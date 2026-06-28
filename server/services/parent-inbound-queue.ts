/**
 * Parent-narrator inbound message queue.
 *
 * Standalone module (no db dependency) to avoid circular imports between
 * narrator-session and agent-communication — mirrors bg-completion-queue and
 * chat-group-queue.
 *
 * When a subagent uses `Send({ id: "parent", message })` to report progress to
 * the narrator that launched it, the message is queued here keyed by the parent
 * narrator id. A working parent drains it at the next `after_tools` sidecar
 * boundary; an idle parent is woken to consume it (see
 * startParentInboundContinuationIfPossible). The parent is always a primary
 * narrator (subagents cannot spawn nested subagents).
 */

import type { Locale } from "../lib/prompt-i18n";

/** Hard cap so a flood of subagent reports can't blow up a parent's context. */
const MAX_PARENT_INBOUND_MESSAGES = 20;
/** Per-message content cap (defensive; progress reports should be concise). */
const MAX_PARENT_INBOUND_CHARS = 8_000;

export interface ParentInboundMessage {
	/** Subagent narrator id that sent the message. */
	fromId: string;
	/** Subagent title (may be null when untitled). */
	fromTitle: string | null;
	/** Subagent type (explore/plan/general/review/custom). */
	fromType: string;
	/** Message text (already capped). */
	text: string;
	timestamp: string;
}

// In-memory only — intentionally not persisted. Subagent lifetimes are short
// (bounded by the parent narrator session) so messages don't need to survive
// server restarts. Working-parent messages land in narrator_sidecars and
// idle-parent wakes persist a system message, so durable records still exist.
let _parentInboundQueue: Map<string, ParentInboundMessage[]> | undefined;
function getParentInboundQueue() {
	if (!_parentInboundQueue) _parentInboundQueue = new Map();
	return _parentInboundQueue;
}

/** Queue a subagent → parent message. Drops the oldest entries on overflow. */
export function pushParentInboundMessage(
	parentNarratorId: string,
	message: ParentInboundMessage,
): void {
	const queue = getParentInboundQueue();
	const list = queue.get(parentNarratorId) ?? [];
	list.push({
		...message,
		text:
			message.text.length > MAX_PARENT_INBOUND_CHARS
				? `${message.text.slice(0, MAX_PARENT_INBOUND_CHARS)}…[truncated]`
				: message.text,
	});
	// Keep only the most recent messages if the queue overflows.
	if (list.length > MAX_PARENT_INBOUND_MESSAGES) {
		list.splice(0, list.length - MAX_PARENT_INBOUND_MESSAGES);
	}
	queue.set(parentNarratorId, list);
}

/** Drain all pending inbound messages for a parent narrator. */
export function drainParentInboundMessages(parentNarratorId: string): ParentInboundMessage[] {
	const queue = getParentInboundQueue();
	const list = queue.get(parentNarratorId);
	if (!list || list.length === 0) return [];
	queue.delete(parentNarratorId);
	return list;
}

function senderLabel(message: ParentInboundMessage, isZh: boolean): string {
	const name = message.fromTitle?.trim() || message.fromId.slice(0, 8);
	return isZh
		? `子代理"${name}"（${message.fromType}）`
		: `subagent "${name}" (${message.fromType})`;
}

/** Format a single inbound message with a sender prefix for injection. */
function formatParentInboundMessage(message: ParentInboundMessage, locale: Locale): string {
	const isZh = locale === "zh-CN";
	if (isZh) {
		return `[来自${senderLabel(message, true)}的进展汇报]：\n${message.text}`;
	}
	return `[Progress report from ${senderLabel(message, false)}]:\n${message.text}`;
}

/** Format a batch of queued inbound messages as one injection block. */
export function formatParentInboundMessages(
	messages: ParentInboundMessage[],
	locale: Locale,
): string {
	return messages.map((message) => formatParentInboundMessage(message, locale)).join("\n\n");
}
