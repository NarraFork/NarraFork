import { type CodexUsageResult, type CodexUsageWindow, getCodexUsageWindows } from "./codex-usage";

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
	modeledUsageCount: number;
	unmodeledUsageCount: number;
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
	totalModeledUsageAccounts: number;
	totalUnmodeledUsageAccounts: number;
	missingUsageAccounts: number;
	zeroUsageAccounts: number;
	scheduledAccountCount: number;
	nextResetAt?: number;
	byTier: Record<CodexPlanTier, CodexUsageTierStats>;
}

export interface CodexUsageForecastPoint {
	timestamp: number;
	byTier: Partial<Record<CodexPlanTier, number>>;
}

export interface CodexUsageForecast {
	generatedAt: string;
	points: CodexUsageForecastPoint[];
	tiers: CodexPlanTier[];
	unit: "account_equivalent";
}

type UsageWindow = CodexUsageWindow;

interface MutableForecastWindow {
	usedPercent: number;
	remainingPercent: number;
	resetAt: number;
	windowType: UsageWindow["window_type"];
	limitWindowSeconds?: number;
}

interface ForecastAccountState {
	tier: CodexPlanTier;
	windows: MutableForecastWindow[];
	immediateWindowIndex: number;
}

export interface CodexQuotaModel {
	windows: UsageWindow[];
	immediateWindow?: UsageWindow;
	constraintWindows: UsageWindow[];
	exhaustedWindows: UsageWindow[];
	effectiveRemainingPercent: number | null;
	isZeroUsage: boolean;
	isExhausted: boolean;
	blockedUntil?: number;
	scheduledResetAt?: number;
	refreshAt?: number;
	isModeled: boolean;
	unmodeledReason?: "no_valid_windows";
}

function emptyTierStats(tier: CodexPlanTier): CodexUsageTierStats {
	return {
		tier,
		accountCount: 0,
		knownUsageCount: 0,
		modeledUsageCount: 0,
		unmodeledUsageCount: 0,
		zeroUsageCount: 0,
		scheduledAccountCount: 0,
		remainingAccountEquivalents: 0,
		averageRemainingPercent: null,
	};
}

