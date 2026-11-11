import { describe, expect, test } from "bun:test";
import {
	BalanceProbeRequestError,
	type BalanceRequest,
	balanceRootCandidates,
	buildBalanceRoots,
	hasSiteQuotaConfig,
	parseNewApiBalance,
	parseNewApiUserQuota,
	parseSub2ApiBalance,
	probeProviderBalance,
	probeSiteQuota,
	refreshProviderBalance,
	refreshSiteQuota,
	resolveSiteQuotaConfig,
} from "../provider-balance-adapters";

const wallet = { mode: "unrestricted", isValid: true, unit: "USD", balance: 12.5 };
const token = {
	code: true,
	message: "ok",
	data: {
		object: "token_usage",
		total_available: 500_000,
		total_used: 250_000,
		total_granted: 750_000,
		unlimited_quota: false,
	},
};
const metadata = (data: Record<string, unknown>) => ({
	success: true,
	data: { quota_per_unit: 500_000, ...data },
});
/** A provider whose site-account credit query is fully configured. */
const credentials = {
	baseUrl: "https://site.test",
	quotaAccessToken: "site-token",
	quotaUserId: "42",
};

describe("sub2api shape validation", () => {
	test.each([0, -3, 2.5])("wallet preserves explicit balance %s", (balance) => {
		expect(parseSub2ApiBalance({ ...wallet, balance })).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: balance }],
		});
	});

	test("key quota takes precedence and preserves window limits", () => {
		expect(
			parseSub2ApiBalance({
				...wallet,
				mode: "quota_limited",
				isValid: false,
				quota: { unit: "USD", limit: 10, used: 12, remaining: -2 },
				rate_limits: [{ window: "5h", limit: 5, used: 1, remaining: 4 }],
			}),
		).toEqual({
			scope: "key",
			unlimited: false,
			amounts: [
				{ unit: "USD", total: 10, used: 12, remaining: -2 },
				{ unit: "USD", total: 5, used: 1, remaining: 4, window: "5h" },
			],
		});
	});

	test("window-only quota is supported", () => {
		expect(
			parseSub2ApiBalance({
				mode: "quota_limited",
				isValid: true,
				rate_limits: [{ window: "7d", limit: 5, used: 5, remaining: 0 }],
			})?.amounts[0]?.remaining,
		).toBe(0);
	});

	test("subscription displays only periods that have actual values", () => {
		const body = {
			mode: "unrestricted",
			isValid: true,
			unit: "USD",
			planName: "Premium",
			subscription: {
				daily_limit_usd: 10,
				daily_usage_usd: 12,
				weekly_limit_usd: null,
				weekly_usage_usd: 100,
				monthly_limit_usd: 0,
				monthly_usage_usd: 0,
			},
		};
		expect(parseSub2ApiBalance(body)).toEqual({
			scope: "subscription",
			planName: "Premium",
			unlimited: false,
			amounts: [
				{ unit: "USD", total: 10, used: 12, remaining: -2, window: "daily" },
				{ unit: "USD", total: 0, used: 0, remaining: 0, window: "monthly" },
			],
		});
		expect(parseSub2ApiBalance({ ...body, subscription: undefined })).toBeNull();
		const { subscription: _subscription, ...withoutSubscription } = body;
		expect(parseSub2ApiBalance(withoutSubscription)).toEqual({
			scope: "subscription",
			planName: "Premium",
			unlimited: false,
			amounts: [],
		});
	});

	test("the gateway's explicit -1 remaining distinguishes unlimited from unknown subscription", () => {
		const base = { mode: "unrestricted", isValid: true, unit: "USD", planName: "Unlimited" };
		const subscription = {
			daily_limit_usd: null,
			daily_usage_usd: 0,
			weekly_limit_usd: null,
			weekly_usage_usd: 0,
			monthly_limit_usd: null,
			monthly_usage_usd: 0,
			expires_at: "2026-11-20T00:00:00Z",
		};
		expect(parseSub2ApiBalance({ ...base, remaining: -1, subscription })).toMatchObject({
			scope: "subscription",
			unlimited: true,
			amounts: [],
		});
		expect(
			parseSub2ApiBalance({
				...base,
				remaining: -1,
				subscription: {
					...subscription,
					daily_limit_usd: 0,
					weekly_limit_usd: 0,
					monthly_limit_usd: 0,
				},
			})?.unlimited,
		).toBe(true);
		// Missing active subscription has no remaining field in the source response.
		expect(parseSub2ApiBalance(base)).toMatchObject({ unlimited: false, amounts: [] });
		expect(parseSub2ApiBalance({ ...base, subscription })).toMatchObject({
			unlimited: false,
			amounts: [],
		});
		const limited = parseSub2ApiBalance({
			...base,
			remaining: 0,
			subscription: {
				...subscription,
				daily_limit_usd: 10,
				daily_usage_usd: 12,
			},
		});
		expect(limited?.unlimited).toBe(false);
		expect(limited?.amounts[0]?.remaining).toBe(-2);
		expect(parseSub2ApiBalance({ ...wallet, balance: -1 })).toMatchObject({
			scope: "wallet",
			unlimited: false,
		});
	});

	test("subscription metadata preserves only explicit values and normalizes RFC3339 offsets", () => {
		const parsed = parseSub2ApiBalance({
			mode: "unrestricted",
			isValid: true,
			unit: "USD",
			planName: "  Pro plan  ",
			subscription: {
				daily_limit_usd: 10,
				daily_usage_usd: 1,
				weekly_limit_usd: 50,
				weekly_usage_usd: 4,
				monthly_limit_usd: 100,
				monthly_usage_usd: 6,
				weekly_window_start: "2026-10-19T12:30:00+08:00",
				expires_at: "2026-11-20T12:30:00.123456789+08:00",
			},
		});
		expect(parsed).toMatchObject({
			scope: "subscription",
			planName: "Pro plan",
			expiresAt: "2026-11-20T04:30:00.123Z",
		});
		expect(parsed?.amounts[1]).toMatchObject({
			window: "weekly",
			windowStart: "2026-10-19T04:30:00.000Z",
		});
		expect(parsed?.amounts[0]).not.toHaveProperty("windowStart");
		expect(parsed?.amounts[2]).not.toHaveProperty("windowStart");
		expect(JSON.stringify(parsed)).not.toContain("reset");
	});

	for (const value of [
		null,
		"",
		"invalid",
		"2026-02-30T10:00:00Z",
		"2026-10-19",
		"2026-10-19T10:00:00",
		"1",
		1,
		true,
		{},
	]) {
		test(`invalid optional subscription dates do not discard valid quota: ${JSON.stringify(value)}`, () => {
			const parsed = parseSub2ApiBalance({
				mode: "unrestricted",
				isValid: true,
				unit: "USD",
				planName: "Pro",
				subscription: {
					weekly_limit_usd: 50,
					weekly_usage_usd: 4,
					weekly_window_start: value,
					expires_at: value,
				},
			});
			expect(parsed?.amounts).toEqual([
				{ unit: "USD", remaining: 46, used: 4, total: 50, window: "weekly" },
			]);
			expect(parsed).not.toHaveProperty("expiresAt");
		});
	}

	test("subscription metadata does not change wallet or key response shapes", () => {
		const metadata = {
			planName: "Not a subscription",
			subscription: { expires_at: "2026-11-20T10:00:00Z" },
		};
		expect(parseSub2ApiBalance({ ...wallet, ...metadata })).toEqual(parseSub2ApiBalance(wallet));
		const key = {
			mode: "quota_limited",
			isValid: true,
			quota: { unit: "USD", limit: 10, used: 1, remaining: 9 },
		};
		expect(parseSub2ApiBalance({ ...key, ...metadata })).toEqual(parseSub2ApiBalance(key));
	});

	test.each([
		"<html>login</html>",
		{},
		{ ...wallet, isValid: "true" },
		{ ...wallet, mode: "other" },
		{ ...wallet, unit: "USD<script>" },
		{ ...wallet, balance: "12" },
		{ ...wallet, balance: Number.NaN },
		{ ...wallet, balance: Infinity },
		{ ...wallet, balance: Number.MAX_SAFE_INTEGER + 1 },
		{ ...wallet, success: false },
		{ ...wallet, error: "failed" },
		{ mode: "quota_limited", isValid: true },
		{ mode: "quota_limited", isValid: true, rate_limits: new Array(11).fill({}) },
		{
			mode: "quota_limited",
			isValid: true,
			rate_limits: [{ window: "forever", limit: 1, used: 0, remaining: 1 }],
		},
		{ ...wallet, balance: undefined, planName: "x".repeat(129) },
		{ ...wallet, unused: "x".repeat(4097) },
	])("rejects malformed or non-protocol response %#", (body) => {
		expect(parseSub2ApiBalance(body)).toBeNull();
	});
});

