import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { AUTO_LAN_HOST } from "../../../shared/server-host";
import { updateSettingsKey } from "../../../shared/update-settings";
import { AppError } from "../../lib/errors";
import { settingsUpdateLock } from "../../lib/settings/write-lock";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-model-test-admin-"));
process.env.NARRAFORK_HOME = testHome;
const { db } = await import("../../db");
const { narrators } = await import("../../db/schema");
const { saveSettings, settings } = await import("../../lib/settings");
const { buildServerRestartUrl, settingsRoutes, updateSettingsSchema } = await import("../settings");
const { getDefaults, deepMerge } = await import("../../lib/settings");
const { registerServerRestart } = await import("../../lib/server-restart");
const { tlsRoutes } = await import("../tls");

/**
 * The admin-gated settings routes run `requireAdmin`, which authorizes against the LIVE role
 * read through the session store, never the token's `role` claim. The middleware below only
 * sets `c.get("user")`, so this seam resolves each principal's role by actor id ("admin-id"
 * → admin, anything else → user). Without it a non-admin would surface as 401 USER_GONE
 * instead of the expected 403 ADMIN_REQUIRED.
 */
const ADMIN_ACTOR_ID = "admin-id";
const NON_ADMIN_ACTOR_ID = "user-id";
const sessionStoreSeam: AuthSessionStore = {
	...authSessionStore,
	findSessionState: async (id) => ({
		id,
		role: id === ADMIN_ACTOR_ID ? "admin" : "user",
		tokenVersion: 0,
	}),
};
setAuthStores({ session: sessionStoreSeam, mfa: authMfaStore });

afterAll(() => {
	setAuthStores(undefined);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
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
	app.route("/settings", settingsRoutes);
	app.route("/tls", tlsRoutes);
	return app;
}

describe("settings availability stays lightweight", () => {
	test("GET and PATCH expose readiness from an unknown registered provider", async () => {
		const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
		const original = structuredClone(settings);
		const descriptor = { id: "future:instance", prefix: "future-api", name: "Future", ready: true };
		let adapterCalls = 0;
		const unregister = registerExternalProviderResolver({
			resolve: () => {
				adapterCalls++;
				throw new Error("Readiness must not create adapters");
			},
			listReadiness: () => [descriptor],
		});
		try {
			settings.agent.summaryModel = "";
			const app = appForRole("admin");
			const response = await app.request("http://localhost/settings");
			expect(response.status).toBe(200);
			expect((await response.json()).providerReadiness).toContainEqual(descriptor);
			const saved = await app.request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: { disabledProviders: [descriptor.prefix] } }),
			});
			expect(saved.status).toBe(200);
			expect((await saved.json()).providerReadiness).toContainEqual({
				...descriptor,
				ready: false,
			});
			expect(adapterCalls).toBe(0);
			unregister();
			const removed = await app.request("http://localhost/settings");
			expect((await removed.json()).providerReadiness).not.toContainEqual(descriptor);
		} finally {
			unregister();
			saveSettings(original);
		}
	});

	test("GET and summary-model PATCH never build a full Codex quota snapshot", async () => {
		const { getCodexManager } = await import("../../lib/codex-manager");
		const manager = getCodexManager();
		const original = structuredClone(settings);
		const snapshot = spyOn(manager, "snapshot").mockImplementation(() => {
			throw new Error("Settings must not compute full account forecasts");
		});
		try {
			const app = appForRole("admin");
			const response = await app.request("http://localhost/settings");
			expect(response.status).toBe(200);
			expect((await response.json()).codexAvailable).toBe(manager.hasAvailableCredentials);
			const saved = await app.request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: { summaryModel: "tokendance:mimo-v2.6-flash" } }),
			});
			expect(saved.status).toBe(200);
			expect((await saved.json()).agent.summaryModel).toBe("tokendance:mimo-v2.6-flash");
			expect(snapshot).not.toHaveBeenCalled();
		} finally {
			snapshot.mockRestore();
			saveSettings(original);
		}
	});
});

