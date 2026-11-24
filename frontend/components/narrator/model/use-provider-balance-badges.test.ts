import { describe, expect, test } from "bun:test";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import { createInstance } from "i18next";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { tokenDanceQuotaView } from "./tokendance-quota-format";
import {
	buildProviderIdByPrefix,
	buildProviderRefreshTargets,
} from "./use-model-menu-refresh-props";
import {
	buildProviderBalanceBadges,
	buildProviderQuotaBadges,
	type ProviderBalanceSources,
} from "./use-provider-balance-badges";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	defaultNS: "narrator",
});
const t = (key: string, options?: Record<string, unknown>) =>
	options ? `${key}:${JSON.stringify(options)}` : key;
function sources(overrides: Partial<ProviderBalanceSources>): ProviderBalanceSources {
	return {
		customApiProviders: [],
		nugProviders: [],
		isAdmin: false,
		now: 1_000_000,
		t,
		...overrides,
	};
}
const snapshot = (
	providerId: string,
	overrides: Partial<ProviderQuotaSnapshot> = {},
): ProviderQuotaSnapshot => ({
	providerId,
	targetId: `custom-api/${providerId}`,
	generation: "g1",
	sourceId: "independent.plugin:arbitrary-source",
	status: "supported",
	data: { amounts: [{ id: "wallet", unit: "CNY", remaining: 10 }], windows: [] },
	fetchedAt: 1,
	attemptedAt: 1,
	stale: false,
	error: null,
	version: 1,
	...overrides,
});
const windowData = {
	amounts: [],
	windows: [{ id: "hour", label: "Hourly", used: 25, limit: 100, remaining: 75, resetAt: null }],
};

