import { describe, expect, mock, test } from "bun:test";
import { BalanceProbeRequestError } from "../provider-balance-adapters";
import { isProviderBalanceCandidate, ProviderBalanceCache } from "../provider-balance-cache";
import type { CustomApiProviderConfig } from "../settings";

function provider(id = "relay-test"): CustomApiProviderConfig {
	return {
		id,
		name: "Relay",
		prefix: id,
		baseUrl: "https://relay.example/v1",
		apiKey: "secret-current-key",
		protocol: "completions-compatible",
		defaultModel: "model",
	};
}
const wallet = (balance = 12) => ({ mode: "unrestricted", isValid: true, balance, unit: "USD" });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture() {
	let providers = [provider()];
	let globalProxy: unknown = { mode: "direct" };
	let now = 100_000;
	let respond = async (_url: string) => Response.json(wallet());
	const fetch = mock(async (input: RequestInfo | URL) => respond(String(input)));
	const cache = new ProviderBalanceCache({
		providers: () => providers,
		globalProxy: () => globalProxy,
		fetch,
		now: () => now,
	});
	return {
		cache,
		fetch,
		setProviders: (value: CustomApiProviderConfig[]) => {
			providers = value;
		},
		setProxy: (value: unknown) => {
			globalProxy = value;
		},
		advance: (delta: number) => {
			now += delta;
		},
		respond: (value: typeof respond) => {
			respond = value;
		},
	};
}

