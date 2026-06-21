/**
 * Chat-group message delivery queue.
 *
 * Standalone module (no db dependency) to avoid circular imports between
 * narrator-session and chat-group-service — mirrors bg-completion-queue.
 *
 * When a group message must be delivered to a narrator member that is currently
 * `working`, it is queued here and drained at the next `after_tools` sidecar
 * boundary (so it rides along with the next request to the model instead of
 * interrupting mid-turn). Idle members are woken directly via sendMessage and
 * do not use this queue.
 */

/** Hard cap so a flood of group chatter can't blow up a narrator's context. */
const MAX_QUEUED_GROUP_MESSAGES = 20;
/** Per-message content cap (defensive; group messages are short by nature). */
const MAX_GROUP_MESSAGE_CHARS = 8_000;

export interface PendingGroupMessage {
	groupId: string;
	groupTitle: string;
	/** Display name of the sender (handle for narrators, username for users, "system"). */
	senderLabel: string;
	content: string;
}

let _groupMessageQueue: Map<string, PendingGroupMessage[]> | undefined;
function getGroupMessageQueue() {
	if (!_groupMessageQueue) _groupMessageQueue = new Map();
	return _groupMessageQueue;
}

export function pushGroupMessageForNarrator(
	narratorId: string,
	message: PendingGroupMessage,
): void {
	const queue = getGroupMessageQueue();
	const list = queue.get(narratorId) ?? [];
	list.push({
		...message,
		content:
			message.content.length > MAX_GROUP_MESSAGE_CHARS
				? `${message.content.slice(0, MAX_GROUP_MESSAGE_CHARS)}…[truncated]`
				: message.content,
	});
	// Keep only the most recent messages if the queue overflows.
	if (list.length > MAX_QUEUED_GROUP_MESSAGES) {
		list.splice(0, list.length - MAX_QUEUED_GROUP_MESSAGES);
	}
	queue.set(narratorId, list);
}

/** Drain queued group messages for a narrator (consumed in getSideCars after_tools). */
export function drainGroupMessagesForNarrator(narratorId: string): PendingGroupMessage[] {
	const queue = getGroupMessageQueue();
	const list = queue.get(narratorId);
	if (!list || list.length === 0) return [];
	queue.delete(narratorId);
	return list;
}

/** Whether a narrator has any queued group messages waiting. */
export function hasQueuedGroupMessages(narratorId: string): boolean {
	const list = getGroupMessageQueue().get(narratorId);
	return !!list && list.length > 0;
}

/** Format a single inbound group message for injection into a narrator's session. */
export function formatGroupMessageForInjection(message: PendingGroupMessage): string {
	return `[Group "${message.groupTitle}" — from @${message.senderLabel}]: ${message.content}`;
}

/** Format a batch of queued group messages as one sidecar block. */
export function formatGroupMessages(messages: PendingGroupMessage[]): string {
	return messages.map(formatGroupMessageForInjection).join("\n\n");
}
