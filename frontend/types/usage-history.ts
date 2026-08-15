/**
 * Pointer left on the dump when the complete copy was written to a file.
 *
 * Mirrors `RawDumpSpillPointer` in `server/lib/api-request-dump-store.ts`, minus the
 * absolute `filePath` — `redactSpillPointerPaths` replaces it with `fileName` before the
 * dump leaves the server, because the path carries the host's OS account name.
 *
 * Every field is optional: the pointer is read out of a stored JSON blob that may predate
 * the current shape, and a missing field must degrade to "say less", never to a crash.
 */
export interface UsageHistoryRawDumpSpill {
	schema?: string;
	/**
	 * True when the inline dump is only the head of a larger file.
	 *
	 * This is the whole reason the pointer is exposed: without surfacing it the UI presents
	 * a truncated body as if it were the entire request.
	 */
	inlineTruncated?: boolean;
	/**
	 * True when the FILE itself had to shed parts to fit the server's per-file ceiling.
	 *
	 * Categorically different from `inlineTruncated`, which is always true on a pointer and
	 * only says the row is a head that a download completes. This one says no complete copy
	 * exists anywhere — downloading gets less than what was sent — so the UI must state that
	 * outright rather than let a file that looks whole imply otherwise.
	 */
	truncated?: boolean;
	/** Serialized byte size of the complete dump before shedding, when `truncated`. */
	originalBytes?: number;
	/** Byte size of the dump actually stored on disk. */
	bytes?: number;
	/** Spill file basename — what correlates a downloaded dump with a server log line. */
	fileName?: string;
	note?: string;
}

export interface UsageHistoryRawDump {
	provider?: string;
	model?: string;
	spill?: UsageHistoryRawDumpSpill | null;
	request?: {
		transport?: string;
		url?: string;
		headers?: Record<string, string>;
		body?: unknown;
	};
	response?: {
		status?: number;
		headers?: Record<string, string>;
		bodyText?: string;
		events?: unknown[];
		error?: string;
	};
}

export interface UsageHistoryRecord {
	id: string;
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
	chapterTitle?: string | null;
	chapterId?: string | null;
	projectId?: string | null;
	hasRawDump?: boolean;
	rawDump?: UsageHistoryRawDump | null;
}

export interface UsageHistoryStats {
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

export interface UsageHistoryTimeSeriesPoint {
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
	narratorId?: string;
	chapterId?: string;
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
export interface CredentialUsageTotals {
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

export type UsageBreakdownDimension = "provider" | "model" | "kind";
export type UsageBreakdownMetric =
	| "requests"
	| "tokens"
	| "cost"
	| "inputTokens"
	| "outputTokens"
	| "reasoningTokens";

export interface UsageBreakdownEntry {
	label: string;
	value: number;
	percentage: number;
	count: number;
}

export interface UsageBreakdownResponse {
	dimension: UsageBreakdownDimension;
	metric: UsageBreakdownMetric;
	entries: UsageBreakdownEntry[];
	total: number;
}

export interface UsageStackedTimeSeriesResponse {
	granularity: UsageHistoryGranularity;
	dimension: UsageBreakdownDimension;
	metric: UsageBreakdownMetric;
	series: Array<{
		label: string;
		color: string;
		data: Array<{ timestamp: string; value: number }>;
	}>;
	timestamps: string[];
	truncated: boolean;
	effectiveStartDate: string;
	effectiveEndDate: string;
}