describe("provider balance discovery lifecycle", () => {
	test("excludes disabled, empty and already dedicated balance sources", () => {
		for (const baseUrl of [
			"https://api.deepseek.com/v1",
			"https://api.kimi.com/coding/v1",
			"https://opencode.ai/zen/go/v1",
		])
			expect(isProviderBalanceCandidate({ ...provider(), baseUrl })).toBe(false);
		expect(isProviderBalanceCandidate({ ...provider(), disabled: true })).toBe(false);
		expect(isProviderBalanceCandidate({ ...provider(), apiKey: "" })).toBe(false);
		expect(isProviderBalanceCandidate(provider())).toBe(true);
	});

	test("a successful discovery is coalesced and reads use only the detected endpoint", async () => {
		const f = fixture();
		const pending = deferred<Response>();
		f.respond(() => pending.promise);
		const generation = f.cache.generations()["relay-test"];
		const first = f.cache.request("relay-test");
		expect(f.cache.request("relay-test")).toBe(first);
		expect(f.cache.read()["relay-test"]?.status).toBe("probing");
		expect(f.fetch).toHaveBeenCalledTimes(1);
		pending.resolve(Response.json(wallet(0)));
		const result = await first;
		expect(result).toMatchObject({ status: "supported", generation, adapter: "sub2api" });
		expect(result?.balance?.amounts[0]?.remaining).toBe(0);
		f.cache.read();
		f.cache.discoverPending();
		expect(f.fetch).toHaveBeenCalledTimes(1);
		f.advance(60_000);
		f.respond(async () => Response.json(wallet(-2)));
		f.cache.read();
		await f.cache.request("relay-test", "refresh");
		expect(f.fetch.mock.calls.map(([url]) => String(url))).toEqual([
			"https://relay.example/v1/usage",
			"https://relay.example/v1/usage",
		]);
		expect(f.cache.peek("relay-test")?.balance?.amounts[0]?.remaining).toBe(-2);
	});

	test("unsupported is discovered once, not on reads, and explicit probe is throttled", async () => {
		const f = fixture();
		f.respond(async () => new Response("not found", { status: 404 }));
		await f.cache.request("relay-test");
		const calls = f.fetch.mock.calls.length;
		expect(calls).toBeLessThanOrEqual(4);
		expect(f.cache.peek("relay-test")?.status).toBe("unsupported");
		f.advance(3_600_000);
		for (let i = 0; i < 5; i++) {
			f.cache.read();
			f.cache.discoverPending();
		}
		expect(f.fetch).toHaveBeenCalledTimes(calls);
		f.respond(async () => Response.json(wallet()));
		await f.cache.request("relay-test");
		expect(f.cache.peek("relay-test")?.status).toBe("supported");
		await f.cache.request("relay-test");
		expect(f.fetch).toHaveBeenCalledTimes(calls + 1);
	});

	test("subscription metadata stays with its generation, not a new key or wallet mode", async () => {
		const f = fixture();
		f.respond(async () =>
			Response.json({
				mode: "unrestricted",
				isValid: true,
				unit: "USD",
				planName: "Pro subscription",
				subscription: {
					weekly_limit_usd: 50,
					weekly_usage_usd: 4,
					weekly_window_start: "2026-10-19T00:00:00Z",
					expires_at: "2026-11-19T00:00:00Z",
				},
			}),
		);
		await f.cache.request("relay-test");
		const first = f.cache.peek("relay-test");
		expect(first?.balance).toMatchObject({
			scope: "subscription",
			planName: "Pro subscription",
			expiresAt: "2026-11-19T00:00:00.000Z",
		});
		f.advance(60_000);
		f.respond(async () => new Response(null, { status: 503 }));
		await f.cache.request("relay-test", "refresh");
		expect(f.cache.peek("relay-test")).toMatchObject({
			status: "supported",
			error: "request_failed",
			balance: first?.balance,
		});
		f.setProviders([{ ...provider(), apiKey: "another-account" }]);
		expect(f.cache.peek("relay-test")?.generation).not.toBe(first?.generation);
		expect(f.cache.peek("relay-test")?.balance).toBeNull();
		f.respond(async () => Response.json(wallet()));
		await f.cache.request("relay-test");
		const next = f.cache.peek("relay-test")?.balance;
		expect(next?.scope).toBe("wallet");
		expect(next).not.toHaveProperty("planName");
		expect(next).not.toHaveProperty("expiresAt");
	});

	test("transient discovery failures are safe and do not poll automatically", async () => {
		const f = fixture();
		f.respond(async () => {
			throw new Error("secret-current-key private upstream body");
		});
		await f.cache.request("relay-test");
		expect(f.cache.peek("relay-test")).toMatchObject({
			status: "error",
			error: "request_failed",
			balance: null,
		});
		const calls = f.fetch.mock.calls.length;
		f.advance(100_000);
		f.cache.read();
		expect(f.fetch).toHaveBeenCalledTimes(calls);
		expect(JSON.stringify(f.cache.read())).not.toMatch(/secret-current-key|private upstream/);
	});

	test("failed refresh retains last success and throttles retry by attempt, not success", async () => {
		const f = fixture();
		await f.cache.request("relay-test");
		const before = f.cache.peek("relay-test");
		f.advance(60_000);
		f.respond(async () => new Response("private", { status: 500 }));
		await f.cache.request("relay-test", "refresh");
		const failed = f.cache.peek("relay-test");
		expect(failed).toMatchObject({
			status: "supported",
			error: "request_failed",
			fetchedAt: before?.fetchedAt,
			balance: before?.balance,
		});
		f.cache.read();
		f.advance(59_999);
		f.cache.read();
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});

	for (const change of [
		"apiKey",
		"baseUrl",
		"protocol",
		"proxy",
		"tls",
		"headers",
		"globalProxy",
		"disable",
		"remove",
	] as const) {
		test(`${change} replaces generation and rejects late old-account data`, async () => {
			const f = fixture();
			const pending = deferred<Response>();
			f.respond(() => pending.promise);
			const original = f.cache.generations()["relay-test"];
			const first = f.cache.request("relay-test");
			const next = provider();
			if (change === "apiKey") next.apiKey = "other-secret";
			if (change === "baseUrl") next.baseUrl = "https://other.example/v1";
			if (change === "protocol") next.protocol = "anthropic-messages";
			if (change === "proxy") next.proxy = { mode: "direct" };
			if (change === "tls") next.tlsRejectUnauthorized = false;
			if (change === "headers") next.extraHeaders = { "X-Token": "another-credential" };
			if (change === "globalProxy") f.setProxy({ mode: "system" });
			if (change === "disable") next.disabled = true;
			f.setProviders(change === "remove" ? [] : [next]);
			expect(f.cache.generations()["relay-test"]).not.toBe(original);
			pending.resolve(Response.json(wallet(999)));
			expect(await first).toBeNull();
			expect(f.cache.peek("relay-test")?.balance ?? null).toBeNull();
		});
	}

	test("name, prefix, model edits and header ordering keep generation and discovery result", async () => {
		const f = fixture();
		f.setProviders([{ ...provider(), extraHeaders: { a: "1", b: "2" } }]);
		await f.cache.request("relay-test");
		const generation = f.cache.generations()["relay-test"];
		f.setProviders([
			{
				...provider(),
				name: "renamed",
				prefix: "new-prefix",
				defaultModel: "other",
				extraHeaders: { b: "2", a: "1" },
			},
		]);
		f.cache.discoverPending();
		expect(f.cache.generations()["relay-test"]).toBe(generation);
		expect(f.fetch).toHaveBeenCalledTimes(1);
		f.setProviders([]);
		f.cache.sync();
		f.setProviders([provider()]);
		expect(f.cache.generations()["relay-test"]).not.toBe(generation);
	});

	test("a selected active provider never refreshes another supported provider", async () => {
		const f = fixture();
		f.setProviders([provider(), provider("other")]);
		f.cache.discoverPending();
		await Promise.all([f.cache.request("relay-test"), f.cache.request("other")]);
		expect(f.fetch).toHaveBeenCalledTimes(2);
		f.advance(60_000);
		expect(Object.keys(f.cache.read("relay-test"))).toEqual(["relay-test"]);
		await f.cache.request("relay-test", "refresh");
		expect(f.fetch).toHaveBeenCalledTimes(3);
		expect(f.cache.peek("other")?.attemptedAt).toBe(100_000);
	});

	test("invalid URLs never send keys and snapshot has no credential-derived identity", async () => {
		const f = fixture();
		f.setProviders([
			{ ...provider(), baseUrl: "https://user:password@relay.example/v1?key=secret" },
		]);
		f.cache.discoverPending();
		await f.cache.request("relay-test");
		expect(f.cache.peek("relay-test")).toMatchObject({
			status: "error",
			error: "invalid_configuration",
		});
		expect(f.fetch).not.toHaveBeenCalled();
		expect(JSON.stringify(f.cache.read())).not.toMatch(/password|secret|relay\.example/);
	});

	test("only four active probes and bounded backlog eventually discovers every entry", async () => {
		const pending = deferred<Response>();
		const providers = Array.from({ length: 12 }, (_, i) => provider(`relay-${i}`));
		let active = 0;
		let maxActive = 0;
		const fetch = mock(async () => {
			active++;
			maxActive = Math.max(active, maxActive);
			const response = await pending.promise;
			active--;
			return response.clone();
		});
		const cache = new ProviderBalanceCache({
			providers: () => providers,
			globalProxy: () => undefined,
			fetch,
			maxQueued: 2,
		});
		cache.discoverPending();
		expect(fetch).toHaveBeenCalledTimes(4);
		pending.resolve(Response.json(wallet()));
		// Await every originally scheduled job; refill also progresses entries outside the backlog.
		await Promise.all(providers.map((p) => cache.request(p.id)));
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(maxActive).toBe(4);
		expect(fetch).toHaveBeenCalledTimes(12);
		expect(Object.values(cache.read()).every((s) => s.status === "supported")).toBe(true);
	});

	test("optional metadata hitting the round deadline keeps confirmed raw new-api quota", async () => {
		const fetch = mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/status")) return new Promise<Response>(() => {});
			if (url.endsWith("/v1/usage")) return new Response(null, { status: 404 });
			return Response.json({
				code: true,
				data: {
					object: "token_usage",
					total_available: 500,
					total_used: 100,
					total_granted: 600,
					unlimited_quota: false,
				},
			});
		});
		const cache = new ProviderBalanceCache({
			providers: () => [provider()],
			globalProxy: () => undefined,
			fetch,
			requestTimeoutMs: 100,
			roundTimeoutMs: 10,
		});
		const result = await cache.request("relay-test");
		expect(result).toMatchObject({ status: "supported", adapter: "new-api", error: null });
		expect(result?.balance?.amounts[0]).toMatchObject({ unit: "QUOTA", remaining: 500 });
	});

	test("request and whole-round timeouts release slots even when transport ignores abort", async () => {
		const fetch = mock(async () => new Promise<Response>(() => {}));
		const cache = new ProviderBalanceCache({
			providers: () => [provider()],
			globalProxy: () => undefined,
			fetch,
			requestTimeoutMs: 5,
			roundTimeoutMs: 10,
		});
		const result = await cache.request("relay-test");
		expect(result).toMatchObject({ status: "error", error: "request_failed" });
		expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
	});
});

