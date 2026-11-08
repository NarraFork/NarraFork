import { expect, test } from "bun:test";
import type { ProviderBalanceSnapshot } from "@shared/provider-balance";
import { createInstance } from "i18next";
import en from "../locales/en/settings.json";
import zh from "../locales/zh-CN/settings.json";
import { formatProviderBalance } from "./provider-balance-format";

const snapshot = (): ProviderBalanceSnapshot => ({
	generation: "A",
	status: "supported",
	adapter: "new-api",
	balance: {
		scope: "key",
		unlimited: false,
		amounts: [{ unit: "QUOTA", remaining: 0, used: 2, total: 2, window: "5h" }],
	},
	fetchedAt: 1000,
	attemptedAt: 1000,
	error: null,
});
for (const [lng, resource] of [
	["en", en],
	["zh-CN", zh],
] as const) {
	const i18n = createInstance();
	await i18n.init({
		lng,
		resources: { [lng]: { settings: resource } },
		defaultNS: "settings",
		interpolation: { escapeValue: false },
	});
	const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));
	test(`${lng}: zero quota preserves window and real unit, scope lives in the tooltip`, () => {
		const result = formatProviderBalance(snapshot(), t, false, 1000);
		expect(result.quotaBalance).not.toContain(t("providerBalance.key"));
		expect(result.quotaBalance).toContain(`5h: 0 ${t("providerBalance.quotaUnit")}`);
		expect(result.quotaBalance).not.toContain("USD");
		expect(result.detailedQuotaBalance).toContain(t("providerBalance.key"));
		expect(result.detailedQuotaBalance).toContain(
			t("providerBalance.used", { amount: `2 ${t("providerBalance.quotaUnit")}` }),
		);
		expect(result.detailedQuotaBalance).toContain(
			t("providerBalance.total", { amount: `2 ${t("providerBalance.quotaUnit")}` }),
		);
	});
	test(`${lng}: unlimited never displays placeholder numeric balance`, () => {
		const value = snapshot();
		if (!value.balance) throw new Error("Expected balance fixture");
		value.balance.unlimited = true;
		const result = formatProviderBalance(value, t, false, 1000);
		expect(result.quotaBalance).toContain(t("providerBalance.unlimited"));
		expect(result.detailedQuotaBalance).not.toContain("5h: 0");
		expect(result.detailedQuotaBalance).not.toContain(t("providerBalance.used", { amount: "2" }));
	});
	test(`${lng}: unknown, wallet, subscription and tokens do not become zero or dollars`, () => {
		const value = snapshot();
		if (!value.balance) throw new Error("Expected balance fixture");
		value.balance.scope = "subscription";
		value.balance.amounts = [{ unit: "TOKENS", remaining: null }];
		const result = formatProviderBalance(value, t, false, 1000);
		expect(result.detailedQuotaBalance).toContain(t("providerBalance.subscription"));
		expect(result.quotaBalance).toContain(t("providerBalance.unknown"));
		value.balance.amounts[0].remaining = -1;
		expect(formatProviderBalance(value, t, false, 1000).quotaBalance).toContain(
			`-1 ${t("providerBalance.tokens")}`,
		);
		value.balance.scope = "wallet";
		value.balance.amounts = [{ unit: "CNY", remaining: 1.25 }];
		expect(formatProviderBalance(value, t, false, 1000)).toEqual({
			quotaBalance: "CNY 1.25",
			detailedQuotaBalance: "CNY 1.25",
		});
	});
	test(`${lng}: wallet shows only the amount and currency, once in each display`, () => {
		const value = snapshot();
		value.adapter = "sub2api";
		value.balance = {
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 56561.8789152 }],
		};
		const result = formatProviderBalance(value, t, false, 1000);
		expect(result).toEqual({
			quotaBalance: "USD 56,561.8789152",
			detailedQuotaBalance: "USD 56,561.8789152",
		});
		expect(result.detailedQuotaBalance).not.toContain(t("providerBalance.wallet"));
		expect(result.detailedQuotaBalance).not.toContain("sub2api");
	});
	test(`${lng}: multiple wallet currencies have no repeated summary in the tooltip`, () => {
		const value = snapshot();
		value.balance = {
			scope: "wallet",
			unlimited: false,
			amounts: [
				{ unit: "CNY", remaining: 1.25 },
				{ unit: "USD", remaining: 1e-8 },
			],
		};
		expect(formatProviderBalance(value, t, false, 1000)).toEqual({
			quotaBalance: "CNY 1.25 / USD 0.00000001",
			detailedQuotaBalance: "CNY 1.25\nUSD 0.00000001",
		});
	});
	test(`${lng}: wallet failure keeps its amount and one useful status line`, () => {
		const value = snapshot();
		value.balance = { scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 0 }] };
		value.error = "request_failed";
		const result = formatProviderBalance(value, t, false, 1000);
		expect(result.quotaBalance).toContain("USD 0");
		expect(result.quotaBalance).not.toContain(t("providerBalance.wallet"));
		expect(result.detailedQuotaBalance.split("\n")).toEqual([
			"USD 0",
			`${t("providerBalance.failed")} · ${t("providerBalance.stale")}`,
		]);
	});
	test.each([
		"USD",
		"CNY",
		"EUR",
		"€",
	])(`${lng}: %s precedes all monetary amounts and quota details`, (unit) => {
		const value = snapshot();
		value.balance = {
			scope: "key",
			unlimited: false,
			amounts: [{ unit, remaining: -1.25, used: 2, total: 0.75 }],
		};
		const result = formatProviderBalance(value, t, false, 1000);
		expect(result.quotaBalance).toContain(`${unit} -1.25`);
		expect(result.detailedQuotaBalance).toContain(
			t("providerBalance.used", { amount: `${unit} 2` }),
		);
		expect(result.detailedQuotaBalance).toContain(
			t("providerBalance.total", { amount: `${unit} 0.75` }),
		);
	});
	test(`${lng}: tiny nonzero balances never round to zero`, () => {
		const value = snapshot();
		if (!value.balance) throw new Error("Expected balance fixture");
		value.balance.amounts = [{ unit: "USD", remaining: 1e-8 }];
		expect(formatProviderBalance(value, t, false, 1000).quotaBalance).toContain("USD 0.00000001");
		value.balance.amounts[0].remaining = -1e-8;
		expect(formatProviderBalance(value, t, false, 1000).quotaBalance).toContain("USD -0.00000001");
	});
	test(`${lng}: failure retains the last amount and marks it outdated`, () => {
		const value = snapshot();
		if (!value.balance) throw new Error("Expected balance fixture");
		value.error = "request_failed";
		const result = formatProviderBalance(value, t, false, 1000);
		expect(result.quotaBalance).toContain("5h: 0");
		expect(result.quotaBalance).toContain(t("providerBalance.failed"));
		expect(result.quotaBalance).toContain(t("providerBalance.stale"));
		expect(formatProviderBalance(snapshot(), t, false, 122_000).quotaBalance).toContain(
			t("providerBalance.stale"),
		);
	});
	test(`${lng}: pending/unsupported and missing balances never show fake zero`, () => {
		for (const status of ["pending", "probing", "unsupported", "error"] as const) {
			const value = snapshot();
			if (!value.balance) throw new Error("Expected balance fixture");
			value.status = status;
			value.balance = null;
			expect(formatProviderBalance(value, t).quotaBalance).toBe(t(`providerBalance.${status}`));
		}
	});
}
