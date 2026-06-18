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