describe("site-account credit failures", () => {
	// The base URL keeps /v1 (Codex-style preset), so the site root must be separate.
	const siteProvider = (): CustomApiProviderConfig => ({
		...provider(),
		baseUrl: "https://relay.example/v1",
		quotaSiteUrl: "https://relay.example",
		quotaAccessToken: "site-token",
		quotaUserId: "42",
	});
	const siteBody = {
		success: true,
		data: { quota: 5_000_000, used_quota: 1_000_000, group: "vip" },
	};

	function siteFixture() {
		let providers = [siteProvider()];
		let now = 100_000;
		let respond: (url: string) => Promise<Response> = async () => Response.json(siteBody);
		const fetch = mock(async (input: RequestInfo | URL) => respond(String(input)));
		const persistence = {
			restore: mock(() => undefined as never),
			save: mock(() => {}),
			remove: mock(() => {}),
			flush: mock(async () => {}),
		};
		const cache = new ProviderBalanceCache({
			providers: () => providers,
			globalProxy: () => undefined,
			fetch,
			now: () => now,
			persistence,
		});
		return {
			cache,
			fetch,
			persistence,
			advance: (delta: number) => {
				now += delta;
			},
			respond: (value: typeof respond) => {
				respond = value;
			},
			setProviders: (value: CustomApiProviderConfig[]) => {
				providers = value;
			},
		};
	}

	test("probes /api/user/self on the site root and reports USD credit", async () => {
		const f = siteFixture();
		const requested: string[] = [];
		f.respond(async (url) => {
			requested.push(url);
			return Response.json(siteBody);
		});
		const snapshot = await f.cache.request("relay-test");
		expect(requested).toEqual(["https://relay.example/api/user/self"]);
		expect(snapshot).toMatchObject({ status: "supported", adapter: "new-api-user" });
		expect(snapshot?.balance).toMatchObject({
			scope: "wallet",
			planName: "vip",
			amounts: [{ unit: "USD", remaining: 10, used: 2, total: 12 }],
		});
	});

	test("a transient failure keeps the last good value inside the 10 minute window", async () => {
		const f = siteFixture();
		const fresh = await f.cache.request("relay-test");
		f.advance(60_000);
		f.respond(async () => new Response(null, { status: 503 }));
		const failed = await f.cache.request("relay-test", "refresh");
		expect(failed).toMatchObject({
			status: "supported",
			error: "request_failed",
			balance: fresh?.balance,
			fetchedAt: fresh?.fetchedAt,
		});
	});

	test("the last good value is withdrawn once the window closes", async () => {
		const f = siteFixture();
		await f.cache.request("relay-test");
		f.advance(10 * 60_000 + 1);
		f.respond(async () => new Response(null, { status: 500 }));
		const failed = await f.cache.request("relay-test", "refresh");
		expect(failed).toMatchObject({ status: "error", error: "request_failed", balance: null });
	});

	test("a rejected token clears the value instead of retrying it", async () => {
		const f = siteFixture();
		await f.cache.request("relay-test");
		f.advance(60_000);
		f.respond(async () => new Response(null, { status: 401 }));
		const failed = await f.cache.request("relay-test", "refresh");
		expect(failed).toMatchObject({ status: "error", error: "auth_failed", balance: null });
		// The persisted copy must go too, or a restart would restore retired credit.
		expect(f.persistence.remove).toHaveBeenCalledWith("relay-test");
		// Deterministic failures are not polled again without a manual rediscovery.
		const calls = f.fetch.mock.calls.length;
		f.advance(120_000);
		f.cache.read();
		expect(f.fetch).toHaveBeenCalledTimes(calls);
	});

	test("an unparsable answer is deterministic, not a network blip", async () => {
		const f = siteFixture();
		await f.cache.request("relay-test");
		f.advance(60_000);
		f.respond(async () => Response.json({ success: true, data: { nothing: 1 } }));
		const failed = await f.cache.request("relay-test", "refresh");
		expect(failed).toMatchObject({ status: "error", error: "invalid_response", balance: null });
	});

	test("a half-filled site configuration reports invalid_configuration immediately", async () => {
		const f = siteFixture();
		f.setProviders([{ ...siteProvider(), quotaUserId: "" }]);
		const snapshot = await f.cache.request("relay-test");
		expect(snapshot).toMatchObject({ status: "error", error: "invalid_configuration" });
		expect(f.fetch).not.toHaveBeenCalled();
	});

	test("rotating the access token discards the previous account's value", async () => {
		const f = siteFixture();
		const before = await f.cache.request("relay-test");
		f.setProviders([{ ...siteProvider(), quotaAccessToken: "rotated-token" }]);
		const after = f.cache.peek("relay-test");
		expect(after?.generation).not.toBe(before?.generation);
		expect(after?.balance).toBeNull();
	});
});

