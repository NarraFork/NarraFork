export interface SearchRequest {
	query: string;
	purpose?: string;
	allowedDomains?: string[];
	blockedDomains?: string[];
	recencyDays?: number;
	maxResults?: number;
	channelId?: string;
	locale?: string;
	signal?: AbortSignal;
	parentNarratorId?: string;
	parentToolUseId?: string;
	cwd?: string;
	/** Provider prefix of the session that requested the search (for the native channel). */
	provider?: string;
	/** Model ID of the session that requested the search (for the native channel). */
	model?: string;
	/** User who triggered the requesting turn (for the search-subagent channel). */
	userId?: string | null;
	/** Server-owned settings probe; never accepted from a WebSearch tool call. */
	testMode?: boolean;
}

export interface SearchResultItem {
	title?: string;
	url?: string;
	snippet?: string;
	publishedAt?: string;
	source?: string;
}

export interface SearchChannelResult {
	channelId: string;
	channelLabel: string;
	text: string;
	results?: SearchResultItem[];
	sources?: SearchResultItem[];
}

export interface SearchChannelAttempt {
	channelId: string;
	channelLabel: string;
	skipped?: boolean;
	error?: string;
}

export interface SearchExecutionResult extends SearchChannelResult {
	attempts: SearchChannelAttempt[];
}
