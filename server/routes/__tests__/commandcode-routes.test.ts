import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-commandcode-routes-"));
process.env.NARRAFORK_HOME = testHome;

const { saveSettings, settings } = await import("../../lib/settings");
const { commandCodeRoutes } = await import("../commandcode");
const { invalidateCommandCodeModelsCache } = await import("../../lib/commandcode-models");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

// assertAdmin authorizes against the live store role, not the token claim, so the
// acting principal must be reported with its role by the session store.
beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "admin-id" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
});
afterEach(() => {
	setAuthStores(undefined);
});

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: `${role}-id`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		throw error;
	});
	app.route("/commandcode", commandCodeRoutes);
	return app;
}

test("model refresh is admin-only and can use an unsaved key without storing it", async () => {
	const originalFetch = globalThis.fetch;
	const original = structuredClone(settings);
	let requestedUrl = "";
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requestedUrl = String(input);
		return new Response(
			JSON.stringify({ data: [{ id: "gpt-test", supported_endpoints: ["/chat/completions"] }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	try {
		saveSettings({ ...settings, commandCode: { apiKey: "stored-key" } });
		const user = await appForRole("user").request("/commandcode/models/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ apiKey: "draft-key" }),
		});
		expect(user.status).toBe(403);

		invalidateCommandCodeModelsCache();
		const admin = await appForRole("admin").request("/commandcode/models/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ apiKey: "draft-key", baseUrl: "https://proxy.example/provider/v1" }),
		});
		expect(admin.status).toBe(200);
		expect(await admin.json()).toEqual({ models: ["gpt-test"], ok: true });
		expect(requestedUrl).toBe("https://proxy.example/provider/v1/models");
		expect(settings.commandCode?.apiKey).toBe("stored-key");

		const invalid = await appForRole("admin").request("/commandcode/models/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		expect(invalid.status).toBe(400);
	} finally {
		globalThis.fetch = originalFetch;
		invalidateCommandCodeModelsCache();
		saveSettings(original);
	}
});
