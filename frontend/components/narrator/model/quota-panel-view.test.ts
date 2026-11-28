import { describe, expect, test } from "bun:test";
import {
	formatQuotaAmount,
	formatQuotaBadgeText,
	formatQuotaCountdown,
	formatQuotaSummaryLines,
	pickLimitingWindow,
	type QuotaPanelView,
	quotaLevelForRemaining,
	quotaWindowFromAmounts,
} from "./quota-panel-view";

const t = (key: string, options?: Record<string, unknown>) =>
	options ? `${key}[${Object.values(options).join(",")}]` : key;

function view(overrides: Partial<QuotaPanelView> = {}): QuotaPanelView {
	return {
		title: "title",
		unavailableText: "unavailable",
		windows: [],
		limiting: null,
		level: "unknown",
		rows: [],
		failed: false,
		failureDetail: null,
		fetchedAt: 0,
		...overrides,
	};
}

describe("quota panel view", () => {
	test.each([
		[0, "0"],
		[42, "42"],
		[1.2, "1.2"],
		[1.2345, "1.23"],
		[0.004, "0.004"],
		[0.001, "0.001"],
		[1e-8, "0.00000001"],
		[-0.004, "-0.004"],
	] as const)("formats %s compactly without turning a nonzero allowance into zero", (value, expected) => {
		expect(formatQuotaAmount(value)).toBe(expected);
	});
	test("levels follow the 25% / 10% remaining thresholds", () => {
		expect(quotaLevelForRemaining(null)).toBe("unknown");
		expect(quotaLevelForRemaining(26)).toBe("ok");
		expect(quotaLevelForRemaining(25)).toBe("warning");
		expect(quotaLevelForRemaining(10)).toBe("critical");
		expect(quotaLevelForRemaining(0)).toBe("exhausted");
		expect(quotaLevelForRemaining(80, true)).toBe("exhausted");
	});

	test("amounts are clamped into a percentage", () => {
		const over = quotaWindowFromAmounts({
			id: "w",
			label: "W",
			shortLabel: "w",
			used: 120,
			limit: 100,
		});
		expect(over.usedPercent).toBe(100);
		expect(over.level).toBe("exhausted");
		const noLimit = quotaWindowFromAmounts({
			id: "w",
			label: "W",
			shortLabel: "w",
			used: 1,
			limit: 0,
		});
		expect(noLimit.usedPercent).toBeNull();
		expect(noLimit.limit).toBe(0);
		expect(noLimit.used).toBe(1);
		expect(noLimit.level).toBe("exhausted");
	});

	test("positive fractions never become exhausted because the badge rounds to zero percent", () => {
		const window = quotaWindowFromAmounts({
			id: "tiny",
			label: "Tiny",
			shortLabel: "T",
			used: 99.6,
			limit: 100,
			remaining: 0.4,
		});
		expect(window.remainingPercent).toBe(0);
		expect(window.level).toBe("critical");
		expect(formatQuotaBadgeText(view({ windows: [window], limiting: window }), t)).toBe(
			"quotaPanel.badgeRemaining[T,0]",
		);
	});

	test("unknown and nonfinite window values stay unknown while a true zero limit stays known", () => {
		const unknown = quotaWindowFromAmounts({
			id: "unknown",
			label: "Unknown",
			shortLabel: "?",
			used: Number.NaN,
			limit: Number.POSITIVE_INFINITY,
			remaining: Number.NaN,
		});
		expect(unknown).toMatchObject({
			used: null,
			limit: null,
			remainingPercent: null,
			level: "unknown",
		});
		const overflow = quotaWindowFromAmounts({
			id: "large",
			label: "Large",
			shortLabel: "L",
			used: null,
			limit: Number.MAX_VALUE,
			remaining: -Number.MAX_VALUE,
		});
		expect(overflow.used).toBeNull();
		expect(overflow.level).toBe("exhausted");
		const zero = quotaWindowFromAmounts({
			id: "zero",
			label: "Zero",
			shortLabel: "0",
			used: 0,
			limit: 0,
			remaining: 0,
		});
		expect(zero).toMatchObject({ used: 0, limit: 0, remainingPercent: null, level: "exhausted" });
	});

	test("an authoritative badge status takes precedence over a positive limiting window", () => {
		const window = quotaWindowFromAmounts({
			id: "w",
			label: "W",
			shortLabel: "w",
			used: 1,
			limit: 10,
		});
		expect(
			formatQuotaBadgeText(view({ windows: [window], limiting: window, badgeText: "Expired" }), t),
		).toBe("Expired");
	});

	test("an exhausted window that refills last bounds the account", () => {
		const a = { level: "exhausted" as const, remainingPercent: 0, resetAt: 10 };
		const b = { level: "exhausted" as const, remainingPercent: 0, resetAt: 20 };
		const c = { level: "ok" as const, remainingPercent: 50, resetAt: null };
		expect(pickLimitingWindow([c, a, b])).toBe(b);
		expect(pickLimitingWindow([])).toBeNull();
	});

	test("badge text names the limiting window or falls back to the placeholder", () => {
		const window = quotaWindowFromAmounts({
			id: "w",
			label: "Weekly",
			shortLabel: "Wk",
			used: 30,
			limit: 100,
		});
		expect(formatQuotaBadgeText(view({ windows: [window], limiting: window }), t)).toBe(
			"quotaPanel.badgeRemaining[Wk,70]",
		);
		expect(formatQuotaBadgeText(view(), t)).toBe("unavailable");
	});

	test("summary uses the same explicit reset caption as the panel", () => {
		const window = quotaWindowFromAmounts({
			id: "w",
			label: "W",
			shortLabel: "w",
			used: 1,
			limit: 10,
			resetAt: 90_000,
		});
		window.resetCaptionKey = "quotaPanel.expiryCaption";
		expect(formatQuotaSummaryLines(view({ windows: [window] }), 0, t)).toEqual([
			"W: quotaPanel.remainingPercent[90] · quotaPanel.usedOfLimit[1,10] · quotaPanel.expiryCaption[quotaPanel.countdownM[2]]",
		]);
	});

	test("countdown units", () => {
		expect(formatQuotaCountdown(0, t)).toBe("quotaPanel.resetDue");
		expect(formatQuotaCountdown(90_000, t)).toBe("quotaPanel.countdownM[2]");
		expect(formatQuotaCountdown(3 * 86_400_000 + 3_600_000, t)).toBe("quotaPanel.countdownDH[3,1]");
	});
});
