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

function weeklyOnlyUsage(
	planType: string,
	weekly: { used: number; remaining: number; resetAt: number },
): CodexUsageResult {
	return {
		plan_type: planType,
		primary_window: {
			used_percent: weekly.used,
			remaining_percent: weekly.remaining,
			reset_at: weekly.resetAt,
			reset_after_seconds: 0,
			window_type: "weekly",
		},
		queriedAt: new Date(0).toISOString(),
	};
}

describe("Codex usage summary", () => {
	test("normalizes Codex plan tiers", () => {
		expect(normalizeCodexPlanTier("free")).toBe("free");
		expect(normalizeCodexPlanTier("plus")).toBe("plus");
		expect(normalizeCodexPlanTier("team")).toBe("team");
		expect(normalizeCodexPlanTier("business")).toBe("team");
		expect(normalizeCodexPlanTier("pro_lite")).toBe("prolite");
		expect(normalizeCodexPlanTier("prolite")).toBe("prolite");
		expect(normalizeCodexPlanTier("pro")).toBe("pro");
		expect(normalizeCodexPlanTier("enterprise")).toBe("other");
	});

	test("zero-usage accounts are not scheduled", () => {
		const zeroUsage = usage("plus", { used: 0, remaining: 100, resetAt: 2_000 });

		expect(isZeroUsageAccount(zeroUsage)).toBe(true);
		expect(getScheduledUsageResetAt(zeroUsage)).toBeUndefined();
	});

	test("summarizes tiers with 5h quota while non-exhausted weekly window stays separate", () => {
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
					id: "team-a",
					usage: usage("team", { used: 25, remaining: 75, resetAt: (now + 90_000) / 1000 }),
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
		expect(summary.byTier.plus.remainingAccountEquivalents).toBe(0.8);
		expect(summary.byTier.plus.averageRemainingPercent).toBe(80);
		expect(summary.byTier.plus.scheduledAccountCount).toBe(1);
		expect(summary.byTier.plus.nextResetAt).toBe(now + 60_000);
		expect(summary.byTier.team.accountCount).toBe(1);
		expect(summary.byTier.team.remainingAccountEquivalents).toBe(0.75);
		expect(summary.byTier.team.scheduledAccountCount).toBe(1);
		expect(summary.byTier.pro.accountCount).toBe(1);
		expect(summary.byTier.pro.zeroUsageCount).toBe(1);
		expect(summary.byTier.pro.scheduledAccountCount).toBe(0);
	});

	test("weekly exhaustion blocks 5h quota until weekly reset", () => {
		const now = 1_000_000;
		const shortReset = now + 60_000;
		const weeklyReset = now + 120_000;
		const exhausted = usage(
			"plus",
			{ used: 20, remaining: 80, resetAt: shortReset / 1000 },
			{ used: 100, remaining: 0, resetAt: weeklyReset / 1000 },
		);
		const summary = buildCodexUsageSummary([{ id: "plus-a", usage: exhausted }], now);

		expect(summary.byTier.plus.remainingAccountEquivalents).toBe(0);
		expect(summary.byTier.plus.averageRemainingPercent).toBe(0);
		expect(summary.byTier.plus.scheduledAccountCount).toBe(1);
		expect(summary.byTier.plus.nextResetAt).toBe(weeklyReset);
		expect(getScheduledUsageResetAt(exhausted)).toBe(weeklyReset);
		expect(isZeroUsageAccount(exhausted)).toBe(false);
	});

	test("weekly-only free accounts use weekly quota as their quota window", () => {
		const now = 1_000_000;
		const weeklyReset = now + 120_000;
		const freeUsage = weeklyOnlyUsage("free", {
			used: 40,
			remaining: 60,
			resetAt: weeklyReset / 1000,
		});
		const summary = buildCodexUsageSummary([{ id: "free-a", usage: freeUsage }], now);

		expect(summary.byTier.free.accountCount).toBe(1);
		expect(summary.byTier.free.remainingAccountEquivalents).toBe(0.6);
		expect(summary.byTier.free.averageRemainingPercent).toBe(60);
		expect(summary.byTier.free.scheduledAccountCount).toBe(1);
		expect(summary.byTier.free.nextResetAt).toBe(weeklyReset);
		expect(getScheduledUsageResetAt(freeUsage)).toBe(weeklyReset);
		expect(isZeroUsageAccount(freeUsage)).toBe(false);
	});

	test("unused weekly-only free accounts are not scheduled", () => {
		const now = 1_000_000;
		const freeUsage = weeklyOnlyUsage("free", {
			used: 0,
			remaining: 100,
			resetAt: (now + 120_000) / 1000,
		});
		const summary = buildCodexUsageSummary([{ id: "free-a", usage: freeUsage }], now);

		expect(summary.byTier.free.remainingAccountEquivalents).toBe(1);
		expect(summary.byTier.free.zeroUsageCount).toBe(1);
		expect(summary.byTier.free.scheduledAccountCount).toBe(0);
		expect(getScheduledUsageResetAt(freeUsage)).toBeUndefined();
		expect(isZeroUsageAccount(freeUsage)).toBe(true);
	});

	test("forecast restores each tier at its own 5h reset time", () => {
		const now = 1_000_000;
		const plusReset = now + 60_000;
		const teamReset = now + 90_000;
		const proReset = now + 120_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-a",
					usage: usage("plus", { used: 50, remaining: 50, resetAt: plusReset / 1000 }),
				},
				{
					id: "team-a",
					usage: usage("team", { used: 25, remaining: 75, resetAt: teamReset / 1000 }),
				},
				{
					id: "pro-a",
					usage: usage("pro", { used: 20, remaining: 80, resetAt: proReset / 1000 }),
				},
			],
			now,
		);

		expect(forecast.tiers).toContain("team");
		expect(forecast.points).toHaveLength(4);
		expect(forecast.points[0]?.byTier.plus).toBe(0.5);
		expect(forecast.points[0]?.byTier.team).toBe(0.75);
		expect(forecast.points[0]?.byTier.pro).toBe(0.8);
		expect(forecast.points[1]?.timestamp).toBe(plusReset);
		expect(forecast.points[1]?.byTier.plus).toBe(1);
		expect(forecast.points[1]?.byTier.team).toBe(0.75);
		expect(forecast.points[1]?.byTier.pro).toBe(0.8);
		expect(forecast.points[2]?.timestamp).toBe(teamReset);
		expect(forecast.points[2]?.byTier.team).toBe(1);
		expect(forecast.points[2]?.byTier.pro).toBe(0.8);
		expect(forecast.points[3]?.timestamp).toBe(proReset);
		expect(forecast.points[3]?.byTier.plus).toBe(1);
		expect(forecast.points[3]?.byTier.team).toBe(1);
		expect(forecast.points[3]?.byTier.pro).toBe(1);
	});

	test("forecast ignores non-exhausted weekly reset points", () => {
		const now = 1_000_000;
		const shortReset = now + 60_000;
		const weeklyReset = now + 120_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-a",
					usage: usage(
						"plus",
						{ used: 50, remaining: 50, resetAt: shortReset / 1000 },
						{ used: 80, remaining: 20, resetAt: weeklyReset / 1000 },
					),
				},
			],
			now,
		);

		expect(forecast.points).toHaveLength(2);
		expect(forecast.points[0]?.byTier.plus).toBe(0.5);
		expect(forecast.points[1]?.timestamp).toBe(shortReset);
		expect(forecast.points[1]?.byTier.plus).toBe(1);
	});

	test("forecast waits for weekly reset when weekly quota is exhausted", () => {
		const now = 1_000_000;
		const shortReset = now + 60_000;
		const weeklyReset = now + 120_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-a",
					usage: usage(
						"plus",
						{ used: 50, remaining: 50, resetAt: shortReset / 1000 },
						{ used: 100, remaining: 0, resetAt: weeklyReset / 1000 },
					),
				},
			],
			now,
		);

		expect(forecast.points).toHaveLength(2);
		expect(forecast.points[0]?.byTier.plus).toBe(0);
		expect(forecast.points[1]?.timestamp).toBe(weeklyReset);
		expect(forecast.points[1]?.byTier.plus).toBe(1);
	});

	test("forecast supports weekly-only free accounts", () => {
		const now = 1_000_000;
		const weeklyReset = now + 120_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "free-a",
					usage: weeklyOnlyUsage("free", {
						used: 40,
						remaining: 60,
						resetAt: weeklyReset / 1000,
					}),
				},
			],
			now,
		);

		expect(forecast.points).toHaveLength(2);
		expect(forecast.points[0]?.byTier.free).toBe(0.6);
		expect(forecast.points[1]?.timestamp).toBe(weeklyReset);
		expect(forecast.points[1]?.byTier.free).toBe(1);
	});
});
