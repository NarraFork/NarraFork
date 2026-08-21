/**
 * The Kimi usage REFRESH layer: dedup, staleness, and failure handling.
 *
 * Split from kimi-usage-cache.test.ts because this file has to mock the outbound
 * transport and the settings singleton, while that one covers pure parsing.
 *
 * ── The bug this exists for ──────────────────────────────────────────────────
 *
 * Staleness is judged by `fetchedAt`, which is only written once a fetch RESOLVES.
 * Nothing marked a refresh as in progress, so every request arriving during one saw
 * the same stale (or absent) entry and started its own upstream call. The first page
 * load has no cache at all, the frontend polls every 60s, and a NarratorPanel can be
 * mounted several times over (workspace / dock) across several tabs and users — so
 * "one refresh per stale window" quietly became "one per reader per interval"
 * against a third party's API. Nothing failed, nothing logged: the numbers were
 * correct, there were just N times too many requests behind them.
 *
 * Everything here was previously untested (the 12 existing cases are all pure
 * parsing), which is precisely why that defect shipped.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const actualSettingsModule = { ...(await import("../../../server/lib/settings")) };
const actualOutboundModule = { ...(await import("../../../server/lib/net/outbound-fetch")) };

/** Mutable settings the module under test reads through the singleton. */
const settingsState = {
	customApiProviders: [
		{ id: "kimi-1", name: "Kimi", baseUrl: "https://api.kimi.com", apiKey: "sk-test", prefix: "k" },
	],
} as unknown as typeof actualSettingsModule.settings;

/** One upstream call: how many happened, and how each resolves. */
let fetchCalls = 0;
let pendingResolvers: Array<(body: unknown) => void> = [];
let pendingRejecters: Array<(err: Error) => void> = [];
/** When false, a call resolves immediately instead of waiting for the test. */
let holdFetches = false;
let nextBody: unknown = { usage: { limit: 100, used: 10 } };
let nextError: Error | null = null;

function fakeOutboundFetch(): Promise<Response> {
	fetchCalls++;
	const settle = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	if (!holdFetches) {
		if (nextError) return Promise.reject(nextError);
		return Promise.resolve(settle(nextBody));
	}
	return new Promise<Response>((resolve, reject) => {
		pendingResolvers.push((body) => resolve(settle(body)));
		pendingRejecters.push(reject);
	});
}

mock.module("../../../server/lib/settings", () => ({
	...actualSettingsModule,
	settings: settingsState,
	saveSettings: () => {},
}));
mock.module("../../../server/lib/net/outbound-fetch", () => ({
	...actualOutboundModule,
	outboundFetch: fakeOutboundFetch,
}));

const {
	getKimiCachedUsage,
	purgeKimiUsageCache,
	refreshAllKimiUsages,
	refreshKimiUsage,
	refreshStaleKimiUsages,
} = await import("../../../server/lib/kimi-usage-cache");

/** Let queued microtasks drain so an in-flight promise can settle. */
async function drain() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
	fetchCalls = 0;
	pendingResolvers = [];
	pendingRejecters = [];
	holdFetches = false;
	nextBody = { usage: { limit: 100, used: 10 } };
	nextError = null;
	purgeKimiUsageCache(["kimi-1"]);
});

afterAll(() => {
	mock.module("../../../server/lib/settings", () => actualSettingsModule);
	mock.module("../../../server/lib/net/outbound-fetch", () => actualOutboundModule);
	mock.restore();
});

describe("refreshKimiUsage — one upstream call per provider at a time", () => {
	test("concurrent callers share ONE request and all see its result", async () => {
		holdFetches = true;
		const a = refreshKimiUsage("kimi-1");
		const b = refreshKimiUsage("kimi-1");
		const c = refreshKimiUsage("kimi-1");
		// THE regression: this was 3 before the in-flight map.
		expect(fetchCalls).toBe(1);

		pendingResolvers[0]?.({ usage: { limit: 100, used: 42 } });
		const [ra, rb, rc] = await Promise.all([a, b, c]);
		expect(ra?.weekly?.used).toBe(42);
		// Not just equal values — the same resolved cache entry.
		expect(rb).toEqual(ra);
		expect(rc).toEqual(ra);
	});

	test("a later call after settling starts a NEW request", async () => {
		await refreshKimiUsage("kimi-1");
		expect(fetchCalls).toBe(1);
		await refreshKimiUsage("kimi-1");
		// The slot must be released on completion, not held for the process lifetime.
		expect(fetchCalls).toBe(2);
	});

	test("a FAILED refresh releases the slot instead of wedging it shut", async () => {
		// Cleared in `finally`, so a rejection cannot block every later attempt —
		// which would have frozen the quota display until a restart.
		nextError = new Error("upstream down");
		await refreshKimiUsage("kimi-1");
		expect(fetchCalls).toBe(1);
		nextError = null;
		const second = await refreshKimiUsage("kimi-1");
		expect(fetchCalls).toBe(2);
		expect(second?.error).toBeNull();
	});

	test("refreshAllKimiUsages collapses onto an in-flight single refresh", async () => {
		holdFetches = true;
		const single = refreshKimiUsage("kimi-1");
		const all = refreshAllKimiUsages();
		expect(fetchCalls).toBe(1);
		pendingResolvers[0]?.({ usage: { limit: 100, used: 7 } });
		await Promise.all([single, all]);
		expect(fetchCalls).toBe(1);
	});

	test("ignores a provider that is not a Kimi host", async () => {
		settingsState.customApiProviders = [
			{ id: "other", name: "X", baseUrl: "https://example.com", apiKey: "k" },
		] as typeof settingsState.customApiProviders;
		expect(await refreshKimiUsage("other")).toBeNull();
		expect(fetchCalls).toBe(0);
		settingsState.customApiProviders = [
			{ id: "kimi-1", name: "Kimi", baseUrl: "https://api.kimi.com", apiKey: "sk-test" },
		] as typeof settingsState.customApiProviders;
	});

	test("ignores a Kimi provider with no api key", async () => {
		settingsState.customApiProviders = [
			{ id: "kimi-1", name: "Kimi", baseUrl: "https://api.kimi.com", apiKey: "" },
		] as typeof settingsState.customApiProviders;
		expect(await refreshKimiUsage("kimi-1")).toBeNull();
		expect(fetchCalls).toBe(0);
		settingsState.customApiProviders = [
			{ id: "kimi-1", name: "Kimi", baseUrl: "https://api.kimi.com", apiKey: "sk-test" },
		] as typeof settingsState.customApiProviders;
	});
});

