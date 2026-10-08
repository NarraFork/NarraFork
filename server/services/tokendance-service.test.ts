import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isLegacyTokenDancePrefixAllowed } from "../lib/settings/tokendance-prefix";
import type { NarraForkSettings } from "../lib/settings/types";

const fakeSettings = {
	server: { allowedOrigins: ["https://ui.example"] },
	tokendance: { apiKey: "", disabled: false, generation: 0 },
	agent: { hiddenModels: [], modelAggregations: [] },
} as unknown as NarraForkSettings;
let saves = 0;
mock.module("../lib/settings", () => ({
	settings: fakeSettings,
	saveSettings: (next: NarraForkSettings) => {
		saves++;
		Object.assign(fakeSettings, next);
	},
}));
const service = await import("./tokendance-service");
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let ownerCount = 0;
function start(snapshot?: unknown) {
	const owner = `owner-${++ownerCount}`;
	const result = service.startTokenDanceOAuth(
		owner,
		new URL("https://ui.example/base/settings/providers/tokendance/callback"),
		snapshot,
	);
	return { ...result, owner };
}
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status });
}
function fetchMock(fn: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) =>
		fn(String(url), init),
	) as unknown as typeof fetch;
}
beforeEach(async () => {
	Date.now = originalNow;
	await service.deleteTokenDanceConnection();
	saves = 0;
	fakeSettings.agent = {
		hiddenModels: [],
		modelAggregations: [],
	} as unknown as NarraForkSettings["agent"];
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	Date.now = originalNow;
});