describe("capability plugin gating", () => {
	/**
	 * The plugin owns quota querying, so a disabled plugin has to be observable: the snapshot
	 * reports `plugin_not_enabled` and the previously cached allowance is dropped, exactly like
	 * any other deterministic failure.
	 */
	function gatedFixture() {
		let enabled = false;
		let now = 100_000;
		let engineCalls = 0;
		const persistence = {
			restore: mock(() => undefined as never),
			save: mock(() => {}),
			remove: mock(() => {}),
			flush: mock(async () => {}),
		};
		const cache = new ProviderBalanceCache({
			providers: () => [provider()],
			globalProxy: () => undefined,
			now: () => now,
			persistence,
			engine: () => ({
				id: "test-connector",
				probe: async () => {
					engineCalls++;
					if (!enabled) throw new BalanceProbeRequestError("plugin_disabled");
					return {
						adapter: "sub2api",
						root: "https://relay.example",
						balance: {
							scope: "wallet",
							unlimited: false,
							amounts: [{ unit: "USD", remaining: 7 }],
						},
					};
				},
				refresh: async () => {
					engineCalls++;
					if (!enabled) throw new BalanceProbeRequestError("plugin_disabled");
					return { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 7 }] };
				},
			}),
		});
		return {
			cache,
			persistence,
			engineCalls: () => engineCalls,
			setEnabled: (value: boolean) => {
				enabled = value;
			},
			advance: (delta: number) => {
				now += delta;
			},
		};
	}

	test("a disabled plugin is reported instead of being answered by the bundled adapters", async () => {
		const f = gatedFixture();

		const snapshot = await f.cache.request("relay-test");

		expect(snapshot).toMatchObject({ status: "error", error: "plugin_not_enabled", balance: null });
		// Deterministic: no value may survive behind the disabled state.
		expect(f.persistence.remove).toHaveBeenCalledWith("relay-test");
	});

	test("a value cached while enabled is withdrawn once the plugin is disabled", async () => {
		const f = gatedFixture();
		f.setEnabled(true);
		await f.cache.request("relay-test");
		expect(f.cache.peek("relay-test")).toMatchObject({ status: "supported" });

		f.setEnabled(false);
		f.advance(60_000);
		await f.cache.request("relay-test", "refresh");

		expect(f.cache.peek("relay-test")).toMatchObject({
			status: "error",
			error: "plugin_not_enabled",
			balance: null,
		});
	});

	test("re-enabling the plugin restores the value on the next read", async () => {
		const f = gatedFixture();
		await f.cache.request("relay-test");
		expect(f.cache.peek("relay-test")?.error).toBe("plugin_not_enabled");

		f.setEnabled(true);
		// Inside the stale window reads are served from the snapshot without touching the
		// engine; the recovery attempt happens on the first read past it.
		f.cache.read("relay-test");
		expect(f.engineCalls()).toBe(1);
		f.advance(60_000);
		f.cache.read("relay-test");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		expect(f.cache.peek("relay-test")).toMatchObject({
			status: "supported",
			error: null,
		});
		expect(f.cache.peek("relay-test")?.balance?.amounts[0]?.remaining).toBe(7);
	});
});
