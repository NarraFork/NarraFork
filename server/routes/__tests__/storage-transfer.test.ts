import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { AppError, catalogError } from "../../lib/errors";
import type { ImportOptions, TransferSelection } from "../../services/data-portability";

const PASSPHRASE = "correct horse battery";
const PROVIDERS_ONLY = { requests: false, sessions: false, providers: true };
let role: "admin" | "user" | undefined = "admin";

const requireAdmin: MiddlewareHandler = async (_c, next) => {
	if (!role) throw catalogError("AUTH_REQUIRED");
	if (role !== "admin") throw catalogError("ADMIN_REQUIRED");
	await next();
};
const consumeStepUp = mock((token: string | undefined) => {
	if (token !== "valid-step-up") throw catalogError("STEP_UP_REQUIRED");
});
const createExportTicket = mock(
	(_selection: TransferSelection, _now: number, _passphrase?: string) => "download-ticket",
);
const exportData = mock(async () => {
	throw new Error("The streaming export service must not be reached by these tests");
});
const applyImport = mock(async (_token: string, options: ImportOptions) => {
	if (!options.passphrase) throw catalogError("IMPORT_PASSPHRASE_REQUIRED");
	if (options.passphrase !== PASSPHRASE) throw catalogError("BUNDLE_PASSPHRASE");
	return {
		requestsInserted: 0,
		sessionsInserted: 1,
		sessionsOverwritten: 0,
		sessionsSkipped: 0,
		sessionsRejected: 0,
		providersAdded: 1,
		providersRenamed: 0,
		keysImported: 1,
		keysFailed: 0,
	};
});
const clearData = mock(async () => ({}));
const previewImport = mock(async () => {
	throw new Error("Unexpected in-memory preview");
});
const previewImportFromStream = mock(async () => {
	throw new Error("Unexpected streaming preview");
});
const redeemExportTicket = mock(() => undefined);

mock.module("../../middleware/auth", () => ({ requireAdmin }));
mock.module("../../services/step-up-service", () => ({ consumeStepUp }));
mock.module("../../services/data-portability", () => ({
	applyImport,
	clearData,
	createExportTicket,
	exportData,
	previewImport,
	previewImportFromStream,
	redeemExportTicket,
}));

const { storageTransferRoutes } = await import("../storage-transfer");

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
	app.route("/api/storage", storageTransferRoutes);
	return app;
}

function post(path: string, body: unknown) {
	return makeApp().request(`/api/storage${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	role = "admin";
	consumeStepUp.mockClear();
	createExportTicket.mockClear();
	exportData.mockClear();
	applyImport.mockClear();
	clearData.mockClear();
	previewImport.mockClear();
	previewImportFromStream.mockClear();
	redeemExportTicket.mockClear();
});

describe("storage provider export authorization", () => {
	test.each([
		["anonymous", undefined, 401],
		["non-admin", "user", 403],
	] as const)("%s cannot create a provider export ticket", async (_label, currentRole, status) => {
		role = currentRole;
		const response = await post("/export/ticket", {
			...PROVIDERS_ONLY,
			stepUpToken: "valid-step-up",
			passphrase: PASSPHRASE,
		});

		expect(response.status).toBe(status);
		expect(consumeStepUp).not.toHaveBeenCalled();
		expect(createExportTicket).not.toHaveBeenCalled();
	});

	test.each([
		"/export",
		"/export/ticket",
	])("POST %s with providers and no passphrase does not consume step-up", async (path) => {
		const response = await post(path, {
			...(path === "/export" ? { selection: PROVIDERS_ONLY } : PROVIDERS_ONLY),
			stepUpToken: "valid-step-up",
		});

		expect(response.status).toBe(400);
		expect((await response.json()).messageCode).toBe("EXPORT_PARAMS_INVALID");
		expect(consumeStepUp).not.toHaveBeenCalled();
		expect(exportData).not.toHaveBeenCalled();
		expect(createExportTicket).not.toHaveBeenCalled();
	});

	test("provider export requires and consumes a grant for the storage purpose", async () => {
		const denied = await post("/export/ticket", {
			...PROVIDERS_ONLY,
			stepUpToken: "wrong-step-up",
			passphrase: PASSPHRASE,
		});
		expect(denied.status).toBe(401);
		expect((await denied.json()).code).toBe("STEP_UP_REQUIRED");
		expect(createExportTicket).not.toHaveBeenCalled();

		const response = await post("/export/ticket", {
			...PROVIDERS_ONLY,
			stepUpToken: "valid-step-up",
			passphrase: PASSPHRASE,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ticket: "download-ticket" });
		expect(consumeStepUp).toHaveBeenLastCalledWith("valid-step-up", {
			userId: "admin-id",
			sessionId: "session-id",
			purpose: "storage.export.providers",
		});
		expect(createExportTicket).toHaveBeenCalledWith(PROVIDERS_ONLY, expect.any(Number), PASSPHRASE);
	});
});

describe("storage import passphrase errors", () => {
	test.each([
		["missing", undefined, "IMPORT_PASSPHRASE_REQUIRED"],
		["wrong", "wrong-passphrase", "BUNDLE_PASSPHRASE"],
	] as const)("%s passphrase is returned to the caller", async (_label, passphrase, code) => {
		const response = await post("/import", {
			token: "preview-token",
			...(passphrase ? { passphrase } : {}),
		});

		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe(code);
		expect(applyImport).toHaveBeenCalledTimes(1);
	});

	test("a valid passphrase and import decisions reach the service", async () => {
		const response = await post("/import", {
			token: "preview-token",
			conflictDefault: "skip",
			include: { providers: true },
			passphrase: PASSPHRASE,
		});

		expect(response.status).toBe(200);
		expect((await response.json()).keysImported).toBe(1);
		expect(applyImport).toHaveBeenCalledWith("preview-token", {
			conflictDefault: "skip",
			conflictById: undefined,
			include: { providers: true },
			passphrase: PASSPHRASE,
		});
	});
});