describe("TokenDance backend", () => {
	test.each([
		"top_up_balance",
		"reauthorize_api_key",
		"api_key_quota",
	] as const)("refresh preserves %s even when its error body never finishes", async (action) => {
		fakeSettings.tokendance = { apiKey: "secret-refresh-key", disabled: false, generation: 100 };
		let cancelled = false;
		fetchMock(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{
						status: 429,
						headers: { "TokenDance-Recovery-Action": action, "Content-Length": "999999999" },
					},
				),
		);
		try {
			await service.refreshTokenDanceModels();
			throw new Error("Expected recovery error");
		} catch (error) {
			expect(error).toHaveProperty("extra.recoveryAction", action);
		}
		expect(service.getTokenDanceConnection().recoveryAction).toBe(action);
		expect(cancelled).toBe(true);
	});
	test("public DTO omits key and ordinary settings explicitly override spread", () => {
		fakeSettings.tokendance = { apiKey: "secret-never-return", disabled: false, generation: 100 };
		expect(JSON.stringify(service.getTokenDanceConnection())).not.toContain("secret-never-return");
		const source = readFileSync(new URL("../routes/settings.ts", import.meta.url), "utf8");
		expect(source).toContain("tokendance: getTokenDanceConnection()");
		expect(source).toContain('new Set(["codex", "tokendance"])');
	});
	test("callback origin/path is controlled and loopback dev/subpaths work", () => {
		expect(
			service.validateTokenDanceCallback(
				"http://localhost:7778/base/settings/providers/tokendance/callback",
				"http://localhost:7779/api/tokendance/oauth/start",
				"http://localhost:7778",
			).pathname,
		).toStartWith("/base/");
		expect(() =>
			service.validateTokenDanceCallback(
				"https://evil.example/settings/providers/tokendance/callback",
				"https://server.example/api/x",
				"https://evil.example",
			),
		).toThrow();
		expect(() =>
			service.validateTokenDanceCallback(
				"https://ui.example/other",
				"https://server.example/api/x",
				"https://ui.example",
			),
		).toThrow();
		expect(() =>
			service.validateTokenDanceCallback(
				"https://ui.example/settings/providers/tokendance/callback?code=secret",
				"https://server.example/api/x",
				"https://ui.example",
			),
		).toThrow();
	});
	test("PKCE challenge and fixed attribution; snapshot owner-only one-time claim does not consume flow", async () => {
		const snapshot = {
			draft: { openaiProviders: [{ apiKey: "unsaved-other-key" }] },
			baseline: {},
			addPage: {},
		};
		const flow = start(snapshot);
		const auth = new URL(flow.authorizeUrl);
		expect(auth.origin).toBe("https://tokendance.space");
		expect(auth.searchParams.get("app_url")).toBe("https://tokendanceconnect.narrafork.dev/");
		expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
		expect(new URL(auth.searchParams.get("callback_url") as string).searchParams.get("state")).toBe(
			flow.flowId,
		);
		expect(() => service.restoreTokenDanceDraft("wrong", flow.flowId)).toThrow();
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toEqual({
			status: "pending",
			draftSnapshot: snapshot,
		});
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toEqual({ status: "pending" });
		fetchMock((_url, init) =>
			init?.method === "POST" ? json({ key: "key-private" }) : json({ data: [] }),
		);
		expect(
			(await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "opaque-code")).connected,
		).toBe(true);
	});
	test("reject TokenDance draft fields and oversized snapshot before redirect", () => {
		expect(() => start({ draft: { tokendance: { apiKey: "bad" } }, baseline: {} })).toThrow();
		expect(() =>
			start({ draft: { nested: [{ prefix: "tokendance", apiKey: "bad" }] }, baseline: {} }),
		).not.toThrow();
		expect(() => start({ draft: { text: "x".repeat(1024 * 1024) }, baseline: {} })).toThrow();
	});
	test("consume exchange once under concurrency; persist before catalog; safe recovery", async () => {
		const flow = start({ draft: {}, baseline: {} });
		let resolve!: (value: Response) => void;
		fetchMock((_url, init) =>
			init?.method === "POST"
				? new Promise((r) => {
						resolve = r;
					})
				: new Response("secret-upstream", {
						status: 402,
						headers: { "TokenDance-Recovery-Action": "top_up_balance" },
					}),
		);
		const first = service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code-private");
		await expect(
			service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code-private"),
		).rejects.toThrow("already consumed");
		resolve(json({ key: "key-private" }));
		const result = await first;
		expect(result).toEqual({
			connected: true,
			modelsRefreshed: false,
			refreshError: "TokenDance model refresh failed",
			recoveryAction: "top_up_balance",
		});
		expect(saves).toBe(1);
		expect(JSON.stringify(result)).not.toContain("secret-upstream");
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId).status).toBe("completed");
	});
	test("failed and cancelled exchanges retain snapshots without replay", async () => {
		const flow = start({ draft: { value: 1 }, baseline: {} });
		fetchMock(() => json({ message: "sensitive-code" }, 400));
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"authorization failed",
		);
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId).status).toBe("failed");
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"already consumed",
		);
		const cancelled = start({ draft: {}, baseline: {} });
		service.cancelTokenDanceOAuth(cancelled.owner, cancelled.flowId);
		expect(service.restoreTokenDanceDraft(cancelled.owner, cancelled.flowId).status).toBe(
			"cancelled",
		);
	});
	test("delete invalidates late complete and preserves owner snapshot", async () => {
		const flow = start({ draft: {}, baseline: {} });
		let resolve!: (value: Response) => void;
		fetchMock(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const pending = service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code");
		await service.deleteTokenDanceConnection();
		resolve(json({ key: "late-key-private" }));
		await expect(pending).rejects.toThrow();
		expect(service.getTokenDanceConnection().connected).toBe(false);
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toEqual({
			status: "cancelled",
			draftSnapshot: { draft: {}, baseline: {} },
		});
	});
	test("catalog filters non-conversation entries, sends attribution, and ignores late refresh", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 501 };
		fetchMock((_url, init) => {
			expect(new Headers(init?.headers).get("X-App-URL")).toBe(
				"https://tokendanceconnect.narrafork.dev/",
			);
			return json({
				data: [
					{
						id: "chat",
						name: "Chat",
						context_length: 100000,
						supported_protocols: ["openai:responses"],
					},
					{ id: "image", supported_protocols: ["image:generation"] },
				],
			});
		});
		expect((await service.refreshTokenDanceModels()).map((m) => m.id)).toEqual(["chat"]);
		let resolve!: (value: Response) => void;
		fetchMock(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const pending = service.refreshTokenDanceModels();
		await service.deleteTokenDanceConnection();
		resolve(json({ data: [{ id: "late", supported_protocols: ["openai:responses"] }] }));
		await expect(pending).rejects.toThrow();
		expect(service.getTokenDanceConnection().models).toEqual([]);
	});
	test("bounded exchange rejects huge success/error bodies", async () => {
		fetchMock(() => new Response("x".repeat(65537)));
		const flow = start();
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"request failed",
		);
		expect(saves).toBe(0);
	});
	test("expiry and restart unavailable flow are explicit", () => {
		const flow = start({ draft: {}, baseline: {} });
		Date.now = () => originalNow() + 600001;
		expect(() => service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toThrow(
			"expired or unavailable",
		);
		expect(() => service.restoreTokenDanceDraft(flow.owner, "never-existed")).toThrow(
			"expired or unavailable",
		);
	});
	test("delete cleans settings references and cancels runtime requests", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 600 };
		fakeSettings.agent.defaultModel = "tokendance:chat";
		fakeSettings.agent.hiddenModels = ["tokendance:chat", "other:chat"];
		fakeSettings.agent.modelAggregations = [
			{ id: "x", name: "X", routingMode: "priority", models: ["tokendance:chat"] },
		];
		const controller = new AbortController();
		service.registerTokenDanceRequest(controller, 600);
		await service.deleteTokenDanceConnection();
		expect(controller.signal.aborted).toBe(true);
		expect(fakeSettings.agent.defaultModel).toBe("");
		expect(fakeSettings.agent.hiddenModels).toEqual(["other:chat"]);
		expect(fakeSettings.agent.modelAggregations).toEqual([]);
	});
	test("delete clears only known model references and preserves unrelated prefix-like strings", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 700 };
		fakeSettings.agent = {
			...fakeSettings.agent,
			defaultModel: "tokendance:vendor:opaque/id",
			summaryModel: "tokendance:chat",
			translationModel: "other:translation",
			promptOptimizeModel: "tokendance:chat",
			defaultSystemPrompt: "tokendance: respond briefly",
			commandWhitelist: [{ pattern: "tokendance: command pattern", enabled: true }],
			customRetryRules: [{ id: "retry", keyword: "tokendance: retry keyword", enabled: true }],
			customModels: [
				{ value: "tokendance:chat", label: "Platform" },
				{ value: "other:chat", label: "Other" },
			],
			modelCards: [
				{ modelKey: "tokendance:chat" },
				{ modelKey: "other:chat", notes: "tokendance: keep this note" },
			],
			modelContextWindows: { "tokendance:chat": 200000, "other:chat": 100000 },
			subagentModels: { explore: "tokendance:chat", plan: "other:chat" },
			subagentAllowedModels: {
				explore: ["tokendance:chat", "other:chat"],
				plan: [],
				general: [],
				search: [],
				review: [],
			},
			hiddenModels: ["tokendance:chat", "other:chat"],
			providerOrder: ["tokendance", "other"],
			disabledProviders: ["tokendance", "other"],
			modelAggregations: [
				{
					id: "mixed",
					name: "tokendance: label",
					routingMode: "priority",
					models: ["tokendance:chat", "other:chat"],
				},
			],
		} as unknown as NarraForkSettings["agent"];
		const unrelated = structuredClone({
			prompt: fakeSettings.agent.defaultSystemPrompt,
			commands: fakeSettings.agent.commandWhitelist,
			retries: fakeSettings.agent.customRetryRules,
		});
		await service.deleteTokenDanceConnection();
		expect({
			prompt: fakeSettings.agent.defaultSystemPrompt,
			commands: fakeSettings.agent.commandWhitelist,
			retries: fakeSettings.agent.customRetryRules,
		}).toEqual(unrelated);
		expect(fakeSettings.agent.defaultModel).toBe("");
		expect(fakeSettings.agent.summaryModel).toBe("");
		expect(fakeSettings.agent.translationModel).toBe("other:translation");
		expect(fakeSettings.agent.promptOptimizeModel).toBe("");
		expect(fakeSettings.agent.customModels).toEqual([{ value: "other:chat", label: "Other" }]);
		expect(fakeSettings.agent.modelCards).toEqual([
			{ modelKey: "other:chat", notes: "tokendance: keep this note" },
		]);
		expect(fakeSettings.agent.modelContextWindows).toEqual({ "other:chat": 100000 });
		expect(fakeSettings.agent.subagentModels).toEqual({ explore: "", plan: "other:chat" });
		expect(fakeSettings.agent.subagentAllowedModels.explore).toEqual(["other:chat"]);
		expect(fakeSettings.agent.providerOrder).toEqual(["other"]);
		expect(fakeSettings.agent.disabledProviders).toEqual(["other"]);
		expect(fakeSettings.agent.modelAggregations).toEqual([
			{ id: "mixed", name: "tokendance: label", routingMode: "priority", models: ["other:chat"] },
		]);
	});
	test("persisted catalog survives runtime cache invalidation and disabled refresh", async () => {
		const catalog = [
			{
				id: "restored",
				name: "Restored",
				context_length: 100,
				supported_protocols: ["openai:responses"],
			},
		];
		fakeSettings.tokendance = {
			apiKey: "key-private",
			disabled: true,
			generation: 800,
			models: catalog,
		};
		expect(service.getTokenDanceCatalogModels()).toEqual(catalog);
		fetchMock(() => json({ data: catalog }));
		await service.refreshTokenDanceModels();
		expect(fakeSettings.tokendance.models).toEqual(catalog);
		expect(service.getTokenDanceConnection().disabled).toBe(true);
		expect((await service.setTokenDanceDisabled(false)).models).toEqual(catalog);
		expect((await service.setTokenDanceDisabled(true)).models).toEqual(catalog);
	});
	test("deep snapshots are rejected and legacy custom TokenDance drafts preserved", () => {
		let nested: Record<string, unknown> = {};
		for (let index = 0; index < 70; index++) nested = { child: nested };
		expect(() => start({ draft: nested, baseline: {} })).toThrow("too complex");
		const legacy = {
			draft: {
				customApiProviders: [{ prefix: "tokendance", apiKey: "user-unsaved-key" }],
				hiddenModels: ["tokendance:chat"],
			},
			baseline: {},
		};
		expect(service.validateTokenDanceSnapshot(legacy)).toEqual(legacy);
	});
	test("legacy prefix permits unchanged ID only until the platform is connected", () => {
		const existing = [{ id: "manual", prefix: "tokendance" }] as const;
		expect(isLegacyTokenDancePrefixAllowed(existing[0], existing, false)).toBe(true);
		expect(isLegacyTokenDancePrefixAllowed(existing[0], existing, true)).toBe(false);
		expect(
			isLegacyTokenDancePrefixAllowed({ id: "new", prefix: "tokendance" }, existing, false),
		).toBe(false);
		expect(
			isLegacyTokenDancePrefixAllowed({ id: "manual", prefix: "codex" }, existing, false),
		).toBe(false);
	});
	test("legacy prefix conflict fails before exchange without mutating existing key", () => {
		fakeSettings.customApiProviders = [
			{ prefix: "tokendance", apiKey: "old-private-key" },
		] as NarraForkSettings["customApiProviders"];
		expect(() => start()).toThrow("Rename the existing custom provider");
		expect(fakeSettings.customApiProviders?.[0]?.apiKey).toBe("old-private-key");
		fakeSettings.customApiProviders = [];
	});
	test("only strict key envelope accepted; body cannot spoof recovery action", async () => {
		const flow = start();
		fetchMock(() => json({ api_key: "must-not-accept" }));
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"authorization failed",
		);
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 900 };
		fetchMock(() => json({ recovery_action: "top_up_balance" }, 402));
		await expect(service.refreshTokenDanceModels()).rejects.toThrow("model refresh failed");
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
	});
	test("runtime recovery is generation checked and successful refresh clears it", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 901 };
		service.setTokenDanceRecoveryAction("top_up_balance", 900);
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
		service.setTokenDanceRecoveryAction("top_up_balance", 901);
		expect(service.getTokenDanceConnection().recoveryAction).toBe("top_up_balance");
		fetchMock(() => json({ data: [] }));
		await service.refreshTokenDanceModels();
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
	});
	test("new authorization cancels runtime requests from the prior generation", async () => {
		fakeSettings.tokendance = { apiKey: "old-key-private", disabled: false, generation: 902 };
		const old = new AbortController();
		service.registerTokenDanceRequest(old, 902);
		const flow = start();
		fetchMock((_url, init) =>
			init?.method === "POST" ? json({ key: "new-key-private" }) : json({ data: [] }),
		);
		await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code");
		expect(old.signal.aborted).toBe(true);
		expect(fakeSettings.tokendance.apiKey).toBe("new-key-private");
	});
	test("request timeout also bounds a stalled response reader", async () => {
		const timeout = globalThis.setTimeout;
		const originalClear = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: () => void, delay: number) =>
			delay === 30_000 ? timeout(callback, 5) : timeout(callback, delay)) as typeof setTimeout;
		try {
			fetchMock(
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('{"key":'));
							},
						}),
					),
			);
			const flow = start();
			await expect(
				service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code"),
			).rejects.toThrow("request failed");
			expect(saves).toBe(0);
		} finally {
			globalThis.setTimeout = timeout;
			globalThis.clearTimeout = originalClear;
		}
	});
	test("catalog and snapshot storage are bounded; mounted paths may contain dots", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 910 };
		fetchMock(() =>
			json({
				data: Array.from({ length: 1002 }, (_, index) => ({
					id: `model-${index}`,
					supported_protocols: ["openai:responses"],
				})),
			}),
		);
		expect((await service.refreshTokenDanceModels()).length).toBe(1000);
		expect(
			service.validateTokenDanceCallback(
				"https://ui.example/code.server/%E4%B8%AD/settings/providers/tokendance/callback",
				"https://server.example/api/x",
				"https://ui.example",
			).pathname,
		).toContain("code.server");
	});
	test("HTTPS same-authority proxy upgrade is allowed, external origins remain refused", () => {
		expect(
			service.validateTokenDanceCallback(
				"https://app.example/prefix/settings/providers/tokendance/callback",
				"http://app.example/api/start",
				"https://app.example",
			).origin,
		).toBe("https://app.example");
		expect(() =>
			service.validateTokenDanceCallback(
				"https://evil.example/settings/providers/tokendance/callback",
				"http://app.example/api/start",
				"https://evil.example",
			),
		).toThrow();
	});
	test("fixed targets explicitly reject redirect and exchange only approved fields", async () => {
		const flow = start();
		fetchMock((url, init) => {
			expect(init?.redirect).toBe("error");
			if (init?.method === "POST") {
				expect(url).toBe("https://tokendance.space/portal/api/v1/auth/keys");
				const body = JSON.parse(String(init.body));
				expect(Object.keys(body).sort()).toEqual([
					"code",
					"code_challenge_method",
					"code_verifier",
				]);
				expect(body.code_verifier.length).toBe(43);
				expect(body.code_challenge_method).toBe("S256");
				return json({ key: "key-private" });
			}
			expect(url).toBe("https://tokendance.space/gateway/v1/models");
			return json({ data: [] });
		});
		await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code");
	});
	test("model normalization retains supported protocols after unknowns and rejects unsafe IDs", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 950 };
		fetchMock(() =>
			json({
				data: [
					{
						id: "chat",
						supported_protocols: [
							...Array.from({ length: 20 }, (_, index) => `unknown-${index}`),
							"openai:responses",
						],
					},
					{ id: "chat", supported_protocols: ["openai:responses"] },
					{ id: "namespace:chat", supported_protocols: ["openai:responses"] },
					{ id: "secret", name: "key-private", supported_protocols: ["openai:responses"] },
					{
						id: Buffer.from("key-private").toString("base64"),
						supported_protocols: ["openai:responses"],
					},
				],
			}),
		);
		expect(await service.refreshTokenDanceModels()).toEqual([
			{ id: "chat", name: "chat", context_length: 0, supported_protocols: ["openai:responses"] },
			{
				id: "namespace:chat",
				name: "namespace:chat",
				context_length: 0,
				supported_protocols: ["openai:responses"],
			},
			{
				id: "secret",
				name: "key-********vate",
				context_length: 0,
				supported_protocols: ["openai:responses"],
			},
		]);
	});
	test("draft model-reference maps and ordinary custom headers are allowed", () => {
		const snapshot = {
			draft: {
				modelContextWindows: { "tokendance:vendor:opaque/id": 200000 },
				customApiProviders: [
					{ prefix: "manual", extraHeaders: { "x-tokendance-feature": "preview" } },
				],
			},
			baseline: {},
		};
		const flow = start(snapshot);
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId).draftSnapshot).toEqual(snapshot);
		expect(() =>
			start({ draft: { nested: { tokenDance: { apiKey: "injected-key" } } }, baseline: {} }),
		).toThrow();
		expect(() =>
			start({ draft: { nested: { tokenDanceApiKey: "injected-key" } }, baseline: {} }),
		).toThrow();
	});
	test("per-owner, global flow and total snapshot budgets are enforced", () => {
		let now = originalNow() + 10_000_000;
		Date.now = () => now;
		const callback = new URL("https://ui.example/settings/providers/tokendance/callback");
		try {
			for (let index = 0; index < 10; index++)
				service.startTokenDanceOAuth("limited-owner", callback);
			expect(() => service.startTokenDanceOAuth("limited-owner", callback)).toThrow("Too many");
			now += 600001;
			const memoryFlows = Array.from({ length: 9 }, () =>
				start({ draft: { text: "v".repeat(900_000) }, baseline: {} }),
			);
			expect(() => start({ draft: { text: "v".repeat(900_000) }, baseline: {} })).toThrow(
				"storage is full",
			);
			const first = memoryFlows[0];
			if (first) service.restoreTokenDanceDraft(first.owner, first.flowId);
			expect(() => start({ draft: { text: "v".repeat(900_000) }, baseline: {} })).not.toThrow();
			now += 600001;
			for (let index = 0; index < 100; index++) start();
			expect(() => start()).toThrow("Too many");
			now += 600001;
			start(); // Eager cleanup releases all expired snapshots and flows.
		} finally {
			Date.now = originalNow;
		}
	});
});
