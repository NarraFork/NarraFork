import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderQuotaData, QuotaQueryResult } from "@shared/provider-quota";
import {
	opencodeUsageUrl,
	parseOpencodeUsageResponse,
} from "../../../plugins/provider-quota/src/opencode";
import { providerQuotaService } from "../../services/provider-quota-service";
import {
	getAllOpencodeCachedUsages,
	getOpencodeCachedUsage,
	getOpencodeUsageGenerations,
	isOpencodeCustomApiProvider,
	noteOpencodeUsageActivity,
	refreshAllOpencodeUsages,
	refreshOpencodeUsage,
	refreshStaleOpencodeUsages,
	toOpencodeUsageCache,
} from "../opencode-usage-cache";
import { settings } from "../settings";
import {
	deferred,
	legacyQuotaFixture,
	quotaConfig,
	quotaSnapshot,
} from "./provider-quota-legacy-fixture";

const config = () =>
	quotaConfig({
		id: "opencode-test",
		prefix: "opencode-test",
		baseUrl: "https://opencode.ai/zen/go/v1",
	});
const body = {
	usage: {
		rolling: { status: "ok", percent: 37, resetsAt: "2026-10-15T17:56:27.780Z" },
		weekly: { status: "ok", percent: 12, resetsAt: "2026-10-19T00:00:00.000Z" },
		monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-15T12:39:31.000Z" },
	},
};
const data: ProviderQuotaData = {
	amounts: [{ id: "balance:USD", unit: "USD", remaining: 12.34 }],
	windows: [
		{
			id: "rolling",
			status: "ok",
			usedPercent: 37,
			resetAt: "2026-10-15T17:56:27.780Z",
			used: null,
			limit: null,
			remaining: null,
		},
		{
			id: "weekly",
			status: "ok",
			usedPercent: 12,
			resetAt: "2026-10-19T00:00:00.000Z",
			used: null,
			limit: null,
			remaining: null,
		},
		{
			id: "monthly",
			status: "rate-limited",
			usedPercent: 100,
			resetAt: "2026-11-15T12:39:31.000Z",
			used: 15,
			limit: 15,
			remaining: 0,
		},
	],
};
let fixture: ReturnType<typeof legacyQuotaFixture>;
beforeEach(() => {
	fixture = legacyQuotaFixture([config()], data);
});
afterEach(() => {
	fixture.dispose();
	mock.restore();
});