describe("per-response tool-call limit settings", () => {
	test("defaults to 32 and preserves legacy partial updates", () => {
		expect(getDefaults().agent.maxToolCallsPerResponse).toBe(32);
		const legacy = updateSettingsSchema.parse({ agent: { silentToolCallThreshold: 20 } });
		expect(legacy.agent).not.toHaveProperty("maxToolCallsPerResponse");
		expect(deepMerge(getDefaults(), legacy).agent.maxToolCallsPerResponse).toBe(32);
		const configured = getDefaults();
		configured.agent.maxToolCallsPerResponse = 64;
		expect(deepMerge(configured, legacy).agent.maxToolCallsPerResponse).toBe(64);
	});

	test.each([1, 32, 128])("accepts integer limit %s", (limit) => {
		const parsed = updateSettingsSchema.parse({ agent: { maxToolCallsPerResponse: limit } });
		expect(parsed.agent?.maxToolCallsPerResponse).toBe(limit);
	});

	test.each([-1, 0, 129, 500, 1.5, "32", null])("rejects invalid limit %s", (limit) => {
		expect(
			updateSettingsSchema.safeParse({ agent: { maxToolCallsPerResponse: limit } }).success,
		).toBe(false);
	});
});

describe("search channel settings validation", () => {
	test("accepts reordered plugin and built-in channels without changing their settings", () => {
		const channels = [
			{ id: "plugin:com.example.search:web", kind: "plugin", enabled: false, timeoutMs: 90000 },
			{ id: "custom:engine", kind: "custom-api", enabled: true, providerId: "engine" },
			{ id: "nug:gateway", kind: "nug-mcp", enabled: true, providerId: "gateway" },
			{ id: "subagent", kind: "subagent", enabled: true, maxTurns: 7 },
			{ id: "native", kind: "native", enabled: true },
		];

		for (const reordered of [channels, [...channels].reverse()]) {
			const parsed = updateSettingsSchema.parse({ search: { channels: reordered } });
			expect<unknown>(parsed.search?.channels).toEqual(reordered);
		}
	});

	test("still rejects unknown channel kinds", () => {
		const result = updateSettingsSchema.safeParse({
			search: { channels: [{ id: "unknown", kind: "unknown", enabled: true }] },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(["search", "channels", 0, "kind"]);
		}
	});
});

describe("settings restart redirects", () => {
	test.each([
		"/settings/generate-tls",
		"/tls/generate",
	])("%s returns actual rollback protocol and port, not desired HTTPS settings", async (endpoint) => {
		const original = structuredClone(settings);
		const suppress = process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
		const listener = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("owned"),
		});
		try {
			delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
			registerServerRestart((_host, _port, options) => {
				expect(options?.preserveResponse).toBe(true);
				return { host: "127.0.0.1", port: listener.port as number, protocol: "http" };
			});
			const response = await appForRole("admin").request(`http://localhost${endpoint}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { newUrl: string };
			expect(body.newUrl).toBe(`http://127.0.0.1:${listener.port}`);
		} finally {
			void listener.stop(true);
			registerServerRestart(null);
			saveSettings(original);
			if (suppress === undefined) delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
			else process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART = suppress;
		}
	});
	test("persists automatic LAN mode but redirects to the actual local fallback", async () => {
		const original = structuredClone(settings);
		const previousSuppressRestart = process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
		try {
			delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
			registerServerRestart((_host, port, options) => {
				expect(options?.preserveResponse).toBe(true);
				return { host: _host === AUTO_LAN_HOST ? "localhost" : _host, port, protocol: "http" };
			});
			saveSettings({ ...settings, server: { ...settings.server, host: "localhost" } });
			const response = await appForRole("admin").request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ server: { host: AUTO_LAN_HOST } }),
			});
			const body = (await response.json()) as { server: { host: string }; newUrl: string };
			expect(response.status).toBe(200);
			expect(settings.server.host).toBe(AUTO_LAN_HOST);
			expect(body.server.host).toBe(AUTO_LAN_HOST);
			expect(new URL(body.newUrl).hostname).toBe("localhost");
		} finally {
			saveSettings(original);
			registerServerRestart(null);
			if (previousSuppressRestart === undefined) {
				delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
			} else {
				process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART = previousSuppressRestart;
			}
		}
	});
	test("preserves the request hostname when switching to a wildcard listener", async () => {
		const original = structuredClone(settings);
		const previousSuppressRestart = process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
		try {
			delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
			registerServerRestart((_host, port, options) => {
				expect(options?.preserveResponse).toBe(true);
				return { host: _host === AUTO_LAN_HOST ? "localhost" : _host, port, protocol: "http" };
			});
			saveSettings({
				...settings,
				server: { ...settings.server, host: "localhost" },
			});

			const response = await appForRole("admin").request(
				`http://127.0.0.1:${settings.server.port}/settings`,
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ server: { host: "0.0.0.0" } }),
				},
			);
			const body = (await response.json()) as { newUrl?: string };

			expect(response.status).toBe(200);
			expect(body.newUrl).toBe(
				buildServerRestartUrl(
					`http://127.0.0.1:${settings.server.port}/settings`,
					"0.0.0.0",
					settings.server.port,
					settings.server.tls?.enabled === true,
				),
			);
			expect(new URL(body.newUrl as string).hostname).toBe("127.0.0.1");
		} finally {
			saveSettings(original);
			registerServerRestart(null);
			if (previousSuppressRestart === undefined) {
				delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
			} else {
				process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART = previousSuppressRestart;
			}
		}
	});
});

