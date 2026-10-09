import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { PreparedUpdateIdentity } from "../../../shared/update-identity";

const preparedId = "a".repeat(64);
const preparedIdentity: PreparedUpdateIdentity = {
	id: preparedId,
	version: "77.0.0",
	sha512: "fixture-only-digest",
	sizeBytes: 37,
	sourceIdentity: {
		source: "github",
		repository: "fixture/original",
		channel: "stable",
		platform: "linux-x64",
	},
};
let role = "admin";
let applies: Array<{ targetVersion?: string; preparedId?: string }> = [];
let statusVersions: Array<string | undefined> = [];
let applyResult: Record<string, unknown> = { success: true, scheduled: true };
const requireAuth: MiddlewareHandler = async (c, next) => {
	if (!role) return c.json({ error: "Unauthenticated" }, 401);
	await next();
};
const requireAdmin: MiddlewareHandler = async (c, next) => {
	if (role !== "admin") return c.json({ error: "Forbidden" }, 403);
	await next();
};
mock.module("../../middleware/auth", () => ({ requireAuth, requireAdmin }));
mock.module("../../services/update-service", () => ({
	getUpdateNotes: async () => ({ notes: null }),
	applyUpdate: async (options: { targetVersion?: string; preparedId?: string }) => {
		applies.push(options);
		return applyResult;
	},
	cancelPreparedUpdate: () => ({ cancelled: false, status: {} }),
	checkForUpdate: async () => ({
		currentVersion: "1.0.0",
		latestVersion: preparedIdentity.version,
		updateAvailable: true,
		source: "github",
		repository: "fixture/original",
		releaseInfo: {
			version: preparedIdentity.version,
			sha512: preparedIdentity.sha512,
			files: [{ size: preparedIdentity.sizeBytes }],
			sourceIdentity: preparedIdentity.sourceIdentity,
		},
	}),
	cleanupOldUpdates: () => {},
	downloadUpdate: async () => ({
		success: true,
		version: preparedIdentity.version,
		updatePath: "fixture-only-never-executed",
		preparedIdentity,
	}),
	getUpdateDirectory: () => "fixture-only",
	getUpdateInstructions: () => ({ manual: true, message: "Fixture only" }),
	getUpdateStatus: async (version?: string) => {
		statusVersions.push(version);
		return { ready: true, version: preparedIdentity.version, preparedIdentity };
	},
	isUpdateSourceCurrent: () => true,
	shutdownForManualUpdate: () => ({ success: false }),
}));
const { updateRoutes } = await import("../update");
const app = new Hono().route("/update", updateRoutes);
const post = (body: unknown, headers?: Record<string, string>) =>
	app.request("/update/apply", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

beforeEach(() => {
	role = "admin";
	applies = [];
	statusVersions = [];
	applyResult = { success: true, scheduled: true };
});

describe("prepared identity route boundary", () => {
	for (const identity of ["", "user"]) {
		test(`${identity || "anonymous"} cannot apply an otherwise valid selector`, async () => {
			role = identity;
			const response = await post({ version: preparedIdentity.version, preparedId });
			expect(response.status).toBe(identity ? 403 : 401);
			expect(applies).toEqual([]);
		});
	}

	test("valid selector and requested version reach the service, not client artifact metadata", async () => {
		const response = await post({
			version: ` ${preparedIdentity.version} `,
			preparedId,
			sha512: "client-cannot-select-by-forged-hash",
			updatePath: "/untrusted/client/path",
			sourceIdentity: { source: "github", repository: "attacker/payload" },
		});
		expect(response.status).toBe(200);
		expect(applies).toEqual([{ targetVersion: preparedIdentity.version, preparedId }]);
		expect(await response.json()).toMatchObject({ success: true, scheduled: true });
	});

	test("a selector can be submitted without a redundant version", async () => {
		const response = await post({ preparedId });
		expect(response.status).toBe(200);
		expect(applies).toEqual([{ targetVersion: undefined, preparedId }]);
	});

	test("version-only clients receive an explicit identity-required conflict", async () => {
		applyResult = { success: false, code: "PREPARED_UPDATE_IDENTITY_REQUIRED" };
		const response = await post({ version: preparedIdentity.version });
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("PREPARED_UPDATE_IDENTITY_REQUIRED");
	});

	test("empty legacy requests receive an identity-required conflict", async () => {
		applyResult = { success: false, code: "PREPARED_UPDATE_IDENTITY_REQUIRED" };
		const response = await app.request("/update/apply", { method: "POST" });
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("PREPARED_UPDATE_IDENTITY_REQUIRED");
	});

	test("a changed prepared artifact maps the service conflict to HTTP 409", async () => {
		applyResult = { success: false, code: "PREPARED_UPDATE_CHANGED" };
		const response = await post({ version: preparedIdentity.version, preparedId });
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("PREPARED_UPDATE_CHANGED");
		expect(applies).toEqual([{ targetVersion: preparedIdentity.version, preparedId }]);
	});

	for (const invalid of [
		123,
		{},
		[],
		"not-a-selector",
		"a".repeat(63),
		"g".repeat(64),
		"a".repeat(65),
	]) {
		test(`invalid selector ${JSON.stringify(invalid)} is rejected before the service`, async () => {
			const response = await post({ version: preparedIdentity.version, preparedId: invalid });
			expect(response.status).toBe(400);
			expect(applies).toEqual([]);
		});
	}

	test("malformed JSON is rejected instead of silently selecting the current artifact", async () => {
		const response = await app.request("/update/apply", { method: "POST", body: "{broken" });
		expect(response.status).toBe(400);
		expect(applies).toEqual([]);
	});

	for (const body of [[], "selector", null]) {
		test(`non-object JSON body ${JSON.stringify(body)} is rejected`, async () => {
			const response = await post(body);
			expect(response.status).toBe(400);
			expect(applies).toEqual([]);
		});
	}

	test("request bytes are bounded to 64 KiB without Content-Length", async () => {
		const response = await post({ preparedId, ignored: "x".repeat(64 * 1024) });
		expect(response.status).toBe(413);
		expect(applies).toEqual([]);
	});

	test("declared request size over 64 KiB is rejected before service dispatch", async () => {
		const response = await post({ preparedId }, { "content-length": String(64 * 1024 + 1) });
		expect(response.status).toBe(413);
		expect(applies).toEqual([]);
	});

	test("status forwards the server-verified identity unchanged", async () => {
		const response = await app.request(`/update/status?version=${preparedIdentity.version}`);
		expect(response.status).toBe(200);
		expect(statusVersions).toEqual([preparedIdentity.version]);
		expect((await response.json()).preparedIdentity).toEqual(preparedIdentity);
	});

	test("download completion exposes the same verified selector used by apply", async () => {
		const response = await app.request("/update/download", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ releaseInfo: { version: preparedIdentity.version } }),
		});
		expect(response.status).toBe(200);
		const events = await response.text();
		const complete = events.split("\n\n").find((event) => event.includes("event: complete"));
		expect(complete).toBeDefined();
		const data = complete
			?.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice(6);
		expect(JSON.parse(data ?? "{}").preparedIdentity).toEqual(preparedIdentity);
	});
});
