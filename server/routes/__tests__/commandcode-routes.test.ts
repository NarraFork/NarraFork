import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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

const actualCommandCodeManager = await import("../../lib/commandcode-manager");
const { saveSettings, settings } = await import("../../lib/settings");
const { commandCodeRoutes } = await import("../commandcode");
const { invalidateCommandCodeModelsCache } = await import("../../lib/commandcode-models");
const { quotaStore } = await import("../../lib/sourcing/quota-store");
const { COMMAND_CODE_KEY_OWNER, getProviderKeyStore } = await import("../../lib/provider-keys");
const { COMMAND_CODE_USAGE_STALE_MS } = await import("../../lib/commandcode-usage");

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

function usageResponses() {
	return {
		credits: {
			credits: {
				monthlyCredits: 25,
				purchasedCredits: 5,
				freeCredits: 20,
				creditThreshold: 1,
				belowThreshold: false,
			},
			windowLimits: {
				limited: false,
				fiveHour: { used: 1, cap: 10, exceeded: false, resetAt: 1_800_000_000_000 },
				weekly: { used: 2, cap: 20, exceeded: false },
			},
			sandboxAccess: true,
		},
		summary: {
			totalCount: 4,
			totalTokens: 100,
			totalTokensIn: 60,
			totalTokensOut: 40,
			successRate: 100,
			completedCount: 4,
			failedCount: 0,
			totalMonthlyCredits: 3,
			periodStart: "2026-11-01T00:00:00.000Z",
		},
	};
}

test("settings-key usage is a 60-second snapshot cache with the exact legacy response", async () => {
	const originalFetch = globalThis.fetch;
	const originalNow = Date.now;
	const original = structuredClone(settings);
	const now = originalNow();
	const bodies = usageResponses();
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return Response.json(calls % 2 === 1 ? bodies.credits : bodies.summary);
	}) as unknown as typeof fetch;
	Date.now = () => now;
	quotaStore.remove("CommandCode");
	let credentialId = "CommandCode";
	try {
		saveSettings({
			...settings,
			commandCode: { ...settings.commandCode, apiKey: "usage-settings-key" },
		});
		const app = appForRole("user");
		const first = await app.request("/commandcode/usage");
		expect(first.status).toBe(200);
		const body = (await first.json()) as Record<string, unknown>;
		expect(body).toEqual({
			loggedIn: true,
			credits: bodies.credits.credits,
			windowLimits: bodies.credits.windowLimits,
			sandboxAccess: true,
			summary: bodies.summary,
		});
		const second = await app.request("/commandcode/usage");
		expect(await second.json()).toEqual(body);
		expect(calls).toBe(2);
		credentialId = getProviderKeyStore().list(COMMAND_CODE_KEY_OWNER)[0]?.id ?? "CommandCode";
		const snapshot = quotaStore.peek(credentialId);
		expect(snapshot?.windows).toEqual([
			{ kind: "5h", usedRatio: 0.1, resetsAt: 1_800_000_000_000 },
			{ kind: "weekly", usedRatio: 0.1, resetsAt: null },
		]);
		expect(snapshot?.balances).toEqual([{ unit: "credits", remaining: 25, total: 28 }]);
		const { loggedIn: _loggedIn, ...usage } = body;
		expect(snapshot?.detail).toEqual(usage);

		Date.now = () => now + COMMAND_CODE_USAGE_STALE_MS + 1;
		expect((await app.request("/commandcode/usage")).status).toBe(200);
		expect(calls).toBe(4);
	} finally {
		Date.now = originalNow;
		globalThis.fetch = originalFetch;
		quotaStore.remove(credentialId);
		saveSettings(original);
	}
});

test("a late old-key refresh cannot overwrite the current key's snapshot", async () => {
	const originalFetch = globalThis.fetch;
	const original = structuredClone(settings);
	const bodies = usageResponses();
	const bodyFor = (monthlyCredits: number) => ({
		...bodies.credits,
		credits: { ...bodies.credits.credits, monthlyCredits },
	});
	let calls = 0;
	let finishOldCredits!: () => void;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls++;
		const authorization = new Headers(init?.headers).get("Authorization");
		if (authorization === "Bearer key-a" && String(input).endsWith("/alpha/billing/credits")) {
			return new Promise<Response>((resolve) => {
				finishOldCredits = () => resolve(Response.json(bodyFor(5)));
			});
		}
		return Response.json(
			String(input).endsWith("/alpha/usage/summary") ? bodies.summary : bodyFor(30),
		);
	}) as unknown as typeof fetch;
	let credentialId = "CommandCode";
	quotaStore.remove(credentialId);
	try {
		saveSettings({ ...settings, commandCode: { ...settings.commandCode, apiKey: "key-a" } });
		const app = appForRole("user");
		const oldRequest = app.request("/commandcode/usage");
		saveSettings({ ...settings, commandCode: { ...settings.commandCode, apiKey: "key-b" } });
		credentialId = getProviderKeyStore().list(COMMAND_CODE_KEY_OWNER)[0]?.id ?? "CommandCode";
		expect((await app.request("/commandcode/usage")).status).toBe(200);
		const callsAfterFresh = calls;
		expect(quotaStore.peek(credentialId)?.detail).toMatchObject({
			credits: { monthlyCredits: 30 },
		});
		finishOldCredits();
		expect((await oldRequest).status).toBe(200);
		const current = await app.request("/commandcode/usage");
		expect(current.status).toBe(200);
		expect(await current.json()).toMatchObject({ credits: { monthlyCredits: 30 } });
		expect(quotaStore.peek(credentialId)?.detail).toMatchObject({
			credits: { monthlyCredits: 30 },
		});
		// Only the old request's summary was added; the current snapshot stayed fresh.
		expect(calls).toBe(callsAfterFresh + 1);
	} finally {
		globalThis.fetch = originalFetch;
		quotaStore.remove(credentialId);
		saveSettings(original);
	}
});

test("CLI auth falls back to the original uncached requests and writes no snapshot", async () => {
	const originalFetch = globalThis.fetch;
	const original = structuredClone(settings);
	const bodies = usageResponses();
	const authorization: string[] = [];
	let calls = 0;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		calls++;
		authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
		return Response.json(calls % 2 === 1 ? bodies.credits : bodies.summary);
	}) as typeof fetch;
	const auth = spyOn(actualCommandCodeManager, "resolveCommandCodeToken").mockReturnValue({
		credential: { token: "cli-token", source: "cli", userName: "CLI User" },
	});
	quotaStore.remove("CommandCode");
	try {
		saveSettings({ ...settings, commandCode: { ...settings.commandCode, apiKey: "" } });
		const app = appForRole("user");
		const first = await app.request("/commandcode/usage");
		const second = await app.request("/commandcode/usage");
		expect(first.status).toBe(200);
		expect(await second.json()).toEqual(await first.json());
		expect(calls).toBe(4);
		expect(authorization).toEqual(Array(4).fill("Bearer cli-token"));
		expect(quotaStore.peek("CommandCode")).toBeUndefined();
	} finally {
		auth.mockRestore();
		globalThis.fetch = originalFetch;
		quotaStore.remove("CommandCode");
		saveSettings(original);
	}
});
