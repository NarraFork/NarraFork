import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { BundleError } from "../../lib/credential-transfer/bundle";
import { AppError, catalogError } from "../../lib/errors";

const PASSPHRASE = "correct horse battery";
let role: "admin" | "user" | undefined = "admin";

const requireAdmin: MiddlewareHandler = async (_c, next) => {
	if (!role) throw catalogError("AUTH_REQUIRED");
	if (role !== "admin") throw catalogError("ADMIN_REQUIRED");
	await next();
};

const consumeStepUp = mock((token: string | undefined) => {
	if (token !== "valid-step-up") throw catalogError("STEP_UP_REQUIRED");
});
const exportCredentials = mock(async () => ({ text: "sealed-bundle", count: 2 }));
const previewCredentialImport = mock(async (_bundle: string, passphrase: string) => {
	if (passphrase === "wrong-passphrase") {
		throw new BundleError("BUNDLE_PASSPHRASE", "Wrong passphrase");
	}
	return { exportedAt: 1, items: [] };
});
const applyCredentialImport = mock(
	async (
		_bundle: string,
		passphrase: string,
		_choices: ReadonlyMap<number, "import" | "replace">,
		_actor: { userId: string },
	) => {
		if (passphrase === "wrong-passphrase") {
			throw new BundleError("BUNDLE_PASSPHRASE", "Wrong passphrase");
		}
		return { added: 1, replaced: 0, skipped: 0 };
	},
);
const listTransferableCredentials = mock(() => []);

mock.module("../../middleware/auth", () => ({ requireAdmin }));
mock.module("../../services/step-up-service", () => ({ consumeStepUp }));
mock.module("../../lib/credential-transfer", () => ({
	applyCredentialImport,
	exportCredentials,
	listTransferableCredentials,
	previewCredentialImport,
}));

const { credentialTransferRoutes } = await import("../credential-transfer");

function makeApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (role) {
			c.set("user", {
				sub: `${role}-id`,
				sid: "session-id",
				role,
				iat: 0,
				exp: Number.MAX_SAFE_INTEGER,
			});
		}
		await next();
	});
	app.onError((error, c) => {
		if (error instanceof AppError) {
			return c.json({ code: error.code, messageCode: error.messageCode }, error.statusCode as 400);
		}
		return c.json({ error: String(error) }, 500);
	});
	app.route("/api/credential-transfer", credentialTransferRoutes);
	return app;
}

function post(path: string, body: unknown) {
	return makeApp().request(`/api/credential-transfer${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	role = "admin";
	consumeStepUp.mockClear();
	exportCredentials.mockClear();
	previewCredentialImport.mockClear();
	applyCredentialImport.mockClear();
	listTransferableCredentials.mockClear();
});

describe("credential transfer route authorization", () => {
	test.each([
		["anonymous", undefined, 401],
		["non-admin", "user", 403],
	] as const)("%s cannot export credentials", async (_label, currentRole, status) => {
		role = currentRole;
		const response = await post("/export", {
			stepUpToken: "valid-step-up",
			passphrase: PASSPHRASE,
		});

		expect(response.status).toBe(status);
		expect(consumeStepUp).not.toHaveBeenCalled();
		expect(exportCredentials).not.toHaveBeenCalled();
	});

	test("export requires a passphrase before consuming step-up", async () => {
		const response = await post("/export", { stepUpToken: "valid-step-up" });

		expect(response.status).toBe(400);
		expect(consumeStepUp).not.toHaveBeenCalled();
		expect(exportCredentials).not.toHaveBeenCalled();
	});

	test("export consumes a grant bound to the admin, session and credential purpose", async () => {
		const denied = await post("/export", {
			stepUpToken: "wrong-step-up",
			passphrase: PASSPHRASE,
		});
		expect(denied.status).toBe(401);
		expect((await denied.json()).code).toBe("STEP_UP_REQUIRED");
		expect(exportCredentials).not.toHaveBeenCalled();

		const response = await post("/export", {
			stepUpToken: "valid-step-up",
			passphrase: PASSPHRASE,
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-credential-count")).toBe("2");
		expect(consumeStepUp).toHaveBeenLastCalledWith("valid-step-up", {
			userId: "admin-id",
			sessionId: "session-id",
			purpose: "credentials.export",
		});
		expect(exportCredentials).toHaveBeenCalledWith(undefined, PASSPHRASE, { userId: "admin-id" });
	});
});

describe("credential import route validation", () => {
	test.each([
		"/import/preview",
		"/import",
	])("wrong passphrase is rejected by POST %s", async (path) => {
		const response = await post(path, {
			bundle: "sealed-bundle",
			passphrase: "wrong-passphrase",
			...(path === "/import" ? { choices: [] } : {}),
		});

		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe("BUNDLE_PASSPHRASE");
	});

	test("import accepts 5000 choices and rejects 5001 before opening the bundle", async () => {
		const choices = Array.from({ length: 5000 }, (_, index) => ({ index, action: "import" }));
		const accepted = await post("/import", {
			bundle: "sealed-bundle",
			passphrase: PASSPHRASE,
			choices,
		});
		expect(accepted.status).toBe(200);
		expect(applyCredentialImport).toHaveBeenCalledTimes(1);
		expect(applyCredentialImport.mock.calls[0]?.[2]).toBeInstanceOf(Map);
		expect(applyCredentialImport.mock.calls[0]?.[2]?.size).toBe(5000);

		const rejected = await post("/import", {
			bundle: "sealed-bundle",
			passphrase: PASSPHRASE,
			choices: [...choices, { index: 5000, action: "import" }],
		});
		expect(rejected.status).toBe(400);
		expect(applyCredentialImport).toHaveBeenCalledTimes(1);
	});
});