describe("OpenCode parser moved to the quota source plugin", () => {
	test("only enabled Go plan endpoints qualify, never Zen or relay paths", () => {
		for (const suffix of ["", "/"]) {
			expect(
				isOpencodeCustomApiProvider({ baseUrl: `https://opencode.ai/zen/go/v1${suffix}` }),
			).toBe(true);
			expect(
				isOpencodeCustomApiProvider({ baseUrl: `https://opencode.ai/inference/go/v1${suffix}` }),
			).toBe(true);
		}
		expect(isOpencodeCustomApiProvider({ baseUrl: "https://opencode.ai:443/zen/go/v1" })).toBe(
			true,
		);
		for (const baseUrl of [
			"https://opencode.ai/zen/v1",
			"https://opencode.ai/inference/v1",
			"https://opencode.ai/zen/go/v2",
			"http://opencode.ai/zen/go/v1",
			"https://opencode.ai.evil.test/zen/go/v1",
			"https://evil.opencode.ai.test/zen/go/v1",
			"https://opencode.ai:444/zen/go/v1",
			"https://key@opencode.ai/zen/go/v1",
			"https://opencode.ai/zen/go/v1?api_key=secret",
			"https://example.com/zen/go/v1",
			"invalid",
		]) {
			expect(isOpencodeCustomApiProvider({ baseUrl })).toBe(false);
		}
		expect(isOpencodeCustomApiProvider({ ...config(), disabled: true })).toBe(false);
	});

	test("derives usage from the configured root, including per-family inference paths", () => {
		expect(opencodeUsageUrl("https://opencode.ai/zen/go/v1")).toBe(
			"https://opencode.ai/zen/go/v1/usage",
		);
		expect(opencodeUsageUrl("https://opencode.ai/inference/go/v1/")).toBe(
			"https://opencode.ai/inference/go/v1/usage",
		);
		expect(opencodeUsageUrl("https://opencode.ai/inference/go/openai/v1")).toBe(
			"https://opencode.ai/inference/go/v1/usage",
		);
	});

	test("parses three windows while tolerating missing and unknown fields", () => {
		expect(parseOpencodeUsageResponse(body)).toEqual({
			rolling: { status: "ok", percent: 37, resetsAt: "2026-10-15T17:56:27.780Z" },
			weekly: { status: "ok", percent: 12, resetsAt: "2026-10-19T00:00:00.000Z" },
			monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-15T12:39:31.000Z" },
		});
		expect(
			parseOpencodeUsageResponse({
				usage: { rolling: { status: "weird", percent: 130, resetsAt: "not a date" } },
			}),
		).toEqual({
			rolling: { status: null, percent: 100, resetsAt: null },
			weekly: null,
			monthly: null,
		});
		for (const usage of [{ rolling: null }, {}])
			expect(parseOpencodeUsageResponse({ usage })).toEqual({
				rolling: null,
				weekly: null,
				monthly: null,
			});
		for (const invalid of [null, {}, { usage: null }, { usage: "x" }])
			expect(() => parseOpencodeUsageResponse(invalid)).toThrow();
	});

	test("absolute amounts and balance are retained; only known amounts derive a percentage", () => {
		const parsed = parseOpencodeUsageResponse({
			usage: {
				rolling: { status: "ok", used: 1.5, limit: 6, resetsAt: 1_792_500_000 },
				weekly: { status: "rate-limited", percent: 100, used: "15", quota: "15" },
				monthly: { percent: 40 },
				balance: { amount: 12.34 },
			},
		});
		expect(parsed.rolling).toEqual({
			status: "ok",
			percent: 25,
			resetsAt: new Date(1_792_500_000 * 1000).toISOString(),
			used: 1.5,
			limit: 6,
		});
		expect(parsed.weekly).toMatchObject({ percent: 100, used: 15, limit: 15 });
		expect(parsed.monthly).toEqual({ status: null, percent: 40, resetsAt: null });
		expect(parsed.balance).toBe(12.34);
	});

	test("a zero limit or lone amount never fabricates a ratio", () => {
		const parsed = parseOpencodeUsageResponse({
			usage: { rolling: { status: "ok", used: 3, limit: 0 }, weekly: { used: 3 } },
		});
		expect(parsed.rolling).toEqual({ status: "ok", percent: null, resetsAt: null });
		expect(parsed.weekly).toBeNull();
		expect(parsed).not.toHaveProperty("balance");
	});
});

