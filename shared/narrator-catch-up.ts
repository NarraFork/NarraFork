export const MAX_CATCH_UP_CHILD_ANCHORS = 32;

export interface CatchUpChildAnchor {
	/** Parent narrator tool_use ID that owns this child stream. */
	parentToolUseId: string;
	/** Narrator that stores the child messages. Omitted until the first child is known. */
	narratorId?: string;
	/** Last child message received for this stream. Omitted to watch from stream start. */
	lastMessageId?: string;
}

export interface CatchUpCursor {
	/** Parent narrator top-level message stream position. */
	parentLastMessageId?: string;
	/** Subagent child stream positions keyed by parentToolUseId. */
	childAnchors?: CatchUpChildAnchor[];
}
