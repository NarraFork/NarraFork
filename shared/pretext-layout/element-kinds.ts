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
	/**
	 * 一整轮已完成工作的折叠条（"已处理 2m 14s · 12.3k token"）。
	 *
	 * 由 `round-group.ts` 的运行期合成产生：把一轮里「轮首用户消息」与「最终
	 * 回复」之间的过程元素替换成这一个元素。收起态高度是常量（一行），展开态
	 * 高度由渲染层实测回填（`round-fold-heights.ts`）—— 本列表里唯一的这种元素。
	 *
	 * 与 `tool-run-count` / `activity-trace` 的区别：那两个折的是**一段工具调用**，
	 * 这个折的是**整轮**，且带时长与 token。
	 */
	| "round-group"
	| "turn-usage";