function emptyTierValues(): Partial<Record<CodexPlanTier, number>> {
	return {};
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function getWindowRemainingPercent(window: UsageWindow): number | null {
	if (Number.isFinite(window.remaining_percent)) {
		return clampPercent(window.remaining_percent);
	}
	if (Number.isFinite(window.used_percent)) return clampPercent(100 - window.used_percent);
	return null;
}

function getWindowResetAtMs(window: UsageWindow): number | undefined {
	const resetAt = window.reset_at * 1000;
	return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined;
}

function isValidModeledWindow(window: UsageWindow): boolean {
	return (
		Number.isFinite(window.used_percent) &&
		getWindowRemainingPercent(window) !== null &&
		getWindowResetAtMs(window) !== undefined
	);
}

const WINDOW_TYPE_ORDER: Record<UsageWindow["window_type"], number> = {
	"5h": 0,
	weekly: 1,
	monthly: 2,
	unknown: 3,
};

function compareUsageWindows(a: UsageWindow, b: UsageWindow): number {
	const aDuration = a.limit_window_seconds;
	const bDuration = b.limit_window_seconds;
	if (
		typeof aDuration === "number" &&
		Number.isFinite(aDuration) &&
		typeof bDuration === "number" &&
		Number.isFinite(bDuration) &&
		aDuration !== bDuration
	) {
		return aDuration - bDuration;
	}
	return WINDOW_TYPE_ORDER[a.window_type] - WINDOW_TYPE_ORDER[b.window_type];
}

function isWindowUsed(window: UsageWindow): boolean {
	return clampPercent(window.used_percent) > 0;
}

function isWindowExhausted(window: UsageWindow): boolean {
	const remaining = getWindowRemainingPercent(window);
	return remaining !== null && (remaining <= 0 || clampPercent(window.used_percent) >= 100);
}

export function resolveCodexQuotaModel(usage: CodexUsageResult, now = Date.now()): CodexQuotaModel {
	const windows = getCodexUsageWindows(usage)
		.filter(isValidModeledWindow)
		.sort(compareUsageWindows);
	const immediateWindow = windows[0];
	if (!immediateWindow) {
		return {
			windows,
			constraintWindows: [],
			exhaustedWindows: [],
			effectiveRemainingPercent: null,
			isZeroUsage: false,
			isExhausted: false,
			isModeled: false,
			unmodeledReason: "no_valid_windows",
		};
	}

	const exhaustedWindows = windows.filter((window) => {
		const resetAt = getWindowResetAtMs(window);
		return isWindowExhausted(window) && resetAt !== undefined && resetAt > now;
	});
	const blockedUntil = exhaustedWindows.reduce<number | undefined>((latest, window) => {
		const resetAt = getWindowResetAtMs(window);
		return resetAt === undefined ? latest : Math.max(latest ?? resetAt, resetAt);
	}, undefined);
	const isExhausted = exhaustedWindows.length > 0;
	const immediateRemaining = getWindowRemainingPercent(immediateWindow);
	const effectiveRemainingPercent = isExhausted ? 0 : immediateRemaining;
	const immediateResetAt = getWindowResetAtMs(immediateWindow);
	const refreshAt = windows.reduce<number | undefined>((earliest, window) => {
		const resetAt = getWindowResetAtMs(window);
		return resetAt === undefined ? earliest : Math.min(earliest ?? resetAt, resetAt);
	}, undefined);
	const scheduledResetAt = isExhausted
		? blockedUntil
		: isWindowUsed(immediateWindow) && immediateResetAt && immediateResetAt > now
			? immediateResetAt
			: undefined;

	return {
		windows,
		immediateWindow,
		constraintWindows: windows.slice(1),
		exhaustedWindows,
		effectiveRemainingPercent,
		isZeroUsage: !isExhausted && !isWindowUsed(immediateWindow),
		isExhausted,
		blockedUntil,
		scheduledResetAt,
		refreshAt,
		isModeled: effectiveRemainingPercent !== null,
	};
}

function getModeledRemainingPercent(usage: CodexUsageResult, now = Date.now()): number | null {
	return resolveCodexQuotaModel(usage, now).effectiveRemainingPercent;
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
	const queriedAtMs = new Date(usage.queriedAt).getTime();
	const effectiveTimestamp =
		typeof timestamp === "number" && Number.isFinite(timestamp)
			? timestamp
			: Number.isFinite(queriedAtMs)
				? queriedAtMs
				: Date.now();
	if (!Number.isFinite(effectiveTimestamp)) return null;
	const remainingPercent = getModeledRemainingPercent(usage, effectiveTimestamp);
	if (remainingPercent === null) return null;

	return {
		timestamp: effectiveTimestamp,
		tier: normalizeCodexPlanTier(usage.plan_type),
		remainingPercent: Number(clampPercent(remainingPercent).toFixed(4)),
	};
}

export function isZeroUsageAccount(usage?: CodexUsageResult, now = Date.now()): boolean {
	return usage ? resolveCodexQuotaModel(usage, now).isZeroUsage : false;
}

export function getScheduledUsageResetAt(
	usage?: CodexUsageResult,
	now = Date.now(),
): number | undefined {
	if (!usage) return undefined;
	const resetTimes = getCodexUsageWindows(usage)
		.map(getWindowResetAtMs)
		.filter((resetAt): resetAt is number => resetAt !== undefined);
	const earliestResetAt = resetTimes.length > 0 ? Math.min(...resetTimes) : undefined;
	const evaluationTime = earliestResetAt === undefined ? now : Math.min(now, earliestResetAt - 1);
	return resolveCodexQuotaModel(usage, evaluationTime).scheduledResetAt;
}

export function getNextUsageResetAt(
	usage?: CodexUsageResult,
	now = Date.now(),
): number | undefined {
	const resetAt = usage ? resolveCodexQuotaModel(usage, now).scheduledResetAt : undefined;
	return resetAt && resetAt > now ? resetAt : undefined;
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
	let totalModeledUsageAccounts = 0;
	let totalUnmodeledUsageAccounts = 0;
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

		const quotaModel = resolveCodexQuotaModel(usage, now);
		const modeledRemaining = quotaModel.effectiveRemainingPercent;
		if (modeledRemaining !== null) {
			totalModeledUsageAccounts++;
			tierStats.modeledUsageCount++;
			tierStats.remainingAccountEquivalents += modeledRemaining / 100;
			remainingSums[tier] += modeledRemaining;
			remainingCounts[tier]++;
		} else {
			totalUnmodeledUsageAccounts++;
			tierStats.unmodeledUsageCount++;
		}

		if (quotaModel.isZeroUsage) {
			zeroUsageAccounts++;
			tierStats.zeroUsageCount++;
		}

		const resetAt =
			quotaModel.scheduledResetAt && quotaModel.scheduledResetAt > now
				? quotaModel.scheduledResetAt
				: undefined;
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
		totalModeledUsageAccounts,
		totalUnmodeledUsageAccounts,
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
		remainingPercent: getWindowRemainingPercent(window) ?? 0,
		resetAt: getWindowResetAtMs(window) ?? 0,
		windowType: window.window_type,
		limitWindowSeconds: window.limit_window_seconds,
	};
}