describe("refreshKimiUsage — a failure keeps the last good numbers visible", () => {
	test("stale windows survive; only `error` advances", async () => {
		nextBody = { usage: { limit: 100, used: 55 } };
		await refreshKimiUsage("kimi-1");
		expect(getKimiCachedUsage("kimi-1")?.weekly?.used).toBe(55);

		nextError = new Error("HTTP 502");
		await refreshKimiUsage("kimi-1");
		const cached = getKimiCachedUsage("kimi-1");
		// The reader keeps seeing the last known quota rather than an empty card…
		expect(cached?.weekly?.used).toBe(55);
		// …plus the reason it is not advancing.
		expect(cached?.error).toBe("HTTP 502");
	});

	test("an HTTP error message carries the status only, never the request", async () => {
		// The cache is served to clients, so the error string must not become a channel
		// for the URL or credentials.
		holdFetches = false;
		nextError = null;
		mock.module("../../../server/lib/net/outbound-fetch", () => ({
			...actualOutboundModule,
			outboundFetch: () => Promise.resolve(new Response("nope", { status: 403 })),
		}));
		const { refreshKimiUsage: freshRefresh } = await import("../../../server/lib/kimi-usage-cache");
		await freshRefresh("kimi-1");
		const message = getKimiCachedUsage("kimi-1")?.error ?? "";
		expect(message).toContain("403");
		expect(message).not.toContain("sk-test");
		expect(message).not.toContain("api.kimi.com");
		mock.module("../../../server/lib/net/outbound-fetch", () => ({
			...actualOutboundModule,
			outboundFetch: fakeOutboundFetch,
		}));
	});
});

describe("refreshStaleKimiUsages", () => {
	test("skips a provider refreshed within the window", async () => {
		await refreshKimiUsage("kimi-1");
		expect(fetchCalls).toBe(1);
		await refreshStaleKimiUsages(60_000);
		// Fresh enough — this is what stops every GET from reaching upstream.
		expect(fetchCalls).toBe(1);
	});

	test("refreshes a provider with no cache entry at all", async () => {
		await refreshStaleKimiUsages(60_000);
		expect(fetchCalls).toBe(1);
	});

	test("refreshes once when the entry has aged past the window", async () => {
		await refreshKimiUsage("kimi-1");
		// A NEGATIVE budget, not 0: the comparison is `age > maxAgeMs`, and an entry
		// written in this same millisecond has age 0, so `maxAgeMs: 0` leaves it fresh.
		// Waiting out a real interval would make this test slow for no added coverage.
		await refreshStaleKimiUsages(-1);
		expect(fetchCalls).toBe(2);
	});

	test("concurrent stale sweeps still make ONE call", async () => {
		holdFetches = true;
		const first = refreshStaleKimiUsages(60_000);
		const second = refreshStaleKimiUsages(60_000);
		await drain();
		expect(fetchCalls).toBe(1);
		pendingResolvers[0]?.({ usage: { limit: 1, used: 1 } });
		await Promise.all([first, second]);
	});
});

describe("purgeKimiUsageCache", () => {
	test("drops the entry so the next read refetches", async () => {
		await refreshKimiUsage("kimi-1");
		expect(getKimiCachedUsage("kimi-1")).toBeDefined();
		purgeKimiUsageCache(["kimi-1"]);
		expect(getKimiCachedUsage("kimi-1")).toBeUndefined();
	});

	test("an unknown id is a no-op", () => {
		expect(() => purgeKimiUsageCache(["nope"])).not.toThrow();
	});
});