describe("new-api quota normalization", () => {
	test("raw native envelope requires no invented conversion", () => {
		expect(parseNewApiBalance(token)?.amounts).toEqual([
			{ unit: "QUOTA", remaining: 500_000, used: 250_000, total: 750_000 },
		]);
	});

	test.each([0, -500_000])("preserves remaining %s", (remaining) => {
		expect(
			parseNewApiBalance({ ...token, data: { ...token.data, total_available: remaining } })
				?.amounts[0]?.remaining,
		).toBe(remaining);
	});

	test("unlimited has no pseudo amount", () => {
		expect(
			parseNewApiBalance({ ...token, data: { ...token.data, unlimited_quota: true } }),
		).toEqual({ scope: "key", unlimited: true, amounts: [] });
	});

	test.each([
		[{ quota_display_type: "USD" }, "USD", 1],
		[{ quota_display_type: "CNY", usd_exchange_rate: 7.2 }, "CNY", 7.2],
		[{ quota_display_type: "TOKENS" }, "TOKENS", 500_000],
		[
			{
				quota_display_type: "CUSTOM",
				custom_currency_symbol: "€",
				custom_currency_exchange_rate: 0.9,
			},
			"€",
			0.9,
		],
		[
			{
				quota_display_type: "CUSTOM",
				custom_currency_symbol: "CREDIT",
				custom_currency_exchange_rate: 2,
			},
			"CREDIT",
			2,
		],
	] as const)("uses upstream unit/rate %#", (data, unit, remaining) => {
		expect(parseNewApiBalance(token, metadata(data))?.amounts[0]).toEqual({
			unit,
			remaining,
			used: remaining / 2,
			total: remaining * 1.5,
		});
	});

	test.each([
		undefined,
		{},
		{ success: false, data: { quota_per_unit: 1, quota_display_type: "USD" } },
		metadata({ quota_display_type: "USD", quota_per_unit: 0 }),
		metadata({ quota_display_type: "USD", quota_per_unit: "500000" }),
		metadata({ quota_display_type: "unknown" }),
		metadata({ quota_display_type: "CNY", usd_exchange_rate: -7 }),
		metadata({
			quota_display_type: "CUSTOM",
			custom_currency_symbol: "<img>",
			custom_currency_exchange_rate: 1,
		}),
		metadata({
			quota_display_type: "CUSTOM",
			custom_currency_symbol: "x".repeat(9),
			custom_currency_exchange_rate: 1,
		}),
		metadata({ quota_display_type: "USD", quota_per_unit: Number.MIN_VALUE }),
		metadata({ quota_display_type: "USD", quota_per_unit: Infinity }),
		metadata({ display_in_currency: true }),
	])("invalid metadata falls back to raw quota %#", (status) => {
		expect(parseNewApiBalance(token, status)?.amounts[0]?.unit).toBe("QUOTA");
	});

	test.each([
		"<html>",
		{},
		{ ...token, code: false },
		{ ...token, success: false },
		{ ...token, code: 200 },
		{ ...token, data: { ...token.data, object: "balance" } },
		{ ...token, data: { ...token.data, total_used: NaN } },
		{ ...token, data: { ...token.data, total_granted: Infinity } },
		{ ...token, data: { ...token.data, total_available: Number.MAX_SAFE_INTEGER + 1 } },
		{ ...token, data: { ...token.data, unlimited_quota: "false" } },
	])("rejects false-positive body %#", (body) => {
		expect(parseNewApiBalance(body)).toBeNull();
	});
});

