import { describe, expect, test } from "bun:test";
import type { TokenDanceBalance } from "@shared/tokendance";
import { formatTokenDanceAmount, tokenDanceQuotaView } from "./tokendance-quota-format";

const t = (key: string, values?: Record<string, string>) =>
	`${key}${values ? JSON.stringify(values) : ""}`;
const balance = (value: number | null): TokenDanceBalance => ({
	generation: 7,
	credits: 58_000_000,
	creditsUsed: 57_837_189,
	balance: value,
	updatedAt: 1_000_000,
	loading: false,
	hasError: false,
});
const view = (value: number | null, admin = true) =>
	tokenDanceQuotaView(balance(value), 7, admin, t, "en", 1_000_000);

describe("TokenDance narrator balance", () => {
	test("converts integer micro-CNY without losing small positive balances", () => {
		expect(formatTokenDanceAmount(162811, "en")).toBe("0.162811");
		expect(formatTokenDanceAmount(1, "en")).toBe("0.000001");
		expect(formatTokenDanceAmount(0, "en")).toBe("0.00");
		expect(formatTokenDanceAmount(-1, "en")).toBe("-0.000001");
		expect(formatTokenDanceAmount(58_000_000, "zh-CN")).toBe("58.00");
	});
	test("positive balance shows recharge only in details with total and used amounts", () => {
		const result = view(162811);
		expect(result?.showRechargeButton).toBe(false);
		expect(result?.showRechargeInDetails).toBe(true);
		expect(result?.detailsText).toContain('"credits":"58.00"');
		expect(result?.detailsText).toContain('"used":"57.837189"');
		expect(result?.balance).toContain("0.162811");
	});
	test.each([0, -1000])("zero or debt exposes the direct recharge entry (%s)", (value) => {
		expect(view(value)?.showRechargeButton).toBe(true);
		expect(view(value)?.showRechargeInDetails).toBe(false);
	});
	test("missing balance is unknown rather than zero and stays manually actionable", () => {
		expect(view(null)?.balance).toBe("tokendanceBalanceUnknown");
		expect(view(null)?.showRechargeButton).toBe(true);
		expect(tokenDanceQuotaView(undefined, 7, true, t)?.balance).toBe("tokendanceBalanceUnknown");
	});
	test("non-admins get contact-admin guidance, never payment controls", () => {
		const result = view(0, false);
		expect(result?.detailsText).toContain("tokendanceAdminRechargeRequired");
		expect(result?.showRechargeButton).toBe(false);
		expect(result?.showRechargeInDetails).toBe(false);
		expect(view(10, false)?.showRechargeInDetails).toBe(false);
	});
	test("old connection data cannot masquerade as the new balance", () => {
		const result = tokenDanceQuotaView(balance(162811), 8, true, t);
		expect(result?.balance).toBe("tokendanceBalanceUnknown");
		expect(result?.detailsText).not.toContain("162811");
		expect(tokenDanceQuotaView(balance(162811), undefined, true, t)).toBeNull();
	});
	test("upstream errors and stale snapshots are identified without dropping known values", () => {
		const result = tokenDanceQuotaView(
			{ ...balance(162811), hasError: true },
			7,
			true,
			t,
			"en",
			1_000_000,
		);
		expect(result?.balance).toContain("0.162811");
		expect(result?.detailsText).toContain("tokendanceBalanceStale");
		expect(
			tokenDanceQuotaView(balance(162811), 7, true, t, "en", 1_090_001)?.detailsText,
		).toContain("tokendanceBalanceStale");
	});
	test("invalid numeric data is not presented as a real balance", () => {
		expect(view(Number.NaN)?.balance).toBe("tokendanceBalanceUnknown");
		expect(view(1.5)?.balance).toBe("tokendanceBalanceUnknown");
	});
});
