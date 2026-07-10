import type { CodexUsageResult } from "./codex-usage";

export type CodexPlanTier = "free" | "plus" | "team" | "k12" | "prolite" | "pro" | "other";

export const CODEX_PLAN_TIERS: CodexPlanTier[] = [
	"free",
	"plus",
	"team",
	"k12",
	"prolite",
	"pro",
	"other",
];
export const CODEX_DISPLAY_PLAN_TIERS: CodexPlanTier[] = [
	"free",
	"plus",
	"team",
	"k12",
	"prolite",
	"pro",
];
export const CODEX_USAGE_FORECAST_HISTORY_MS = 60 * 60_000;

export interface CodexUsageHistoryEntry {
	timestamp: number;
	tier: CodexPlanTier;
	remainingPercent: number;
}

export interface CodexUsageSourceEntry {
	id: string;
	disabled?: boolean;
	disabledReason?: string;
	usage?: CodexUsageResult;
	usageHistory?: CodexUsageHistoryEntry[];
}

export interface CodexUsageTierStats {
	tier: CodexPlanTier;
	accountCount: number;
	knownUsageCount: number;
	zeroUsageCount: number;
	scheduledAccountCount: number;
	remainingAccountEquivalents: number;
	averageRemainingPercent: number | null;
	nextResetAt?: number;
}

export interface CodexUsageSummary {
	generatedAt: string;
	totalTrackedAccounts: number;
	totalKnownUsageAccounts: number;
	missingUsageAccounts: number;
	zeroUsageAccounts: number;
	scheduledAccountCount: number;
	nextResetAt?: number;
	byTier: Record<CodexPlanTier, CodexUsageTierStats>;
}

export interface CodexUsageForecastPoint {
	timestamp: number;
	byTier: Record<CodexPlanTier, number>;
}

export interface CodexUsageForecast {
	generatedAt: string;
	points: CodexUsageForecastPoint[];
	tiers: CodexPlanTier[];
	unit: "account_equivalent";
}

type UsageWindow = NonNullable<CodexUsageResult["primary_window"]>;

interface MutableForecastWindow {
	usedPercent: number;
	remainingPercent: number;
	resetAt: number;
}

interface ForecastAccountState {
	tier: CodexPlanTier;
	quotaWindow: MutableForecastWindow;
	blockingWeeklyWindow?: MutableForecastWindow;
}

function emptyTierStats(tier: CodexPlanTier): CodexUsageTierStats {
	return {
		tier,
		accountCount: 0,
		knownUsageCount: 0,
		zeroUsageCount: 0,
		scheduledAccountCount: 0,
		remainingAccountEquivalents: 0,
		averageRemainingPercent: null,
	};
}

