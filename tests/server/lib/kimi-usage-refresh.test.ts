import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderQuotaData, QuotaQueryResult } from "@shared/provider-quota";
import {
	deferred,
	legacyQuotaFixture,
	quotaConfig,
	quotaSnapshot,
} from "../../../server/lib/__tests__/provider-quota-legacy-fixture";
import {
	KIMI_QUOTA_RESET_SKEW_MS,
	resolveKimiQuotaResumeTarget,
} from "../../../server/lib/kimi-quota-wait";
import {
	getAllKimiCachedUsages,
	getKimiCachedUsage,
	purgeKimiUsageCache,
	refreshAllKimiUsages,
	refreshKimiUsage,
	refreshStaleKimiUsages,
	toKimiUsageCache,
} from "../../../server/lib/kimi-usage-cache";
import { settings } from "../../../server/lib/settings";

const config = () => quotaConfig({ id: "kimi-1", prefix: "kimi", baseUrl: "https://api.kimi.com" });
const data = (used = 10): ProviderQuotaData => ({
	amounts: [],
	windows: [
		{ id: "weekly", used, limit: 100, remaining: 100 - used, resetAt: "2026-11-01T00:00:00Z" },
	],
});
let fixture: ReturnType<typeof legacyQuotaFixture>;
beforeEach(() => {
	fixture = legacyQuotaFixture([config()], data());
});
afterEach(() => {
	fixture.dispose();
	mock.restore();
});

