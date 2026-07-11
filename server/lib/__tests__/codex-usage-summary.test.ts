import { describe, expect, test } from "bun:test";
import type { CodexUsageResult } from "../codex-usage";
import {
	buildCodexUsageForecast,
	buildCodexUsageSummary,
	createCodexUsageHistoryEntry,
	getScheduledUsageResetAt,
	isZeroUsageAccount,
	normalizeCodexPlanTier,
	resolveCodexQuotaModel,
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

function usageQueriedAt(usageResult: CodexUsageResult, timestamp: number): CodexUsageResult {
	return {
		...usageResult,
		queriedAt: new Date(timestamp).toISOString(),
	};
}

describe("Codex usage summary", () => {
	test("normalizes Codex plan tiers", () => {
		expect(normalizeCodexPlanTier("free")).toBe("free");
		expect(normalizeCodexPlanTier("plus")).toBe("plus");
		expect(normalizeCodexPlanTier("team")).toBe("team");
		expect(normalizeCodexPlanTier("business")).toBe("team");
		expect(normalizeCodexPlanTier("k12")).toBe("k12");
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

	test("summarizes K12 accounts in their own tier", () => {
		const now = 1_000_000;
		const resetAt = now + 60_000;
		const summary = buildCodexUsageSummary(
			[
				{
					id: "k12-a",
					usage: usage("K-12", { used: 35, remaining: 65, resetAt: resetAt / 1000 }),
				},
			],
			now,
		);

		expect(summary.byTier.k12.accountCount).toBe(1);
		expect(summary.byTier.k12.remainingAccountEquivalents).toBe(0.65);
		expect(summary.byTier.k12.averageRemainingPercent).toBe(65);
		expect(summary.byTier.k12.scheduledAccountCount).toBe(1);
		expect(summary.byTier.k12.nextResetAt).toBe(resetAt);
		expect(summary.byTier.other.accountCount).toBe(0);
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

	test("forecast includes K12 quota through each reset point", () => {
		const now = 1_000_000;
		const plusReset = now + 60_000;
		const k12Reset = now + 90_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-a",
					usage: usage("plus", { used: 50, remaining: 50, resetAt: plusReset / 1000 }),
				},
				{
					id: "k12-a",
					usage: usage("k_12", { used: 60, remaining: 40, resetAt: k12Reset / 1000 }),
				},
			],
			now,
		);

		expect(forecast.tiers).toContain("k12");
		expect(forecast.points).toHaveLength(3);
		expect(forecast.points[0]?.byTier.k12).toBe(0.4);
		expect(forecast.points[1]?.timestamp).toBe(plusReset);
		expect(forecast.points[1]?.byTier.k12).toBe(0.4);
		expect(forecast.points[2]?.timestamp).toBe(k12Reset);
		expect(forecast.points[2]?.byTier.k12).toBe(1);
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

	test("forecast extends one hour back using stored usage history", () => {
		const now = 10_000_000;
		const reset = now + 60_000;
		const oldPoint = now - 45 * 60_000;
		const recentPoint = now - 15 * 60_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-a",
					usage: usageQueriedAt(
						usage("plus", { used: 50, remaining: 50, resetAt: reset / 1000 }),
						now,
					),
					usageHistory: [
						{ timestamp: oldPoint, tier: "plus", remainingPercent: 90 },
						{ timestamp: recentPoint, tier: "plus", remainingPercent: 60 },
					],
				},
				{
					id: "plus-b",
					usage: usageQueriedAt(
						usage("plus", { used: 20, remaining: 80, resetAt: reset / 1000 }),
						now,
					),
				},
			],
			now,
		);

		expect(forecast.points[0]?.timestamp).toBe(now - 60 * 60_000);
		expect(forecast.points.find((point) => point.timestamp === oldPoint)?.byTier.plus).toBe(1.7);
		expect(forecast.points.find((point) => point.timestamp === recentPoint)?.byTier.plus).toBe(1.4);
		expect(forecast.points.find((point) => point.timestamp === now)?.byTier.plus).toBe(1.3);
		expect(forecast.points.at(-1)?.timestamp).toBe(reset);
	});

	test("models real Team monthly fixtures as 1.38 account equivalents at 69% average", () => {
		const now = 1_000_000;
		const resetAt = now + 30 * 24 * 60 * 60_000;
		const monthly = (remainingPercent: number): CodexUsageResult => ({
			plan_type: "team",
			primary_window: {
				used_percent: 100 - remainingPercent,
				remaining_percent: remainingPercent,
				reset_at: resetAt / 1000,
				reset_after_seconds: (resetAt - now) / 1000,
				limit_window_seconds: 30 * 24 * 60 * 60,
				window_type: "monthly",
			},
			queriedAt: new Date(now).toISOString(),
		});
		const summary = buildCodexUsageSummary(
			[
				{ id: "team-55", usage: monthly(55) },
				{ id: "team-83", usage: monthly(83) },
			],
			now,
		);

		expect(summary.byTier.team.remainingAccountEquivalents).toBe(1.38);
		expect(summary.byTier.team.averageRemainingPercent).toBe(69);
		expect(summary.byTier.team.modeledUsageCount).toBe(2);
		expect(summary.byTier.team.unmodeledUsageCount).toBe(0);
		expect(summary.totalModeledUsageAccounts).toBe(2);
		expect(summary.totalUnmodeledUsageAccounts).toBe(0);
	});

	test("resolves monthly-only and mixed window combinations through one quota model", () => {
		const now = 1_000_000;
		const window = (
			type: "5h" | "weekly" | "monthly" | "unknown",
			remaining: number,
			resetAt: number,
			limitWindowSeconds?: number,
		) => ({
			used_percent: 100 - remaining,
			remaining_percent: remaining,
			reset_at: resetAt / 1000,
			reset_after_seconds: (resetAt - now) / 1000,
			window_type: type,
			...(limitWindowSeconds ? { limit_window_seconds: limitWindowSeconds } : {}),
		});
		const monthlyReset = now + 30 * 24 * 60 * 60_000;
		const weeklyReset = now + 7 * 24 * 60 * 60_000;
		const shortReset = now + 5 * 60 * 60_000;

		const monthlyOnly = resolveCodexQuotaModel(
			{
				plan_type: "team",
				primary_window: window("monthly", 55, monthlyReset, 30 * 24 * 60 * 60),
				queriedAt: new Date(now).toISOString(),
			},
			now,
		);
		expect(monthlyOnly.effectiveRemainingPercent).toBe(55);
		expect(monthlyOnly.immediateWindow?.window_type).toBe("monthly");
		expect(monthlyOnly.constraintWindows).toHaveLength(0);
		expect(monthlyOnly.scheduledResetAt).toBe(monthlyReset);

		const shortMonthly = resolveCodexQuotaModel(
			{
				plan_type: "plus",
				primary_window: window("5h", 80, shortReset, 18_000),
				secondary_window: window("monthly", 30, monthlyReset, 30 * 24 * 60 * 60),
				queriedAt: new Date(now).toISOString(),
			},
			now,
		);
		expect(shortMonthly.effectiveRemainingPercent).toBe(80);
		expect(shortMonthly.immediateWindow?.window_type).toBe("5h");
		expect(shortMonthly.constraintWindows.map((item) => item.window_type)).toEqual(["monthly"]);

		const weeklyMonthly = resolveCodexQuotaModel(
			{
				plan_type: "team",
				primary_window: window("weekly", 70, weeklyReset, 604_800),
				secondary_window: window("monthly", 40, monthlyReset, 30 * 24 * 60 * 60),
				queriedAt: new Date(now).toISOString(),
			},
			now,
		);
		expect(weeklyMonthly.effectiveRemainingPercent).toBe(70);
		expect(weeklyMonthly.immediateWindow?.window_type).toBe("weekly");
	});

	test("blocks until the latest reset when multiple windows are exhausted", () => {
		const now = 1_000_000;
		const weeklyReset = now + 120_000;
		const monthlyReset = now + 240_000;
		const model = resolveCodexQuotaModel(
			{
				plan_type: "team",
				primary_window: {
					used_percent: 100,
					remaining_percent: 0,
					reset_at: weeklyReset / 1000,
					reset_after_seconds: 120,
					limit_window_seconds: 604_800,
					window_type: "weekly",
				},
				secondary_window: {
					used_percent: 100,
					remaining_percent: 0,
					reset_at: monthlyReset / 1000,
					reset_after_seconds: 240,
					limit_window_seconds: 30 * 24 * 60 * 60,
					window_type: "monthly",
				},
				queriedAt: new Date(now).toISOString(),
			},
			now,
		);

		expect(model.isExhausted).toBe(true);
		expect(model.effectiveRemainingPercent).toBe(0);
		expect(model.exhaustedWindows).toHaveLength(2);
		expect(model.blockedUntil).toBe(monthlyReset);
		expect(model.scheduledResetAt).toBe(monthlyReset);
		expect(
			createCodexUsageHistoryEntry(
				{
					plan_type: "team",
					primary_window: model.windows[0],
					secondary_window: model.windows[1],
					queriedAt: new Date(now).toISOString(),
				},
				now,
			)?.remainingPercent,
		).toBe(0);
	});

	test("models a complete legacy unknown-only window but preserves truly unknown coverage", () => {
		const now = 1_000_000;
		const unknownUsage: CodexUsageResult = {
			plan_type: "team",
			primary_window: {
				used_percent: 35,
				remaining_percent: 65,
				reset_at: (now + 60_000) / 1000,
				reset_after_seconds: 60,
				window_type: "unknown",
			},
			queriedAt: new Date(now).toISOString(),
		};
		const model = resolveCodexQuotaModel(unknownUsage, now);
		expect(model.isModeled).toBe(true);
		expect(model.effectiveRemainingPercent).toBe(65);

		const summary = buildCodexUsageSummary(
			[
				{ id: "modeled", usage: unknownUsage },
				{ id: "unmodeled", usage: { plan_type: "team", queriedAt: new Date(now).toISOString() } },
			],
			now,
		);
		expect(summary.byTier.team.remainingAccountEquivalents).toBe(0.65);
		expect(summary.byTier.team.averageRemainingPercent).toBe(65);
		expect(summary.byTier.team.modeledUsageCount).toBe(1);
		expect(summary.byTier.team.unmodeledUsageCount).toBe(1);
	});

	test("forecasts monthly reset and does not recover early while a long constraint is exhausted", () => {
		const now = 1_000_000;
		const shortReset = now + 60_000;
		const monthlyReset = now + 120_000;
		const monthlyForecast = buildCodexUsageForecast(
			[
				{
					id: "team-monthly",
					usage: {
						plan_type: "team",
						primary_window: {
							used_percent: 45,
							remaining_percent: 55,
							reset_at: monthlyReset / 1000,
							reset_after_seconds: 120,
							limit_window_seconds: 30 * 24 * 60 * 60,
							window_type: "monthly",
						},
						queriedAt: new Date(now).toISOString(),
					},
				},
			],
			now,
		);
		expect(monthlyForecast.points.map((point) => [point.timestamp, point.byTier.team])).toEqual([
			[now, 0.55],
			[monthlyReset, 1],
		]);

		const blockedForecast = buildCodexUsageForecast(
			[
				{
					id: "plus-blocked",
					usage: usage(
						"plus",
						{ used: 50, remaining: 50, resetAt: shortReset / 1000 },
						{ used: 100, remaining: 0, resetAt: monthlyReset / 1000 },
					),
				},
			],
			now,
		);
		expect(blockedForecast.points.map((point) => [point.timestamp, point.byTier.plus])).toEqual([
			[now, 0],
			[monthlyReset, 1],
		]);
	});

	test("forecast omits unmodeled-only tiers instead of encoding them as zero", () => {
		const now = 1_000_000;
		const forecast = buildCodexUsageForecast(
			[
				{
					id: "plus-modeled",
					usage: usage("plus", {
						used: 50,
						remaining: 50,
						resetAt: (now + 60_000) / 1000,
					}),
				},
				{
					id: "team-unmodeled",
					usage: { plan_type: "team", queriedAt: new Date(now).toISOString() },
				},
			],
			now,
		);

		expect(forecast.tiers).toEqual(["plus"]);
		expect(forecast.points[0]?.byTier).toEqual({ plus: 0.5 });
		expect("team" in (forecast.points[0]?.byTier ?? {})).toBe(false);
		expect("free" in (forecast.points[0]?.byTier ?? {})).toBe(false);
	});
});