function emptyTierValues(): Record<CodexPlanTier, number> {
	return {
		free: 0,
		plus: 0,
		team: 0,
		k12: 0,
		prolite: 0,
		pro: 0,
		other: 0,
	};
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function getUsageWindows(usage: CodexUsageResult): UsageWindow[] {
	return [usage.primary_window, usage.secondary_window].filter(
		(window): window is UsageWindow => !!window,
	);
}

function getWindowByType(
	usage: CodexUsageResult,
	windowType: UsageWindow["window_type"],
): UsageWindow | undefined {
	return getUsageWindows(usage).find((window) => window.window_type === windowType);
}

function getShortTermWindow(usage: CodexUsageResult): UsageWindow | undefined {
	return getWindowByType(usage, "5h");
}

function getWeeklyWindow(usage: CodexUsageResult): UsageWindow | undefined {
	return getWindowByType(usage, "weekly");
}

function getWindowRemainingPercent(window: UsageWindow): number {
	if (Number.isFinite(window.remaining_percent)) {
		return clampPercent(window.remaining_percent);
	}
	return clampPercent(100 - window.used_percent);
}

function isMutableForecastWindow(
	window: UsageWindow | MutableForecastWindow,
): window is MutableForecastWindow {
	return "remainingPercent" in window;
}

function getModeledWindowUsedPercent(window: UsageWindow | MutableForecastWindow): number {
	return clampPercent(isMutableForecastWindow(window) ? window.usedPercent : window.used_percent);
}

function getModeledWindowRemainingPercent(window: UsageWindow | MutableForecastWindow): number {
	return isMutableForecastWindow(window)
		? clampPercent(window.remainingPercent)
		: getWindowRemainingPercent(window);
}

function isWindowUsed(window: UsageWindow | MutableForecastWindow): boolean {
	return getModeledWindowUsedPercent(window) > 0;
}

function isWindowExhausted(window: UsageWindow | MutableForecastWindow): boolean {
	return (
		getModeledWindowRemainingPercent(window) <= 0 || getModeledWindowUsedPercent(window) >= 100
	);
}

function isWeeklyExhausted(usage: CodexUsageResult): boolean {
	const weeklyWindow = getWeeklyWindow(usage);
	return weeklyWindow ? isWindowExhausted(weeklyWindow) : false;
}

function getModeledRemainingPercent(usage: CodexUsageResult): number | null {
	const shortTermWindow = getShortTermWindow(usage);
	if (shortTermWindow) {
		return isWeeklyExhausted(usage) ? 0 : getWindowRemainingPercent(shortTermWindow);
	}

	const weeklyWindow = getWeeklyWindow(usage);
	return weeklyWindow ? getWindowRemainingPercent(weeklyWindow) : null;
}

function isQuotaTrackedEntry(entry: CodexUsageSourceEntry): boolean {
	return (
		entry.disabledReason !== "manual" &&
		entry.disabledReason !== "too_many_failures" &&
		entry.disabledReason !== "banned"
	);
}

export function normalizeCodexPlanTier(planType?: string | null): CodexPlanTier {
	if (!planType) return "other";
	const normalized = planType.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!normalized) return "other";
	if (normalized === "k12") return "k12";
	if (normalized.includes("prolite") || normalized.includes("litepro")) return "prolite";
	if (normalized.includes("plus")) return "plus";
	if (normalized.includes("team") || normalized.includes("business")) return "team";
	if (normalized.includes("free")) return "free";
	if (normalized === "pro" || normalized.endsWith("pro") || normalized.includes("chatgptpro")) {
		return "pro";
	}
	return "other";
}

export function createCodexUsageHistoryEntry(
	usage: CodexUsageResult,
	timestamp?: number,
): CodexUsageHistoryEntry | null {
	const remainingPercent = getModeledRemainingPercent(usage);
	if (remainingPercent === null) return null;

	const queriedAtMs = new Date(usage.queriedAt).getTime();
	const effectiveTimestamp =
		typeof timestamp === "number" && Number.isFinite(timestamp)
			? timestamp
			: Number.isFinite(queriedAtMs)
				? queriedAtMs
				: Date.now();
	if (!Number.isFinite(effectiveTimestamp)) return null;

	return {
		timestamp: effectiveTimestamp,
		tier: normalizeCodexPlanTier(usage.plan_type),
		remainingPercent: Number(clampPercent(remainingPercent).toFixed(4)),
	};
}

export function isZeroUsageAccount(usage?: CodexUsageResult): boolean {
	if (!usage) return false;
	const shortTermWindow = getShortTermWindow(usage);
	if (shortTermWindow) return !isWeeklyExhausted(usage) && !isWindowUsed(shortTermWindow);

	const weeklyWindow = getWeeklyWindow(usage);
	return !!weeklyWindow && !isWindowUsed(weeklyWindow);
}

function getModeledUsageResetAt(usage?: CodexUsageResult): number | undefined {
	if (!usage) return undefined;
	const weeklyWindow = getWeeklyWindow(usage);
	const shortTermWindow = getShortTermWindow(usage);

	if (shortTermWindow) {
		if (weeklyWindow && isWindowExhausted(weeklyWindow)) return weeklyWindow.reset_at * 1000;
		return isWindowUsed(shortTermWindow) ? shortTermWindow.reset_at * 1000 : undefined;
	}

	return weeklyWindow && isWindowUsed(weeklyWindow) ? weeklyWindow.reset_at * 1000 : undefined;
}

