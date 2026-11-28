import { describe, expect, test } from "bun:test";
import type { ProviderQuotaData, ProviderQuotaSnapshot } from "@shared/provider-quota";
import { createInstance } from "i18next";
import {
	deepSeekQuotaData,
	parseDeepSeekBalanceResponse,
} from "../../../../plugins/provider-quota/src/deepseek";
import { parseSub2ApiBalance, relayQuotaData } from "../../../../plugins/provider-quota/src/relay";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { matchesProviderQuotaIdentity } from "../../../hooks/useProviderQuota";
import { buildProviderQuotaView, formatProviderQuotaAmount } from "./provider-quota-view";
import { formatQuotaBadgeText, formatQuotaSummaryLines } from "./quota-panel-view";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	defaultNS: "narrator",
});
const t = i18n.getFixedT("en", "narrator");
const snapshot = (overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
	providerId: "p1",
	targetId: "custom-api/p1",
	generation: "account-A",
	sourceId: "com.example.third-party:credits-v7",
	status: "supported",
	data: {
		amounts: [
			{
				id: "credits",
				label: "Project credits",
				unit: "credits",
				remaining: 37.5,
				used: 12.5,
				total: 50,
			},
		],
		windows: [
			{
				id: "rolling",
				label: "Rolling requests",
				unit: "requests",
				used: 40,
				limit: 100,
				remaining: 60,
				resetAt: "2026-01-01T01:00:00Z",
			},
		],
		format: "not-a-core-enum",
		planName: "Team plan",
	},
	fetchedAt: 100,
	attemptedAt: 100,
	stale: false,
	error: null,
	version: 1,
	...overrides,
});

function requireView(value: ReturnType<typeof buildProviderQuotaView>) {
	if (!value) throw new Error("expected normalized quota view");
	return value;
}

function requireQuotaData(value: ProviderQuotaData | null): ProviderQuotaData {
	if (!value) throw new Error("expected normalized quota data");
	return value;
}

const subscriptionQuota = () => {
	const balance = parseSub2ApiBalance({
		mode: "unrestricted",
		isValid: true,
		unit: "USD",
		planName: "Team plan",
		subscription: {
			daily_limit_usd: 10,
			daily_usage_usd: 2.5,
			weekly_limit_usd: 50,
			weekly_usage_usd: 10,
			monthly_limit_usd: 100,
			monthly_usage_usd: 30,
			weekly_window_start: "2026-11-09T12:30:00+08:00",
			expires_at: "2027-01-01T12:30:00+08:00",
		},
	});
	if (!balance) throw new Error("expected subscription balance");
	return relayQuotaData(balance, "sub2api");
};

const quotaNow = Date.parse("2026-11-15T00:00:00Z");

