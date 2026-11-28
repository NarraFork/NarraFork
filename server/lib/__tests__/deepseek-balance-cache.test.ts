import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderQuotaData, QuotaQueryResult } from "@shared/provider-quota";
import {
	deepSeekQuotaData,
	parseDeepSeekBalanceResponse,
} from "../../../plugins/provider-quota/src/deepseek";
import {
	getAllDeepSeekCachedBalances,
	getDeepSeekBalanceGenerations,
	isDeepSeekCustomApiProvider,
	refreshAllDeepSeekBalances,
	refreshDeepSeekBalance,
	refreshStaleDeepSeekBalances,
	toDeepSeekBalanceCache,
} from "../deepseek-balance-cache";
import { settings } from "../settings";
import {
	deferred,
	legacyQuotaFixture,
	quotaConfig,
	quotaSnapshot,
} from "./provider-quota-legacy-fixture";

const config = () =>
	quotaConfig({
		id: "deepseek-test",
		prefix: "deepseek-test",
		baseUrl: "https://api.deepseek.com",
	});
const body = {
	is_available: false,
	balance_infos: [
		{ currency: "CNY", total_balance: "0.00000001", granted_balance: "0", topped_up_balance: "-1" },
		{
			currency: "USD",
			total_balance: "12.3456789",
			granted_balance: "0.5",
			topped_up_balance: "11.8456789",
		},
	],
};
const data: ProviderQuotaData = {
	available: false,
	windows: [],
	amounts: [
		{ id: "balance:CNY", unit: "CNY", remaining: 0.00000001 },
		{ id: "granted:CNY", unit: "CNY", remaining: 0 },
		{ id: "topped-up:CNY", unit: "CNY", remaining: -1 },
		{ id: "balance:USD", unit: "USD", remaining: 12.3456789 },
		{ id: "granted:USD", unit: "USD", remaining: 0.5 },
		{ id: "topped-up:USD", unit: "USD", remaining: 11.8456789 },
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

describe("DeepSeek parser moved to the quota source plugin", () => {
	test("only enabled official HTTPS providers at supported paths qualify for the legacy route", () => {
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
		]) {
			expect(isDeepSeekCustomApiProvider({ baseUrl })).toBe(false);
		}
		expect(isDeepSeekCustomApiProvider({ ...config(), disabled: true })).toBe(false);
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
});

describe("DeepSeek generic-service compatibility projection", () => {
	test("projects currencies, detail amounts and false availability without rounding the numeric value", () => {
		const projected = toDeepSeekBalanceCache(quotaSnapshot({ data }));
		expect(projected.isAvailable).toBe(false);
		expect(projected.balanceInfos).toHaveLength(2);
		expect(Number(projected.balanceInfos[0]?.totalBalance)).toBe(0.00000001);
		expect(projected.balanceInfos[0]).toMatchObject({
			currency: "CNY",
			grantedBalance: "0",
			toppedUpBalance: "-1",
		});
		expect(projected.balanceInfos[1]?.totalBalance).toBe("12.3456789");
	});

	test("new summary/detail semantics preserve all exact legacy currency fields", () => {
		const normalized = deepSeekQuotaData(parseDeepSeekBalanceResponse(body));
		if (!normalized) throw new Error("expected normalized balance");
		const projected = toDeepSeekBalanceCache(quotaSnapshot({ data: normalized }));
		expect(projected.isAvailable).toBe(false);
		expect(projected.balanceInfos).toEqual(parseDeepSeekBalanceResponse(body).balanceInfos);
		expect(normalized.amounts[0]).toMatchObject({ display: "summary", quota: "alternative" });
		expect(normalized.amounts[1]).toMatchObject({ display: "detail", quota: "none" });
	});

	test("legacy projection rejects invalid new fields or exact decimal text instead of stripping them", () => {
		for (const invalid of [
			{ id: "balance:USD", unit: "USD", remaining: 1, display: "hidden" },
			{ id: "balance:USD", unit: "USD", remaining: 1, quota: "optional" },
			{ id: "balance:USD", unit: "USD", remaining: 1, remainingText: "999" },
			{ id: "balance:USD", unit: "USD", remaining: 1, apiKey: "private-key" },
		]) {
			const projected = toDeepSeekBalanceCache(
				quotaSnapshot({
					data: { amounts: [invalid], windows: [] } as unknown as ProviderQuotaData,
				}),
			);
			expect(projected).toMatchObject({
				isAvailable: null,
				balanceInfos: [],
				error: "DeepSeek balance unavailable",
			});
			expect(JSON.stringify(projected)).not.toContain("private-key");
		}
	});

	test("legacy currency projection cannot relabel a foreign or mismatched amount as a balance", () => {
		const projected = toDeepSeekBalanceCache(
			quotaSnapshot({
				data: {
					amounts: [
						{ id: "balance:USD", unit: "CNY", remaining: 5 },
						{ id: "balance:EUR", unit: "EUR", remaining: 3 },
						{
							id: "balance:USD",
							unit: "USD",
							remaining: 2,
							display: "summary",
							quota: "alternative",
						},
						{ id: "granted:USD", unit: "CNY", remaining: 999, display: "detail", quota: "none" },
					],
					windows: [],
				},
			}),
		);
		expect(projected.balanceInfos).toEqual([
			{ currency: "USD", totalBalance: "2", grantedBalance: "", toppedUpBalance: "" },
		]);
	});

	test("missing numeric details remain unknown, never zero or available", () => {
		const projected = toDeepSeekBalanceCache(
			quotaSnapshot({
				data: {
					windows: [],
					amounts: [
						{ id: "balance:CNY", unit: "CNY", remaining: null },
						{ id: "balance:USD", unit: "USD", remaining: 5 },
					],
				},
			}),
		);
		expect(projected.isAvailable).toBeNull();
		expect(projected.balanceInfos).toEqual([
			{ currency: "USD", totalBalance: "5", grantedBalance: "", toppedUpBalance: "" },
		]);
	});

	test("coalesces concurrent refresh and bulk/stale readers in the generic service", async () => {
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const first = refreshDeepSeekBalance("deepseek-test");
		const second = refreshDeepSeekBalance("deepseek-test");
		const bulk = refreshAllDeepSeekBalances();
		const stale = refreshStaleDeepSeekBalances();
		expect(fixture.query).toHaveBeenCalledTimes(1);
		pending.resolve({ status: "supported", data, error: null });
		await Promise.all([first, second, bulk, stale]);
		await refreshStaleDeepSeekBalances();
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	test("read-only generations and DTOs share the single service's account identity", async () => {
		await refreshDeepSeekBalance("deepseek-test");
		const generation = getDeepSeekBalanceGenerations()["deepseek-test"];
		expect(generation).toBe(fixture.service.generations()["deepseek-test"]);
		expect(getAllDeepSeekCachedBalances()["deepseek-test"]?.generation).toBe(generation);
		expect(fixture.query).toHaveBeenCalledTimes(1);
		settings.customApiProviders = [{ ...config(), apiKey: "replacement" }];
		expect(getDeepSeekBalanceGenerations()["deepseek-test"]).not.toBe(generation);
		expect(getAllDeepSeekCachedBalances()["deepseek-test"]?.balanceInfos).toEqual([]);
	});

	test("refreshing preserves same-generation balances until the new query completes", async () => {
		await refreshDeepSeekBalance("deepseek-test");
		const before = getAllDeepSeekCachedBalances()["deepseek-test"];
		fixture.advance(10_000);
		const pending = deferred<QuotaQueryResult>();
		fixture.query.mockImplementation(() => pending.promise);
		const refresh = refreshDeepSeekBalance("deepseek-test");
		expect(fixture.service.peek("deepseek-test")?.status).toBe("probing");
		expect(getAllDeepSeekCachedBalances()["deepseek-test"]).toEqual(before);
		pending.resolve({ status: "supported", data, error: null });
		await refresh;
	});

	test("unsupported and unavailable projections hide previous good data", () => {
		for (const status of ["unsupported", "unavailable"] as const) {
			expect(toDeepSeekBalanceCache(quotaSnapshot({ status, data }))).toMatchObject({
				isAvailable: null,
				balanceInfos: [],
				error: "DeepSeek balance unavailable",
			});
		}
	});

	test("failure keeps stale balances but only a safe fixed error", async () => {
		await refreshDeepSeekBalance("deepseek-test");
		fixture.advance(60_000);
		fixture.query.mockRejectedValue(new Error("test-secret-key private upstream message"));
		const result = await refreshDeepSeekBalance("deepseek-test");
		expect(result?.balanceInfos).toHaveLength(2);
		expect(result?.error).toBe("DeepSeek balance unavailable");
		expect(JSON.stringify(result)).not.toMatch(/test-secret-key|private upstream/);
	});

	test("revocation hides stale balances and cannot reactivate the retired fetcher", async () => {
		await refreshDeepSeekBalance("deepseek-test");
		fixture.revoke();
		const result = await refreshDeepSeekBalance("deepseek-test");
		expect(result).toMatchObject({
			isAvailable: null,
			balanceInfos: [],
			error: "DeepSeek balance unavailable",
		});
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	test("missing keys, disabled and nonofficial providers never trigger a source", async () => {
		for (const overrides of [
			{ apiKey: "" },
			{ disabled: true },
			{ baseUrl: "https://relay.invalid" },
		]) {
			settings.customApiProviders = [{ ...config(), ...overrides }];
			expect(await refreshDeepSeekBalance("deepseek-test")).toBeNull();
		}
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("the facade owns no transport, old endpoint or independent cache", () => {
		const source = readFileSync(new URL("../deepseek-balance-cache.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(
			/outboundFetch|createPersistedCredentialCache|setTimeout|setInterval|new Map|user\/balance/,
		);
	});
});