export function getScheduledUsageResetAt(usage?: CodexUsageResult): number | undefined {
	const resetAt = getModeledUsageResetAt(usage);
	return resetAt && Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined;
}

export function getNextUsageResetAt(
	usage?: CodexUsageResult,
	now = Date.now(),
): number | undefined {
	const resetAt = getModeledUsageResetAt(usage);
	return resetAt && Number.isFinite(resetAt) && resetAt > now ? resetAt : undefined;
}

export function buildCodexUsageSummary(
	entries: CodexUsageSourceEntry[],
	now = Date.now(),
): CodexUsageSummary {
	const byTier = Object.fromEntries(
		CODEX_PLAN_TIERS.map((tier) => [tier, emptyTierStats(tier)]),
	) as Record<CodexPlanTier, CodexUsageTierStats>;
	const remainingSums = Object.fromEntries(CODEX_PLAN_TIERS.map((tier) => [tier, 0])) as Record<
		CodexPlanTier,
		number
	>;
	const remainingCounts = Object.fromEntries(CODEX_PLAN_TIERS.map((tier) => [tier, 0])) as Record<
		CodexPlanTier,
		number
	>;

	let totalTrackedAccounts = 0;
	let totalKnownUsageAccounts = 0;
	let zeroUsageAccounts = 0;
	let scheduledAccountCount = 0;
	let nextResetAt: number | undefined;

	for (const entry of entries) {
		if (!isQuotaTrackedEntry(entry)) continue;
		totalTrackedAccounts++;

		const usage = entry.usage;
		const tier = normalizeCodexPlanTier(usage?.plan_type);
		const tierStats = byTier[tier];
		tierStats.accountCount++;

		if (!usage) continue;
		totalKnownUsageAccounts++;
		tierStats.knownUsageCount++;

		const modeledRemaining = getModeledRemainingPercent(usage);
		if (modeledRemaining !== null) {
			tierStats.remainingAccountEquivalents += modeledRemaining / 100;
			remainingSums[tier] += modeledRemaining;
			remainingCounts[tier]++;
		}

		if (isZeroUsageAccount(usage)) {
			zeroUsageAccounts++;
			tierStats.zeroUsageCount++;
		}

		const resetAt = getNextUsageResetAt(usage, now);
		if (resetAt) {
			scheduledAccountCount++;
			tierStats.scheduledAccountCount++;
			tierStats.nextResetAt = Math.min(tierStats.nextResetAt ?? resetAt, resetAt);
			nextResetAt = Math.min(nextResetAt ?? resetAt, resetAt);
		}
	}

	for (const tier of CODEX_PLAN_TIERS) {
		const count = remainingCounts[tier];
		byTier[tier].remainingAccountEquivalents = Number(
			byTier[tier].remainingAccountEquivalents.toFixed(4),
		);
		byTier[tier].averageRemainingPercent =
			count > 0 ? Number((remainingSums[tier] / count).toFixed(2)) : null;
	}

	return {
		generatedAt: new Date(now).toISOString(),
		totalTrackedAccounts,
		totalKnownUsageAccounts,
		missingUsageAccounts: Math.max(0, totalTrackedAccounts - totalKnownUsageAccounts),
		zeroUsageAccounts,
		scheduledAccountCount,
		nextResetAt,
		byTier,
	};
}

function toMutableForecastWindow(window: UsageWindow): MutableForecastWindow {
	return {
		usedPercent: clampPercent(window.used_percent),
		remainingPercent: getWindowRemainingPercent(window),
		resetAt: window.reset_at * 1000,
	};
}

function buildInitialForecastStates(entries: CodexUsageSourceEntry[]): ForecastAccountState[] {
	return entries.flatMap((entry) => {
		if (!isQuotaTrackedEntry(entry) || !entry.usage) return [];
		const shortTermWindow = getShortTermWindow(entry.usage);
		const weeklyWindow = getWeeklyWindow(entry.usage);
		const quotaWindow = shortTermWindow ?? weeklyWindow;
		if (!quotaWindow) return [];
		return [
			{
				tier: normalizeCodexPlanTier(entry.usage.plan_type),
				quotaWindow: toMutableForecastWindow(quotaWindow),
				...(shortTermWindow && weeklyWindow
					? { blockingWeeklyWindow: toMutableForecastWindow(weeklyWindow) }
					: {}),
			},
		];
	});
}