describe("bounded same-origin deployment roots", () => {
	test.each([
		["https://relay.test/", ["https://relay.test"]],
		["https://relay.test/prefix///", ["https://relay.test/prefix"]],
		[
			"https://relay.test/prefix/v1/",
			["https://relay.test/prefix", "https://relay.test/prefix/v1"],
		],
		["https://relay.test/v1beta", ["https://relay.test", "https://relay.test/v1beta"]],
		[
			"http://relay.test:9000/team/anthropic",
			["http://relay.test:9000/team", "http://relay.test:9000/team/anthropic"],
		],
		["https://relay.test/team/custom", ["https://relay.test/team/custom"]],
	])("normalizes %s without guessing parent directories", (url, roots) => {
		expect(buildBalanceRoots(url)).toEqual(roots);
	});

	test.each([
		"not-a-url",
		"ftp://relay.test",
		"https://user:pass@relay.test/v1",
		"https://user@relay.test",
		"https://relay.test/v1?secret=1",
		"https://relay.test/#hash",
		"https://relay.test/?",
		"https://relay.test/#",
		"https://relay.test\\v1",
	])("rejects ambiguous connection %s", (url) => {
		expect(() => buildBalanceRoots(url)).toThrow("Invalid balance URL");
	});
});

describe("protocol discovery and refresh", () => {
	test("stops immediately on sub2api wallet", async () => {
		const calls: unknown[] = [];
		const request: BalanceRequest = async (...args) => {
			calls.push(args);
			return wallet;
		};
		expect(await probeProviderBalance("https://relay.test/prefix/v1", request)).toEqual({
			adapter: "sub2api",
			root: "https://relay.test/prefix",
			balance: {
				scope: "wallet",
				unlimited: false,
				amounts: [{ unit: "USD", remaining: 12.5 }],
			},
		});
		expect(calls).toEqual([["https://relay.test/prefix/v1/usage", "provider-key"]]);
	});

	test("tries at most four introspections and one unauthenticated metadata request", async () => {
		const calls: unknown[] = [];
		const request: BalanceRequest = async (url, auth) => {
			calls.push([url, auth]);
			if (url.endsWith("/v1/api/usage/token/")) return token;
			if (url.endsWith("/api/status")) return metadata({ quota_display_type: "USD" });
			throw new BalanceProbeRequestError("unsupported");
		};
		const result = await probeProviderBalance("https://relay.test/prefix/v1", request);
		expect(result?.adapter).toBe("new-api");
		expect(result?.balance.amounts[0]?.remaining).toBe(1);
		expect(calls).toEqual([
			["https://relay.test/prefix/v1/usage", "provider-key"],
			["https://relay.test/prefix/api/usage/token/", "provider-key"],
			["https://relay.test/prefix/v1/v1/usage", "provider-key"],
			["https://relay.test/prefix/v1/api/usage/token/", "provider-key"],
			["https://relay.test/prefix/v1/api/status", "none"],
		]);
	});

	test("optional status errors do not lose confirmed support", async () => {
		const request: BalanceRequest = async (url) => {
			if (url.endsWith("/v1/usage")) return {};
			if (url.endsWith("/api/status")) throw new Error("secret response");
			return token;
		};
		expect(
			(await probeProviderBalance("https://relay.test", request))?.balance.amounts[0]?.unit,
		).toBe("QUOTA");
	});

	test("unsupported structures and missing endpoints return null, without metadata", async () => {
		let count = 0;
		expect(
			await probeProviderBalance("https://relay.test/v1", async () => {
				count++;
				return { success: false, message: "error" };
			}),
		).toBeNull();
		expect(count).toBe(4);
		expect(
			await probeProviderBalance("https://relay.test", async () => {
				throw new BalanceProbeRequestError("unsupported");
			}),
		).toBeNull();
	});

	test("transient failures remain errors, but do not prevent later success", async () => {
		await expect(
			probeProviderBalance("https://relay.test", async () => {
				throw new BalanceProbeRequestError("transient");
			}),
		).rejects.toMatchObject({ kind: "transient", message: "Balance request failed" });
		await expect(
			probeProviderBalance("https://relay.test", async () => {
				throw new Error("key-super-secret");
			}),
		).rejects.toThrow("Balance request failed");
		expect(
			(
				await probeProviderBalance("https://relay.test", async (url) => {
					if (url.endsWith("/v1/usage")) throw new BalanceProbeRequestError("transient");
					return token;
				})
			)?.adapter,
		).toBe("new-api");
	});

	test("refresh only uses the confirmed adapter and exact deployment path", async () => {
		const calls: unknown[] = [];
		expect(
			await refreshProviderBalance("sub2api", "https://relay.test/v1", async (...args) => {
				calls.push(args);
				return wallet;
			}),
		).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 12.5 }],
		});
		expect(calls).toEqual([["https://relay.test/v1/v1/usage", "provider-key"]]);
	});

	test("new-api refresh optionally reloads public metadata", async () => {
		const calls: unknown[] = [];
		const balance = await refreshProviderBalance(
			"new-api",
			"https://relay.test/team/",
			async (url, auth) => {
				calls.push([url, auth]);
				return url.endsWith("/api/status") ? metadata({ quota_display_type: "USD" }) : token;
			},
		);
		expect(balance.amounts[0]?.remaining).toBe(1);
		expect(calls).toEqual([
			["https://relay.test/team/api/usage/token/", "provider-key"],
			["https://relay.test/team/api/status", "none"],
		]);
	});

	test("refresh fails safely rather than reporting a false zero", async () => {
		await expect(
			refreshProviderBalance("sub2api", "https://relay.test", async () => ({})),
		).rejects.toMatchObject({ kind: "unsupported" });
		await expect(
			refreshProviderBalance("sub2api", "https://relay.test", async () => {
				throw new Error("private data");
			}),
		).rejects.toMatchObject({ kind: "transient", message: "Balance request failed" });
	});
});