describe("normalized provider quota view", () => {
	test("unknown third-party sources render ordinary amounts and windows", () => {
		const view = requireView(buildProviderQuotaView(snapshot(), t));
		expect(view.windows[0]).toMatchObject({
			id: "rolling",
			remainingPercent: 60,
			used: 40,
			limit: 100,
			level: "ok",
			resetAt: Date.parse("2026-01-01T01:00:00Z"),
		});
		expect(view.rows).toContainEqual({
			id: "amount/credits",
			label: "Project credits",
			value: "credits 37.5",
		});
		expect(view.rows).toContainEqual({
			id: "amount/credits/usage",
			label: "Project credits used / total",
			value: "credits 12.5 / credits 50",
		});
		expect(formatQuotaBadgeText(view, t)).toContain("60%");
		expect(formatQuotaSummaryLines(view, 100, t).join("\n")).toContain("Team plan");
		expect(
			buildProviderQuotaView({ ...snapshot(), sourceId: "another.plugin:anything" }, t),
		).toEqual(view);
	});

	test("amount-only sources use the same panel, not a branded formatter", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: { amounts: [{ id: "wallet", unit: "EUR", remaining: 0.004 }], windows: [] },
				}),
				t,
			),
		);
		expect(view.windows).toEqual([]);
		expect(formatQuotaBadgeText(view, t)).toBe("EUR 0.004");
		expect(view.level).toBe("ok");
	});

	test("unknown values never turn into zero, full allowance or unlimited", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [{ id: "unknown", unit: "USD", remaining: null }],
						windows: [{ id: "unknown", used: null, limit: null, remaining: null, resetAt: null }],
					},
				}),
				t,
			),
		);
		expect(view.windows[0]).toMatchObject({
			usedPercent: null,
			remainingPercent: null,
			used: null,
			limit: null,
			level: "unknown",
		});
		expect(view.rows[0]?.value).toBe("Unknown");
		expect(view.level).toBe("unknown");
		expect(formatQuotaSummaryLines(view, 0, t).join("\n")).not.toMatch(/Unlimited|100%/);
		expect(formatProviderQuotaAmount({ id: "zero", unit: "USD", remaining: 0 }, t)).toBe("USD 0");
		expect(
			formatProviderQuotaAmount(
				{ id: "unlimited", unit: "requests", remaining: null, unlimited: true },
				t,
			),
		).toBe("Unlimited");
	});

	test.each([
		"en",
		"zh-CN",
	])("DeepSeek totals alone form the exact multi-currency summary (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const data = requireQuotaData(
			deepSeekQuotaData(
				parseDeepSeekBalanceResponse({
					is_available: true,
					balance_infos: [
						{
							currency: "CNY",
							total_balance: "0.00",
							granted_balance: "0",
							topped_up_balance: "0.00",
						},
						{
							currency: "USD",
							total_balance: "0.0000000100",
							granted_balance: "0.0000",
							topped_up_balance: "0.0000000100",
						},
					],
				}),
			),
		);
		const value = snapshot({ data });
		const view = requireView(buildProviderQuotaView(value, translate));
		expect(formatQuotaBadgeText(view, translate)).toBe("CNY 0.00 · USD 0.0000000100");
		expect(view.level).toBe("ok");
		expect(view.rows).toContainEqual({
			id: "amount/granted:USD",
			label: "Granted balance",
			value: "USD 0.0000",
		});
		expect(view.rows).toContainEqual({
			id: "amount/topped-up:USD",
			label: "Topped-up balance",
			value: "USD 0.0000000100",
		});
		expect(view.rows.filter((row) => row.id?.startsWith("amount/")).length).toBe(6);
		expect(
			buildProviderQuotaView(
				{ ...value, sourceId: "another.plugin:wallet", data: { ...data, format: "arbitrary" } },
				translate,
			),
		).toEqual(view);
	});

	test("a true total zero stays exhausted even if an informational detail is positive", () => {
		const data = requireQuotaData(
			deepSeekQuotaData(
				parseDeepSeekBalanceResponse({
					is_available: true,
					balance_infos: [
						{
							currency: "USD",
							total_balance: "0.0000",
							granted_balance: "5.00",
							topped_up_balance: "0",
						},
					],
				}),
			),
		);
		const view = requireView(buildProviderQuotaView(snapshot({ data }), t));
		expect(formatQuotaBadgeText(view, t)).toBe("USD 0.0000");
		expect(view.level).toBe("exhausted");
	});

	test.each([
		[0, null, "unknown"],
		[0, 0, "exhausted"],
		[0, 5, "ok"],
		[-1, 0, "exhausted"],
		[null, 5, "ok"],
		[null, null, "unknown"],
	] as const)("alternative amounts %s / %s produce %s without summing currencies", (a, b, level) => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [
							{ id: "a", unit: "EUR", remaining: a, quota: "alternative" },
							{ id: "b", unit: "JPY", remaining: b, quota: "alternative" },
						],
						windows: [],
					},
				}),
				t,
			),
		);
		expect(view.level).toBe(level);
	});

	test("an explicit unlimited alternative satisfies its pool but not an unavailable account", () => {
		const data: ProviderQuotaData = {
			amounts: [
				{ id: "empty", unit: "USD", remaining: 0, quota: "alternative" },
				{ id: "unbounded", unit: "CNY", remaining: null, unlimited: true, quota: "alternative" },
			],
			windows: [],
		};
		expect(buildProviderQuotaView(snapshot({ data }), t)?.level).toBe("ok");
		expect(
			buildProviderQuotaView(snapshot({ data: { ...data, available: false } }), t)?.level,
		).toBe("exhausted");
	});

	test("display and quota semantics are independent; omitted fields preserve legacy constraints", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [
							{
								id: "summary",
								unit: "credits",
								remaining: 9,
								display: "summary",
								quota: "alternative",
							},
							{
								id: "required-detail",
								unit: "requests",
								remaining: 0,
								display: "detail",
								quota: "required",
							},
						],
						windows: [],
					},
				}),
				t,
			),
		);
		expect(formatQuotaBadgeText(view, t)).toBe("credits 9");
		expect(view.level).toBe("exhausted");
		const legacy = snapshot({
			data: { amounts: [{ id: "wallet", unit: "USD", remaining: 0 }], windows: [] },
		});
		expect(buildProviderQuotaView(legacy, t)).toEqual(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [
							{ id: "wallet", unit: "USD", remaining: 0, display: "summary", quota: "required" },
						],
						windows: [],
					},
				}),
				t,
			),
		);
	});

	test("detail-only numbers do not fabricate a summary, unlimited flag or quota judgment", () => {
		const data: ProviderQuotaData = {
			amounts: [{ id: "detail", unit: "USD", remaining: 0, display: "detail", quota: "none" }],
			windows: [],
		};
		const view = requireView(buildProviderQuotaView(snapshot({ data }), t));
		expect(view.level).toBe("unknown");
		expect(formatQuotaBadgeText(view, t)).toBe("Unknown");
		expect(view.rows[0]?.value).toBe("USD 0");
		const unlimited = requireView(
			buildProviderQuotaView(
				snapshot({
					data: { ...data, unlimited: true, amounts: [{ id: "zero", unit: "USD", remaining: 0 }] },
				}),
				t,
			),
		);
		expect(unlimited.level).toBe("ok");
		expect(formatQuotaBadgeText(unlimited, t)).toBe("Unlimited");
		const stillRateLimited = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						...data,
						unlimited: true,
						windows: [
							{
								id: "rate",
								used: null,
								limit: null,
								remaining: null,
								resetAt: null,
								status: "rate-limited",
							},
						],
					},
				}),
				t,
			),
		);
		expect(stillRateLimited.level).toBe("exhausted");
	});

	test.each([
		"en",
		"zh-CN",
	])("plugin-normalized subscription windows share the generic progress panel (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const data = subscriptionQuota();
		const view = requireView(
			buildProviderQuotaView(snapshot({ data }), translate, false, false, quotaNow),
		);
		expect(view.windows.map((window) => window.id)).toEqual(["daily", "weekly", "monthly"]);
		expect(view.windows.map((window) => window.remainingPercent)).toEqual([75, 80, 70]);
		expect(view.windows.every((window) => window.resetAt === null)).toBe(true);
		expect(view.limiting?.id).toBe("monthly");
		expect(formatQuotaBadgeText(view, translate)).toContain("70%");
		expect(view.rows).toContainEqual({
			id: "meta/plan",
			label: translate("providerQuota.plan"),
			value: "Team plan",
		});
		expect(view.rows).toContainEqual({
			id: "meta/expiresAt",
			label: translate("providerQuota.expiresAt"),
			value: "2027-01-01T04:30:00.000Z",
		});
		expect(view.rows.find((row) => row.id === "amount/amount:1/window-start")?.value).toBe(
			"2026-11-09T04:30:00.000Z",
		);
		expect(
			view.rows.some((row) => row.id === "amount/amount:0" || row.id === "amount/amount:1/usage"),
		).toBe(false);
		expect(view.rows.filter((row) => row.id?.startsWith("window/")).length).toBe(3);
	});

	test.each([
		"en",
		"zh-CN",
	])("real expiry wins over numeric progress and unlimited allowance (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		for (const unlimited of [false, true]) {
			const data = { ...subscriptionQuota(), unlimited, expiresAt: "2026-11-15T00:00:00Z" };
			const view = requireView(
				buildProviderQuotaView(snapshot({ data }), translate, false, false, quotaNow),
			);
			expect(formatQuotaBadgeText(view, translate)).toBe(translate("providerQuota.expired"));
			expect(view.windows).toEqual([]);
			expect(view.limiting).toBeNull();
			expect(view.level).toBe("exhausted");
			expect(view.rows).toContainEqual({
				id: "meta/status",
				label: translate("providerQuota.status"),
				value: translate("providerQuota.expiredDetail"),
			});
			expect(formatQuotaSummaryLines(view, quotaNow, translate).join("\n")).toContain(
				translate("providerQuota.expiredDetail"),
			);
		}
	});

	test("unknown expiry and absent subscription limits never imply expiry, zero or unlimited", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: { ...subscriptionQuota(), expiresAt: "not-a-time" },
				}),
				t,
				false,
				false,
				quotaNow,
			),
		);
		expect(view.windows).toHaveLength(3);
		expect(view.rows.some((row) => row.id === "meta/status")).toBe(false);
		for (const subscription of [{}, { daily_limit_usd: 0, daily_usage_usd: 0 }]) {
			const balance = parseSub2ApiBalance({
				mode: "unrestricted",
				isValid: true,
				unit: "USD",
				planName: "Plan",
				subscription,
			});
			if (!balance) throw new Error("expected unknown subscription");
			const unknown = requireView(
				buildProviderQuotaView(
					snapshot({ data: relayQuotaData(balance, "sub2api") }),
					t,
					false,
					false,
					quotaNow,
				),
			);
			expect(unknown.windows).toEqual([]);
			expect(unknown.level).toBe("unknown");
			expect(formatQuotaBadgeText(unknown, t)).toBe("Unknown");
		}
	});

	test("window precision and zero totals are judged independently of rounded badge percentages", () => {
		for (const usedPercent of [undefined, 100]) {
			const view = requireView(
				buildProviderQuotaView(
					snapshot({
						data: {
							amounts: [],
							windows: [
								{
									id: "small",
									used: 99.6,
									limit: 100,
									remaining: 0.4,
									resetAt: null,
									...(usedPercent === undefined ? {} : { usedPercent }),
								},
							],
						},
					}),
					t,
				),
			);
			expect(view.windows[0]?.remainingPercent).toBe(0);
			expect(view.level).toBe("critical");
			expect(formatQuotaBadgeText(view, t)).not.toMatch(/exhausted/i);
		}
		const zero = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [],
						windows: [{ id: "zero", used: 0, limit: 0, remaining: 0, resetAt: null }],
					},
				}),
				t,
			),
		);
		expect(zero.windows[0]).toMatchObject({
			used: 0,
			limit: 0,
			remainingPercent: null,
			level: "exhausted",
		});
	});

	test("percent-only and rate-limited windows remain honest without numeric limits", () => {
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [],
						windows: [
							{
								id: "percent",
								used: null,
								limit: null,
								remaining: null,
								usedPercent: 75,
								resetAt: null,
							},
							{
								id: "blocked",
								used: null,
								limit: null,
								remaining: null,
								status: "rate-limited",
								resetAt: null,
							},
						],
					},
				}),
				t,
			),
		);
		expect(view.windows[0]).toMatchObject({
			remainingPercent: 25,
			used: null,
			limit: null,
			level: "warning",
		});
		expect(view.windows[1]).toMatchObject({ remainingPercent: null, level: "exhausted" });
		expect(view.limiting?.id).toBe("blocked");
	});

	test("same-account stale good values stay visible; fixed error details are admin-only", () => {
		const failed = snapshot({
			status: "error",
			error: "request_failed",
			stale: true,
			attemptedAt: 200,
		});
		const view = requireView(buildProviderQuotaView(failed, t));
		expect(view.rows[0]?.value).toBe("credits 37.5");
		expect(view.windows[0]?.remainingPercent).toBe(60);
		expect(view.failed).toBe(true);
		expect(view.fetchedAt).toBe(100);
		expect(view.failureDetail).toBeNull();
		expect(buildProviderQuotaView(failed, t, true)?.failureDetail).toBe(
			"The quota request failed.",
		);
		expect(buildProviderQuotaView(snapshot(), t, false, true)?.failed).toBe(true);
	});

	test.each([
		["admin", "en"],
		["user", "en"],
		["admin", "zh-CN"],
		["user", "zh-CN"],
	])("unavailable sources hide both empty and cached quotas (%s, %s)", (role, locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const unavailableStates: Partial<ProviderQuotaSnapshot>[] = [
			{ status: "unavailable", error: null },
			{ status: "unavailable", error: "request_failed" },
			{ status: "supported", error: "unavailable" },
			{ status: "error", error: "unavailable" },
			{ status: "pending", error: "unavailable" },
			{ status: "probing", error: "unavailable" },
			{ status: "unsupported", error: "unavailable" },
		];
		for (const state of unavailableStates) {
			for (const data of [null, snapshot().data]) {
				const unavailable = snapshot({ ...state, data, stale: true });
				for (const queryFailed of [false, true]) {
					expect(
						buildProviderQuotaView(unavailable, translate, role === "admin", queryFailed),
					).toBeNull();
				}
			}
		}
	});

	test.each(["en", "zh-CN"])("reinstalling a supported source restores its view (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const good = snapshot();
		expect(buildProviderQuotaView(good, translate)).not.toBeNull();
		expect(
			buildProviderQuotaView(
				{ ...good, status: "unavailable", error: "unavailable", version: 2 },
				translate,
			),
		).toBeNull();
		const restored = requireView(buildProviderQuotaView(snapshot({ version: 3 }), translate));
		expect(restored.rows[0]?.value).toBe("credits 37.5");
		expect(restored.windows[0]?.remainingPercent).toBe(60);
		expect(restored.failed).toBe(false);
	});

	test.each([
		["admin", "en"],
		["user", "en"],
		["admin", "zh-CN"],
		["user", "zh-CN"],
	])("real request and permission failures keep quota data and diagnostics (%s, %s)", (role, locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		for (const error of [
			"request_failed",
			"permission_denied",
			"auth_failed",
			"timeout",
		] as const) {
			const failed = snapshot({ status: "error", error, stale: true });
			const view = requireView(buildProviderQuotaView(failed, translate, role === "admin"));
			expect(view.rows[0]?.value).toBe("credits 37.5");
			expect(view.windows[0]?.remainingPercent).toBe(60);
			expect(view.failed).toBe(true);
			expect(view.failureDetail).toBe(
				role === "admin" ? translate(`providerQuota.errors.${error}`) : null,
			);
		}
	});

	test.each([
		"en",
		"zh-CN",
	])("real zero balances and unavailable accounts remain visible (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [{ id: "wallet", unit: "USD", remaining: 0 }],
						windows: [],
						available: false,
					},
				}),
				translate,
			),
		);
		expect(formatQuotaBadgeText(view, translate)).toBe("USD 0");
		expect(view.level).toBe("exhausted");
		expect(view.rows).toContainEqual({
			id: "meta/availability",
			label: translate("providerQuota.availability"),
			value: translate("providerQuota.accountUnavailable"),
		});
	});

	test.each([
		"en",
		"zh-CN",
	])("scope and site group stay in details, not the amount badge (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const view = requireView(
			buildProviderQuotaView(
				snapshot({
					data: {
						amounts: [{ id: "credit", unit: "USD", remaining: 1.2345, remainingText: "1.2345" }],
						windows: [],
						scope: "wallet",
						planName: "Site group",
					},
				}),
				translate,
			),
		);
		expect(formatQuotaBadgeText(view, translate)).toBe("USD 1.2345");
		expect(view.rows).toContainEqual({
			id: "meta/scope",
			label: translate("providerQuota.scope"),
			value: translate("providerQuota.scopes.wallet"),
		});
		expect(formatQuotaSummaryLines(view, 0, translate).join("\n")).toContain("Site group");
		expect(formatQuotaBadgeText(view, translate)).not.toContain(
			translate("providerQuota.scopes.wallet"),
		);
		const arbitrary = requireView(
			buildProviderQuotaView(
				snapshot({ data: { amounts: [], windows: [], scope: "Third-party scope" } }),
				translate,
			),
		);
		expect(arbitrary.rows).toContainEqual({
			id: "meta/scope",
			label: translate("providerQuota.scope"),
			value: "Third-party scope",
		});
	});

	test.each([
		"en",
		"zh-CN",
	])("auth_failed stays distinct and an empty authoritative error has no old values (%s)", (locale) => {
		const translate = i18n.getFixedT(locale, "narrator");
		const failed = snapshot({ status: "error", error: "auth_failed", data: null });
		const view = requireView(buildProviderQuotaView(failed, translate, true));
		expect(view.rows).toEqual([]);
		expect(view.windows).toEqual([]);
		expect(view.failureDetail).toBe(translate("providerQuota.errors.auth_failed"));
		expect(view.failureDetail).not.toBe(translate("providerQuota.errors.request_failed"));
		expect(view.failureDetail).toContain("401/403");
		expect(buildProviderQuotaView(failed, translate, false)?.failureDetail).toBeNull();
	});

	test("exact reported decimals stay nonzero and invalid cached spellings never replace numbers", () => {
		expect(
			formatProviderQuotaAmount(
				{ id: "credit", unit: "USD", remaining: 0.0000000000004, remainingText: "0.0000000000004" },
				t,
			),
		).toBe("USD 0.0000000000004");
		expect(
			formatProviderQuotaAmount({ id: "credit", unit: "USD", remaining: 0, remainingText: "9" }, t),
		).toBe("USD 0");
	});

	test("locales omit plugin-unavailable hints but keep genuine error and account diagnostics", () => {
		for (const messages of [en, zh]) {
			expect(messages.providerQuota).not.toHaveProperty("unavailable");
			expect(messages.providerQuota.errors).not.toHaveProperty("unavailable");
			expect(messages.providerQuota.accountUnavailable).toBeTruthy();
			expect(messages.providerQuota.errors.request_failed).toBeTruthy();
			expect(messages.providerQuota.errors.permission_denied).toBeTruthy();
		}
	});
});

test("account replacement or a different provider hides old diagnostic snapshots immediately", () => {
	for (const identity of [
		{ providerId: "p1", generation: "account-B" },
		{ providerId: "p2", generation: "account-A" },
		{ providerId: "p1", generation: undefined },
	]) {
		expect(matchesProviderQuotaIdentity(snapshot(), identity.providerId, identity.generation)).toBe(
			false,
		);
	}
	expect(matchesProviderQuotaIdentity(snapshot(), "p1", "account-A")).toBe(true);
});