describe("settings conditional admin guards", () => {
	test("rejects a non-admin before attempting provider resolution", async () => {
		const response = await appForRole("user").request("/settings/test-model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "does-not-matter", prompt: "hello" }),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Admin access required",
			code: "FORBIDDEN",
		});
	});

	test("rejects explicit trustedProxyCidrs patches from non-admins without mutation", async () => {
		const before = structuredClone(settings.auth);
		const response = await appForRole("user").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				auth: { trustedProxyCidrs: ["10.0.0.0/8"] },
				agent: { maxTurns: settings.agent.maxTurns + 1 },
			}),
		});

		expect(response.status).toBe(403);
		expect(settings.auth).toEqual(before);
	});

	test("rejects every instance settings patch from non-admins", async () => {
		// Only instance-wide fields are patchable here (per-user preferences live in
		// /api/user-preferences), so a non-admin must never mutate any of them.
		const before = structuredClone(settings);
		const patches: Array<Record<string, unknown>> = [
			{ auth: { registrationOpen: !settings.auth.registrationOpen } },
			{ server: { host: "0.0.0.0" } },
			{ agent: { maxTurns: settings.agent.maxTurns + 1 } },
			{ paths: { defaultProjectDir: "/tmp/not-allowed" } },
		];

		for (const patch of patches) {
			const response = await appForRole("user").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			});

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: "Admin access required",
				code: "FORBIDDEN",
			});
		}

		expect(settings).toEqual(before);
	});

	test("rejects non-admin writes to the remaining instance settings endpoints", async () => {
		const before = structuredClone(settings);
		const requests: Array<[string, unknown]> = [
			["/settings/generate-tls", {}],
			["/settings/retry-rules", { domain: "example.com" }],
			["/settings/fix-provider-baseurl", { providerId: "does-not-matter" }],
			["/settings/search/test", { query: "hello" }],
		];

		for (const [path, body] of requests) {
			const response = await appForRole("user").request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

			expect(response.status).toBe(403);
		}

		expect(settings).toEqual(before);
	});

	test("allows admins to patch ordinary instance settings", async () => {
		const original = settings.auth.registrationOpen;
		const response = await appForRole("admin").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auth: { registrationOpen: !original } }),
		});

		expect(response.status).toBe(200);
		expect(settings.auth.registrationOpen).toBe(!original);
		settings.auth.registrationOpen = original;
	});

	test("allows admins to update trustedProxyCidrs", async () => {
		const original = structuredClone(settings.auth.trustedProxyCidrs);
		const response = await appForRole("admin").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auth: { trustedProxyCidrs: ["10.0.0.0/8"] } }),
		});

		expect(response.status).toBe(200);
		expect(settings.auth.trustedProxyCidrs).toEqual(["10.0.0.0/8"]);
		settings.auth.trustedProxyCidrs = original;
	});

	test("clears text settings when the patch sends an explicit empty string", async () => {
		const original = structuredClone(settings);
		try {
			saveSettings({
				...settings,
				agent: {
					...settings.agent,
					defaultSystemPrompt: "stale prompt",
					defaultReasoningEffort: "low",
				},
				update: { ...settings.update, serverUrl: "https://stale.example.com" },
			} as typeof settings);

			const response = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agent: { defaultSystemPrompt: "", defaultReasoningEffort: "" },
					update: { serverUrl: "" },
				}),
			});

			expect(response.status).toBe(200);
			expect(settings.agent.defaultSystemPrompt).toBe("");
			expect(settings.agent.defaultReasoningEffort).toBeUndefined();
			expect(settings.update?.serverUrl).toBe("");
		} finally {
			saveSettings(original);
		}
	});

	test("restricts external OAuth WebSocket settings to admins and deep-merges valid patches", async () => {
		const original = structuredClone(settings);
		try {
			const denied = await appForRole("user").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					oauth: { externalWebSocket: { allowedOrigins: ["https://robot.example.com"] } },
				}),
			});
			expect(denied.status).toBe(403);
			expect(settings.oauth?.externalWebSocket?.allowedOrigins).toEqual(
				original.oauth?.externalWebSocket?.allowedOrigins,
			);

			const previousMaxTickets = settings.oauth?.externalWebSocket?.maxTickets;
			const allowed = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					oauth: {
						externalWebSocket: {
							allowedOrigins: ["https://robot.example.com"],
						},
					},
				}),
			});
			expect(allowed.status).toBe(200);
			expect(settings.oauth?.externalWebSocket).toMatchObject({
				allowedOrigins: ["https://robot.example.com"],
				maxTickets: previousMaxTickets,
			});

			const invalidOrigin = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					oauth: {
						externalWebSocket: { allowedOrigins: ["https://robot.example.com/path"] },
					},
				}),
			});
			expect(invalidOrigin.status).toBe(400);
		} finally {
			saveSettings(original);
		}
	});

	test("old split-array patches preserve Gemini providers and real keys", async () => {
		const original = structuredClone(settings);
		try {
			const geminiProvider = {
				id: "gemini-legacy",
				name: "Gemini Legacy",
				prefix: "gemini-legacy",
				apiKey: "real-secret-key",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				defaultModel: "gemini-2.5-flash",
				disabled: false,
			};
			saveSettings({
				...settings,
				customApiProviders: [{ ...geminiProvider, protocol: "gemini-compatible" }],
				openaiProviders: [],
				anthropicProviders: [],
				geminiProviders: [geminiProvider],
			});

			const response = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ openaiProviders: [], anthropicProviders: [] }),
			});

			expect(response.status).toBe(200);
			expect(settings.geminiProviders).toEqual([
				expect.objectContaining({
					id: "gemini-legacy",
					apiKey: "real-secret-key",
					geminiTransport: "generate-content",
				}),
			]);
			expect(settings.customApiProviders).toEqual([
				expect.objectContaining({
					id: "gemini-legacy",
					apiKey: "real-secret-key",
					protocol: "gemini-compatible",
				}),
			]);
		} finally {
			saveSettings(original);
		}
	});

	test.each([
		"generate-content",
		"interactions",
	] as const)("legacy Gemini %s settings preserve fingerprints through HTTP save and readback", async (geminiTransport) => {
		const original = structuredClone(settings);
		try {
			const provider = {
				id: "gemini-fingerprint",
				name: "Gemini",
				prefix: "gemini-fingerprint",
				apiKey: "real-gemini-key",
				baseUrl: "https://opencode.ai/inference/go/v1",
				defaultModel: "gemini-2.5-flash",
				geminiTransport,
				userAgentMode: "custom" as const,
				customUserAgent: "Gemini-Client/1",
				extraHeaders: { "X-OpenCode-Session": "manual-session", "X-Test": "retained" },
			};
			const app = appForRole("admin");
			const patch = (body: unknown) =>
				app.request("/settings", {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			expect((await patch({ geminiProviders: [provider] })).status).toBe(200);
			for (const family of ["geminiProviders", "customApiProviders"] as const) {
				expect(settings[family]?.find((entry) => entry.id === provider.id)).toMatchObject(provider);
			}
			const response = await app.request("/settings");
			expect(response.status).toBe(200);
			const saved = await response.json();
			const legacy = saved.geminiProviders.find(
				(entry: { id: string }) => entry.id === provider.id,
			);
			expect(legacy).toMatchObject({
				userAgentMode: provider.userAgentMode,
				customUserAgent: provider.customUserAgent,
				extraHeaders: provider.extraHeaders,
			});
			expect(legacy.apiKey).not.toBe(provider.apiKey);
			expect((await patch({ geminiProviders: saved.geminiProviders })).status).toBe(200);
			expect(settings.customApiProviders?.find((entry) => entry.id === provider.id)).toMatchObject(
				provider,
			);
			expect(
				(
					await patch({
						openaiProviders: saved.openaiProviders,
						anthropicProviders: saved.anthropicProviders,
					})
				).status,
			).toBe(200);
			expect(settings.geminiProviders?.find((entry) => entry.id === provider.id)).toMatchObject(
				provider,
			);
		} finally {
			saveSettings(original);
		}
	});

	test("masked unified Gemini patches round-trip explicit transport without losing the key", async () => {
		const original = structuredClone(settings);
		try {
			const provider = {
				id: "gemini-interactions",
				name: "Gemini Interactions",
				prefix: "gemini-interactions",
				apiKey: "real-interactions-key",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				defaultModel: "gemini-3-flash-preview",
				protocol: "gemini-compatible" as const,
				geminiTransport: "interactions" as const,
			};
			saveSettings({
				...settings,
				customApiProviders: [provider],
				openaiProviders: [],
				anthropicProviders: [],
				geminiProviders: [provider],
			});

			const getResponse = await appForRole("admin").request("/settings");
			const masked = (await getResponse.json()) as {
				customApiProviders: Array<Record<string, unknown>>;
			};
			expect(masked.customApiProviders[0]?.geminiTransport).toBe("interactions");
			expect(String(masked.customApiProviders[0]?.apiKey).startsWith("*")).toBe(true);
			expect(String(masked.customApiProviders[0]?.apiKey).endsWith("-key")).toBe(true);

			const patchResponse = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ customApiProviders: masked.customApiProviders }),
			});
			expect(patchResponse.status).toBe(200);
			expect(settings.customApiProviders?.[0]).toMatchObject({
				geminiTransport: "interactions",
				apiKey: "real-interactions-key",
			});
			expect(settings.geminiProviders?.[0]).toMatchObject({
				geminiTransport: "interactions",
				apiKey: "real-interactions-key",
			});
		} finally {
			saveSettings(original);
		}
	});

	test("masked Command Code key patches keep the stored credential", async () => {
		const original = structuredClone(settings);
		try {
			// 设置页的底部保存条每次都会带上整份草稿，Command Code 的 key 是脱敏回显值；
			// 提交它必须保留已存凭据，否则一次无关的保存就会把用户的 key 换成星号串。
			saveSettings({ ...settings, commandCode: { apiKey: "real-commandcode-key" } });
			const patchResponse = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ commandCode: { apiKey: "********-key" } }),
			});
			expect(patchResponse.status).toBe(200);
			expect(settings.commandCode?.apiKey).toBe("real-commandcode-key");
		} finally {
			saveSettings(original);
		}
	});

	test("provider prefix changes migrate narrator model references atomically", async () => {
		const original = structuredClone(settings);
		const narratorId = "prefix-migration-narrator";
		const now = new Date().toISOString();
		try {
			const provider = {
				id: "prefix-provider",
				name: "Prefix Provider",
				prefix: "old-prefix",
				apiKey: "secret",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "model-a",
				protocol: "openai-responses" as const,
			};
			saveSettings({
				...settings,
				customApiProviders: [provider],
				openaiProviders: [],
				anthropicProviders: [],
				geminiProviders: [],
			});
			await db.insert(narrators).values({
				id: narratorId,
				model: "old-prefix:model-a",
				pendingModelRestore: "old-prefix:model-b",
				createdAt: now,
				updatedAt: now,
			});

			const response = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					customApiProviders: [{ ...provider, prefix: "new-prefix" }],
				}),
			});
			expect(response.status).toBe(200);
			const row = await db
				.select({ model: narrators.model, pendingModelRestore: narrators.pendingModelRestore })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get();
			expect(row).toEqual({
				model: "new-prefix:model-a",
				pendingModelRestore: "new-prefix:model-b",
			});
			expect(settings.customApiProviders?.[0]?.prefix).toBe("new-prefix");
		} finally {
			await db.delete(narrators).where(eq(narrators.id, narratorId));
			saveSettings(original);
		}
	});
});

