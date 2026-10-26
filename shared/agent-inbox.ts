/** Why queued agent messages cannot start a session by themselves. */
export type AgentInboxBlockedReason = "error" | "user_interrupt";

export interface PendingAgentMessageSummary {
	id: string;
	sender: { id: string; label: string | null; title: string | null } | null;
	/** Leading part of the body; `truncated` says whether more exists. */
	preview: string;
	truncated: boolean;
	createdAt: string;
}

/** `GET /api/narrators/:id/inbox/agent-messages` */
export interface PendingAgentMessagesPage {
	messages: PendingAgentMessageSummary[];
	hasMore: boolean;
	/** A running session reads its queued messages at its next boundary by itself. */
	running: boolean;
	/** Set while the session is idle after a turn agent messages may not restart. */
	blockedReason: AgentInboxBlockedReason | null;
}