describe("site-account credit query (/api/user/self)", () => {
	// One US dollar is 500000 internal quota units on New API sites.
	const site = {
		success: true,
		message: "",
		data: { quota: 2_500_000, used_quota: 500_000, group: "default" },
	};

	test("converts quota units to USD and reports the group", () => {
		expect(parseNewApiUserQuota(site)).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 5, used: 1, total: 6 }],
			planName: "default",
		});
	});

	test("accepts the numeric-string form emitted by some builds", () => {
		expect(
			parseNewApiUserQuota({
				success: true,
				data: { quota: "2500000", used_quota: "500000", group: "vip" },
			}),
		).toMatchObject({
			amounts: [{ unit: "USD", remaining: 5, used: 1, total: 6 }],
			planName: "vip",
		});
	});

	test("omits the group when the site reports none", () => {
		const parsed = parseNewApiUserQuota({ success: true, data: { quota: 0, used_quota: 0 } });
		expect(parsed).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 0, used: 0, total: 0 }],
		});
		expect(parsed).not.toHaveProperty("planName");
	});

	test("quota -1 is unlimited rather than a negative balance", () => {
		expect(parseNewApiUserQuota({ success: true, data: { quota: -1, used_quota: 0 } })).toEqual({
			scope: "wallet",
			unlimited: true,
			amounts: [],
		});
	});

	test.each([
		{ data: { quota: 1, used_quota: 0 } },
		{ success: false, data: { quota: 1, used_quota: 0 } },
		{ success: "true", data: { quota: 1, used_quota: 0 } },
		{ success: true },
		{ success: true, data: null },
		{ success: true, data: { used_quota: 0 } },
		{ success: true, data: { quota: 1 } },
		{ success: true, data: { quota: "1e5", used_quota: 0 } },
		{ success: true, data: { quota: -2, used_quota: 0 } },
		{ success: true, data: { quota: 1, used_quota: -1 } },
	])("rejects a body that is not an allowance answer %#", (body) => {
		expect(parseNewApiUserQuota(body)).toBeNull();
	});

	test("a configured site root is independent of the inference base URL", () => {
		// The base URL keeps /v1 (Codex/Grok/OpenCode presets); the site root does not.
		expect(resolveSiteQuotaConfig({ ...credentials, baseUrl: "https://site.test/v1" })).toEqual({
			root: "https://site.test",
			accessToken: "site-token",
			userId: "42",
		});
		// Trailing slashes and a pasted /v1 on the site root are both tolerated.
		expect(
			resolveSiteQuotaConfig({
				...credentials,
				baseUrl: "https://site.test/v1",
				quotaSiteUrl: "https://site.test/v1/",
			}),
		).toMatchObject({ root: "https://site.test" });
		expect(
			resolveSiteQuotaConfig({ ...credentials, baseUrl: "x", quotaSiteUrl: "https://site.test/" }),
		).toMatchObject({ root: "https://site.test" });
	});

	test.each([
		{ quotaAccessToken: "site-token" },
		{ quotaUserId: "42" },
		{},
	])("a half-filled site configuration is a deterministic error %#", (config) => {
		expect(() => resolveSiteQuotaConfig({ baseUrl: "https://site.test", ...config })).toThrow(
			BalanceProbeRequestError,
		);
		expect(() => resolveSiteQuotaConfig({ baseUrl: "https://site.test", ...config })).toThrow(
			expect.objectContaining({ kind: "invalid_configuration" }),
		);
	});

	test("any single site field switches the query to the site account", () => {
		expect(hasSiteQuotaConfig({})).toBe(false);
		expect(hasSiteQuotaConfig({ quotaSiteUrl: "  " })).toBe(false);
		expect(hasSiteQuotaConfig({ quotaSiteUrl: "https://site.test" })).toBe(true);
		expect(hasSiteQuotaConfig({ quotaAccessToken: "t" })).toBe(true);
		expect(hasSiteQuotaConfig({ quotaUserId: "42" })).toBe(true);
	});

	test("probe sends the site token, the user header and the site path", async () => {
		const calls: Array<[string, string | undefined]> = [];
		const result = await probeSiteQuota(
			{ ...credentials, baseUrl: "https://site.test/v1" },
			async (url, auth) => {
				calls.push([url, auth]);
				return site;
			},
		);
		expect(calls).toEqual([["https://site.test/api/user/self", "site-token"]]);
		expect(result.adapter).toBe("new-api-user");
		expect(result.root).toBe("https://site.test");
		expect(result.balance.amounts[0]).toMatchObject({
			unit: "USD",
			remaining: 5,
			used: 1,
			total: 6,
		});
	});

	test("an unparsable site answer is invalid_response, not unsupported", async () => {
		await expect(
			probeSiteQuota(credentials, async () => ({ success: true, data: { nothing: 1 } })),
		).rejects.toMatchObject({ kind: "invalid_response" });
	});

	test("refresh reuses the stored root and the same authentication", async () => {
		const calls: Array<[string, string | undefined]> = [];
		const balance = await refreshSiteQuota(credentials, "https://site.test/", async (url, auth) => {
			calls.push([url, auth]);
			return site;
		});
		expect(calls).toEqual([["https://site.test/api/user/self", "site-token"]]);
		expect(balance.amounts[0]).toMatchObject({ remaining: 5, used: 1, total: 6 });
	});

	test("root candidates exclude the /v1 form once the site account is configured", () => {
		expect(balanceRootCandidates({ baseUrl: "https://site.test/v1" })).toEqual([
			"https://site.test",
			"https://site.test/v1",
		]);
		expect(balanceRootCandidates({ ...credentials, baseUrl: "https://site.test/v1" })).toEqual([
			"https://site.test",
		]);
	});
});