describe("conditional update source settings", () => {
	test("an expected source is checked after acquiring the settings write lock", async () => {
		const original = structuredClone(settings);
		const initialUpdate = original.update;
		if (!initialUpdate) throw new Error("Missing default update settings");
		const gate = Promise.withResolvers<void>();
		let blocker: Promise<unknown> | undefined;
		try {
			saveSettings({ ...original, update: { ...initialUpdate, source: "github" } });
			const app = appForRole("admin");
			const checked = await (await app.request("http://localhost/settings")).json();
			const expectedUpdateSettingsKey = updateSettingsKey(checked.update);
			const concurrent = {
				...initialUpdate,
				source: "update-server" as const,
				serverUrl: "https://private.example",
			};
			blocker = settingsUpdateLock.acquire("settings", async () => {
				saveSettings({ ...settings, update: concurrent });
				await gate.promise;
			});
			const pending = app.request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedUpdateSettingsKey,
					update: { source: "update-server", serverUrl: "https://narrafork-update.b.domexie.cn" },
				}),
			});
			gate.resolve();
			await blocker;
			const response = await pending;
			expect(response.status).toBe(409);
			expect((await response.json()).code).toBe("UPDATE_SOURCE_CHANGED");
			expect(settings.update).toEqual(concurrent);
		} finally {
			gate.resolve();
			await blocker;
			saveSettings(original);
		}
	});

	test("a matching conditional patch preserves other preferences without persisting its precondition", async () => {
		const original = structuredClone(settings);
		const initialUpdate = original.update;
		if (!initialUpdate) throw new Error("Missing default update settings");
		try {
			saveSettings({
				...original,
				update: {
					...initialUpdate,
					source: "github",
					channel: "beta",
					autoDownload: true,
					proxy: { mode: "direct" },
				},
			});
			const before = structuredClone(settings.update);
			if (!before) throw new Error("Missing saved update settings");
			const response = await appForRole("admin").request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedUpdateSettingsKey: updateSettingsKey(before),
					update: { source: "update-server", serverUrl: "https://narrafork-update.b.domexie.cn" },
				}),
			});
			expect(response.status).toBe(200);
			expect(settings.update).toEqual({
				...before,
				source: "update-server",
				serverUrl: "https://narrafork-update.b.domexie.cn",
			});
			expect(settings).not.toHaveProperty("expectedUpdateSettingsKey");
			expect(await response.json()).not.toHaveProperty("expectedUpdateSettingsKey");
		} finally {
			saveSettings(original);
		}
	});

	test("an ordinary patch without a precondition remains supported", async () => {
		const original = structuredClone(settings);
		try {
			const response = await appForRole("admin").request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ update: { channel: "beta" } }),
			});
			expect(response.status).toBe(200);
			expect(settings.update?.channel).toBe("beta");
		} finally {
			saveSettings(original);
		}
	});
});

describe("default project directory", () => {
	async function patchProjectDir(defaultProjectDir: string) {
		return appForRole("admin").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ paths: { defaultProjectDir } }),
		});
	}

	test("accepts only an existing directory, and unchanged or empty values always save", async () => {
		const original = structuredClone(settings);
		const existing = mkdtempSync(join(testHome, "projects-"));
		try {
			const missing = await patchProjectDir(join(testHome, "no-such-dir"));
			expect(missing.status).toBe(400);
			expect((await missing.json()).code).toBe("PROJECT_DIR_NOT_FOUND");
			expect(settings.paths.defaultProjectDir).toBe(original.paths.defaultProjectDir);

			expect((await patchProjectDir(existing)).status).toBe(200);
			expect(settings.paths.defaultProjectDir).toBe(existing);

			// The chosen directory disappearing must not block re-saving the form.
			rmSync(existing, { recursive: true, force: true });
			expect((await patchProjectDir(existing)).status).toBe(200);
			expect((await patchProjectDir("")).status).toBe(200);
			expect(settings.paths.defaultProjectDir).toBe("");
		} finally {
			saveSettings(original);
		}
	});
});
