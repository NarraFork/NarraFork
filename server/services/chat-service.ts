/**
 * chat-service.ts — Human-to-human chat, disjoint from narrator context.
 *
 * Two room kinds share one storage shape but not one authorization rule:
 *
 *   - `dm`       — closed 1:1. `chat_room_members` IS the ACL.
 *   - `narrator` — the discussion room beside one narrator. Read access follows
 *                  NARRATOR VISIBILITY, not membership; the member row exists
 *                  only to hold that user's read watermark.
 *
 * Nothing written here ever reaches a model. Forwarding is an explicit user
 * action on the client (see `submitToNarrator`), which goes through the
 * narrator's normal composer path so busy-narrator buffering still applies.
 *
 * Main-thread discipline (CLAUDE.md): every query here is small, indexed and
 * bounded. Specifically:
 *   - `seq` is claimed from `chat_rooms.next_seq` inside the write transaction,
 *     never from `MAX(seq)` (a growing scan that also races).
 *   - pagination reads `LIMIT n + 1` and never runs `COUNT(*)`.
 *   - the room list reads `last_message_preview`, never `content_text`.
 *   - unread counts are probed with a hard `LIMIT`, so one huge room cannot turn
 *     a badge refresh into a scan.
 */

import { db } from "@server/db";
import {
	chatAttachments,
	chatMessages,
	chatRoomMembers,
	chatRooms,
	narratorPublicShares,
	narrators,
	users,
} from "@server/db/schema";
import { buildAttachedFilesHint } from "@server/lib/attached-files";
import {
	CHAT_ATTACHMENT_TOTAL_BYTES_MAX,
	CHAT_ATTACHMENTS_PER_MESSAGE_MAX,
	CHAT_ATTACHMENTS_UNAVAILABLE_CODE,
	CHAT_DRAFT_ATTACHMENTS_MAX,
	copyChatAttachmentToWorktree,
	deleteChatAttachmentFiles,
	getChatAttachmentFileInfo,
	saveChatAttachment,
} from "@server/lib/chat-attachments";
import {
	AppError,
	ForbiddenError,
	NotFoundError,
	RateLimitError,
	ValidationError,
} from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { hotSafe } from "@server/lib/hot-safe";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import type { TextFileRef } from "@server/lib/uploads";
import {
	canReadNarrator,
	canWriteNarrator,
	NARRATOR_ACL_COLUMNS,
} from "@server/services/narrator-acl";
import type { PublicDiscussionMessage, PublicDiscussionPage } from "@shared/public-narrator-share";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { PUBLIC_SHARE_LIMITS } from "./public-narrator-share-limits";

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/** Hard ceiling on one message body. Enforced again by the Zod schema. */
export const CHAT_MESSAGE_MAX_CHARS = 8_000;
/** Room-list summary length. Written at post time so the list never reads bodies. */
export const CHAT_PREVIEW_MAX_CHARS = 120;
export const CHAT_PAGE_DEFAULT = 50;
export const CHAT_PAGE_MAX = 100;
/**
 * Unread probe ceiling. Past this the client shows "99+": the exact number stops
 * being useful long before it stops being expensive to compute.
 */
export const CHAT_UNREAD_PROBE_LIMIT = 100;
/**
 * Ceiling on how many of a user's rooms one list/badge request will consider.
 *
 * `ensureMembers` creates a member row on first visit to ANY narrator room, so an
 * active account accumulates rows indefinitely and an unbounded `.all()` here
 * would eventually scan them all on every badge refresh (CLAUDE.md's main-thread
 * rule). 200 is far past what a human scrolls in a conversation list while
 * keeping the per-request work flat. Both callers order by room activity first,
 * so the rooms that get dropped are the least recently used ones.
 */
export const CHAT_ROOM_SCAN_LIMIT = 200;
/**
 * Rooms per batched unread query.
 *
 * Each room contributes its own sub-select to a `UNION ALL`, so the shard size bounds the
 * statement: SQLite's default `SQLITE_MAX_COMPOUND_SELECT` is 500, and the bound parameter
 * count grows with the arm count. 50 keeps both far below their limits while holding the
 * round trips low — a full {@link CHAT_ROOM_SCAN_LIMIT} scan is 4 statements, not 200.
 */
const UNREAD_PROBE_ROOMS_PER_SHARD = 50;
/**
 * Ceiling on the members one badge fan-out will notify.
 *
 * A DM has exactly two, but a narrator room's membership grows with every user who has
 * ever opened it (`ensureMembers` writes a row for the watermark alone), so this list is
 * unbounded in principle. Every posted message walks it, which makes an uncapped read the
 * one place a popular narrator could turn a single message into an ever-growing amount of
 * main-thread work.
 *
 * Ordered by watermark so the members kept are the ones with the most to catch up on. A
 * member past the cap simply does not get a live badge push; their count is still correct
 * the next time they load it, because it is derived rather than stored.
 */
export const CHAT_MEMBER_FANOUT_LIMIT = 200;
/** Directory page size. */
export const CHAT_DIRECTORY_LIMIT = 100;
/** Summarize input bounds — both apply, whichever bites first. */
export const CHAT_SUMMARIZE_MAX_MESSAGES = 200;
export const CHAT_SUMMARIZE_MAX_CHARS = 40_000;
/**
 * Per-user budget for `/summarize`, the one chat path that spends model quota.
 * A token bucket rather than a fixed window so a burst of a few selections is
 * fine but a loop cannot sustain more than one call every ~6 seconds.
 */
export const CHAT_SUMMARIZE_BURST = 5;
export const CHAT_SUMMARIZE_REFILL_PER_SECOND = 1 / 6;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatUserSnapshot {
	id: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
	/** Display-only identity, never a user/profile lookup key. */
	isGuest?: boolean;
}

/**
 * One attachment as the client sees it.
 *
 * Metadata only — the bytes are fetched separately through
 * `GET /api/chat/attachments/:id`, which re-checks room access. `storedName` is
 * deliberately absent: it is a disk detail, and exposing it would invite a client
 * to construct a path instead of going through the authorized endpoint.
 */
export interface ChatAttachmentRow {
	id: string;
	kind: "image" | "file";
	filename: string;
	mediaType: string;
	sizeBytes: number;
	/** Images only. Present so the client can reserve height without loading it. */
	width: number | null;
	height: number | null;
}

export interface ChatMessageRow {
	id: string;
	roomId: string;
	seq: number;
	kind: "text" | "system";
	contentText: string;
	replyToMessageId: string | null;
	/**
	 * Quote snapshot, captured at post time (see the schema note).
	 *
	 * Three distinguishable states, which the previous window-resolution approach
	 * collapsed into one misleading "deleted" label:
	 *   - `replyToPreview` a non-empty string → the quoted text.
	 *   - `replyToPreview` an empty string    → the target was already deleted.
	 *   - all three null                      → a legacy row with no snapshot; the
	 *     client resolves within the loaded window and reports honestly when it
	 *     cannot.
	 */
	replyToSeq: number | null;
	replyToSender: ChatUserSnapshot | null;
	replyToPreview: string | null;
	attachments: ChatAttachmentRow[];
	editedAt: string | null;
	deletedAt: string | null;
	createdAt: string;
	sender: ChatUserSnapshot | null;
}

export interface ChatRoomSummary {
	id: string;
	kind: "dm" | "narrator";
	narratorId: string | null;
	lastMessageAt: string | null;
	lastMessagePreview: string | null;
	lastMessageSenderId: string | null;
	/** DM only: the other participant. */
	peer: ChatUserSnapshot | null;
	unread: number;
	/** `unread` hit CHAT_UNREAD_PROBE_LIMIT — display as "99+". */
	unreadCapped: boolean;
	lastReadSeq: number;
	muted: boolean;
}

export interface ChatMessagePage {
	messages: ChatMessageRow[];
	hasMore: boolean;
	/** Cursor for the next (older) page; null when the room start is loaded. */
	nextBeforeSeq: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const USER_COLUMNS = {
	id: true,
	username: true,
	avatarColor: true,
	avatarImageId: true,
} as const;

function toUserSnapshot(
	row:
		| { id: string; username: string; avatarColor: string | null; avatarImageId: string | null }
		| null
		| undefined,
): ChatUserSnapshot | null {
	if (!row) return null;
	return {
		id: row.id,
		username: row.username,
		avatarColor: row.avatarColor,
		avatarImageId: row.avatarImageId,
	};
}

/** A stable message-scoped display identity, including after the link is removed. */
function toGuestSnapshot(name: string | null, messageId: string): ChatUserSnapshot | null {
	if (name === null) return null;
	return {
		id: `guest:${messageId}`,
		username: name,
		avatarColor: null,
		avatarImageId: null,
		isGuest: true,
	};
}

/** Canonical DM identity: sorted ids joined with ":" (see schema note). */
export function buildDmKey(userA: string, userB: string): string {
	return [userA, userB].sort().join(":");
}

function truncatePreview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= CHAT_PREVIEW_MAX_CHARS) return flat;
	return `${flat.slice(0, CHAT_PREVIEW_MAX_CHARS)}…`;
}

/**
 * The room-list preview for a message, including the attachment-only case.
 *
 * Attachment names, not a `[image]` marker: the filenames are user data, so they
 * carry actual information ("crash-log.txt" tells you what the message is about)
 * and need no translation, which a synthetic marker would. A localized marker
 * would also be wrong here on principle — the preview is written once at post time
 * and read by every member regardless of their language.
 *
 * ⚠️ The client mirrors this in `chatPreviewFromText` / `chatPreviewFromMessage`
 * (frontend/hooks/useChat.ts). The same room's preview comes from here on a refetch
 * and from there while live, so a divergence shows up as the text visibly changing
 * under the reader. Change both together.
 */