describe("buildProviderBalanceBadges", () => {
	test("NUG balances and pushed custom API quotas are keyed by prefix", () => {
		const badges = buildProviderBalanceBadges(
			sources({
				nugProviders: [
					{ id: "n1", prefix: "nug2" },
					{ id: "n2", prefix: "off", disabled: true },
				],
				nugQuotas: { n1: { balance: 1559.75 }, n2: { balance: 3 } },
				customApiProviders: [{ id: "c1", prefix: "relay", baseUrl: "https://relay.example/v1" }],
				customApiQuotas: { c1: { quotaBalance: "$4.20", detailedQuotaBalance: "details" } },
			}),
		);
		expect(Object.keys(badges).sort()).toEqual(["nug2", "relay"]);
		expect(badges.relay).toEqual({ text: "$4.20", tooltip: "details" });
	});
	test("windowed sources use allowance bars without inspecting endpoint brands", () => {
		const input = sources({
			customApiProviders: [
				{ id: "k", prefix: "kimi", baseUrl: "https://api.kimi.com/coding/v1" },
				{ id: "o", prefix: "go", baseUrl: "https://unknown.example/v1" },
			],
			providerQuotas: {
				k: snapshot("k", { data: windowData }),
				o: snapshot("o", { data: windowData }),
			},
			providerQuotaGenerations: { k: "g1", o: "g1" },
		});
		expect(buildProviderBalanceBadges(input)).toEqual({});
		const bars = buildProviderQuotaBadges(input);
		expect(Object.keys(bars)).toEqual(["kimi", "go"]);
		expect(bars.go?.bars?.[0]).toMatchObject({ id: "hour", remainingPercent: 75 });
	});
	test("DeepSeek or any third-party balance from a replaced account is hidden", () => {
		const provider = { id: "d", prefix: "deepseek", baseUrl: "https://api.deepseek.com" };
		const input = sources({
			customApiProviders: [provider],
			providerQuotas: { d: snapshot("d") },
			providerQuotaGenerations: { d: "g1" },
		});
		expect(buildProviderBalanceBadges(input).deepseek?.text).toBe("CNY 10");
		expect(buildProviderBalanceBadges({ ...input, providerQuotaGenerations: { d: "g2" } })).toEqual(
			{},
		);
		expect(
			buildProviderBalanceBadges({
				...input,
				customApiProviders: [{ ...provider, prefix: "renamed" }],
			}).renamed?.text,
		).toBe("CNY 10");
	});
	test("pushed text always suppresses stale plugin amounts and windows", () => {
		for (const data of [snapshot("p").data, windowData]) {
			const input = sources({
				customApiProviders: [{ id: "p", prefix: "example" }],
				providerQuotaGenerations: { p: "g1" },
				providerQuotas: { p: snapshot("p", { data, stale: true, error: "timeout" }) },
				customApiQuotas: { p: { quotaBalance: "0", detailedQuotaBalance: "Live" } },
			});
			expect(buildProviderBalanceBadges(input).example).toEqual({ text: "0", tooltip: "Live" });
			expect(buildProviderQuotaBadges(input)).toEqual({});
		}
	});
	test("only reported amounts become badges; scope/group stay in the tooltip", () => {
		const translate = i18n.getFixedT("en", "narrator");
		const input = sources({
			customApiProviders: [{ id: "p", prefix: "site" }],
			providerQuotaGenerations: { p: "g1" },
			providerQuotas: {
				p: snapshot("p", {
					pushCompatible: false,
					data: {
						amounts: [{ id: "credit", unit: "USD", remaining: 0 }],
						windows: [],
						scope: "wallet",
						planName: "Site group",
					},
				}),
			},
			t: translate,
		});
		const badge = buildProviderBalanceBadges(input).site;
		expect(badge?.text).toBe("USD 0");
		expect(badge?.tooltip).toContain("Wallet balance");
		expect(badge?.tooltip).toContain("Site group");
		for (const status of ["pending", "probing", "unsupported", "error"] as const) {
			expect(
				buildProviderBalanceBadges({
					...input,
					providerQuotas: { p: snapshot("p", { status, data: null }) },
				}),
			).toEqual({});
		}
	});

	test("disabled quota capability hides cached amounts/windows but keeps independent pushes and NUG", () => {
		const input = sources({
			customApiProviders: [
				{ id: "amount", prefix: "amount" },
				{ id: "window", prefix: "window" },
				{ id: "push", prefix: "push" },
			],
			providerQuotaGenerations: { amount: "g1", window: "g1", push: "g1" },
			providerQuotas: {
				amount: snapshot("amount"),
				window: snapshot("window", { data: windowData }),
				push: snapshot("push"),
			},
			customApiQuotas: {
				push: { generation: "g1", quotaBalance: "0", detailedQuotaBalance: "Live" },
			},
			nugProviders: [{ id: "n", prefix: "nug" }],
			nugQuotas: { n: { balance: 8 } },
			quotaCapabilityEnabled: false,
		});
		expect(buildProviderBalanceBadges(input)).toEqual({
			nug: { text: "8", tooltip: undefined },
			push: { text: "0", tooltip: "Live" },
		});
		expect(buildProviderQuotaBadges(input)).toEqual({});
		expect(
			buildProviderBalanceBadges({ ...input, quotaCapabilityEnabled: true }).amount?.text,
		).toBe("CNY 10");
		expect(
			buildProviderQuotaBadges({ ...input, quotaCapabilityEnabled: true }).window?.bars?.[0]
				?.remainingPercent,
		).toBe(75);
	});

	test("same-identity good values remain dimmed on a failed refresh", () => {
		const input = sources({
			customApiProviders: [{ id: "p", prefix: "example" }],
			providerQuotaGenerations: { p: "g1" },
			providerQuotas: { p: snapshot("p", { stale: true, error: "timeout" }) },
		});
		expect(buildProviderBalanceBadges(input).example).toMatchObject({
			text: "CNY 10",
			stale: true,
		});
	});
	test.each([
		["admin", "en"],
		["user", "en"],
		["admin", "zh-CN"],
		["user", "zh-CN"],
	])("unavailable cached amount/window badges disappear and reinstall recovers (%s, %s)", (role, locale) => {
		const input = sources({
			customApiProviders: [
				{ id: "a", prefix: "amount" },
				{ id: "w", prefix: "window" },
			],
			providerQuotaGenerations: { a: "g1", w: "g1" },
			providerQuotas: {
				a: snapshot("a"),
				w: snapshot("w", { data: windowData }),
			},
			isAdmin: role === "admin",
			t: i18n.getFixedT(locale, "narrator"),
		});
		expect(buildProviderBalanceBadges(input).amount?.text).toBe("CNY 10");
		expect(buildProviderQuotaBadges(input).window?.bars?.[0]?.remainingPercent).toBe(75);
		const unavailableStates: Partial<ProviderQuotaSnapshot>[] = [
			{ status: "unavailable", error: null },
			{ status: "unavailable", sourceId: null, error: "unavailable" },
			{ status: "supported", error: "unavailable" },
			{ status: "error", error: "unavailable" },
		];
		for (const state of unavailableStates) {
			const revoked = {
				...input,
				quotaQueryFailed: true,
				providerQuotas: {
					a: snapshot("a", { ...state, stale: true }),
					w: snapshot("w", { ...state, data: windowData, stale: true }),
				},
			};
			expect(buildProviderBalanceBadges(revoked)).toEqual({});
			expect(buildProviderQuotaBadges(revoked)).toEqual({});
		}
		const restored = {
			...input,
			providerQuotas: {
				a: snapshot("a", {
					data: { amounts: [{ id: "wallet", unit: "CNY", remaining: 0 }], windows: [] },
					version: 3,
				}),
				w: snapshot("w", {
					data: {
						amounts: [],
						windows: [{ ...windowData.windows[0], used: 100, remaining: 0 }],
					},
					version: 3,
				}),
			},
		};
		expect(buildProviderBalanceBadges(restored).amount).toMatchObject({
			text: "CNY 0",
			stale: false,
		});
		expect(buildProviderQuotaBadges(restored).window?.bars?.[0]).toMatchObject({
			remainingPercent: 0,
			level: "exhausted",
		});
	});
	test("quota plugin unavailability only affects Custom API; NUG and platform balances are unchanged", () => {
		const tokenDance = {
			generation: 7,
			data: {
				generation: 7,
				credits: 20_000_000,
				creditsUsed: 5_000_000,
				balance: 15_000_000,
				updatedAt: 1,
				loading: false,
				hasError: false,
			},
		};
		const expected = tokenDanceQuotaView(tokenDance.data, 7, false, t);
		if (!expected) throw new Error("expected TokenDance platform view");
		const input = sources({
			customApiProviders: [
				{ id: "p", prefix: "example" },
				{ id: "live", prefix: "pushed" },
			],
			providerQuotaGenerations: { p: "g1", live: "g1" },
			providerQuotas: {
				p: snapshot("p", {
					status: "unavailable",
					data: null,
					sourceId: null,
					error: "unavailable",
				}),
				live: snapshot("live", { status: "error", error: "unavailable", data: windowData }),
			},
			customApiQuotas: { live: { quotaBalance: "0", detailedQuotaBalance: "Live details" } },
			nugProviders: [
				{ id: "n", prefix: "nug" },
				{ id: "zero", prefix: "nugZero" },
			],
			nugQuotas: {
				n: { balance: 8, detailedQuotaBalance: "NUG details" },
				zero: { balance: 0 },
			},
			tokenDance,
		});
		const badges = buildProviderBalanceBadges(input);
		expect(badges.example).toBeUndefined();
		expect(badges.pushed).toEqual({ text: "0", tooltip: "Live details" });
		expect(badges.nug).toEqual({ text: "8", tooltip: "NUG details" });
		expect(badges.nugZero).toEqual({ text: "0", tooltip: undefined });
		expect(buildProviderQuotaBadges(input)).toEqual({});
		expect(badges.tokendance).toEqual({
			text: expected.balance,
			tooltip: expected.detailsText,
			stale: false,
		});
		expect(badges.codex).toBeUndefined();
		expect(badges.CommandCode).toBeUndefined();
	});
});

