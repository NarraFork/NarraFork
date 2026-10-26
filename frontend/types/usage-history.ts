import type { ReferenceCostSummary } from "../lib/usage-cost";

export interface UsageHistoryRecord extends ReferenceCostSummary {
	id: string;
	userId?: string | null;
	username?: string | null;
	narratorId: string | null;
	/** 外部 Agent 写入时自带的叙述者文本（无 narrator 关联时用于占位显示）。 */
	agentLabel?: string | null;
	kind: string;
	provider: string | null;
	credentialId: string | null;
	credentialName: string | null;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationInputTokens: number;
	cacheCreation5mTokens: number;
	cacheCreation1hTokens: number;
	reasoningTokens: number;
	ttftMs: number | null;
	durationMs: number | null;
	costUsd: number | null;
	contextPercent: number | null;
	meterUsage: number | null;
	meterUnit: string | null;
	createdAt: string;
	errorMessage?: string | null;
	narratorTitle?: string | null;
	projectId?: string | null;
	/** Bounded diagnostics summary exists; list rows never carry its content. */
	hasDiagnostics?: boolean;
	/** Detail endpoint only. */
	diagnostics?: unknown | null;
	/** Loop attempt id in the narrator's request recorder, when one was recorded. */
	recordingRequestId?: string | null;
}

interface CacheHitRateStats {
	/** Only requests with cachedInputTokens > 0 participate; ratio is 0–1 or null. */
	cacheHitRate: number | null;
	cacheHitRateReadTokens: number;
	cacheHitRateInputTokens: number;
}

export interface UsageHistoryStats extends ReferenceCostSummary, CacheHitRateStats {
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreation5mTokens: number;
	totalCacheCreation1hTokens: number;
	totalReasoningTokens: number;
	totalTokens: number;
	totalCost: number;
	averageDurationMs: number;
	averageTtftMs: number;
}

export type UsageHistoryGranularity = "hour" | "day" | "month";

export interface UsageHistoryTimeSeriesPoint extends ReferenceCostSummary, CacheHitRateStats {
	timestamp: string;
	requestCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreation5mTokens: number;
	totalCacheCreation1hTokens: number;
	totalReasoningTokens: number;
	totalTokens: number;
	totalCost: number;
	averageDurationMs: number;
	averageTtftMs: number;
	errorCount: number;
	meterUsage: number;
	meterUnit: string | null;
}

export interface UsageHistoryTimeSeriesResponse {
	granularity: UsageHistoryGranularity;
	points: UsageHistoryTimeSeriesPoint[];
	bucketCount: number;
	maxBuckets: number;
	truncated: boolean;
	requestedStartDate: string;
	requestedEndDate: string;
	effectiveStartDate: string;
	effectiveEndDate: string;
	generatedAt: string;
}

export interface UsageHistoryFilters {
	/** '__unattributed__' selects requests without known ownership. */
	userId?: string;
	narratorId?: string;
	projectId?: string;
	provider?: string;
	/** Exact credential id — narrows history to one account in a provider pool. */
	credentialId?: string;
	model?: string;
	kind?: string;
	startDate?: string;
	endDate?: string;
}

/**
 * Lifetime totals for one credential, from `credential_usage_totals`.
 *
 * Unlike the rest of this module these survive narrator deletion, so they are
 * the durable answer to "how much has this account consumed". `costUsd` is at
 * official reference prices; for subscription access it is equivalent
 * consumption, not an amount billed, and `costIsPartial` marks that some
 * requests had no known price.
 */
export interface CredentialUsageTotals extends ReferenceCostSummary {
	provider: string;
	credentialId: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	unpricedRequestCount: number;
	costIsPartial: boolean;
	firstSeenAt: string | null;
	lastSeenAt: string | null;
}

export interface CredentialUsageTotalsByModel extends CredentialUsageTotals {
	model: string;
}

export interface CredentialUsageTotalsDetail extends CredentialUsageTotals {
	byModel: CredentialUsageTotalsByModel[];
	/**
	 * True when the credential has used more models than `byModel` lists.
	 *
	 * The top-level totals always cover every model (they are summed server-side
	 * over all rows); only this breakdown is capped. Surface it, or the per-model
	 * rows will visibly fail to add up to the total.
	 */
	byModelTruncated: boolean;
}

export interface CredentialTotalsResponse {
	provider: string;
	entries: CredentialUsageTotals[];
}

export interface UsageHistoryListResponse {
	records: UsageHistoryRecord[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

export interface UsageHistoryCursorListResponse {
	records: UsageHistoryRecord[];
	hasMore: boolean;
	nextCursor: string | null;
	limit: number;
}

export interface UsageHistoryProvidersResponse {
	providers: string[];
}

export interface UserUsageTotals extends ReferenceCostSummary {
	userId: string;
	username: string | null;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	reasoningTokens: number;
	costUsd: number;
	unpricedRequestCount: number;
	firstUsedAt: string;
	lastUsedAt: string;
}

export interface UserUsageTotalsResponse {
	records: UserUsageTotals[];
	hasMore: boolean;
	nextCursor: string | null;
	limit: number;
}

export type UsageBreakdownDimension = "provider" | "model" | "kind" | "user";
export type UsageBreakdownMetric =
	| "requests"
	| "tokens"
	| "cost"
	| "inputTokens"
	| "outputTokens"
	| "cachedInputTokens"
	| "cacheCreationTokens"
	| "cacheHitRate"
	| "reasoningTokens";

export interface UsageBreakdownEntry {
	label: string;
	value: number | null;
	percentage: number;
	count: number;
}

export interface UsageBreakdownResponse {
	dimension: UsageBreakdownDimension;
	metric: UsageBreakdownMetric;
	entries: UsageBreakdownEntry[];
	total: number | null;
}

export interface UsageStackedTimeSeriesResponse {
	granularity: UsageHistoryGranularity;
	dimension: UsageBreakdownDimension;
	metric: UsageBreakdownMetric;
	series: Array<{
		label: string;
		color: string;
		data: Array<{ timestamp: string; value: number | null }>;
	}>;
	timestamps: string[];
	truncated: boolean;
	effectiveStartDate: string;
	effectiveEndDate: string;
}
