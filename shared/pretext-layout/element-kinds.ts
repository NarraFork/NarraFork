/** Shared visual item kind vocabulary used by adapters and measure registries. */
export type VListElementKind =
	| "message-bubble"
	/**
	 * A FRAMED markdown bubble for server-authored injected content that speaks for
	 * somebody (a subagent's report, a teammate's message, a finished background task).
	 * Distinct from `message-bubble` (plain-text body) and `markdown` (unframed).
	 */
	| "injection-bubble"
	| "markdown"
	| "reasoning"
	| "media"
	| "web-search"
	| "system-simple"
	| "system-text"
	| "knowledge-hint"
	| "plan-card"
	| "ask-in-passing"
	| "subagent-recovery"
	| "tool-call"
	| "tool-call-group"
	| "tool-run-count"
	| "activity-trace"
	| "reasoning-steps"
	| "reasoning-count"
	| "ask-user-question"
	| "inline-permission"
	| "subagent-card"
	| "prune-divider"
	| "turn-usage";