describe("OpenCode generic-service compatibility facade", () => {
	test("translates normalized windows without inventing amounts from a percent", () => {
		const projected = toOpencodeUsageCache(quotaSnapshot({ data }));
		expect(projected.rolling).toEqual({
			status: "ok",
			percent: 37,
			resetsAt: "2026-10-15T17:56:27.780Z",
		});
		expect(projected.monthly).toMatchObject({ percent: 100, used: 15, limit: 15 });
		expect(projected.balance).toBe(12.34);
		expect(
			toOpencodeUsageCache(
				quotaSnapshot({
					data: {
						amounts: [],
						windows: [{ id: "rolling", used: null, limit: null, remaining: null, resetAt: null }],
					},
				}),
			).rolling,
		).toEqual({ status: null, percent: null, resetsAt: null });
	});

	test("coalesces concurrent individual, bulk and stale refreshes in the generic service", async () => {
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const a = refreshOpencodeUsage("opencode-test");
		const b = refreshOpencodeUsage("opencode-test");
		const all = refreshAllOpencodeUsages();
		const stale = refreshStaleOpencodeUsages();
		expect(fixture.query).toHaveBeenCalledTimes(1);
		pending.resolve({ status: "supported", data, error: null });
		expect(await b).toEqual(await a);
		await Promise.all([all, stale]);
	});

	test("uses the service generation and invalidates replaced accounts without an old local cache", async () => {
		await refreshOpencodeUsage("opencode-test");
		const generation = getOpencodeUsageGenerations()["opencode-test"];
		expect(generation).toBe(fixture.service.generations()["opencode-test"]);
		expect(getAllOpencodeCachedUsages()["opencode-test"]?.generation).toBe(generation);
		settings.customApiProviders = [{ ...config(), apiKey: "replacement" }];
		expect(getOpencodeUsageGenerations()["opencode-test"]).not.toBe(generation);
		expect(getOpencodeCachedUsage("opencode-test")?.rolling).toBeNull();
	});

	test("refreshing preserves percentages, amounts and resets from the same generation", async () => {
		await refreshOpencodeUsage("opencode-test");
		const before = getOpencodeCachedUsage("opencode-test");
		fixture.advance(10_000);
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const refresh = refreshOpencodeUsage("opencode-test");
		expect(fixture.service.peek("opencode-test")?.status).toBe("probing");
		expect(getOpencodeCachedUsage("opencode-test")).toEqual(before);
		pending.resolve({ status: "supported", data, error: null });
		await refresh;
	});

	test("unsupported and unavailable projections hide previous good windows and balances", () => {
		for (const status of ["unsupported", "unavailable"] as const) {
			const projected = toOpencodeUsageCache(quotaSnapshot({ status, data }));
			expect(projected).toMatchObject({ rolling: null, weekly: null, monthly: null });
			expect(projected).not.toHaveProperty("balance");
		}
	});

	test("failed refresh preserves stale percentages while redacting private errors", async () => {
		await refreshOpencodeUsage("opencode-test");
		fixture.advance(60_000);
		fixture.query.mockRejectedValue(new Error("test-secret-key private upstream response"));
		const result = await refreshOpencodeUsage("opencode-test");
		expect(result?.rolling?.percent).toBe(37);
		expect(result?.error).toBe("OpenCode usage unavailable");
		expect(JSON.stringify(result)).not.toMatch(/test-secret-key|private upstream/);
	});

	test("disabled or unavailable sources cannot claim recovery or fetch through retired code", async () => {
		await refreshOpencodeUsage("opencode-test");
		fixture.revoke();
		expect(await refreshOpencodeUsage("opencode-test")).toMatchObject({
			rolling: null,
			weekly: null,
			monthly: null,
			error: "OpenCode usage unavailable",
		});
		expect(fixture.query).toHaveBeenCalledTimes(1);
		settings.customApiProviders = [{ ...config(), disabled: true }];
		expect(getOpencodeCachedUsage("opencode-test")).toBeNull();
	});

	test("missing keys and non-Go providers never trigger source execution", async () => {
		for (const overrides of [{ apiKey: "" }, { baseUrl: "https://relay.invalid/zen/go/v1" }]) {
			settings.customApiProviders = [{ ...config(), ...overrides }];
			expect(await refreshOpencodeUsage("opencode-test")).toBeNull();
		}
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("the production activity call forwards raw IDs and prefixes to the generic scheduler", () => {
		noteOpencodeUsageActivity("opencode-test");
		noteOpencodeUsageActivity("opencode-test:model");
		expect(providerQuotaService.noteActivity).toHaveBeenNthCalledWith(1, "opencode-test");
		expect(providerQuotaService.noteActivity).toHaveBeenNthCalledWith(2, "opencode-test:model");
	});

	test("the facade owns no transport, endpoint parsing, persistent state or timer", () => {
		const source = readFileSync(new URL("../opencode-usage-cache.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(
			/outboundFetch|createPersistedCredentialCache|setTimeout|setInterval|new Map|function opencodeUsageUrl/,
		);
	});
});
