import { describe, expect, test } from "bun:test";
import type { CodexUsageResult } from "../codex-usage";
import {
	buildCodexUsageForecast,
	buildCodexUsageSummary,
	getScheduledUsageResetAt,
	isZeroUsageAccount,
	normalizeCodexPlanTier,
} from "../codex-usage-summary";

function usage(
	planType: string,
	primary: { used: number; remaining: number; resetAt: number },
	secondary?: { used: number; remaining: number; resetAt: number },
): CodexUsageResult {
	return {
		plan_type: planType,
		primary_window: {
			used_percent: primary.used,
			remaining_percent: primary.remaining,
			reset_at: primary.resetAt,
			reset_after_seconds: 0,
			window_type: "5h",
		},
		...(secondary
			? {
					secondary_window: {
						used_percent: secondary.used,
						remaining_percent: secondary.remaining,
						reset_at: secondary.resetAt,
						reset_after_seconds: 0,
						window_type: "weekly" as const,
					},
				}
			: {}),
		queriedAt: new Date(0).toISOString(),
	};
}

describe("Codex usage summary", () => {
	test("normalizes Codex plan tiers", () => {
		expect(normalizeCodexPlanTier("free")).toBe("free");
		expect(normalizeCodexPlanTier("plus")).toBe("plus");
		expect(normalizeCodexPlanTier("pro_lite")).toBe("prolite");
		expect(normalizeCodexPlanTier("prolite")).toBe("prolite");
		expect(normalizeCodexPlanTier("pro")).toBe("pro");
		expect(normalizeCodexPlanTier("team")).toBe("other");
	});

	test("zero-usage accounts are not scheduled", () => {
		const zeroUsage = usage("plus", { used: 0, remaining: 100, resetAt: 2_000 });

		expect(isZeroUsageAccount(zeroUsage)).toBe(true);
		expect(getScheduledUsageResetAt(zeroUsage)).toBeUndefined();
	});

	test("summarizes tiers independently and uses the tightest active window", () => {
		const now = 1_000_000;
		const summary = buildCodexUsageSummary(
			[
				{
					id: "plus-a",
					usage: usage(
						"plus",
						{ used: 20, remaining: 80, resetAt: (now + 60_000) / 1000 },
						{ used: 60, remaining: 40, resetAt: (now + 120_000) / 1000 },
					),
				},
				{
					id: "pro-a",
					usage: usage("pro", { used: 0, remaining: 100, resetAt: (now + 60_000) / 1000 }),
				},
				{
					id: "manual",
					disabled: true,
					disabledReason: "manual",
					usage: usage("plus", { used: 50, remaining: 50, resetAt: (now + 60_000) / 1000 }),
				},
			],
			now,
		);

		expect(summary.byTier.plus.accountCount).toBe(1);
		expect(summary.byTier.plus.remainingAccountEquivalents).toBe(0.4);
		expect(summary.byTier.plus.averageRemainingPercent).toBe(40);
		expect(summary.byTier.plus.scheduledAccountCount).toBe(1);
		expect(summary.byTier.pro.accountCount).toBe(1);
		expect(summary.byTier.pro.zeroUsageCount).toBe(1);
		expect(summary.byTier.pro.scheduledAccountCount).toBe(0);
	});

	test("forecast restores each tier at its own reset time", () => {
		const now = 1_000_000;
		const plusReset = now + 60_000;
		const proReset = now + 120_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-a",
					usage: usage("plus", { used: 50, remaining: 50, resetAt: plusReset / 1000 }),
				},
				{
					id: "pro-a",
					usage: usage("pro", { used: 20, remaining: 80, resetAt: proReset / 1000 }),
				},
			],
			now,
		);

		expect(forecast.points).toHaveLength(3);
		expect(forecast.points[0]?.byTier.plus).toBe(0.5);
		expect(forecast.points[0]?.byTier.pro).toBe(0.8);
		expect(forecast.points[1]?.timestamp).toBe(plusReset);
		expect(forecast.points[1]?.byTier.plus).toBe(1);
		expect(forecast.points[1]?.byTier.pro).toBe(0.8);
		expect(forecast.points[2]?.timestamp).toBe(proReset);
		expect(forecast.points[2]?.byTier.plus).toBe(1);
		expect(forecast.points[2]?.byTier.pro).toBe(1);
	});
});