export function buildRoomPreview(
	text: string,
	attachments: ReadonlyArray<{ filename: string }> = [],
): string {
	const body = text.trim();
	if (body) return truncatePreview(body);
	if (attachments.length === 0) return "";
	return truncatePreview(attachments.map((attachment) => attachment.filename).join(", "));
}

/**
 * Max characters of quoted text frozen into a reply snapshot.
 *
 * Matches the client's `CHAT_REPLY_PREVIEW_MAX_CHARS`: the strip is a single
 * clamped line, so storing more would be bytes nothing can display. Truncating on
 * WRITE (rather than on read) is what keeps the read path from ever touching a
 * quoted message's `content_text`.
 */
export const CHAT_REPLY_PREVIEW_SNAPSHOT_MAX_CHARS = 120;

function truncateReplyPreview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= CHAT_REPLY_PREVIEW_SNAPSHOT_MAX_CHARS) return flat;
	return `${flat.slice(0, CHAT_REPLY_PREVIEW_SNAPSHOT_MAX_CHARS)}…`;
}

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Neutralize LIKE wildcards in user input (paired with `ESCAPE '\'`).
 *
 * A raw `%` or `_` in a directory search is not a search — it is "list everyone",
 * which quietly defeats the point of asking for a query at all. The escape
 * character itself is escaped first, otherwise a trailing `\` would swallow the
 * `%` this code appends and produce a syntax error.
 */
function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Room resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve (creating if needed) the DM room between two users.
 *
 * Idempotent under concurrency: the insert is `ON CONFLICT DO NOTHING` against
 * the unique `dm_key`, then the row is read back. Whoever loses the race still
 * gets the winner's room rather than a duplicate.
 */
export async function resolveDmRoom(userId: string, peerUserId: string): Promise<ChatRoomSummary> {
	if (userId === peerUserId) {
		throw new ValidationError("Cannot open a direct message with yourself");
	}
	const peer = await db.query.users.findFirst({
		where: eq(users.id, peerUserId),
		columns: USER_COLUMNS,
	});
	if (!peer) throw new NotFoundError("User", peerUserId);

	const dmKey = buildDmKey(userId, peerUserId);
	const timestamp = nowIso();

	await db
		.insert(chatRooms)
		.values({ id: generateId(), kind: "dm", dmKey, nextSeq: 1, createdAt: timestamp })
		.onConflictDoNothing({ target: chatRooms.dmKey });

	const room = await db.query.chatRooms.findFirst({ where: eq(chatRooms.dmKey, dmKey) });
	if (!room) throw new NotFoundError("Chat room", dmKey);

	// Both sides get a member row: for a DM this is the ACL, so it must exist for
	// the peer too or they could not read a conversation someone started with them.
	await ensureMembers(room.id, [userId, peerUserId]);

	const membership = await loadMembership(room.id, userId);
	const unread = await probeUnread(room.id, membership?.lastReadSeq ?? 0);
	return {
		id: room.id,
		kind: "dm",
		narratorId: null,
		lastMessageAt: room.lastMessageAt,
		lastMessagePreview: room.lastMessagePreview,
		lastMessageSenderId: room.lastMessageSenderId,
		peer: toUserSnapshot(peer),
		unread: unread.count,
		unreadCapped: unread.capped,
		lastReadSeq: membership?.lastReadSeq ?? 0,
		muted: membership?.muted ?? false,
	};
}

/**
 * Resolve (creating if needed) the discussion room beside a narrator.
 *
 * The member row is created lazily for the WATERMARK only — it does not grant
 * access (see `assertCanRead`).
 *
 * Authorization happens before the room is created, not just before it is read:
 * otherwise an unauthorized visit would still materialize a room and add the
 * visitor as a member, leaving a trail of phantom participants on private
 * sessions.
 */
export async function resolveNarratorRoom(
	narratorId: string,
	userId: string,
): Promise<ChatRoomSummary> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	if (!(await canReadNarrator(narrator, await resolvePrincipal(userId)))) {
		throw new NotFoundError("Narrator", narratorId);
	}

	const timestamp = nowIso();
	await db
		.insert(chatRooms)
		.values({ id: generateId(), kind: "narrator", narratorId, nextSeq: 1, createdAt: timestamp })
		.onConflictDoNothing({ target: chatRooms.narratorId });

	const room = await db.query.chatRooms.findFirst({
		where: eq(chatRooms.narratorId, narratorId),
	});
	if (!room) throw new NotFoundError("Chat room for narrator", narratorId);

	await ensureMembers(room.id, [userId]);
	const membership = await loadMembership(room.id, userId);
	const unread = await probeUnread(room.id, membership?.lastReadSeq ?? 0);
	return {
		id: room.id,
		kind: "narrator",
		narratorId,
		lastMessageAt: room.lastMessageAt,
		lastMessagePreview: room.lastMessagePreview,
		lastMessageSenderId: room.lastMessageSenderId,
		peer: null,
		unread: unread.count,
		unreadCapped: unread.capped,
		lastReadSeq: membership?.lastReadSeq ?? 0,
		muted: membership?.muted ?? false,
	};
}

/** Called only after the share manager has checked owner/admin access; never by a public GET. */
export async function ensureNarratorDiscussionRoomForShare(narratorId: string): Promise<string> {
	return db.transaction((tx) => {
		const narrator = tx
			.select({ id: narrators.id })
			.from(narrators)
			.where(and(eq(narrators.id, narratorId), eq(narrators.type, "primary")))
			.get();
		if (!narrator) throw new NotFoundError("Narrator", narratorId);
		tx.insert(chatRooms)
			.values({
				id: generateId(),
				kind: "narrator",
				narratorId,
				nextSeq: 1,
				createdAt: nowIso(),
			})
			.onConflictDoNothing({ target: chatRooms.narratorId })
			.run();
		const room = tx
			.select({ id: chatRooms.id })
			.from(chatRooms)
			.where(and(eq(chatRooms.narratorId, narratorId), eq(chatRooms.kind, "narrator")))
			.get();
		if (!room) throw new NotFoundError("Chat room for narrator", narratorId);
		return room.id;
	});
}

async function ensureMembers(roomId: string, userIds: string[]): Promise<void> {
	const timestamp = nowIso();
	for (const userId of userIds) {
		await db
			.insert(chatRoomMembers)
			.values({ id: generateId(), roomId, userId, lastReadSeq: 0, joinedAt: timestamp })
			.onConflictDoNothing({
				target: [chatRoomMembers.roomId, chatRoomMembers.userId],
			});
	}
}

async function loadMembership(roomId: string, userId: string) {
	return db.query.chatRoomMembers.findFirst({
		where: and(eq(chatRoomMembers.roomId, roomId), eq(chatRoomMembers.userId, userId)),
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization — the ONE place read access is decided
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatRoomAccess {
	room: typeof chatRooms.$inferSelect;
	/** Existing member row, if any. Absent is legal for a narrator room. */
	membership: typeof chatRoomMembers.$inferSelect | undefined;
}

/**
 * Assert `userId` may read `roomId`, returning the room + membership.
 *
 * Every reader — REST handlers and the WebSocket subscribe path alike — goes
 * through here rather than assembling its own predicate, which is what makes the
 * narrator ACL below a single-point change.
 *
 * A narrator room is exactly as wide as the narrator it belongs to: a discussion
 * quotes the work, names files and often carries the same conclusions, so letting
 * it be read by someone who cannot open the session would leak the session through
 * the side door. `isAdmin` is resolved from the user row rather than passed in,
 * because callers reaching here from the WS path do not all carry a role.
 */
export async function assertCanRead(roomId: string, userId: string): Promise<ChatRoomAccess> {
	const room = await db.query.chatRooms.findFirst({ where: eq(chatRooms.id, roomId) });
	if (!room) throw new NotFoundError("Chat room", roomId);
	const membership = await loadMembership(roomId, userId);

	if (room.kind === "dm") {
		if (!membership) throw new NotFoundError("Chat room", roomId);
		return { room, membership };
	}

	// Narrator room: access follows the narrator's own visibility.
	if (!room.narratorId) throw new NotFoundError("Chat room", roomId);
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, room.narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!narrator) throw new NotFoundError("Narrator", room.narratorId);
	if (!(await canReadNarrator(narrator, await resolvePrincipal(userId)))) {
		// Reported as a missing room, matching the narrator surface: a distinct
		// "forbidden" would confirm the room (and thus the narrator) exists.
		throw new NotFoundError("Chat room", roomId);
	}
	return { room, membership };
}

/** Build the ACL principal for a user id, reading the live role. */
async function resolvePrincipal(userId: string): Promise<{ userId: string; isAdmin: boolean }> {
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	return { userId, isAdmin: user?.role === "admin" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting
// ─────────────────────────────────────────────────────────────────────────────

type ChatTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Shared allocation only; each caller must apply its own authorization before entering here. */
function claimMessageSeq(
	tx: ChatTransaction,
	roomId: string,
	timestamp: string,
	preview: string,
	senderUserId: string | null,
): number {
	const updated = tx
		.update(chatRooms)
		.set({
			nextSeq: sql`${chatRooms.nextSeq} + 1`,
			lastMessageAt: timestamp,
			lastMessagePreview: preview,
			lastMessageSenderId: senderUserId,
		})
		.where(eq(chatRooms.id, roomId))
		.returning({ nextSeq: chatRooms.nextSeq })
		.get();
	if (!updated) throw new NotFoundError("Chat room", roomId);
	return updated.nextSeq - 1;
}

export interface PostMessageInput {
	roomId: string;
	senderUserId: string;
	/** May be empty when `attachmentIds` is not — an attachment carries a message. */
	text: string;
	replyToMessageId?: string | null;
	/** Previously uploaded, still-unclaimed attachments to attach to this message. */
	attachmentIds?: string[];
	kind?: "text" | "system";
}

/**
 * Append a message and advance the room's denormalized tail.
 *
 * One transaction claims the seq, writes the row, claims the attachments, updates
 * the room summary and pushes the SENDER's own watermark — a message you just typed
 * is never unread for you, and doing it here avoids a second round trip that could
 * interleave.
 *
 * Attachment claiming is inside that transaction on purpose: a claim that succeeded
 * while the insert failed would leave a file owned by a message that does not exist,
 * and the reverse would show a message with attachments the reader cannot fetch.
 */
export async function postMessage(input: PostMessageInput): Promise<ChatMessageRow> {
	const text = input.text.trim();
	const attachmentIds = [...new Set(input.attachmentIds ?? [])];
	// Text OR attachments — matching the narrator composer, where an attachment is
	// meaningful content on its own. Only a fully empty request is rejected.
	if (!text && attachmentIds.length === 0) {
		throw new ValidationError("Message text or an attachment is required");
	}
	if (text.length > CHAT_MESSAGE_MAX_CHARS) {
		throw new ValidationError(`Message exceeds ${CHAT_MESSAGE_MAX_CHARS} characters`);
	}
	if (attachmentIds.length > CHAT_ATTACHMENTS_PER_MESSAGE_MAX) {
		throw new ValidationError(
			`Maximum ${CHAT_ATTACHMENTS_PER_MESSAGE_MAX} attachments per message`,
		);
	}

	const access = await assertCanRead(input.roomId, input.senderUserId);
	// A narrator room's member row may not exist yet if the sender never opened
	// the panel through the resolve endpoint (e.g. posting straight from a deep
	// link). The watermark update below needs it.
	if (!access.membership) await ensureMembers(input.roomId, [input.senderUserId]);

	// The quote snapshot. Read the target's own scalars here — the ONE place a
	// quoted message's body is touched — so every later read of the quote strip is
	// served from this row instead of chasing the target across pages.
	let replySnapshot: {
		replyToSeq: number | null;
		replyToSenderUserId: string | null;
		replyToGuestName: string | null;
		replyToPreview: string | null;
	} = { replyToSeq: null, replyToSenderUserId: null, replyToGuestName: null, replyToPreview: null };
	if (input.replyToMessageId) {
		const target = await db.query.chatMessages.findFirst({
			where: and(
				eq(chatMessages.id, input.replyToMessageId),
				eq(chatMessages.roomId, input.roomId),
			),
			columns: {
				id: true,
				seq: true,
				senderUserId: true,
				senderGuestName: true,
				contentText: true,
				deletedAt: true,
			},
		});
		if (!target) throw new ValidationError("Replied-to message is not in this room");
		replySnapshot = {
			replyToSeq: target.seq,
			replyToSenderUserId: target.senderUserId,
			replyToGuestName: target.senderGuestName,
			// An empty string (not null) for an already-deleted target: null means
			// "legacy row, no snapshot taken", and conflating the two would send the
			// client back to window resolution for a message we know is gone.
			replyToPreview: target.deletedAt ? "" : truncateReplyPreview(target.contentText),
		};
	}

	// Attachment metadata is read BEFORE the transaction so the returned row and the
	// room preview can carry it. The claim itself re-checks ownership inside the
	// transaction, so nothing here is trusted as a permission decision.
	const pendingAttachments =
		attachmentIds.length > 0
			? await db.query.chatAttachments.findMany({
					where: and(
						inArray(chatAttachments.id, attachmentIds),
						eq(chatAttachments.roomId, input.roomId),
						eq(chatAttachments.uploaderUserId, input.senderUserId),
						isNull(chatAttachments.messageId),
					),
				})
			: [];
	if (pendingAttachments.length !== attachmentIds.length) {
		// Deliberately one message for every failure mode (unknown id, another room's
		// attachment, someone else's draft, already claimed). Distinguishing them
		// would confirm the existence of attachments the caller has no claim to.
		// The CODE is specific even though the message is not: the composer needs to
		// mark its chips as failed, which it cannot do by matching English prose.
		throw new ValidationError(
			"One or more attachments are unavailable",
			CHAT_ATTACHMENTS_UNAVAILABLE_CODE,
		);
	}
	const attachmentBytes = pendingAttachments.reduce((total, row) => total + row.sizeBytes, 0);
	if (attachmentBytes > CHAT_ATTACHMENT_TOTAL_BYTES_MAX) {
		throw new ValidationError(
			`Combined attachments exceed the ${(CHAT_ATTACHMENT_TOTAL_BYTES_MAX / 1024 / 1024).toFixed(
				0,
			)}MB limit`,
		);
	}

	const timestamp = nowIso();
	const messageId = generateId();
	const preview = buildRoomPreview(text, pendingAttachments);

	const seq = db.transaction((tx) => {
		const claimed = claimMessageSeq(tx, input.roomId, timestamp, preview, input.senderUserId);

		tx.insert(chatMessages)
			.values({
				id: messageId,
				roomId: input.roomId,
				seq: claimed,
				senderUserId: input.senderUserId,
				kind: input.kind ?? "text",
				contentText: text,
				replyToMessageId: input.replyToMessageId ?? null,
				replyToSeq: replySnapshot.replyToSeq,
				replyToSenderUserId: replySnapshot.replyToSenderUserId,
				replyToGuestName: replySnapshot.replyToGuestName,
				replyToPreview: replySnapshot.replyToPreview,
				createdAt: timestamp,
			})
			.run();

		if (attachmentIds.length > 0) {
			// Every predicate is load-bearing and re-asserted here rather than trusted
			// from the read above: `room_id` stops an attachment uploaded elsewhere from
			// being smuggled into this room, `uploader_user_id` stops claiming someone
			// else's draft, and `message_id IS NULL` stops re-claiming one that already
			// belongs to a posted message. A row count mismatch aborts the whole
			// transaction, so a partial claim is not a reachable state.
			//
			// `returning` rather than a driver rowcount: Drizzle's `.run()` is typed
			// void here, and counting returned ids is the portable way to assert that
			// every requested attachment was actually claimable.
			const claimed_ = tx
				.update(chatAttachments)
				.set({ messageId, claimedAt: timestamp })
				.where(
					and(
						inArray(chatAttachments.id, attachmentIds),
						eq(chatAttachments.roomId, input.roomId),
						eq(chatAttachments.uploaderUserId, input.senderUserId),
						isNull(chatAttachments.messageId),
					),
				)
				.returning({ id: chatAttachments.id })
				.all();
			if (claimed_.length !== attachmentIds.length) {
				throw new ValidationError(
					"One or more attachments are unavailable",
					CHAT_ATTACHMENTS_UNAVAILABLE_CODE,
				);
			}
		}

		tx.update(chatRoomMembers)
			.set({ lastReadSeq: claimed, lastReadAt: timestamp })
			.where(
				and(
					eq(chatRoomMembers.roomId, input.roomId),
					eq(chatRoomMembers.userId, input.senderUserId),
				),
			)
			.run();

		return claimed;
	});

	const sender = await db.query.users.findFirst({
		where: eq(users.id, input.senderUserId),
		columns: USER_COLUMNS,
	});
	const replyToSender = replySnapshot.replyToSenderUserId
		? toUserSnapshot(
				await db.query.users.findFirst({
					where: eq(users.id, replySnapshot.replyToSenderUserId),
					columns: USER_COLUMNS,
				}),
			)
		: null;

	const row: ChatMessageRow = {
		id: messageId,
		roomId: input.roomId,
		seq,
		kind: input.kind ?? "text",
		contentText: text,
		replyToMessageId: input.replyToMessageId ?? null,
		replyToSeq: replySnapshot.replyToSeq,
		replyToSender:
			toGuestSnapshot(replySnapshot.replyToGuestName, input.replyToMessageId ?? messageId) ??
			replyToSender,
		replyToPreview: replySnapshot.replyToPreview,
		attachments: pendingAttachments.map(toAttachmentRow),
		editedAt: null,
		deletedAt: null,
		createdAt: timestamp,
		sender: toUserSnapshot(sender),
	};

	eventBus.emit({
		type: "chat:message_created",
		roomId: input.roomId,
		messageId,
		seq,
		senderUserId: input.senderUserId,
		roomKind: access.room.kind,
		narratorId: access.room.narratorId,
	});

	return row;
}

// ─── Public discussion: capabilities, not user ACL bypasses ────────────────────

interface PublicDiscussionAccessInput {
	shareId: string;
	tokenHash: string;
}

function unavailablePublicDiscussion(): AppError {
	return new AppError("Share link unavailable", 404, "PUBLIC_SHARE_UNAVAILABLE");
}

/** One indexed join; no room creation, user lookup or membership write. */
function requirePublicDiscussion(
	input: PublicDiscussionAccessInput,
	connection: typeof db | ChatTransaction = db,
) {
	const access = connection
		.select({
			shareId: narratorPublicShares.id,
			guestName: narratorPublicShares.guestName,
			narratorId: narrators.id,
			roomId: chatRooms.id,
		})
		.from(narratorPublicShares)
		.innerJoin(
			narrators,
			and(eq(narrators.id, narratorPublicShares.narratorId), eq(narrators.type, "primary")),
		)
		.innerJoin(
			chatRooms,
			and(eq(chatRooms.narratorId, narrators.id), eq(chatRooms.kind, "narrator")),
		)
		.where(
			and(
				eq(narratorPublicShares.id, input.shareId),
				eq(narratorPublicShares.tokenHash, input.tokenHash),
				isNull(narratorPublicShares.revokedAt),
			),
		)
		.get();
	if (!access) throw unavailablePublicDiscussion();
	return access;
}

const PUBLIC_DISCUSSION_RESPONSE_BYTES = PUBLIC_SHARE_LIMITS.responseBytes;
const PUBLIC_DISCUSSION_NAME_CHARS = 120;
const PUBLIC_DISCUSSION_MAX_CHARS = PUBLIC_SHARE_LIMITS.discussionChars;
const publicReplyUser = alias(users, "public_discussion_reply_user");

/** All large fields are bounded in SQLite before crossing into the JS heap. */
function publicDiscussionQuery(roomId: string, shareId: string) {
	return db
		.select({
			id: chatMessages.id,
			seq: chatMessages.seq,
			text: sql<string>`CASE WHEN ${chatMessages.deletedAt} IS NOT NULL THEN '' ELSE substr(${chatMessages.contentText}, 1, ${PUBLIC_DISCUSSION_MAX_CHARS}) END`,
			truncated: sql<number>`CASE WHEN ${chatMessages.deletedAt} IS NULL AND length(substr(${chatMessages.contentText}, 1, ${PUBLIC_DISCUSSION_MAX_CHARS + 1})) > ${PUBLIC_DISCUSSION_MAX_CHARS} THEN 1 ELSE 0 END`,
			name: sql<string>`substr(COALESCE(${chatMessages.senderGuestName}, ${users.username}, 'Unknown sender'), 1, ${PUBLIC_DISCUSSION_NAME_CHARS})`,
			isGuest: sql<number>`${chatMessages.senderGuestName} IS NOT NULL`,
			isSelf: sql<number>`COALESCE(${chatMessages.senderShareId} = ${shareId}, 0)`,
			createdAt: chatMessages.createdAt,
			deletedAt: chatMessages.deletedAt,
			replyId: chatMessages.replyToMessageId,
			replySeq: chatMessages.replyToSeq,
			replyName: sql<string>`substr(COALESCE(${chatMessages.replyToGuestName}, ${publicReplyUser.username}, 'Unknown sender'), 1, ${PUBLIC_DISCUSSION_NAME_CHARS})`,
			replyText: sql<
				string | null
			>`substr(${chatMessages.replyToPreview}, 1, ${CHAT_REPLY_PREVIEW_SNAPSHOT_MAX_CHARS + 1})`,
			hasAttachments: sql<number>`CASE WHEN ${chatMessages.deletedAt} IS NOT NULL THEN 0 ELSE EXISTS(SELECT 1 FROM ${chatAttachments} WHERE ${chatAttachments.messageId} = ${chatMessages.id} LIMIT 1) END`,
		})
		.from(chatMessages)
		.leftJoin(users, eq(users.id, chatMessages.senderUserId))
		.leftJoin(publicReplyUser, eq(publicReplyUser.id, chatMessages.replyToSenderUserId))
		.where(eq(chatMessages.roomId, roomId));
}

type PublicDiscussionRow = ReturnType<ReturnType<typeof publicDiscussionQuery>["all"]>[number];

function toPublicDiscussionMessage(row: PublicDiscussionRow): PublicDiscussionMessage {
	return {
		id: row.id,
		seq: row.seq,
		text: row.truncated ? `${row.text}\n[Content truncated]` : row.text,
		author: { name: row.name, isGuest: !!row.isGuest, isSelf: !!row.isSelf },
		createdAt: row.createdAt,
		deletedAt: row.deletedAt,
		replyTo: row.replyId
			? { id: row.replyId, seq: row.replySeq, name: row.replyName, text: row.replyText }
			: null,
		hasAttachments: !!row.hasAttachments,
	};
}

export async function listPublicDiscussion(
	input: PublicDiscussionAccessInput & {
		beforeSeq?: number;
		limit?: number;
	},
): Promise<PublicDiscussionPage> {
	const access = requirePublicDiscussion(input);
	if (
		input.beforeSeq !== undefined &&
		(!Number.isSafeInteger(input.beforeSeq) || input.beforeSeq < 1)
	) {
		throw new ValidationError("Invalid discussion cursor");
	}
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
		throw new ValidationError("Invalid discussion limit");
	}
	const limit = Math.min(
		input.limit ?? PUBLIC_SHARE_LIMITS.defaultPage,
		PUBLIC_SHARE_LIMITS.maxPage,
	);
	const rows = publicDiscussionQuery(access.roomId, access.shareId)
		.$dynamic()
		.where(
			and(
				eq(chatMessages.roomId, access.roomId),
				input.beforeSeq !== undefined ? lt(chatMessages.seq, input.beforeSeq) : undefined,
			),
		)
		.orderBy(desc(chatMessages.seq))
		.limit(limit + 1)
		.all();
	const messages: PublicDiscussionMessage[] = [];
	// Reserve the envelope/cursor and commas. Each row is <= ~200 KiB even with JSON escapes.
	let bytes = 256;
	for (const row of rows.slice(0, limit)) {
		const message = toPublicDiscussionMessage(row);
		const rowBytes = Buffer.byteLength(JSON.stringify(message)) + 1;
		if (bytes + rowBytes > PUBLIC_DISCUSSION_RESPONSE_BYTES) break;
		bytes += rowBytes;
		messages.push(message);
	}
	const hasMore = rows.length > messages.length;
	messages.reverse();
	return {
		messages,
		hasMore,
		nextBeforeSeq: hasMore && messages.length > 0 ? messages[0].seq : null,
	};
}

export async function postPublicDiscussion(
	input: PublicDiscussionAccessInput & {
		text: string;
		replyToMessageId?: string | null;
	},
): Promise<PublicDiscussionMessage> {
	const access = requirePublicDiscussion(input);
	if (
		typeof input.text !== "string" ||
		input.text.length > PUBLIC_DISCUSSION_MAX_CHARS ||
		!input.text.trim()
	) {
		throw new ValidationError(`Message must contain 1–${PUBLIC_DISCUSSION_MAX_CHARS} characters`);
	}
	if (
		input.replyToMessageId != null &&
		(typeof input.replyToMessageId !== "string" ||
			!input.replyToMessageId ||
			input.replyToMessageId.length > 128)
	) {
		throw new ValidationError("Invalid replied-to message");
	}
	const text = input.text.trim();
	const timestamp = nowIso();
	const messageId = generateId();
	const result = db.transaction((tx) => {
		// Re-check after any wait between the first check and transaction acquisition.
		const live = requirePublicDiscussion(input, tx);
		if (live.roomId !== access.roomId || live.narratorId !== access.narratorId)
			throw unavailablePublicDiscussion();
		const reply = input.replyToMessageId
			? tx
					.select({
						id: chatMessages.id,
						seq: chatMessages.seq,
						senderUserId: chatMessages.senderUserId,
						guestName: sql<
							string | null
						>`substr(${chatMessages.senderGuestName}, 1, ${PUBLIC_DISCUSSION_NAME_CHARS})`,
						text: sql<string>`CASE WHEN ${chatMessages.deletedAt} IS NOT NULL THEN '' ELSE substr(${chatMessages.contentText}, 1, ${PUBLIC_DISCUSSION_MAX_CHARS}) END`,
					})
					.from(chatMessages)
					.where(
						and(eq(chatMessages.id, input.replyToMessageId), eq(chatMessages.roomId, live.roomId)),
					)
					.get()
			: undefined;
		if (input.replyToMessageId && !reply)
			throw new ValidationError("Replied-to message is not in this room");
		const seq = claimMessageSeq(tx, live.roomId, timestamp, buildRoomPreview(text), null);
		tx.insert(chatMessages)
			.values({
				id: messageId,
				roomId: live.roomId,
				seq,
				senderUserId: null,
				senderShareId: live.shareId,
				senderGuestName: live.guestName,
				kind: "text",
				contentText: text,
				replyToMessageId: reply?.id ?? null,
				replyToSeq: reply?.seq ?? null,
				replyToSenderUserId: reply?.senderUserId ?? null,
				replyToGuestName: reply?.guestName ?? null,
				replyToPreview: reply ? truncateReplyPreview(reply.text) : null,
				createdAt: timestamp,
			})
			.run();
		return { seq, roomId: live.roomId, narratorId: live.narratorId };
	});
	const stored = publicDiscussionQuery(result.roomId, access.shareId)
		.$dynamic()
		.where(and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, result.roomId)))
		.get();
	if (!stored) throw unavailablePublicDiscussion();
	const message = toPublicDiscussionMessage(stored);
	eventBus.emit({
		type: "chat:message_created",
		roomId: result.roomId,
		messageId,
		seq: result.seq,
		senderUserId: null,
		roomKind: "narrator",
		narratorId: result.narratorId,
	});
	return message;
}

/**
 * Assemble the client-facing shape for ONE stored message.
 *
 * The single place a `chat:message` WebSocket frame is built, so the live path and
 * the paginated read path cannot drift: both go through this and `listMessages`
 * respectively, and both are checked against the same `ChatMessageRow` type. A frame
 * assembled by hand in `chat-notify` is how a field ends up delivered on a refetch
 * but missing live.
 *
 * Three small indexed reads at most (sender, reply author, attachments), on a path
 * that runs once per posted message.
 */
export async function hydrateMessageForBroadcast(
	row: typeof chatMessages.$inferSelect,
): Promise<ChatMessageRow> {
	const [sender, replyToSender, attachmentRows] = await Promise.all([
		row.senderUserId
			? db.query.users.findFirst({ where: eq(users.id, row.senderUserId), columns: USER_COLUMNS })
			: Promise.resolve(undefined),
		row.replyToSenderUserId
			? db.query.users.findFirst({
					where: eq(users.id, row.replyToSenderUserId),
					columns: USER_COLUMNS,
				})
			: Promise.resolve(undefined),
		row.deletedAt
			? Promise.resolve([])
			: db.query.chatAttachments.findMany({
					where: eq(chatAttachments.messageId, row.id),
					orderBy: [asc(chatAttachments.createdAt)],
				}),
	]);

	return {
		id: row.id,
		roomId: row.roomId,
		seq: row.seq,
		kind: row.kind,
		contentText: row.deletedAt ? "" : row.contentText,
		replyToMessageId: row.replyToMessageId,
		replyToSeq: row.replyToSeq,
		replyToSender:
			toGuestSnapshot(row.replyToGuestName, row.replyToMessageId ?? row.id) ??
			toUserSnapshot(replyToSender),
		replyToPreview: row.replyToPreview,
		attachments: attachmentRows.map(toAttachmentRow),
		editedAt: row.editedAt,
		deletedAt: row.deletedAt,
		createdAt: row.createdAt,
		sender: toGuestSnapshot(row.senderGuestName, row.id) ?? toUserSnapshot(sender),
	};
}

/** DB row → the metadata shape clients receive (never `storedName`). */
function toAttachmentRow(row: typeof chatAttachments.$inferSelect): ChatAttachmentRow {
	return {
		id: row.id,
		kind: row.kind,
		filename: row.filename,
		mediaType: row.mediaType,
		sizeBytes: row.sizeBytes,
		width: row.width,
		height: row.height,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

export interface ListMessagesInput {
	roomId: string;
	userId: string;
	/** Exclusive upper bound; omit for the newest page. */
	beforeSeq?: number;
	limit?: number;
}

/**
 * One page of messages, newest-first internally and returned oldest-first.
 *
 * `LIMIT n + 1` decides `hasMore` — deliberately not `COUNT(*)`, which grows
 * with the room and would run on every page fetch.
 */
export async function listMessages(input: ListMessagesInput): Promise<ChatMessagePage> {
	await assertCanRead(input.roomId, input.userId);
	const limit = Math.min(Math.max(input.limit ?? CHAT_PAGE_DEFAULT, 1), CHAT_PAGE_MAX);

	const rows = await db.query.chatMessages.findMany({
		where:
			input.beforeSeq !== undefined
				? and(eq(chatMessages.roomId, input.roomId), lt(chatMessages.seq, input.beforeSeq))
				: eq(chatMessages.roomId, input.roomId),
		orderBy: [desc(chatMessages.seq)],
		limit: limit + 1,
		with: { sender: { columns: USER_COLUMNS } },
	});

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;

	// Two extra bounded queries for the whole page, never one per row: the page is
	// at most CHAT_PAGE_MAX, so each is a single `IN (...)` on an indexed column.
	const [replyAuthors, attachmentsByMessage] = await Promise.all([
		loadReplyAuthors(page),
		loadAttachmentsForMessages(page),
	]);

	const messages = page
		.map((row) => ({
			id: row.id,
			roomId: row.roomId,
			seq: row.seq,
			kind: row.kind,
			contentText: row.deletedAt ? "" : row.contentText,
			replyToMessageId: row.replyToMessageId,
			replyToSeq: row.replyToSeq,
			replyToSender:
				toGuestSnapshot(row.replyToGuestName, row.replyToMessageId ?? row.id) ??
				(row.replyToSenderUserId ? (replyAuthors.get(row.replyToSenderUserId) ?? null) : null),
			replyToPreview: row.replyToPreview,
			// A soft-deleted message reports no attachments: its body is already gone,
			// so listing files it used to carry would offer content the delete removed.
			attachments: row.deletedAt ? [] : (attachmentsByMessage.get(row.id) ?? []),
			editedAt: row.editedAt,
			deletedAt: row.deletedAt,
			createdAt: row.createdAt,
			sender: toGuestSnapshot(row.senderGuestName, row.id) ?? toUserSnapshot(row.sender),
		}))
		.reverse();

	return {
		messages,
		hasMore,
		nextBeforeSeq: hasMore && messages.length > 0 ? messages[0].seq : null,
	};
}

/**
 * Resolve the authors named by a page's reply snapshots.
 *
 * The snapshot stores an id rather than a username so a rename is reflected
 * everywhere, which means the name has to be joined back on read — but once per
 * page, for the distinct set, not once per message.
 */
async function loadReplyAuthors(
	rows: ReadonlyArray<{ replyToSenderUserId: string | null }>,
): Promise<Map<string, ChatUserSnapshot>> {
	const ids = [
		...new Set(
			rows
				.map((row) => row.replyToSenderUserId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	if (ids.length === 0) return new Map();
	const users_ = await db.query.users.findMany({
		where: inArray(users.id, ids),
		columns: USER_COLUMNS,
	});
	const map = new Map<string, ChatUserSnapshot>();
	for (const row of users_) {
		const snapshot = toUserSnapshot(row);
		if (snapshot) map.set(row.id, snapshot);
	}
	return map;
}

/** Attachment metadata for a page of messages, in one bounded query. */
async function loadAttachmentsForMessages(
	rows: ReadonlyArray<{ id: string; deletedAt: string | null }>,
): Promise<Map<string, ChatAttachmentRow[]>> {
	const ids = rows.filter((row) => !row.deletedAt).map((row) => row.id);
	if (ids.length === 0) return new Map();
	const attachmentRows = await db.query.chatAttachments.findMany({
		where: inArray(chatAttachments.messageId, ids),
		orderBy: [asc(chatAttachments.createdAt)],
	});
	const map = new Map<string, ChatAttachmentRow[]>();
	for (const row of attachmentRows) {
		if (!row.messageId) continue;
		const list = map.get(row.messageId);
		if (list) list.push(toAttachmentRow(row));
		else map.set(row.messageId, [toAttachmentRow(row)]);
	}
	return map;
}

/**
 * Bounded unread probe: counts up to CHAT_UNREAD_PROBE_LIMIT rows past `lastReadSeq`.
 *
 * Soft-deleted rows are excluded. They keep their `seq` to hold the cursor
 * sequence contiguous, but counting them would promise content that is gone —
 * the user opens the room and finds only "this message was deleted".
 */
async function probeUnread(
	roomId: string,
	lastReadSeq: number,
): Promise<{ count: number; capped: boolean }> {
	const rows = await db
		.select({ seq: chatMessages.seq })
		.from(chatMessages)
		.where(
			and(
				eq(chatMessages.roomId, roomId),
				gt(chatMessages.seq, lastReadSeq),
				isNull(chatMessages.deletedAt),
			),
		)
		.limit(CHAT_UNREAD_PROBE_LIMIT + 1);
	if (rows.length > CHAT_UNREAD_PROBE_LIMIT) {
		return { count: CHAT_UNREAD_PROBE_LIMIT, capped: true };
	}
	return { count: rows.length, capped: false };
}

/** A room plus the watermark to count from. */
interface UnreadProbeTarget {
	roomId: string;
	lastReadSeq: number;
}

/**
 * Probe several rooms in one round trip.
 *
 * The per-room `probeUnread` is correct but wrong to call in a loop: the room list and the
 * badge summary each hold up to {@link CHAT_ROOM_SCAN_LIMIT} rooms, so a loop is 200
 * synchronous `bun:sqlite` statements inside one request — bounded individually, not
 * bounded in aggregate, which is the shape CLAUDE.md's SQLite discipline rules out.
 *
 * Written as a union of per-room sub-selects, the same construction
 * `workspace-modification-view` uses and for the same reason: each arm is a plain indexed
 * `SEARCH` on `idx_chat_messages_room_seq` with its own `LIMIT`, so the total row count
 * stays `rooms × (CHAT_UNREAD_PROBE_LIMIT + 1)` and no arm can be starved by a busier
 * neighbour. A single `GROUP BY room_id HAVING seq > ?` cannot express this: the watermark
 * differs per room, and an aggregate over all of them has no per-room cap, so one very
 * active room would scan without bound.
 *
 * Only `seq` is selected. Bodies are never read on a counting path.
 */
async function probeUnreadBatch(
	targets: readonly UnreadProbeTarget[],
): Promise<Map<string, { count: number; capped: boolean }>> {
	const result = new Map<string, { count: number; capped: boolean }>();
	if (targets.length === 0) return result;

	const seqsByRoom = new Map<string, number>();
	for (const target of targets) seqsByRoom.set(target.roomId, 0);

	for (let offset = 0; offset < targets.length; offset += UNREAD_PROBE_ROOMS_PER_SHARD) {
		const shard = targets.slice(offset, offset + UNREAD_PROBE_ROOMS_PER_SHARD);
		const parts = shard.map(
			(target) => sql`
				select * from (
					select
						${chatMessages.roomId} as "roomId",
						${chatMessages.seq} as "seq"
					from ${chatMessages}
					where ${and(
						eq(chatMessages.roomId, target.roomId),
						gt(chatMessages.seq, target.lastReadSeq),
						isNull(chatMessages.deletedAt),
					)}
					limit ${CHAT_UNREAD_PROBE_LIMIT + 1}
				)`,
		);
		const rows = await db.all<{ roomId: string; seq: number }>(sql.join(parts, sql` union all `));
		for (const row of rows) {
			seqsByRoom.set(row.roomId, (seqsByRoom.get(row.roomId) ?? 0) + 1);
		}
	}

	for (const [roomId, found] of seqsByRoom) {
		result.set(
			roomId,
			found > CHAT_UNREAD_PROBE_LIMIT
				? { count: CHAT_UNREAD_PROBE_LIMIT, capped: true }
				: { count: found, capped: false },
		);
	}
	return result;
}

/**
 * Unread count for ONE room and user.
 *
 * The single-room answer, kept as the reference definition of "unread" that the batched
 * paths are checked against: `getUnreadSummary` and `listRoomUnreadForFanout` compute the
 * same number for many rows at once, and a test that pins them to this function is what
 * keeps an optimization from quietly changing the meaning.
 *
 * Muting is decided here rather than by the caller so the "muted ⇒ no badge" rule cannot
 * drift between call sites: a muted room reports 0, the same value `getUnreadSummary`
 * reports by skipping it.
 *
 * Not on a fan-out path — that would be one statement per recipient. Use
 * {@link listRoomUnreadForFanout} there.
 */
export async function probeRoomUnreadForUser(
	roomId: string,
	userId: string,
): Promise<{ count: number; capped: boolean }> {
	const membership = await loadMembership(roomId, userId);
	if (membership?.muted) return { count: 0, capped: false };
	return probeUnread(roomId, membership?.lastReadSeq ?? 0);
}

/**
 * The current user's DM conversations, newest activity first.
 *
 * Reads only room scalars, the peer's user scalars and the stored preview — never
 * `content_text`.
 */
export async function listDmRooms(userId: string): Promise<ChatRoomSummary[]> {
	// Driven from the ROOM side, joined to this user's member row, so the
	// CHAT_ROOM_SCAN_LIMIT cut falls on the least recently active conversations
	// rather than on an arbitrary slice of member rows. Reading memberships first
	// could not do this: `chat_room_members` has no activity column to order by.
	// `NULL last_message_at` (a room opened but never written in) sorts last under
	// DESC in SQLite, which is also where it belongs in the list.
	const rows = await db
		.select({
			id: chatRooms.id,
			dmKey: chatRooms.dmKey,
			lastMessageAt: chatRooms.lastMessageAt,
			lastMessagePreview: chatRooms.lastMessagePreview,
			lastMessageSenderId: chatRooms.lastMessageSenderId,
			lastReadSeq: chatRoomMembers.lastReadSeq,
			muted: chatRoomMembers.muted,
		})
		.from(chatRooms)
		.innerJoin(chatRoomMembers, eq(chatRoomMembers.roomId, chatRooms.id))
		.where(and(eq(chatRoomMembers.userId, userId), eq(chatRooms.kind, "dm")))
		.orderBy(desc(chatRooms.lastMessageAt))
		.limit(CHAT_ROOM_SCAN_LIMIT);
	if (rows.length === 0) return [];

	// Peers come from the dmKey rather than a second members join: the key already
	// encodes both ids, so this is one bounded `inArray` instead of a fan-out.
	const peerIds = new Set<string>();
	for (const room of rows) {
		for (const id of (room.dmKey ?? "").split(":")) {
			if (id && id !== userId) peerIds.add(id);
		}
	}
	const peerRows =
		peerIds.size > 0
			? await db.query.users.findMany({
					where: inArray(users.id, [...peerIds]),
					columns: USER_COLUMNS,
				})
			: [];
	const peerById = new Map(peerRows.map((row) => [row.id, row]));

	// One batched query for every room's count. Muted rooms are excluded from it rather
	// than probed and discarded: they report 0 by definition (the client draws no badge),
	// so counting them would be work with no reader.
	const unreadByRoom = await probeUnreadBatch(
		rows
			.filter((room) => !room.muted)
			.map((room) => ({ roomId: room.id, lastReadSeq: room.lastReadSeq })),
	);

	const summaries: ChatRoomSummary[] = [];
	for (const room of rows) {
		const unread = unreadByRoom.get(room.id) ?? { count: 0, capped: false };
		const peerId = (room.dmKey ?? "").split(":").find((id) => id && id !== userId);
		summaries.push({
			id: room.id,
			kind: "dm",
			narratorId: null,
			lastMessageAt: room.lastMessageAt,
			lastMessagePreview: room.lastMessagePreview,
			lastMessageSenderId: room.lastMessageSenderId,
			peer: toUserSnapshot(peerId ? peerById.get(peerId) : null),
			unread: unread.count,
			unreadCapped: unread.capped,
			lastReadSeq: room.lastReadSeq,
			muted: room.muted,
		});
	}

	// The SQL already ordered by activity; this only settles ties deterministically
	// (rooms sharing a timestamp, or the never-written ones whose value is null).
	summaries.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
	return summaries;
}

export interface ChatUnreadSummary {
	dmTotal: number;
	dmTotalCapped: boolean;
	byRoom: Record<string, number>;
}

/**
 * Unread totals for the navigation badge.
 *
 * Narrator rooms are excluded from `dmTotal`: their badge belongs on the
 * narrator's own toolbar entry, not on the global messages nav item. They still
 * appear in `byRoom` so an open panel can show its own count.
 *
 * Bounded to CHAT_ROOM_SCAN_LIMIT rooms, ordered by activity, for the same reason
 * as `listDmRooms`: this runs on every badge refresh. If someone really is a
 * member of more rooms than that, the ones left out are the ones nothing has
 * happened in recently — i.e. the ones with nothing unread anyway.
 *
 * Prefer `probeRoomUnreadForUser` when only ONE room's count is needed; calling
 * this and reading a single key out of `byRoom` probes every room for nothing.
 */
export async function getUnreadSummary(userId: string): Promise<ChatUnreadSummary> {
	const memberships = await db
		.select({
			roomId: chatRooms.id,
			kind: chatRooms.kind,
			lastReadSeq: chatRoomMembers.lastReadSeq,
			muted: chatRoomMembers.muted,
		})
		.from(chatRooms)
		.innerJoin(chatRoomMembers, eq(chatRoomMembers.roomId, chatRooms.id))
		.where(eq(chatRoomMembers.userId, userId))
		.orderBy(desc(chatRooms.lastMessageAt))
		.limit(CHAT_ROOM_SCAN_LIMIT);
	if (memberships.length === 0) return { dmTotal: 0, dmTotalCapped: false, byRoom: {} };

	const unreadByRoom = await probeUnreadBatch(
		memberships
			.filter((membership) => !membership.muted)
			.map((membership) => ({
				roomId: membership.roomId,
				lastReadSeq: membership.lastReadSeq,
			})),
	);

	const byRoom: Record<string, number> = {};
	let dmTotal = 0;
	let dmTotalCapped = false;
	for (const membership of memberships) {
		if (membership.muted) continue;
		const unread = unreadByRoom.get(membership.roomId);
		if (!unread || unread.count === 0) continue;
		byRoom[membership.roomId] = unread.count;
		if (membership.kind === "dm") {
			dmTotal += unread.count;
			if (unread.capped) dmTotalCapped = true;
		}
	}
	return { dmTotal, dmTotalCapped, byRoom };
}

/**
 * Advance a read watermark. Monotonic: an older seq never moves it backwards.
 *
 * The seq is CLAMPED to the room's highest existing seq (`next_seq - 1`) inside
 * the same statement that reads it. Without the clamp, monotonicity turns into a
 * trap: one client sending `seq: 999999999` — a bug, a stale cursor, or malice —
 * pins the watermark above every seq the room will realistically ever reach, so
 * nothing is ever unread there again and no later call can lower it. Validation
 * cannot catch this on its own, because whether a number is "in the future"
 * depends on room state the schema does not know.
 *
 * The clamp is a correlated subquery rather than a read-then-write pair so the
 * bound is taken from the same snapshot as the update; `bun:sqlite` statements
 * are atomic, which is why no explicit transaction is needed here.
 */
export async function markRead(roomId: string, userId: string, seq: number): Promise<number> {
	const access = await assertCanRead(roomId, userId);
	if (!access.membership) await ensureMembers(roomId, [userId]);
	const timestamp = nowIso();
	const ceiling = sql`(SELECT ${chatRooms.nextSeq} - 1 FROM ${chatRooms} WHERE ${chatRooms.id} = ${roomId})`;
	const [updated] = await db
		.update(chatRoomMembers)
		.set({
			lastReadSeq: sql`MAX(${chatRoomMembers.lastReadSeq}, MIN(${seq}, COALESCE(${ceiling}, 0)))`,
			lastReadAt: timestamp,
		})
		.where(and(eq(chatRoomMembers.roomId, roomId), eq(chatRoomMembers.userId, userId)))
		.returning({ lastReadSeq: chatRoomMembers.lastReadSeq });

	// No row updated means the membership vanished between the assert and here
	// (cascade from a room/user delete). Report the clamped intent rather than the
	// raw request so the caller never sees a watermark the room cannot support.
	const lastReadSeq = updated?.lastReadSeq ?? Math.min(seq, access.room.nextSeq - 1);
	eventBus.emit({ type: "chat:room_read", roomId, userId, lastReadSeq });
	return lastReadSeq;
}

/**
 * Soft-delete a message: body emptied, row kept.
 *
 * The row must survive because `seq` is the pagination cursor — removing it
 * would punch a hole in the sequence every client walks.
 */
export async function softDeleteMessage(
	roomId: string,
	messageId: string,
	userId: string,
	isAdmin: boolean,
): Promise<void> {
	const access = await assertCanRead(roomId, userId);
	const message = await db.query.chatMessages.findFirst({
		where: and(eq(chatMessages.id, messageId), eq(chatMessages.roomId, roomId)),
		columns: { id: true, senderUserId: true, deletedAt: true },
	});
	if (!message) throw new NotFoundError("Chat message", messageId);
	if (message.deletedAt) return;
	if (!isAdmin && message.senderUserId !== userId) {
		// 403, not 400: the request is well-formed and the message exists — the
		// caller simply does not own it. A client cannot tell "fix your input" from
		// "this was never yours" if both arrive as a validation failure.
		throw new ForbiddenError("You can only delete your own messages");
	}
	// Attachments go with the body. Leaving the files fetchable would make the
	// delete cosmetic: the text is gone but the screenshot someone regretted posting
	// is still served to anyone holding its id.
	//
	// Like the body itself, this is NOT recoverable — which is the existing contract
	// for a chat delete, not a new one introduced here. The rows are read before the
	// delete so the file removal knows which paths to unlink.
	const attached = await db.query.chatAttachments.findMany({
		where: eq(chatAttachments.messageId, messageId),
		columns: { id: true, roomId: true, storedName: true },
	});
	const deleted = await db
		.update(chatMessages)
		.set({ contentText: "", deletedAt: nowIso() })
		.where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)))
		.returning({ id: chatMessages.id });
	if (deleted.length === 0) return;
	eventBus.emit({
		type: "chat:message_deleted",
		roomId,
		messageId,
		narratorId: access.room.narratorId,
	});
	if (attached.length > 0) {
		await db.delete(chatAttachments).where(eq(chatAttachments.messageId, messageId));
		// After the DB rows are gone: an orphaned file is reclaimable by the cleanup
		// sweep, whereas a row pointing at a missing file is a broken thumbnail.
		deleteChatAttachmentFiles(attached);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist an upload as an unclaimed (draft) attachment for a room.
 *
 * Access is checked FIRST, before anything reaches the disk: an unauthorized upload
 * that got written and only then rejected would let a non-member consume the
 * server's storage.
 */
export async function createChatAttachment(
	roomId: string,
	userId: string,
	file: File,
): Promise<ChatAttachmentRow> {
	await assertCanRead(roomId, userId);

	// Bound the drafts one user can accumulate in a room. An upload is persisted
	// before its message exists, so "upload and never send" is reachable; the
	// cleanup sweep reclaims those eventually, but a write-time bound is what stops
	// a loop from filling the disk between sweeps.
	const drafts = await db
		.select({ id: chatAttachments.id })
		.from(chatAttachments)
		.where(
			and(
				eq(chatAttachments.roomId, roomId),
				eq(chatAttachments.uploaderUserId, userId),
				isNull(chatAttachments.messageId),
			),
		)
		.limit(CHAT_DRAFT_ATTACHMENTS_MAX);
	if (drafts.length >= CHAT_DRAFT_ATTACHMENTS_MAX) {
		throw new ValidationError(
			"Too many pending attachments. Send or remove some before uploading more.",
		);
	}

	const saved = await saveChatAttachment(roomId, file);
	const id = generateId();
	try {
		await db.insert(chatAttachments).values({
			id,
			roomId,
			messageId: null,
			uploaderUserId: userId,
			kind: saved.kind,
			filename: saved.filename,
			mediaType: saved.mediaType,
			sizeBytes: saved.sizeBytes,
			width: saved.width ?? null,
			height: saved.height ?? null,
			storedName: saved.storedName,
			createdAt: nowIso(),
			claimedAt: null,
		});
	} catch (error) {
		// The file is already on disk; without this it would be unreferenced from the
		// moment the insert failed, and only the periodic sweep would notice.
		deleteChatAttachmentFiles([{ roomId, storedName: saved.storedName }]);
		throw error;
	}

	return {
		id,
		kind: saved.kind,
		filename: saved.filename,
		mediaType: saved.mediaType,
		sizeBytes: saved.sizeBytes,
		width: saved.width ?? null,
		height: saved.height ?? null,
	};
}

export interface ChatAttachmentReadTarget {
	filePath: string;
	size: number;
	filename: string;
	mediaType: string;
	kind: "image" | "file";
}

/**
 * Resolve an attachment for download, enforcing the ROOM's access rule.
 *
 * Deliberately not served from `/api/uploads/:narratorId/:imageId`, which is
 * reachable by any authenticated user who knows the ids. A chat attachment must be
 * exactly as visible as the conversation it belongs to, so it goes through
 * `assertCanRead` — the same single decision point the message list uses. Reported
 * as a missing attachment rather than a 403 for the same reason rooms are: a
 * distinct "forbidden" would confirm it exists.
 */
export async function loadChatAttachmentForRead(
	attachmentId: string,
	userId: string,
): Promise<ChatAttachmentReadTarget> {
	const row = await db.query.chatAttachments.findFirst({
		where: eq(chatAttachments.id, attachmentId),
	});
	if (!row) throw new NotFoundError("Chat attachment", attachmentId);
	await assertCanRead(row.roomId, userId);

	const info = getChatAttachmentFileInfo(row.roomId, row.storedName);
	if (!info) throw new NotFoundError("Chat attachment", attachmentId);
	return {
		filePath: info.filePath,
		size: info.size,
		filename: row.filename,
		mediaType: row.mediaType,
		kind: row.kind,
	};
}

/**
 * Discard an unclaimed attachment (the composer removed a pending chip).
 *
 * Only the uploader, and only while unclaimed: once a message owns it, removal is
 * the message's soft delete, not a separate operation.
 */
export async function discardChatAttachment(attachmentId: string, userId: string): Promise<void> {
	const row = await db.query.chatAttachments.findFirst({
		where: eq(chatAttachments.id, attachmentId),
	});
	if (!row) throw new NotFoundError("Chat attachment", attachmentId);
	await assertCanRead(row.roomId, userId);
	if (row.uploaderUserId !== userId) {
		throw new ForbiddenError("You can only remove your own attachments");
	}
	if (row.messageId) {
		throw new ValidationError("This attachment already belongs to a sent message");
	}
	await db.delete(chatAttachments).where(eq(chatAttachments.id, attachmentId));
	deleteChatAttachmentFiles([{ roomId: row.roomId, storedName: row.storedName }]);
}

export interface MaterializeAttachmentsInput {
	roomId: string;
	userId: string;
	narratorId: string;
	attachmentIds: string[];
}

export interface MaterializedChatAttachments {
	files: TextFileRef[];
	/** The `<attached_files>` block to append to the forwarded text. */
	hint: string;
}

/**
 * Copy chat attachments into a narrator's worktree so a forward can name their paths.
 *
 * Two authorization checks, and both are required:
 *   - `assertCanRead(roomId)` — you cannot forward out of a conversation you cannot
 *     read.
 *   - `canWriteNarrator` — this WRITES FILES into the narrator's worktree. Checking
 *     read access would be the wrong question: a read-only observer of someone
 *     else's session would be able to drop files into it.
 *
 * The hint text comes from `buildAttachedFilesHint`, the same builder the narrator's
 * own attachment path uses, so a forwarded file is described to the model exactly
 * like a directly attached one. Images need no separate treatment: they are copied
 * as files and the Read tool handles image files.
 */
export async function materializeAttachmentsForNarrator(
	input: MaterializeAttachmentsInput,
): Promise<MaterializedChatAttachments> {
	await assertCanRead(input.roomId, input.userId);
	const attachmentIds = [...new Set(input.attachmentIds)];
	if (attachmentIds.length === 0) return { files: [], hint: "" };
	if (attachmentIds.length > CHAT_ATTACHMENTS_PER_MESSAGE_MAX) {
		throw new ValidationError(
			`Maximum ${CHAT_ATTACHMENTS_PER_MESSAGE_MAX} attachments per forward`,
		);
	}

	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, input.narratorId),
		columns: { ...NARRATOR_ACL_COLUMNS, cwd: true },
	});
	if (!narrator) throw new NotFoundError("Narrator", input.narratorId);
	const user = await db.query.users.findFirst({
		where: eq(users.id, input.userId),
		columns: { role: true },
	});
	if (
		!(await canWriteNarrator(narrator, {
			userId: input.userId,
			isAdmin: user?.role === "admin",
		}))
	) {
		throw new ForbiddenError("You cannot attach files to this narrator");
	}
	if (!narrator.cwd) {
		throw new ValidationError("This narrator has no working directory to attach files to");
	}

	const rows = await db.query.chatAttachments.findMany({
		where: and(
			inArray(chatAttachments.id, attachmentIds),
			eq(chatAttachments.roomId, input.roomId),
			// Only attachments belonging to a POSTED message may be forwarded: a draft
			// is not yet part of the conversation, so forwarding one would leak content
			// the room has never seen.
			isNotNull(chatAttachments.messageId),
		),
		orderBy: [asc(chatAttachments.createdAt)],
	});
	if (rows.length === 0) return { files: [], hint: "" };

	const files: TextFileRef[] = [];
	for (const row of rows) {
		try {
			files.push(
				await copyChatAttachmentToWorktree(narrator.cwd, {
					roomId: row.roomId,
					storedName: row.storedName,
					filename: row.filename,
					sizeBytes: row.sizeBytes,
				}),
			);
		} catch (error) {
			// One unreadable attachment (file reclaimed, permissions) must not lose the
			// whole forward: the text still carries the transcript, which is the part
			// the user selected. Logged so the gap is visible rather than silent.
			logger.warn("Chat attachment could not be forwarded", {
				attachmentId: row.id,
				narratorId: input.narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { files, hint: buildAttachedFilesHint(files) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The user directory a person picks a DM partner from.
 *
 * ⚠️ This is a deliberate widening of what a NON-ADMIN account can see: before
 * chat, the user list was admin-only (`/api/admin/users`). Choosing someone to
 * message is impossible without it. The exposure is held to the minimum that
 * makes the picker work — id, username and avatar — and deliberately excludes
 * `role`, `createdAt`, `mfaEnabled` and every other account attribute.
 */
export async function listDirectory(
	currentUserId: string,
	query?: string,
): Promise<ChatUserSnapshot[]> {
	const trimmed = query?.trim();
	const rows = await db.query.users.findMany({
		where: trimmed
			? sql`${users.username} LIKE ${`%${escapeLikePattern(trimmed)}%`} ESCAPE '\\'`
			: undefined,
		columns: USER_COLUMNS,
		orderBy: [asc(users.username)],
		limit: CHAT_DIRECTORY_LIMIT,
	});
	return rows
		.filter((row) => row.id !== currentUserId)
		.map((row) => toUserSnapshot(row))
		.filter((row): row is ChatUserSnapshot => row !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summarize
// ─────────────────────────────────────────────────────────────────────────────

export interface SummarizeInput {
	roomId: string;
	userId: string;
	messageIds: string[];
	locale: Locale;
}

/**
 * Per-user token bucket for `/summarize`.
 *
 * Deliberately NOT `oauthRateLimit`: that middleware keys on IP + OAuth client and
 * lives in the OAuth namespace set, while the thing being protected here is model
 * QUOTA and the only meaningful key is the user. It also has to bite in the
 * service rather than the route, because summarize is reachable from the REST
 * handler today and is the kind of thing an internal caller will reuse later.
 *
 * In-memory, so the budget is per process and resets on restart. That is the
 * accepted trade-off: a DB-backed counter would put a write on every summarize
 * request to defend a resource whose own cost dwarfs it, and NarraFork is a
 * single-process deployment. `hotSafe` pins the buckets across `--hot` reloads so
 * editing this file does not hand everyone a fresh allowance.
 */
const summarizeBuckets = hotSafe(
	"narrafork.chat.summarizeBuckets",
	() => new Map<string, { tokens: number; updatedAt: number }>(),
);
/** Bound the map so unique user ids cannot grow it without limit. */
const SUMMARIZE_BUCKET_MAX_KEYS = 4_096;

function consumeSummarizeToken(userId: string, now = Date.now()): number {
	let bucket = summarizeBuckets.get(userId);
	if (!bucket) {
		// Full buckets are indistinguishable from absent ones, so evicting the whole
		// map at the ceiling is safe: worst case a few users get their allowance back.
		if (summarizeBuckets.size >= SUMMARIZE_BUCKET_MAX_KEYS) summarizeBuckets.clear();
		bucket = { tokens: CHAT_SUMMARIZE_BURST, updatedAt: now };
		summarizeBuckets.set(userId, bucket);
	}
	const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1_000;
	bucket.tokens = Math.min(
		CHAT_SUMMARIZE_BURST,
		bucket.tokens + elapsedSeconds * CHAT_SUMMARIZE_REFILL_PER_SECOND,
	);
	bucket.updatedAt = now;
	if (bucket.tokens >= 1) {
		bucket.tokens -= 1;
		return 0;
	}
	return Math.ceil(((1 - bucket.tokens) / CHAT_SUMMARIZE_REFILL_PER_SECOND) * 1_000);
}

/**
 * Direct access to the summarize budget, for tests only.
 *
 * Mirrors `oauthRateLimitTesting`: the bucket arithmetic is worth asserting on
 * with an injected clock, and draining a bucket is how a test reaches the
 * rate-limited branch of `summarizeMessages` without calling a model.
 */
export const chatSummarizeRateLimitTesting = {
	consume: consumeSummarizeToken,
	reset: (userId?: string): void => {
		if (userId) summarizeBuckets.delete(userId);
		else summarizeBuckets.clear();
	},
};

/**
 * Summarize selected messages with the summary model.
 *
 * The result is NOT persisted: it is a draft the user reviews before forwarding
 * it to a narrator, so storing it would create a second source of truth for
 * something that may never be sent.
 *
 * Rate limited per user: this is the only chat path that spends model quota, and
 * every authenticated account can reach it.
 */
export async function summarizeMessages(input: SummarizeInput): Promise<{ summary: string }> {
	await assertCanRead(input.roomId, input.userId);
	// After the access check so an unauthorized probe cannot burn the victim's
	// budget, before the model call so a rejected request costs nothing.
	const retryAfterMs = consumeSummarizeToken(input.userId);
	if (retryAfterMs > 0) {
		throw new RateLimitError(
			"CHAT_SUMMARIZE_RATE_LIMITED",
			retryAfterMs,
			"Too many summarize requests. Please wait a moment.",
		);
	}
	const ids = input.messageIds.slice(0, CHAT_SUMMARIZE_MAX_MESSAGES);
	if (ids.length === 0) throw new ValidationError("No messages selected");

	const rows = await db.query.chatMessages.findMany({
		where: and(eq(chatMessages.roomId, input.roomId), inArray(chatMessages.id, ids)),
		orderBy: [asc(chatMessages.seq)],
		with: { sender: { columns: { username: true } } },
	});
	if (rows.length === 0) throw new ValidationError("Selected messages are not in this room");

	// Reply authors for the selection, one bounded query (the selection is capped at
	// CHAT_SUMMARIZE_MAX_MESSAGES). Without this the transcript is a flat list of
	// utterances and the model cannot tell agreement from contradiction when two
	// people are answering different things.
	const replyAuthors = await loadReplyAuthors(rows);

	// Bounded transcript: the model input is capped independently of how many
	// rows matched, so one huge message cannot blow the request up.
	const parts: string[] = [];
	let budget = CHAT_SUMMARIZE_MAX_CHARS;
	for (const row of rows) {
		if (budget <= 0) break;
		if (row.deletedAt) continue;
		const author =
			row.senderGuestName !== null
				? `${row.senderGuestName} [share guest]`
				: (row.sender?.username ?? "unknown");
		const quoted =
			row.replyToGuestName !== null
				? `${row.replyToGuestName} [share guest]`
				: row.replyToSenderUserId
					? replyAuthors.get(row.replyToSenderUserId)?.username
					: undefined;
		// The quote is rendered inline from the SNAPSHOT, so summarizing never has to
		// fetch a message outside the selection to know what was being answered.
		const replyPrefix = row.replyToPreview
			? `[replying to ${quoted ?? "unknown"}: "${row.replyToPreview}"] `
			: row.replyToMessageId
				? `[replying to ${quoted ?? "unknown"}] `
				: "";
		const line = `${author}: ${replyPrefix}${row.contentText}`;
		parts.push(line.length > budget ? line.slice(0, budget) : line);
		budget -= line.length;
	}
	const transcript = parts.join("\n");
	if (!transcript) throw new ValidationError("Selected messages have no content");

	const { summaryGenerate } = await import("../lib/agent");
	const systemPrompt =
		input.locale === "zh-CN"
			? '你在总结一段团队聊天记录，供开发者转发给 AI 编码助手。用简体中文输出要点：结论、决定、待办、未解决的问题。保留具体的文件名、命令和标识符原文。行首的 [replying to X: "…"] 表示该发言是在回复谁、回复的是哪句话，用它判断谁在回应谁、哪些分歧已经解决。不要加寒暄或前言。'
			: 'You are summarizing a team chat excerpt so a developer can forward it to an AI coding assistant. Output the essentials: conclusions, decisions, action items, open questions. Preserve concrete file names, commands and identifiers verbatim. A leading [replying to X: "…"] marks which message a line answers — use it to attribute agreement and disagreement correctly. No preamble or pleasantries.';

	try {
		const result = await summaryGenerate(transcript, systemPrompt, { kind: "chat_summarize" });
		return { summary: result.text.trim() };
	} catch (err) {
		logger.warn("Chat summarize failed", {
			roomId: input.roomId,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}
}

/**
 * Unread counts for every member of one room who should receive a badge push.
 *
 * Replaces "list the members, then probe each one": that read the member table without a
 * limit and then issued one statement per recipient, on the path that runs for EVERY
 * posted message. A narrator room's membership grows with each user who has ever opened it,
 * so both halves scaled with popularity.
 *
 * Two bounded queries now: the member slice (see {@link CHAT_MEMBER_FANOUT_LIMIT}) and one
 * batched probe. `exclude` covers the sender and anyone with the room open — they either
 * wrote the message or already received it live — and is applied before the probe so those
 * rooms are not counted for nothing.
 *
 * Muted members are dropped here, matching `probeRoomUnreadForUser`: a muted room reports
 * no badge, and deciding it in one place keeps the two from drifting.
 */
export async function listRoomUnreadForFanout(
	roomId: string,
	exclude: ReadonlySet<string>,
): Promise<Array<{ userId: string; unread: number }>> {
	const members = await db
		.select({
			userId: chatRoomMembers.userId,
			lastReadSeq: chatRoomMembers.lastReadSeq,
			muted: chatRoomMembers.muted,
		})
		.from(chatRoomMembers)
		.where(eq(chatRoomMembers.roomId, roomId))
		// Least-caught-up first, so the cap drops the members with the least to be told.
		.orderBy(asc(chatRoomMembers.lastReadSeq))
		.limit(CHAT_MEMBER_FANOUT_LIMIT);

	const recipients = members.filter((member) => !member.muted && !exclude.has(member.userId));
	if (recipients.length === 0) return [];

	// One room, many watermarks, so the union is keyed by USER: each arm counts that
	// member's own tail, bounded by the same probe ceiling as everywhere else, and carries
	// the user id through so the results can be attributed without a second lookup.
	const counts: Array<{ userId: string; unread: number }> = [];
	for (let offset = 0; offset < recipients.length; offset += UNREAD_PROBE_ROOMS_PER_SHARD) {
		const shard = recipients.slice(offset, offset + UNREAD_PROBE_ROOMS_PER_SHARD);
		const parts = shard.map(
			(member) => sql`
				select
					${member.userId} as "userId",
					(
						select count(*) from (
							select ${chatMessages.seq}
							from ${chatMessages}
							where ${and(
								eq(chatMessages.roomId, roomId),
								gt(chatMessages.seq, member.lastReadSeq),
								isNull(chatMessages.deletedAt),
							)}
							limit ${CHAT_UNREAD_PROBE_LIMIT}
						)
					) as "unread"`,
		);
		counts.push(
			...(await db.all<{ userId: string; unread: number }>(sql.join(parts, sql` union all `))),
		);
	}
	return counts;
}
