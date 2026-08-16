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
import { chatMessages, chatRoomMembers, chatRooms, narrators, users } from "@server/db/schema";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { hotSafe } from "@server/lib/hot-safe";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import { canReadNarrator } from "@server/services/narrator-acl";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

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
}

export interface ChatMessageRow {
	id: string;
	roomId: string;
	seq: number;
	kind: "text" | "system";
	contentText: string;
	replyToMessageId: string | null;
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

/** Canonical DM identity: sorted ids joined with ":" (see schema note). */
export function buildDmKey(userA: string, userB: string): string {
	return [userA, userB].sort().join(":");
}

function truncatePreview(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= CHAT_PREVIEW_MAX_CHARS) return flat;
	return `${flat.slice(0, CHAT_PREVIEW_MAX_CHARS)}…`;
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
		columns: { id: true, ownerUserId: true, visibility: true, chapterId: true },
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
		columns: { id: true, ownerUserId: true, visibility: true, chapterId: true },
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

export interface PostMessageInput {
	roomId: string;
	senderUserId: string;
	text: string;
	replyToMessageId?: string | null;
	kind?: "text" | "system";
}

/**
 * Append a message and advance the room's denormalized tail.
 *
 * One transaction claims the seq, writes the row, updates the room summary and
 * pushes the SENDER's own watermark — a message you just typed is never unread
 * for you, and doing it here avoids a second round trip that could interleave.
 */
export async function postMessage(input: PostMessageInput): Promise<ChatMessageRow> {
	const text = input.text.trim();
	if (!text) throw new ValidationError("Message text is required");
	if (text.length > CHAT_MESSAGE_MAX_CHARS) {
		throw new ValidationError(`Message exceeds ${CHAT_MESSAGE_MAX_CHARS} characters`);
	}

	const access = await assertCanRead(input.roomId, input.senderUserId);
	// A narrator room's member row may not exist yet if the sender never opened
	// the panel through the resolve endpoint (e.g. posting straight from a deep
	// link). The watermark update below needs it.
	if (!access.membership) await ensureMembers(input.roomId, [input.senderUserId]);

	if (input.replyToMessageId) {
		const target = await db.query.chatMessages.findFirst({
			where: and(
				eq(chatMessages.id, input.replyToMessageId),
				eq(chatMessages.roomId, input.roomId),
			),
			columns: { id: true },
		});
		if (!target) throw new ValidationError("Replied-to message is not in this room");
	}

	const timestamp = nowIso();
	const messageId = generateId();
	const preview = truncatePreview(text);

	const seq = db.transaction((tx) => {
		const [updated] = tx
			.update(chatRooms)
			.set({
				nextSeq: sql`${chatRooms.nextSeq} + 1`,
				lastMessageAt: timestamp,
				lastMessagePreview: preview,
				lastMessageSenderId: input.senderUserId,
			})
			.where(eq(chatRooms.id, input.roomId))
			.returning({ nextSeq: chatRooms.nextSeq })
			.all();
		// No row means the room was deleted (or cascaded away with its narrator)
		// between `assertCanRead` and this transaction. Without the check the next
		// line reads `.nextSeq` off undefined and the caller gets a TypeError/500
		// instead of the 404 that actually describes what happened.
		if (!updated) throw new NotFoundError("Chat room", input.roomId);
		// `returning` gives the POST-increment value, so the number this message
		// owns is one less.
		const claimed = updated.nextSeq - 1;

		tx.insert(chatMessages)
			.values({
				id: messageId,
				roomId: input.roomId,
				seq: claimed,
				senderUserId: input.senderUserId,
				kind: input.kind ?? "text",
				contentText: text,
				replyToMessageId: input.replyToMessageId ?? null,
				createdAt: timestamp,
			})
			.run();

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

	const row: ChatMessageRow = {
		id: messageId,
		roomId: input.roomId,
		seq,
		kind: input.kind ?? "text",
		contentText: text,
		replyToMessageId: input.replyToMessageId ?? null,
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
	const messages = page
		.map((row) => ({
			id: row.id,
			roomId: row.roomId,
			seq: row.seq,
			kind: row.kind,
			contentText: row.deletedAt ? "" : row.contentText,
			replyToMessageId: row.replyToMessageId,
			editedAt: row.editedAt,
			deletedAt: row.deletedAt,
			createdAt: row.createdAt,
			sender: toUserSnapshot(row.sender),
		}))
		.reverse();

	return {
		messages,
		hasMore,
		nextBeforeSeq: hasMore && messages.length > 0 ? messages[0].seq : null,
	};
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
	await assertCanRead(roomId, userId);
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
	await db
		.update(chatMessages)
		.set({ contentText: "", deletedAt: nowIso() })
		.where(eq(chatMessages.id, messageId));
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

	// Bounded transcript: the model input is capped independently of how many
	// rows matched, so one huge message cannot blow the request up.
	const parts: string[] = [];
	let budget = CHAT_SUMMARIZE_MAX_CHARS;
	for (const row of rows) {
		if (budget <= 0) break;
		if (row.deletedAt) continue;
		const line = `${row.sender?.username ?? "unknown"}: ${row.contentText}`;
		parts.push(line.length > budget ? line.slice(0, budget) : line);
		budget -= line.length;
	}
	const transcript = parts.join("\n");
	if (!transcript) throw new ValidationError("Selected messages have no content");

	const { summaryGenerate } = await import("../lib/agent");
	const systemPrompt =
		input.locale === "zh-CN"
			? "你在总结一段团队聊天记录，供开发者转发给 AI 编码助手。用简体中文输出要点：结论、决定、待办、未解决的问题。保留具体的文件名、命令和标识符原文。不要加寒暄或前言。"
			: "You are summarizing a team chat excerpt so a developer can forward it to an AI coding assistant. Output the essentials: conclusions, decisions, action items, open questions. Preserve concrete file names, commands and identifiers verbatim. No preamble or pleasantries.";

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
