/**
 * chat-vlist-adapter.ts — Project chat room messages into TreeMessage rows.
 *
 * The chat list renders through the SAME PretextExactMessageList as the narrator
 * panel, so this module is the ONLY chat-specific piece: it maps the room's
 * DTO onto the document shape (user bubbles with quote strips, tombstones,
 * grouping and attachment blocks). Everything downstream — measure, render,
 * virtualization, realtime upserts — is the shared vlist.
 *
 * Pure (no React, no DOM): reply preview resolution and grouping come from
 * `chat-list-layout`'s buildChatRows, the same pure kernel the pre-vlist list
 * used. Attachment bytes are never located here — a `fetchUrl` passthrough
 * names the authenticated endpoint the render layer resolves.
 */

import type { ChatAttachment, ChatMessage } from "../../lib/api/chat";
import type { ContentBlock, TreeMessage } from "../../lib/api/types";
import { buildChatRows, type ChatRowInput } from "./chat-list-layout";

/** Localized strings the projection bakes into rows (cache-keyed upstream). */
export interface ChatTreeProjectionLabels {
	/** Tombstone line of a soft-deleted message. */
	messageDeleted: string;
	/** Quote strip when the reply target was deleted. */
	replyToDeleted: string;
	/** Quote strip when the reply target is outside the loaded window. */
	replyUnavailable: string;
	/** Guest marker appended to a quoted guest author's name. */
	guestMarker: string;
}

/**
 * Project one room's loaded window (oldest first) into TreeMessages. Grouping
 * and reply resolution re-run wholesale because a prepended page changes the
 * grouping of the old first row.
 */
export function projectChatMessagesToTree(
	messages: readonly ChatMessage[],
	labels: ChatTreeProjectionLabels,
): TreeMessage[] {
	return buildChatRows(messages).map((row) => projectChatRow(row, labels));
}

/** Project a live row using only its predecessor and optional quote target, not the full history. */
export function projectChatLiveMessage(
	message: ChatMessage,
	loaded: ReadonlyMap<string, ChatMessage>,
	labels: ChatTreeProjectionLabels,
): TreeMessage | undefined {
	let previous: ChatMessage | undefined;
	for (const candidate of loaded.values()) {
		if (candidate.seq < message.seq && (!previous || candidate.seq > previous.seq))
			previous = candidate;
	}
	const context = new Map<string, ChatMessage>([[message.id, message]]);
	if (previous) context.set(previous.id, previous);
	const quoted = message.replyToMessageId ? loaded.get(message.replyToMessageId) : undefined;
	if (quoted) context.set(quoted.id, quoted);
	return projectChatMessagesToTree(
		[...context.values()].sort((a, b) => a.seq - b.seq),
		labels,
	).find((row) => row.id === message.id);
}

/** Preserve identity/cursors while erasing deleted bytes. Safe before or after cache WS patches. */
export function chatMessageTombstone(message: ChatMessage, deletedAt: string): ChatMessage {
	return {
		...message,
		contentText: "",
		attachments: [],
		deletedAt: message.deletedAt ?? deletedAt,
	};
}

/** Only legacy quotes follow the loaded target; immutable post-time snapshots stay intact. */
export function projectChatDeletion(
	messages: readonly ChatMessage[],
	messageId: string,
	deletedAt: string,
	labels: ChatTreeProjectionLabels,
): { messages: ChatMessage[]; upserts: TreeMessage[] } {
	const patched = messages.map((message) =>
		message.id === messageId ? chatMessageTombstone(message, deletedAt) : message,
	);
	const index = patched.findIndex((message) => message.id === messageId);
	const successor = index >= 0 ? patched[index + 1] : undefined;
	const affected = new Set(
		patched
			.filter(
				(message) =>
					message.id === messageId ||
					message.id === successor?.id ||
					(message.replyToMessageId === messageId && message.replyToPreview == null),
			)
			.map((message) => message.id),
	);
	return {
		messages: patched,
		upserts: buildChatRows(patched)
			.filter((row) => affected.has(row.message.id))
			.map((row) => projectChatRow(row, labels)),
	};
}

function projectChatRow(row: ChatRowInput, labels: ChatTreeProjectionLabels): TreeMessage {
	const { message } = row;
	const deleted = message.deletedAt != null;
	const contentJson: ContentBlock[] = [];
	// Attachments stack above the body INSIDE the user bubble (the kernel's user
	// branch reads image/text_file blocks in contentJson order).
	if (!deleted) {
		for (const attachment of message.attachments) {
			contentJson.push(projectAttachment(attachment));
		}
	}
	contentJson.push({ type: "text", text: deleted ? "" : message.contentText } as ContentBlock);

	return {
		id: message.id,
		narratorId: message.roomId,
		parentToolUseId: null,
		role: "user",
		bodyFormat: "markdown",
		contentJson,
		contentText: deleted ? "" : message.contentText,
		toolCalls: [],
		createdAt: message.createdAt,
		seq: message.seq,
		creator: message.sender
			? {
					id: message.sender.id,
					username: message.sender.username,
					avatarColor: message.sender.avatarColor,
					avatarImageId: message.sender.avatarImageId,
					...(message.sender.isGuest ? { isGuest: true } : {}),
				}
			: null,
		children: [],
		editedAt: message.editedAt,
		// Kernel passthrough (see TreeMessage's projection-only fields).
		replyQuote: row.reply
			? {
					authorName: row.reply.authorName
						? row.reply.authorIsGuest
							? `${row.reply.authorName} (${labels.guestMarker})`
							: row.reply.authorName
						: null,
					text:
						row.reply.state === "quoted"
							? row.reply.preview
							: row.reply.state === "deleted"
								? labels.replyToDeleted
								: labels.replyUnavailable,
					state: row.reply.state,
					targetId: row.reply.targetId,
					targetSeq: row.reply.targetSeq,
				}
			: null,
		omitHeader: row.grouped,
		...(deleted ? { deletedLabel: labels.messageDeleted } : {}),
	} as TreeMessage;
}

/**
 * One attachment as a content block. The bytes live behind the authenticated
 * `/chat/attachments/:id` endpoint; `fetchUrl` is the render layer's lane
 * (VListImage), so nothing is fetched at projection time.
 */
function projectAttachment(attachment: ChatAttachment): ContentBlock {
	return {
		type: attachment.kind === "image" ? "image" : "text_file",
		filename: attachment.filename,
		mediaType: attachment.mediaType,
		size: attachment.sizeBytes,
		width: attachment.width,
		height: attachment.height,
		fetchUrl: `/chat/attachments/${attachment.id}`,
	} as ContentBlock;
}
