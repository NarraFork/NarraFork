/**
 * Parent-narrator inbound message queue.
 *
 * Compatibility producer/formatter over the shared persistent runtime mailbox.
 *
 * When a subagent uses `Send({ id: "parent", message })` to report progress to
 * the narrator that launched it, the message is enqueued in the shared
 * `parent-injection-queue` keyed by the parent narrator id. A working parent drains it
 * at the next `after_tools` boundary; an idle parent is woken to consume it (see
 * startParentInboundContinuationIfPossible). The parent is always a primary
 * narrator (subagents cannot spawn nested subagents).
 *
 * This module now owns only the message SHAPE, its character cap, and the model-facing
 * formatting — ordering is shared with the background-completion producers.
 */

import type { Locale } from "../lib/prompt-i18n";
import { pushPendingInjection } from "./parent-injection-queue";

export interface ParentInboundMessage {
	delivery?: import("./agent-message-delivery").AgentMessageDelivery;
	/** Subagent narrator id that sent the message. */
	fromId: string;
	/** Subagent title (may be null when untitled). */
	fromTitle: string | null;
	/**
	 * Readable alias of the sender, used when it has no title. The previous
	 * fallback was an 8-char slice of the nanoid — recognizable only by accident.
	 */
	fromLabel?: string | null;
	/** Subagent type (explore/plan/general/review/custom). */
	fromType: string;
	/**
	 * Where the sender was in its OWN session when it sent this — the reader's
	 * navigation target (see `SideCarInboundMessage.fromMessageId`).
	 *
	 * Reader-only: `formatParentInboundMessages` never prints it. The model names
	 * agents by alias and has no use for a message id.
	 */
	fromMessageId?: string | null;
	/** Exact Send call in the sender's session; preferred over the legacy message target. */
	fromToolUseId?: string;
	/** Message text (already capped). */
	text: string;
	timestamp: string;
}

/**
 * Queue a subagent → parent message.
 *
 * The per-message character cap stays here (this producer's concern). The ORDER lives in
 * the shared `parent-injection-queue`, together with the two background-completion
 * producers: a report sent BEFORE a task finished must not be shown after it. The count
 * cap (20) now lives there too, applied per kind so a burst of completions cannot evict
 * messages. See that module's header.
 */
export function pushParentInboundMessage(
	parentNarratorId: string,
	message: ParentInboundMessage,
): Promise<void> {
	return pushPendingInjection(parentNarratorId, { kind: "subagent_message", message });
}

function senderLabel(message: ParentInboundMessage, isZh: boolean): string {
	const name = message.fromTitle?.trim() || message.fromLabel?.trim() || message.fromId.slice(0, 8);
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