function buildInitialForecastStates(
	entries: CodexUsageSourceEntry[],
	now: number,
): ForecastAccountState[] {
	return entries.flatMap((entry) => {
		if (!isQuotaTrackedEntry(entry) || !entry.usage) return [];
		const model = resolveCodexQuotaModel(entry.usage, now);
		if (!model.immediateWindow) return [];
		return [
			{
				tier: normalizeCodexPlanTier(entry.usage.plan_type),
				windows: model.windows.map(toMutableForecastWindow),
				immediateWindowIndex: model.windows.indexOf(model.immediateWindow),
			},
		];
	});
}

function isMutableForecastWindowExhausted(window: MutableForecastWindow): boolean {
	return window.remainingPercent <= 0 || window.usedPercent >= 100;
}

function getForecastRemainingPercent(state: ForecastAccountState, timestamp: number): number {
	const blocked = state.windows.some(
		(window) => isMutableForecastWindowExhausted(window) && window.resetAt > timestamp,
	);
	return blocked ? 0 : (state.windows[state.immediateWindowIndex]?.remainingPercent ?? 0);
}

function calculateForecastPoint(
	states: ForecastAccountState[],
	timestamp: number,
): CodexUsageForecastPoint {
	const byTier = emptyTierValues();
	for (const state of states) {
		byTier[state.tier] =
			(byTier[state.tier] ?? 0) + getForecastRemainingPercent(state, timestamp) / 100;
	}
	for (const tier of CODEX_PLAN_TIERS) {
		const value = byTier[tier];
		if (value !== undefined) byTier[tier] = Number(value.toFixed(4));
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
			byTier[snapshot.tier] = (byTier[snapshot.tier] ?? 0) + snapshot.remainingPercent / 100;
		}
		for (const tier of CODEX_PLAN_TIERS) {
			const value = byTier[tier];
			if (value !== undefined) byTier[tier] = Number(value.toFixed(4));
		}
		return { timestamp, byTier };
	});
}

function haveEqualForecastValues(a: CodexUsageForecastPoint, b: CodexUsageForecastPoint): boolean {
	return CODEX_PLAN_TIERS.every((tier) => a.byTier[tier] === b.byTier[tier]);
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
	if (last && haveEqualForecastValues(last, point)) return;
	points.push(point);
}

export function buildCodexUsageForecast(
	entries: CodexUsageSourceEntry[],
	now = Date.now(),
): CodexUsageForecast {
	const states = buildInitialForecastStates(entries, now);
	const resetTimes = [
		...new Set(
			states.flatMap((state) =>
				state.windows.flatMap((window, index) => {
					const affectsQuota =
						index === state.immediateWindowIndex
							? window.usedPercent > 0
							: isMutableForecastWindowExhausted(window);
					return affectsQuota && window.resetAt > now ? [window.resetAt] : [];
				}),
			),
		),
	].sort((a, b) => a - b);

	const points: CodexUsageForecastPoint[] = buildHistoricalForecastPoints(entries, now);
	if (states.length > 0) appendForecastPoint(points, calculateForecastPoint(states, now));

	for (const resetTime of resetTimes) {
		for (const state of states) {
			for (const window of state.windows) {
				if (window.resetAt <= resetTime && window.usedPercent > 0) {
					window.usedPercent = 0;
					window.remainingPercent = 100;
				}
			}
		}
		appendForecastPoint(points, calculateForecastPoint(states, resetTime));
	}

	const tiers = CODEX_DISPLAY_PLAN_TIERS.filter((tier) =>
		points.some((point) => point.byTier[tier] !== undefined),
	);
	return {
		generatedAt: new Date(now).toISOString(),
		points,
		tiers,
		unit: "account_equivalent",
	};
}
