import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import * as outbound from "../net/outbound-fetch";
import { type CustomApiProviderConfig, settings } from "../settings";

/**
 * The POST refresh route runs `requireAdmin`, which authorizes against the LIVE role read
 * through the session store, never the token's `role` claim. The middleware below only sets
 * `c.get("user")`, so this seam resolves each principal's role by actor id. The two roles
 * carry distinct subs (below) so a single test can exercise both without the lookup (or its
 * cache) colliding. Without the seam a non-admin would 401 USER_GONE instead of 403.
 */
const DEEPSEEK_ADMIN_ID = "deepseek-admin";
const DEEPSEEK_USER_ID = "deepseek-user";
const sessionStoreSeam: AuthSessionStore = {
	...authSessionStore,
	findSessionState: async (id) => ({
		id,
		role: id === DEEPSEEK_ADMIN_ID ? "admin" : "user",
		tokenVersion: 0,
	}),
};
setAuthStores({ session: sessionStoreSeam, mfa: authMfaStore });

const originalProviders = settings.customApiProviders;
const originalProxy = settings.proxy;
const body = {
	is_available: false,
	balance_infos: [
		{ currency: "CNY", total_balance: "0.00000001", granted_balance: "0", topped_up_balance: "-1" },
		{ currency: "USD", total_balance: "2.34", granted_balance: "1", topped_up_balance: "1.34" },
	],
};
const provider = (): CustomApiProviderConfig => ({
	id: "deepseek-test",
	name: "DeepSeek",
	prefix: "ds-test",
	protocol: "completions-compatible",
	defaultModel: "deepseek-chat",
	baseUrl: "https://api.deepseek.com/v1",
	apiKey: "secret-test-key",
});
let respond: () => Promise<Response> = async () => Response.json(body);
const {
	getAllDeepSeekCachedBalances,
	getDeepSeekBalanceGenerations,
	isDeepSeekCustomApiProvider,
	parseDeepSeekBalanceResponse,
	refreshAllDeepSeekBalances,
	refreshDeepSeekBalance,
	refreshStaleDeepSeekBalances,
	syncDeepSeekBalanceCache,
} = await import("../deepseek-balance-cache");
const { deepseekRoutes, redactBalancesForRole } = await import("../../routes/deepseek");

beforeEach(() => {
	settings.customApiProviders = [];
	syncDeepSeekBalanceCache();
	settings.customApiProviders = [provider()];
	settings.proxy = { mode: "direct" };
	respond = async () => Response.json(body);
	spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
});
afterEach(() => mock.restore());
afterAll(() => {
	setAuthStores(undefined);
	settings.customApiProviders = originalProviders;
	settings.proxy = originalProxy;
	syncDeepSeekBalanceCache();
});

function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const sub = role === "admin" ? DEEPSEEK_ADMIN_ID : DEEPSEEK_USER_ID;
		c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		const status = (error as { statusCode?: number }).statusCode;
		return new Response("denied", { status: status ?? 500 });
	});
	app.route("/api/deepseek", deepseekRoutes);
	return app;
}

