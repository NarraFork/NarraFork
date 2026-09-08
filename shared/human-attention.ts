/** Actionable human decisions, independent of narrator execution status. */
export type HumanAttentionKind =
	| "async_question"
	| "blocking_question"
	| "permission"
	| "plan_approval"
	| "reflection";

/** List rows never carry full tool inputs, plans, or question forms. */
export interface HumanAttentionItem {
	/** Source-prefixed identity, so a question and a permission cannot collide. */
	id: string;
	kind: HumanAttentionKind;
	source: "question" | "permission";
	/** Actual answer/decision endpoint identity; reflection IDs can be synthetic. */
	requestId: string;
	toolCallId: string;
	toolName: string;
	/** The decision owner, never the parent's broadcast target. */
	narratorId: string;
	narratorTitle: string | null;
	/** Only subagents inherit display grouping from their parent/root. */
	parentNarratorId: string | null;
	rootNarratorId: string | null;
	chapterId: string | null;
	createdAt: string;
	blocking: boolean;
	/** Read visibility does not imply permission to answer or approve. */
	canAct: boolean;
	summary: string;
}

/** Counts are derived from loaded pages; nextCursor means the count is a lower bound. */
export interface HumanAttentionPage {
	items: HumanAttentionItem[];
	nextCursor: string | null;
}

export const HUMAN_ATTENTION_DEFAULT_PAGE_SIZE = 50;
export const HUMAN_ATTENTION_MAX_PAGE_SIZE = 100;
export const HUMAN_ATTENTION_DETAIL_MAX_BYTES = 256 * 1024;
export const HUMAN_ATTENTION_CHANGED_WS_TYPE = "human_attention_changed";