describe("Kimi usage facade delegates the real generic lifecycle", () => {
	test("concurrent callers share one source query and receive the same allowance", async () => {
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const a = refreshKimiUsage("kimi-1");
		const b = refreshKimiUsage("kimi-1");
		const c = refreshKimiUsage("kimi-1");
		expect(fixture.query).toHaveBeenCalledTimes(1);
		pending.resolve({ status: "supported", data: data(42), error: null });
		const [ra, rb, rc] = await Promise.all([a, b, c]);
		expect(ra?.weekly?.used).toBe(42);
		expect(rb).toEqual(ra);
		expect(rc).toEqual(ra);
	});

	test("a later allowed refresh starts a new query instead of holding the inflight slot forever", async () => {
		await refreshKimiUsage("kimi-1");
		fixture.advance(60_000);
		await refreshKimiUsage("kimi-1");
		expect(fixture.query).toHaveBeenCalledTimes(2);
	});

	test("a failed query releases the slot and retries after the shared backoff", async () => {
		fixture.query.mockRejectedValueOnce(new Error("upstream down"));
		await refreshKimiUsage("kimi-1");
		fixture.advance(60_000);
		const second = await refreshKimiUsage("kimi-1");
		expect(fixture.query).toHaveBeenCalledTimes(2);
		expect(second?.error).toBeNull();
	});

	test("bulk and stale sweeps collapse onto the same single refresh", async () => {
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const single = refreshKimiUsage("kimi-1");
		const all = refreshAllKimiUsages();
		const stale = refreshStaleKimiUsages();
		expect(fixture.query).toHaveBeenCalledTimes(1);
		pending.resolve({ status: "supported", data: data(7), error: null });
		await Promise.all([single, all, stale]);
	});

	test("non-Kimi providers and missing keys never trigger a source query", async () => {
		settings.customApiProviders = [quotaConfig({ id: "other" }), { ...config(), apiKey: "" }];
		expect(await refreshKimiUsage("other")).toBeNull();
		expect(await refreshKimiUsage("kimi-1")).toBeNull();
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("refreshing keeps the same-generation known reset available to the wait policy", async () => {
		const now = 1_000_000;
		const resetAt = now + 3_600_000;
		const exhausted: ProviderQuotaData = {
			amounts: [],
			windows: [
				{
					id: "weekly",
					used: 100,
					limit: 100,
					remaining: 0,
					resetAt: new Date(resetAt).toISOString(),
				},
			],
		};
		fixture.query.mockResolvedValueOnce({ status: "supported", data: exhausted, error: null });
		await refreshKimiUsage("kimi-1");
		const before = getKimiCachedUsage("kimi-1");
		fixture.advance(10_000);
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const refresh = refreshKimiUsage("kimi-1");
		expect(fixture.service.peek("kimi-1")?.status).toBe("probing");
		expect(getKimiCachedUsage("kimi-1")).toEqual(before);
		expect(
			await resolveKimiQuotaResumeTarget("kimi-1", "Weekly usage limit reached", now),
		).toMatchObject({
			bucket: "weekly",
			resetAt,
			resumeAt: resetAt + KIMI_QUOTA_RESET_SKEW_MS,
		});
		expect(fixture.query).toHaveBeenCalledTimes(2);
		pending.resolve({ status: "supported", data: exhausted, error: null });
		await refresh;
	});

	test("unsupported and unavailable projections never use supplied previous good windows", () => {
		for (const status of ["unsupported", "unavailable"] as const) {
			expect(toKimiUsageCache(quotaSnapshot({ status, data: data() }))).toMatchObject({
				fiveHour: null,
				weekly: null,
				monthly: null,
				extraWindows: [],
			});
		}
	});

	test("failed refresh retains stale windows but never upstream exception text", async () => {
		await refreshKimiUsage("kimi-1");
		fixture.advance(60_000);
		fixture.query.mockRejectedValue(new Error("test-secret-key private provider URL"));
		const result = await refreshKimiUsage("kimi-1");
		expect(result?.weekly?.used).toBe(10);
		expect(result?.error).toBe("Kimi usage unavailable");
		expect(JSON.stringify(result)).not.toMatch(/test-secret-key|private provider URL/);
	});

	test("fresh reads do not start any query and stale sweeps honor the service cadence", async () => {
		await refreshKimiUsage("kimi-1");
		expect(getKimiCachedUsage("kimi-1")?.weekly?.used).toBe(10);
		expect(Object.keys(getAllKimiCachedUsages())).toEqual(["kimi-1"]);
		fixture.advance(59_999);
		await refreshStaleKimiUsages();
		expect(fixture.query).toHaveBeenCalledTimes(1);
		fixture.advance(1);
		await refreshStaleKimiUsages();
		expect(fixture.query).toHaveBeenCalledTimes(2);
	});

	test("a provider with no cached allowance is refreshed exactly once", async () => {
		await Promise.all([refreshStaleKimiUsages(), refreshStaleKimiUsages()]);
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	test("settings reconciliation drops removed or replaced accounts immediately", async () => {
		await refreshKimiUsage("kimi-1");
		settings.customApiProviders = [{ ...config(), apiKey: "replacement" }];
		purgeKimiUsageCache(["kimi-1"]);
		expect(getKimiCachedUsage("kimi-1")?.weekly).toBeNull();
		settings.customApiProviders = [];
		purgeKimiUsageCache(["kimi-1"]);
		expect(getKimiCachedUsage("kimi-1")).toBeUndefined();
	});

	test("an unknown purge ID is a no-op for the existing generation", async () => {
		await refreshKimiUsage("kimi-1");
		purgeKimiUsageCache(["unknown"]);
		expect(getKimiCachedUsage("kimi-1")?.weekly?.used).toBe(10);
	});

	test("window labels and null amounts survive projection without invented remaining allowance", () => {
		const projected = toKimiUsageCache(
			quotaSnapshot({
				data: {
					amounts: [],
					windows: [
						{ id: "fiveHour", used: null, limit: null, remaining: null, resetAt: null },
						{
							id: "extra:0",
							label: "Daily",
							used: 2,
							limit: 3,
							remaining: 1,
							resetAt: "2026-11-01T00:00:00Z",
						},
					],
				},
			}),
		);
		expect(projected.fiveHour).toEqual({
			used: null,
			limit: null,
			remaining: null,
			resetTime: null,
		});
		expect(projected.weekly).toBeNull();
		expect(projected.extraWindows[0]).toMatchObject({ label: "Daily", used: 2, remaining: 1 });
	});

	test("without an active source, old reset data is not treated as quota recovery evidence", async () => {
		await refreshKimiUsage("kimi-1");
		fixture.revoke();
		expect(getKimiCachedUsage("kimi-1")).toMatchObject({
			weekly: null,
			error: "Kimi usage unavailable",
		});
		expect(
			await resolveKimiQuotaResumeTarget("kimi-1", "Weekly usage limit reached", 1_000_000),
		).toBeNull();
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	test("the facade owns no fetch, persistence, local cache or timer", () => {
		const source = readFileSync(
			new URL("../../../server/lib/kimi-usage-cache.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toMatch(
			/outboundFetch|createPersistedCredentialCache|setTimeout|setInterval|new Map|coding\/v1\/usages/,
		);
	});
});