describe("buildProviderRefreshTargets", () => {
	test("maps every protocol's prefix to its refresh endpoint", () => {
		const settings = {
			openaiProviders: [{ id: "o", prefix: "oa" }],
			anthropicProviders: [{ id: "a", prefix: "an" }],
			geminiProviders: [{ id: "g", prefix: "ge", disabled: true }],
			nugProviders: [{ id: "n", prefix: "nug" }],
		};
		expect(buildProviderRefreshTargets(settings, { nug: true, admin: false })).toEqual({
			oa: { kind: "openai", id: "o" },
			an: { kind: "anthropic", id: "a" },
			nug: { kind: "nug", id: "n" },
		});
		const admin = buildProviderRefreshTargets(settings, { nug: false, admin: true });
		expect(admin.nug).toBeUndefined();
		expect(admin.CommandCode).toEqual({ kind: "commandcode" });
		expect(admin.tokendance).toEqual({ kind: "tokendance" });
	});
});

describe("buildProviderIdByPrefix", () => {
	test("links the settings button by provider id, not by model prefix", () => {
		expect(
			buildProviderIdByPrefix(
				{
					customApiProviders: [{ id: "c1", prefix: "xiaomi" }],
					nugProviders: [{ id: "n1", prefix: "nugjp" }],
				},
				{ other: "n2" },
			),
		).toEqual({ xiaomi: "c1", nugjp: "n1", other: "n2" });
	});
});
