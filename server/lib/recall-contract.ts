/** Persisted values, not a second sender-identity or permission model. */
export const RECALL_ROLES = ["user", "assistant", "system", "sys", "disp"] as const;
export type RecallRole = (typeof RECALL_ROLES)[number];
export const RECALL_ORIGINS = ["user", "assistant", "system", "unknown"] as const;
export type RecallOrigin = (typeof RECALL_ORIGINS)[number];
export type RecallSort = "relevance" | "newest" | "oldest";
export type RecallDirection = "older" | "newer" | "around";

export const RECALL_LIMITS = {
	queries: 10,
	queryChars: 512,
	defaultResults: 20,
	maxResults: 50,
	previewChars: 500,
	defaultPageChars: 8000,
	maxPageChars: 20000,
} as const;

export interface RecallFilters {
	roles?: readonly RecallRole[];
	/** NULL is unknown, never silently promoted to confirmed human authorship. */
	origins?: readonly RecallOrigin[];
	createdFrom?: string;
	createdTo?: string;
}

export interface RecallConversationOptions extends RecallFilters {
	direction?: RecallDirection;
	/** Exclusive sequence boundary; around uses messageId instead. */
	cursor?: number;
	includeToolCalls?: boolean;
}

export interface RecallPagination {
	hasOlder: boolean;
	hasNewer: boolean;
	olderCursor: number | null;
	newerCursor: number | null;
}

/** All offsets and counts below use Unicode code points, not UTF-16 code units. */
export interface RecallTextPage {
	text: string;
	offset: number;
	totalChars: number;
	hasMore: boolean;
	nextOffset: number | null;
}

export interface RecallMessageInput {
	narratorId: string;
	messageId: string;
	offset: number;
	maxChars: number;
}
export interface RecallMessagePage extends RecallTextPage {
	messageId: string;
	narratorId: string;
	narratorTitle: string | null;
	role: string;
	origin: string | null;
	originLabel: string | null;
	createdAt: string;
	seq: number;
	bodyRevision: number;
	/** Non-text bodies are described, never fabricated as original text or attachment bytes. */
	omittedBlocks?: readonly string[];
	toolCalls?: {
		toolUseId: string;
		toolName: string;
		status: string;
		summary: string;
	}[];
}

export interface RecallToolCallPageInput {
	toolCallId: string;
	/** null means a global lookup, after the existing cross-narrator permission check. */
	narratorId: string | null;
	part: "both" | "input" | "output";
	offset: number;
	maxChars: number;
}
