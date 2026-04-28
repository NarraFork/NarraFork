export interface UsageHistoryRawDump {
	provider?: string;
	model?: string;
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
	narratorId: string;
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

export interface UsageHistoryFilters {
	narratorId?: string;
	chapterId?: string;
	projectId?: string;
	provider?: string;
	model?: string;
	startDate?: string;
	endDate?: string;
}

export interface UsageHistoryListResponse {
	records: UsageHistoryRecord[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

export interface UsageHistoryProvidersResponse {
	providers: string[];
}
