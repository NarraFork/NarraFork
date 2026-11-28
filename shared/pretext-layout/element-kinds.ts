/** Shared visual item kind vocabulary used by adapters and measure registries. */
export type VListElementKind =
	| "message-bubble"
	/**
	 * A FRAMED markdown bubble for server-authored injected content that speaks for
	 * somebody (a subagent's report, a teammate's message, a finished background task).
	 * Distinct from `message-bubble` (plain-text body) and `markdown` (unframed).
	 */
	| "injection-bubble"
	/** Outgoing Send / TeamStatus messages, never folded into tool activity traces. */
	| "communication-bubble"
	| "markdown"
	| "reasoning"
	| "media"
	| "web-search"
	| "system-simple"
	| "system-text"
	| "knowledge-hint"
	| "plan-card"
	| "modeltrace-result"
	/**
	 * A concluded code review: a header row over a maxHeight-capped scroll box holding a
	 * markdown body. Shaped like a tool card because the content is the same species as a
	 * plan — a long agent-authored document with code in it — which neither a clamped
	 * one-line card nor a plain-text notice could present.
	 */
	| "review-card"
	| "ask-in-passing"
	| "subagent-recovery"
	| "tool-call"
	/** A real message or system event using the shared tool-card presentation. */
	| "auxiliary-content"
	| "tool-call-group"
	| "tool-run-count"
	| "activity-trace"
	| "reasoning-steps"
	| "reasoning-count"
	| "ask-user-question"
	| "inline-permission"
	| "subagent-card"
	| "turn-usage"
	/**
	 * Team page only (opt-in): consecutive coordinator `Team` calls of one action folded into a
	 * one-line chip (「创建工作项 ×7」); toggles open onto the ordinary tool cards below it.
	 */
	| "team-chip"
	/** Team page only (opt-in): a team event as a thin divider at its time. */
	| "team-event";
