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

export interface PendingGroupMember {
	narratorId: string;
	handle?: string | null;
	title?: string | null;
	role?: string | null;
	canControl?: boolean | null;
	status?: string | null;
	substatus?: unknown;
}

export interface PendingGroupMessage {
	groupId: string;
	groupTitle: string;
	/** Stored chat_group_messages ID for diagnostics / future delivery-state tracking. */
	groupMessageId?: string;
	/** Display name of the sender (handle for narrators, username for users, "system"). */
	senderLabel: string;
	senderType?: "user" | "narrator" | "system";
	content: string;
	members?: PendingGroupMember[];
	locale?: string;
}

export interface PendingGroupReplyContext {
	groupId: string;
	groupTitle: string;
	groupMessageId?: string;
	senderLabel: string;
}

let _groupMessageQueue: Map<string, PendingGroupMessage[]> | undefined;
let _groupReplyContextQueue: Map<string, PendingGroupReplyContext[]> | undefined;

function getGroupMessageQueue() {
	if (!_groupMessageQueue) _groupMessageQueue = new Map();
	return _groupMessageQueue;
}

function getGroupReplyContextQueue() {
	if (!_groupReplyContextQueue) _groupReplyContextQueue = new Map();
	return _groupReplyContextQueue;
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

/**
 * Record that group user messages have actually been consumed by a narrator turn.
 * Only user-originated group messages trigger auto-backflow; narrator/system
 * messages are intentionally excluded to avoid agent-to-agent reply loops.
 */
export function markGroupMessagesConsumedForReply(
	narratorId: string,
	messages: PendingGroupMessage[],
): void {
	const contexts = messages
		.filter((message) => message.senderType === "user")
		.map((message) => ({
			groupId: message.groupId,
			groupTitle: message.groupTitle,
			groupMessageId: message.groupMessageId,
			senderLabel: message.senderLabel,
		}));
	if (contexts.length === 0) return;
	const queue = getGroupReplyContextQueue();
	const list = queue.get(narratorId) ?? [];
	list.push(...contexts);
	if (list.length > MAX_QUEUED_GROUP_MESSAGES) {
		list.splice(0, list.length - MAX_QUEUED_GROUP_MESSAGES);
	}
	queue.set(narratorId, list);
}

export function drainPendingGroupReplyContexts(narratorId: string): PendingGroupReplyContext[] {
	const queue = getGroupReplyContextQueue();
	const list = queue.get(narratorId);
	if (!list || list.length === 0) return [];
	queue.delete(narratorId);
	return list;
}

function memberLabel(member: PendingGroupMember): string {
	if (member.handle) return `@${member.handle}`;
	if (member.title) return member.title;
	return member.narratorId.slice(0, 8);
}

function formatMembers(message: PendingGroupMessage, isZh: boolean): string {
	const members = message.members ?? [];
	if (members.length === 0) return isZh ? "（成员列表暂不可用）" : "(member list unavailable)";
	return members
		.map((member) => {
			const role = member.role ? `role=${member.role}` : null;
			const status = member.status ? `status=${member.status}` : null;
			const control = member.canControl ? (isZh ? "可控制" : "canControl") : null;
			const meta = [role, status, control].filter(Boolean).join(", ");
			return `- ${memberLabel(member)} (id=${member.narratorId}${meta ? `; ${meta}` : ""})`;
		})
		.join("\n");
}

/** Format a single inbound group message for injection into a narrator's session. */
export function formatGroupMessageForInjection(message: PendingGroupMessage): string {
	const isZh = message.locale === "zh-CN";
	const title = message.groupTitle || (isZh ? "未命名群聊" : "untitled group");
	const sender = message.senderLabel.startsWith("@")
		? message.senderLabel
		: `@${message.senderLabel}`;

	if (isZh) {
		return [
			`[群聊消息] 群聊："${title}" (group_id=${message.groupId})`,
			`发送者：${sender}`,
			"群成员：",
			formatMembers(message, true),
			"消息内容：",
			message.content,
			'协作提示：如果你的回复需要让群聊成员看到，请使用 Send 工具发回对应成员，例如 Send({ name: "@handle", message: "..." })。只在本会话自然回复不会自动出现在群聊页。',
		].join("\n");
	}

	return [
		`[Group message] Group: "${title}" (group_id=${message.groupId})`,
		`From: ${sender}`,
		"Members:",
		formatMembers(message, false),
		"Message:",
		message.content,
		'Collaboration hint: if your reply should be visible to the group, use the Send tool to reply to a member, for example Send({ name: "@handle", message: "..." }). A normal reply in this session will not automatically appear on the group chat page.',
	].join("\n");
}

/** Format a batch of queued group messages as one sidecar block. */
export function formatGroupMessages(messages: PendingGroupMessage[]): string {
	return messages.map(formatGroupMessageForInjection).join("\n\n");
}