function isForecastBlockedByWeekly(state: ForecastAccountState): boolean {
	return state.blockingWeeklyWindow ? isWindowExhausted(state.blockingWeeklyWindow) : false;
}

function getForecastRemainingPercent(state: ForecastAccountState): number {
	return isForecastBlockedByWeekly(state) ? 0 : state.quotaWindow.remainingPercent;
}

function calculateForecastPoint(
	states: ForecastAccountState[],
	timestamp: number,
): CodexUsageForecastPoint {
	const byTier = emptyTierValues();
	for (const state of states) {
		byTier[state.tier] += getForecastRemainingPercent(state) / 100;
	}
	for (const tier of CODEX_PLAN_TIERS) {
		byTier[tier] = Number(byTier[tier].toFixed(4));
	}
	return { timestamp, byTier };
}

function normalizeStoredUsageHistoryEntry(
	entry: CodexUsageHistoryEntry,
): CodexUsageHistoryEntry | null {
	if (!Number.isFinite(entry.timestamp)) return null;
	if (!CODEX_PLAN_TIERS.includes(entry.tier)) return null;
	return {
		timestamp: entry.timestamp,
		tier: entry.tier,
		remainingPercent: Number(clampPercent(entry.remainingPercent).toFixed(4)),
	};
}

function getCurrentUsageHistoryEntry(
	entry: CodexUsageSourceEntry,
	now: number,
): CodexUsageHistoryEntry | null {
	if (!entry.usage) return null;
	const queriedAtMs = new Date(entry.usage.queriedAt).getTime();
	const timestamp = Number.isFinite(queriedAtMs) ? Math.min(queriedAtMs, now) : now;
	return createCodexUsageHistoryEntry(entry.usage, timestamp);
}

