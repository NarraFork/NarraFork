/** Actionable human decisions, independent of narrator execution status. */
export type HumanAttentionKind =
	| "async_question"
	| "blocking_question"
	| "permission"
	| "plan_approval"
	| "reflection"
	/** Outline (P2 PR 7): questions put to you under one block, or a change for you to confirm. */
	| "outline_decision"
	/** Outline: what agents confirmed on your behalf, to acknowledge (reports later, PR 11). */
	| "outline_digest";

/** What an outline item is about; ids only (the client reads the rest from the outline API). */
export interface HumanAttentionOutlineRef {
	what: "questions" | "pending" | "digest";
	spaceId: string | null;
	pageId: string | null;
	/** The block the questions are under; a pending change's locked task. */
	blockId: string | null;
	/** A pending change's id. */
	pendingId: string | null;
	/** Questions in the group, operations of the change, confirmations in the digest. */
	count: number;
	/**
	 * The asking or proposing session is one the person may not read: the row names neither its
	 * id nor its title, and the client shows a placeholder.
	 */
	sessionHidden: boolean;
}

/** List rows never carry full tool inputs, plans, or question forms. */
export interface HumanAttentionItem {
	/** Source-prefixed identity, so a question and a permission cannot collide. */
	id: string;
	kind: HumanAttentionKind;
	source: "question" | "permission" | "outline";
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
	createdAt: string;
	blocking: boolean;
	/** Read visibility does not imply permission to answer or approve. */
	canAct: boolean;
	summary: string;
	/** Outline items only. */
	outline?: HumanAttentionOutlineRef;
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