describe("DeepSeek balances", () => {
	test("only enabled official HTTPS providers at supported paths qualify", () => {
		for (const suffix of ["", "/", "/v1", "/v1/", "/anthropic", "/anthropic/"]) {
			expect(isDeepSeekCustomApiProvider({ baseUrl: `https://api.deepseek.com${suffix}` })).toBe(
				true,
			);
		}
		for (const baseUrl of [
			"http://api.deepseek.com",
			"https://api.deepseek.com.evil.test",
			"https://evil.api.deepseek.com",
			"https://api.deepseek.com:444",
			"https://key@api.deepseek.com",
			"https://api.deepseek.com/other",
			"https://api.deepseek.com/v1?api_key=secret",
			"invalid",
		])
			expect(isDeepSeekCustomApiProvider({ baseUrl })).toBe(false);
		expect(isDeepSeekCustomApiProvider({ ...provider(), disabled: true })).toBe(false);
	});

	test("parses both currencies without rounding and preserves false availability", () => {
		const parsed = parseDeepSeekBalanceResponse(body);
		expect(parsed.isAvailable).toBe(false);
		expect(parsed.balanceInfos[0]).toEqual({
			currency: "CNY",
			totalBalance: "0.00000001",
			grantedBalance: "0",
			toppedUpBalance: "-1",
		});
		expect(parsed.balanceInfos[1]?.currency).toBe("USD");
		expect(
			parseDeepSeekBalanceResponse({ is_available: true, balance_infos: [] }).balanceInfos,
		).toEqual([]);
		for (const value of [
			null,
			{},
			{ ...body, is_available: "true" },
			{ ...body, balance_infos: [{}] },
		]) {
			expect(() => parseDeepSeekBalanceResponse(value)).toThrow();
		}
	});

	test("uses fixed endpoint, bearer, provider proxy/TLS and disallows redirects", async () => {
		settings.customApiProviders = [
			{
				...provider(),
				proxy: { mode: "custom", url: "http://localhost:1234" },
				tlsRejectUnauthorized: false,
			},
		];
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		await refreshDeepSeekBalance("deepseek-test");
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.deepseek.com/user/balance",
			expect.objectContaining({
				headers: { Authorization: "Bearer secret-test-key", Accept: "application/json" },
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
			{ proxyUrl: "http://localhost:1234", tlsRejectUnauthorized: false, retryPolicy: "never" },
		);
	});

	test("coalesces concurrent refresh and bulk/stale readers", async () => {
		const pending = deferred();
		respond = () => pending.promise;
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		const first = refreshDeepSeekBalance("deepseek-test");
		expect(refreshDeepSeekBalance("deepseek-test")).toBe(first);
		const bulk = refreshAllDeepSeekBalances();
		const stale = refreshStaleDeepSeekBalances();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		pending.resolve(Response.json(body));
		await Promise.all([first, bulk, stale]);
		await refreshStaleDeepSeekBalances();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	test("60s SWR and failed retries preserve stale balances but throttle errors", async () => {
		let now = 100_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		await refreshDeepSeekBalance("deepseek-test");
		now += 59_999;
		await refreshStaleDeepSeekBalances();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		now++;
		respond = async () => {
			throw new Error("secret-test-key upstream private error");
		};
		await refreshStaleDeepSeekBalances();
		const cache = getAllDeepSeekCachedBalances()["deepseek-test"];
		expect(cache?.balanceInfos).toHaveLength(2);
		expect(cache?.error).toBe("DeepSeek balance request failed");
		expect(cache?.fetchedAt).toBe(now);
		await refreshStaleDeepSeekBalances();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	for (const change of [
		"apiKey",
		"baseUrl",
		"protocol",
		"disabled",
		"proxy",
		"tls",
		"globalProxy",
		"remove",
	] as const) {
		test(`${change} invalidates cache and rejects a late old request`, async () => {
			const pending = deferred();
			respond = () => pending.promise;
			const first = refreshDeepSeekBalance("deepseek-test");
			const oldGeneration = getDeepSeekBalanceGenerations()["deepseek-test"];
			const config = settings.customApiProviders?.[0];
			if (!config) throw new Error("missing fixture");
			if (change === "apiKey") config.apiKey = "new-account";
			if (change === "baseUrl") config.baseUrl = "https://api.deepseek.com/anthropic";
			if (change === "protocol") config.protocol = "anthropic-messages";
			if (change === "disabled") config.disabled = true;
			if (change === "proxy") config.proxy = { mode: "direct" };
			if (change === "tls") config.tlsRejectUnauthorized = false;
			if (change === "globalProxy")
				settings.proxy = { mode: "custom", url: "http://localhost:4321" };
			if (change === "remove") settings.customApiProviders = [];
			const current = getAllDeepSeekCachedBalances();
			expect(getDeepSeekBalanceGenerations()["deepseek-test"]).not.toBe(oldGeneration);
			expect(current["deepseek-test"]?.generation).toBe(
				getDeepSeekBalanceGenerations()["deepseek-test"],
			);
			expect(current["deepseek-test"]?.balanceInfos ?? []).toEqual([]);
			pending.resolve(Response.json(body));
			expect(await first).toBeNull();
			expect(getAllDeepSeekCachedBalances()["deepseek-test"]?.balanceInfos ?? []).toEqual([]);
		});
	}

	test("random generations are stable across reads, refreshes and unrelated edits, not restored by key reuse", async () => {
		const original = getDeepSeekBalanceGenerations()["deepseek-test"];
		expect(original).toMatch(/^[\da-f-]{36}$/);
		await refreshDeepSeekBalance("deepseek-test");
		settings.customApiProviders = [{ ...provider(), name: "Renamed" }];
		expect(getDeepSeekBalanceGenerations()["deepseek-test"]).toBe(original);
		settings.customApiProviders = [{ ...provider(), apiKey: "second-account" }];
		const second = getDeepSeekBalanceGenerations()["deepseek-test"];
		expect(second).not.toBe(original);
		settings.customApiProviders = [provider()];
		const third = getDeepSeekBalanceGenerations()["deepseek-test"];
		expect(third).not.toBe(original);
		expect(third).not.toBe(second);
		expect(JSON.stringify(getDeepSeekBalanceGenerations())).not.toContain(provider().apiKey);
	});

	test("completed balances disappear on credential changes, disable and removal", async () => {
		await refreshDeepSeekBalance("deepseek-test");
		expect(getAllDeepSeekCachedBalances()["deepseek-test"]?.balanceInfos).toHaveLength(2);
		settings.customApiProviders = [{ ...provider(), apiKey: "other-account" }];
		expect(getAllDeepSeekCachedBalances()["deepseek-test"]?.balanceInfos).toEqual([]);
		await refreshDeepSeekBalance("deepseek-test");
		settings.customApiProviders = [{ ...provider(), disabled: true }];
		expect(getAllDeepSeekCachedBalances()).toEqual({});
		settings.customApiProviders = [];
		expect(await refreshDeepSeekBalance("deepseek-test")).toBeNull();
	});

	test("settings projects the same opaque generations for users and admins without persisting them", async () => {
		const { settingsRoutes } = await import("../../routes/settings");
		for (const role of ["user", "admin"] as const) {
			const app = appForRole(role);
			app.route("/api/settings", settingsRoutes);
			const response = await app.request("/api/settings");
			expect(response.status).toBe(200);
			const projection = await response.json();
			expect(projection.deepseekBalanceGenerations).toEqual(getDeepSeekBalanceGenerations());
			expect(projection.customApiProviders[0].apiKey).not.toBe(provider().apiKey);
		}
		expect(settings).not.toHaveProperty("deepseekBalanceGenerations");
		expect(settings.customApiProviders?.[0]).not.toHaveProperty("generation");
	});

	test("cold GET returns a loading snapshot without waiting on upstream", async () => {
		const pending = deferred();
		respond = () => pending.promise;
		const response = await appForRole("user").request("/api/deepseek/balances");
		expect((await response.json())["deepseek-test"]).toEqual({
			isAvailable: null,
			balanceInfos: [],
			fetchedAt: 0,
			hasError: false,
			generation: getDeepSeekBalanceGenerations()["deepseek-test"],
		});
		pending.resolve(Response.json(body));
		await refreshAllDeepSeekBalances();
	});

	test("missing credentials and nonofficial providers never trigger transport", async () => {
		settings.customApiProviders = [
			{ ...provider(), apiKey: "" },
			{ ...provider(), id: "third-party", baseUrl: "https://example.com" },
		];
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(async () => respond());
		await refreshAllDeepSeekBalances();
		expect(getAllDeepSeekCachedBalances()).toEqual({});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("an old finalizer cannot clear the replacement request's inflight slot", async () => {
		const old = deferred();
		respond = () => old.promise;
		const first = refreshDeepSeekBalance("deepseek-test");
		settings.customApiProviders = [{ ...provider(), apiKey: "new" }];
		const current = deferred();
		respond = () => current.promise;
		const second = refreshDeepSeekBalance("deepseek-test");
		old.resolve(Response.json(body));
		await first;
		expect(refreshDeepSeekBalance("deepseek-test")).toBe(second);
		current.resolve(Response.json({ is_available: true, balance_infos: [] }));
		expect((await second)?.isAvailable).toBe(true);
	});

	test("bounds declared and streamed response size and rejects malformed/upstream errors safely", async () => {
		for (const response of [
			new Response("private secret-test-key", { status: 401 }),
			new Response("private secret-test-key"),
			new Response("{}", { headers: { "content-length": "65537" } }),
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array(65537));
						c.close();
					},
				}),
			),
		]) {
			respond = async () => response;
			const cache = await refreshDeepSeekBalance("deepseek-test");
			expect(cache?.error).toBe("DeepSeek balance request failed");
			expect(JSON.stringify(cache)).not.toContain("secret-test-key");
		}
	});

	test("15s deadline covers both transport and a stalled response body", async () => {
		const originalTimeout = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms: number,
		) => originalTimeout(callback, ms === 15_000 ? 5 : ms)) as typeof setTimeout);
		respond = () => new Promise(() => {});
		expect((await refreshDeepSeekBalance("deepseek-test"))?.error).not.toBeNull();
		let cancelled = false;
		respond = async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			);
		expect((await refreshDeepSeekBalance("deepseek-test"))?.error).not.toBeNull();
		expect(cancelled).toBe(true);
		expect(timer.mock.calls.some(([, ms]) => ms === 15_000)).toBe(true);
	});

	test("GET is nonblocking SWR, redacts user errors, and POST is admin-only", async () => {
		respond = async () => {
			throw new Error("secret-test-key");
		};
		await refreshDeepSeekBalance("deepseek-test");
		const user = appForRole("user");
		const response = await user.request("/api/deepseek/balances");
		const data = await response.json();
		expect(response.status).toBe(200);
		expect(data["deepseek-test"].hasError).toBe(true);
		expect(data["deepseek-test"].error).toBeUndefined();
		expect((await user.request("/api/deepseek/balances/refresh", { method: "POST" })).status).toBe(
			403,
		);
		const admin = appForRole("admin");
		expect(
			(await (await admin.request("/api/deepseek/balances")).json())["deepseek-test"].error,
		).toBe("DeepSeek balance request failed");
		const pending = deferred();
		respond = () => pending.promise;
		expect((await admin.request("/api/deepseek/balances/refresh", { method: "POST" })).status).toBe(
			200,
		);
		pending.resolve(Response.json(body));
		await refreshAllDeepSeekBalances();
		expect(
			redactBalancesForRole(getAllDeepSeekCachedBalances(), false)["deepseek-test"],
		).toHaveProperty("hasError", false);
	});
});