function buildAccountHistorySnapshots(
	entry: CodexUsageSourceEntry,
	now: number,
): CodexUsageHistoryEntry[] {
	const snapshots = (entry.usageHistory ?? [])
		.map(normalizeStoredUsageHistoryEntry)
		.filter((snapshot): snapshot is CodexUsageHistoryEntry => !!snapshot);
	const currentSnapshot = getCurrentUsageHistoryEntry(entry, now);
	if (currentSnapshot) snapshots.push(currentSnapshot);

	const byTimestamp = new Map<number, CodexUsageHistoryEntry>();
	for (const snapshot of snapshots) {
		const existing = byTimestamp.get(snapshot.timestamp);
		if (!existing || snapshot.timestamp >= existing.timestamp) {
			byTimestamp.set(snapshot.timestamp, snapshot);
		}
	}

	return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function getSnapshotAt(
	snapshots: CodexUsageHistoryEntry[],
	timestamp: number,
): CodexUsageHistoryEntry | undefined {
	let latestBefore: CodexUsageHistoryEntry | undefined;
	for (const snapshot of snapshots) {
		if (snapshot.timestamp <= timestamp) {
			latestBefore = snapshot;
			continue;
		}
		return latestBefore ?? snapshot;
	}
	return latestBefore;
}

function compressHistoricalTimes(times: number[], minGapMs: number): number[] {
	const sorted = [...new Set(times)].sort((a, b) => a - b);
	if (sorted.length <= 2) return sorted;

	const result = [sorted[0]];
	for (const timestamp of sorted.slice(1, -1)) {
		const last = result[result.length - 1];
		if (result.length === 1 && timestamp - last < minGapMs) {
			continue;
		}
		if (timestamp - last < minGapMs) {
			result[result.length - 1] = timestamp;
		} else {
			result.push(timestamp);
		}
	}

	const lastTimestamp = sorted[sorted.length - 1];
	if (result.length === 1 && lastTimestamp - result[0] < minGapMs) {
		result.push(lastTimestamp);
	} else if (lastTimestamp - result[result.length - 1] < minGapMs) {
		result[result.length - 1] = lastTimestamp;
	} else {
		result.push(lastTimestamp);
	}
	return result;
}

function buildHistoricalForecastPoints(
	entries: CodexUsageSourceEntry[],
	now: number,
): CodexUsageForecastPoint[] {
	const historyStart = now - CODEX_USAGE_FORECAST_HISTORY_MS;
	const hasStoredHistory = entries.some(
		(entry) =>
			isQuotaTrackedEntry(entry) &&
			!!entry.usage &&
			(entry.usageHistory ?? []).some(
				(snapshot) =>
					Number.isFinite(snapshot.timestamp) &&
					snapshot.timestamp >= historyStart &&
					snapshot.timestamp <= now,
			),
	);
	if (!hasStoredHistory) return [];

	const accountSnapshots = entries.flatMap((entry) => {
		if (!isQuotaTrackedEntry(entry) || !entry.usage) return [];
		const snapshots = buildAccountHistorySnapshots(entry, now);
		return snapshots.length > 0 ? [snapshots] : [];
	});
	if (accountSnapshots.length === 0) return [];

	const candidateTimes = [
		historyStart,
		...accountSnapshots.flatMap((snapshots) =>
			snapshots
				.map((snapshot) => snapshot.timestamp)
				.filter((timestamp) => timestamp > historyStart && timestamp < now),
		),
	];
	const times = compressHistoricalTimes(candidateTimes, 60_000).filter(
		(timestamp) => timestamp < now,
	);

	return times.map((timestamp) => {
		const byTier = emptyTierValues();
		for (const snapshots of accountSnapshots) {
			const snapshot = getSnapshotAt(snapshots, timestamp);
			if (!snapshot) continue;
			byTier[snapshot.tier] += snapshot.remainingPercent / 100;
		}
		for (const tier of CODEX_PLAN_TIERS) {
			byTier[tier] = Number(byTier[tier].toFixed(4));
		}
		return { timestamp, byTier };
	});
}

function appendForecastPoint(
	points: CodexUsageForecastPoint[],
	point: CodexUsageForecastPoint,
): void {
	const last = points[points.length - 1];
	if (last && last.timestamp === point.timestamp) {
		points[points.length - 1] = point;
		return;
	}
	points.push(point);
}

export function buildCodexUsageForecast(
	entries: CodexUsageSourceEntry[],
	now = Date.now(),
): CodexUsageForecast {
	const states = buildInitialForecastStates(entries);
	const resetTimes = [
		...new Set(
			states.flatMap((state) => {
				if (isForecastBlockedByWeekly(state)) {
					return state.blockingWeeklyWindow && state.blockingWeeklyWindow.resetAt > now
						? [state.blockingWeeklyWindow.resetAt]
						: [];
				}
				return isWindowUsed(state.quotaWindow) && state.quotaWindow.resetAt > now
					? [state.quotaWindow.resetAt]
					: [];
			}),
		),
	].sort((a, b) => a - b);

	const points: CodexUsageForecastPoint[] = buildHistoricalForecastPoints(entries, now);
	appendForecastPoint(points, calculateForecastPoint(states, now));

	for (const resetTime of resetTimes) {
		for (const state of states) {
			if (state.blockingWeeklyWindow && isWindowExhausted(state.blockingWeeklyWindow)) {
				if (state.blockingWeeklyWindow.resetAt <= resetTime) {
					state.blockingWeeklyWindow.usedPercent = 0;
					state.blockingWeeklyWindow.remainingPercent = 100;
					state.quotaWindow.usedPercent = 0;
					state.quotaWindow.remainingPercent = 100;
				}
				continue;
			}

			if (isWindowUsed(state.quotaWindow) && state.quotaWindow.resetAt <= resetTime) {
				state.quotaWindow.usedPercent = 0;
				state.quotaWindow.remainingPercent = 100;
			}
		}
		appendForecastPoint(points, calculateForecastPoint(states, resetTime));
	}

	return {
		generatedAt: new Date(now).toISOString(),
		points,
		tiers: CODEX_DISPLAY_PLAN_TIERS,
		unit: "account_equivalent",
	};
}
