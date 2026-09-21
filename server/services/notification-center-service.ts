/**
 * Notification center — service layer (Phase 1 / task package B).
 *
 * The notification table is a durable projection of events, not a replica of
 * source-system state. Persistent status is only `unread|read`; `resolved` and
 * `gone` are derived at list time from the authoritative source (tool call /
 * chat room ACL).
 *
 * Hard rules this module enforces (docs/plans/notification-center-phase1.md §4):
 * 1. `recordNotifications` is bounded, dedupes on `(userId, kind, sourceKey)`,
 *    and never throws back into the caller's transaction.
 * 2. List selects notification columns only — never message `contentJson` or
 *    tool `inputJson`/`outputJson`.
 * 3. Unread counts use `LIMIT cap+1` probes, never unbounded `COUNT(*)`.
 * 4. `markRead` is owner-scoped and monotonic (already-read rows keep `readAt`).
 * 5. Delete is owner-scoped; anything else is 404 (do not confirm existence).
 *
 * Shared contract lives in `shared/notification-center.ts` (package A) — this
 * module re-exports those types/constants so existing service/route call sites
 * keep a single import surface. Physical SQL uses column names from
 * `server/db/schema.ts` `notifications` (snake_case); raw SQL is intentional so
 * list/count paths stay explicitly bounded and never pull large JSON fields.
 *
 * Fan-out (package C) resolves this module via dynamic import of
 * `recordNotifications`; do not rename that export without updating C.
 */

import {
	NOTIFICATION_FANOUT_MAX_RECIPIENTS,
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_UNREAD_COUNT_CAP,
	type NotificationKind,
	type NotificationLink,
	type NotificationListItem,
	type NotificationListPage,
	type NotificationPersistentStatus,
	type NotificationUnreadCounts,
} from "@shared/notification-center";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import { chatRoomMembers, chatRooms, narrators, narratorToolCalls, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { canReadNarrator } from "./narrator-acl";

// Re-export the shared contract so routes/tests can import from this service.
export type {
	NotificationDisplayStatus,
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationPersistentStatus,
	NotificationUnreadCounts,
} from "@shared/notification-center";
export {
	NOTIFICATION_FANOUT_MAX_RECIPIENTS,
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_UNREAD_COUNT_CAP,
} from "@shared/notification-center";

/** Title clamp at write time (bounded display string; not in shared §3.4). */
export const NOTIFICATION_TITLE_MAX_LENGTH = 200;

/**
 * Retention constants (§4.1). Cleanup is intentionally NOT run on the request
 * path — background job TODO when the surrounding job infrastructure is chosen.
 */
export const NOTIFICATION_RETENTION_MAX_ROWS = 500;
export const NOTIFICATION_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Change hook (package D / WS) ───────────────────────────────────────────
//
// event-bus is not in this package's file ownership. D (or a later integration
// pass) can subscribe here; payload stays empty of titles/previews by design.

export interface NotificationCenterChangeEvent {
	userId: string;
	kinds?: NotificationKind[];
}

type NotificationCenterChangeListener = (event: NotificationCenterChangeEvent) => void;
const changeListeners = new Set<NotificationCenterChangeListener>();

/** Subscribe to notification-center mutations. Returns an unsubscribe fn. */
export function onNotificationCenterChanged(
	listener: NotificationCenterChangeListener,
): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}

function notifyChanged(userId: string, kinds?: NotificationKind[]): void {
	for (const listener of changeListeners) {
		try {
			listener({ userId, kinds });
		} catch (err) {
			logger.warn("notification-center: change listener failed", {
				userId,
				error: String(err),
			});
		}
	}
}

// ─── Pure helpers (exported for unit tests) ─────────────────────────────────

export function clampNotificationText(value: string | null | undefined, maxLength: number): string {
	const text = typeof value === "string" ? value : "";
	if (maxLength <= 0) return "";
	if (text.length <= maxLength) return text;
	// Keep a visible ellipsis when truncating so UI previews stay honest
	// (fan-out may already have produced a max-length string ending in `…`).
	if (maxLength === 1) return "…";
	return `${text.slice(0, maxLength - 1)}…`;
}

export function encodeNotificationCursor(createdAt: number, id: string): string {
	return Buffer.from(`${createdAt}:${id}`, "utf8").toString("base64url");
}

export function decodeNotificationCursor(cursor: string): { createdAt: number; id: string } {
	if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
		throw new ValidationError("Invalid notification cursor");
	}
	let raw: string;
	try {
		raw = Buffer.from(cursor, "base64url").toString("utf8");
	} catch {
		throw new ValidationError("Invalid notification cursor");
	}
	const sep = raw.indexOf(":");
	if (sep <= 0 || sep === raw.length - 1) {
		throw new ValidationError("Invalid notification cursor");
	}
	const createdAt = Number(raw.slice(0, sep));
	const id = raw.slice(sep + 1);
	if (!Number.isFinite(createdAt) || !Number.isInteger(createdAt) || createdAt < 0 || !id) {
		throw new ValidationError("Invalid notification cursor");
	}
	return { createdAt, id };
}

export function parseNotificationLink(raw: unknown): NotificationLink {
	if (!raw || typeof raw !== "object") {
		return { type: "narrator" };
	}
	const obj = raw as Record<string, unknown>;
	if (obj.type === "chat_room" && typeof obj.roomId === "string") {
		return { type: "chat_room", roomId: obj.roomId };
	}
	if (obj.type === "narrator" && typeof obj.narratorId === "string") {
		return { type: "narrator", narratorId: obj.narratorId };
	}
	if (typeof obj.roomId === "string" && obj.roomId) {
		return { type: "chat_room", roomId: obj.roomId };
	}
	if (typeof obj.narratorId === "string" && obj.narratorId) {
		return { type: "narrator", narratorId: obj.narratorId };
	}
	return { type: "narrator" };
}

function isNotificationKind(value: unknown): value is NotificationKind {
	return value === "chat_message" || value === "permission_request";
}

function isPersistentStatus(value: unknown): value is NotificationPersistentStatus {
	return value === "unread" || value === "read";
}

function andAll(parts: SQL[]): SQL {
	if (parts.length === 1) return parts[0];
	return parts.reduce((acc, part) => sql`${acc} AND ${part}`);
}

function inIds(ids: string[]): SQL {
	return sql`id IN (${ids.map((id) => sql`${id}`).reduce((acc, part) => sql`${acc}, ${part}`)})`;
}

// ─── Row shapes (physical columns) ──────────────────────────────────────────

interface NotificationRow {
	id: string;
	user_id: string;
	kind: string;
	project_id: string | null;
	chapter_id: string | null;
	narrator_id: string | null;
	title: string;
	preview: string;
	link_json: string;
	source_key: string;
	status: string;
	created_at: number;
	read_at: number | null;
}

function rowToListBase(row: NotificationRow): NotificationListItem {
	let link: NotificationLink = { type: "narrator" };
	try {
		link = parseNotificationLink(JSON.parse(row.link_json));
	} catch {
		link = { type: "narrator" };
	}
	const kind: NotificationKind = isNotificationKind(row.kind) ? row.kind : "chat_message";
	const status: NotificationPersistentStatus = isPersistentStatus(row.status)
		? row.status
		: "unread";
	return {
		id: row.id,
		kind,
		projectId: row.project_id ?? null,
		chapterId: row.chapter_id ?? null,
		narratorId: row.narrator_id ?? null,
		title: row.title ?? "",
		preview: row.preview ?? "",
		link,
		sourceKey: row.source_key,
		status,
		// Overwritten by resolveDisplayStatus for each page item.
		displayStatus: status,
		createdAt: Number(row.created_at) || 0,
		readAt: row.read_at == null ? null : Number(row.read_at),
	};
}

// ─── recordNotifications ────────────────────────────────────────────────────

export interface RecordNotificationInput {
	userId: string;
	kind: NotificationKind;
	sourceKey: string;
	title: string;
	preview: string;
	link: NotificationLink;
	projectId?: string | null;
	chapterId?: string | null;
	narratorId?: string | null;
	createdAt?: number;
}

/**
 * Bounded fan-out insert. Duplicate `(userId, kind, sourceKey)` rows are
 * ignored. Failures are logged and swallowed so a notification write can never
 * roll back the source chat/permission transaction.
 */
export async function recordNotifications(inputs: RecordNotificationInput[]): Promise<void> {
	if (!Array.isArray(inputs) || inputs.length === 0) return;

	const bounded = inputs.slice(0, NOTIFICATION_FANOUT_MAX_RECIPIENTS);
	if (inputs.length > NOTIFICATION_FANOUT_MAX_RECIPIENTS) {
		logger.warn("notification-center: fan-out truncated", {
			requested: inputs.length,
			limit: NOTIFICATION_FANOUT_MAX_RECIPIENTS,
		});
	}

	const touchedUsers = new Map<string, Set<NotificationKind>>();

	for (const input of bounded) {
		if (!input?.userId || !input.sourceKey || !isNotificationKind(input.kind)) continue;
		try {
			const id = generateId();
			const createdAt = Number.isFinite(input.createdAt)
				? Math.floor(input.createdAt as number)
				: Date.now();
			const title = clampNotificationText(input.title, NOTIFICATION_TITLE_MAX_LENGTH);
			const preview = clampNotificationText(input.preview, NOTIFICATION_PREVIEW_MAX_LENGTH);
			const linkJson = JSON.stringify(
				input.link && typeof input.link === "object" ? input.link : { type: "narrator" },
			);
			const narratorId =
				input.narratorId ??
				(input.link && input.link.type === "narrator" ? input.link.narratorId : null) ??
				null;

			const insertResult = await db.run(sql`
				INSERT INTO notifications (
					id, user_id, kind, project_id, chapter_id, narrator_id,
					title, preview, link_json, source_key, status, created_at, read_at
				) VALUES (
					${id},
					${input.userId},
					${input.kind},
					${input.projectId ?? null},
					${input.chapterId ?? null},
					${narratorId},
					${title},
					${preview},
					${linkJson},
					${input.sourceKey},
					'unread',
					${createdAt},
					NULL
				)
				ON CONFLICT (user_id, kind, source_key) DO NOTHING
			`);

			// Dedup replay must not wake clients: only a real insert changes unread.
			const inserted = typeof insertResult?.changes === "number" ? insertResult.changes > 0 : true;
			if (!inserted) continue;

			let kinds = touchedUsers.get(input.userId);
			if (!kinds) {
				kinds = new Set();
				touchedUsers.set(input.userId, kinds);
			}
			kinds.add(input.kind);
		} catch (err) {
			// Never rethrow: fan-out must not fail the source write.
			logger.warn("notification-center: record failed", {
				userId: input.userId,
				kind: input.kind,
				sourceKey: input.sourceKey,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	for (const [userId, kinds] of touchedUsers) {
		notifyChanged(userId, [...kinds]);
	}
}

// ─── displayStatus derivation ───────────────────────────────────────────────

async function resolvePrincipalFor(userId: string): Promise<{ userId: string; isAdmin: boolean }> {
	try {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { role: true },
		});
		return { userId, isAdmin: row?.role === "admin" };
	} catch {
		return { userId, isAdmin: false };
	}
}

async function canUserReadNarratorId(
	userId: string,
	narratorId: string,
	isAdmin: boolean,
): Promise<boolean> {
	if (!narratorId) return false;
	try {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
		});
		if (!row) return false;
		return await canReadNarrator(row, { userId, isAdmin });
	} catch {
		return false;
	}
}

async function canUserReadChatRoomId(
	userId: string,
	roomId: string,
	isAdmin: boolean,
): Promise<boolean> {
	if (!roomId) return false;
	try {
		const room = await db.query.chatRooms.findFirst({
			where: eq(chatRooms.id, roomId),
		});
		if (!room) return false;
		if (room.kind === "dm") {
			const membership = await db.query.chatRoomMembers.findFirst({
				where: sql`${chatRoomMembers.roomId} = ${roomId} AND ${chatRoomMembers.userId} = ${userId}`,
			});
			return Boolean(membership);
		}
		if (!room.narratorId) return false;
		return canUserReadNarratorId(userId, room.narratorId, isAdmin);
	} catch {
		return false;
	}
}

/**
 * Derive display status for one row against its source system.
 * Bounded: at most a handful of point lookups per list item.
 */
async function resolveDisplayStatus(
	base: NotificationListItem,
	principal: { userId: string; isAdmin: boolean },
): Promise<NotificationListItem> {
	const dbStatus = base.status;

	if (base.kind === "permission_request") {
		const sourceKey = base.sourceKey;
		let tool: {
			id: string;
			narratorId: string;
			status: string;
			permissionDecidedBy: string | null;
		} | null = null;
		try {
			const found = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, sourceKey),
				columns: {
					id: true,
					narratorId: true,
					status: true,
					permissionDecidedBy: true,
				},
			});
			tool = found ?? null;
		} catch {
			tool = null;
		}

		if (!tool) {
			return { ...base, displayStatus: "gone", sourceAlive: false };
		}

		const narratorId = base.narratorId ?? tool.narratorId;
		const readable = await canUserReadNarratorId(principal.userId, narratorId, principal.isAdmin);
		if (!readable) {
			return { ...base, displayStatus: "gone", sourceAlive: false };
		}

		// "Still pending" = persisted status pending and no decision recorded.
		// Live in-memory pendingPermissions are covered when C hooks offer-time
		// insert; list-time derivation stays on the durable tool-call row.
		const stillPending = tool.status === "pending" && !tool.permissionDecidedBy;
		if (!stillPending) {
			// Narrator is still readable (checked above). Resolved ≠ gone: keep the
			// row navigable so click can open the session and clear unread (review M1).
			return { ...base, displayStatus: "resolved", sourceAlive: true };
		}
		return { ...base, displayStatus: dbStatus, sourceAlive: true };
	}

	// chat_message
	const roomId = base.link.type === "chat_room" && base.link.roomId ? base.link.roomId : null;
	if (!roomId) {
		return { ...base, displayStatus: "gone", sourceAlive: false };
	}
	const readable = await canUserReadChatRoomId(principal.userId, roomId, principal.isAdmin);
	if (!readable) {
		return { ...base, displayStatus: "gone", sourceAlive: false };
	}
	return { ...base, displayStatus: dbStatus };
}

/**
 * Derive display status for a whole list page with bounded batch lookups.
 *
 * Review M3: a page of up to 50 rows used to issue 2–4 point queries each.
 * We preload tool calls / narrators / chat rooms / DM memberships for the
 * unique ids on the page, then derive in memory. ACL still goes through
 * `canReadNarrator` per unique narrator (same authorization code path).
 * Falls back to per-row resolution if a batch query fails.
 */
async function resolveDisplayStatusBatch(
	bases: NotificationListItem[],
	principal: { userId: string; isAdmin: boolean },
): Promise<NotificationListItem[]> {
	if (bases.length === 0) return [];

	try {
		const toolIds = [
			...new Set(bases.filter((b) => b.kind === "permission_request").map((b) => b.sourceKey)),
		];
		const toolById = new Map<
			string,
			{
				id: string;
				narratorId: string;
				status: string;
				permissionDecidedBy: string | null;
			}
		>();
		if (toolIds.length > 0) {
			const found = await db
				.select({
					id: narratorToolCalls.id,
					narratorId: narratorToolCalls.narratorId,
					status: narratorToolCalls.status,
					permissionDecidedBy: narratorToolCalls.permissionDecidedBy,
				})
				.from(narratorToolCalls)
				.where(inArray(narratorToolCalls.id, toolIds));
			for (const row of found) toolById.set(row.id, row);
		}

		const roomIds = new Set<string>();
		for (const base of bases) {
			if (base.kind === "chat_message" && base.link.type === "chat_room" && base.link.roomId) {
				roomIds.add(base.link.roomId);
			}
		}

		const roomById = new Map<string, { id: string; kind: string; narratorId: string | null }>();
		const narratorIdSet = new Set<string>();
		for (const base of bases) {
			if (base.narratorId) narratorIdSet.add(base.narratorId);
		}
		for (const tool of toolById.values()) {
			if (tool.narratorId) narratorIdSet.add(tool.narratorId);
		}
		if (roomIds.size > 0) {
			const rooms = await db
				.select({
					id: chatRooms.id,
					kind: chatRooms.kind,
					narratorId: chatRooms.narratorId,
				})
				.from(chatRooms)
				.where(inArray(chatRooms.id, [...roomIds]));
			for (const room of rooms) {
				roomById.set(room.id, room);
				if (room.narratorId) narratorIdSet.add(room.narratorId);
			}
		}

		const narratorById = new Map<string, Parameters<typeof canReadNarrator>[0]>();
		if (narratorIdSet.size > 0) {
			const rows = await db
				.select()
				.from(narrators)
				.where(inArray(narrators.id, [...narratorIdSet]));
			for (const row of rows) narratorById.set(row.id, row);
		}

		const readableNarrator = new Map<string, boolean>();
		for (const [id, row] of narratorById) {
			try {
				readableNarrator.set(id, await canReadNarrator(row, principal));
			} catch {
				readableNarrator.set(id, false);
			}
		}

		const memberRoomIds = new Set<string>();
		if (roomIds.size > 0) {
			const memberships = await db
				.select({ roomId: chatRoomMembers.roomId })
				.from(chatRoomMembers)
				.where(
					and(
						eq(chatRoomMembers.userId, principal.userId),
						inArray(chatRoomMembers.roomId, [...roomIds]),
					),
				);
			for (const m of memberships) memberRoomIds.add(m.roomId);
		}

		const isNarratorReadable = (narratorId: string | null | undefined): boolean => {
			if (!narratorId) return false;
			return readableNarrator.get(narratorId) ?? false;
		};

		return bases.map((base) => {
			if (base.kind === "permission_request") {
				const tool = toolById.get(base.sourceKey);
				if (!tool) {
					return { ...base, displayStatus: "gone" as const, sourceAlive: false };
				}
				const narratorId = base.narratorId ?? tool.narratorId;
				if (!isNarratorReadable(narratorId)) {
					return { ...base, displayStatus: "gone" as const, sourceAlive: false };
				}
				const stillPending = tool.status === "pending" && !tool.permissionDecidedBy;
				if (!stillPending) {
					return { ...base, displayStatus: "resolved" as const, sourceAlive: true };
				}
				return { ...base, displayStatus: base.status, sourceAlive: true };
			}

			const roomId = base.link.type === "chat_room" && base.link.roomId ? base.link.roomId : null;
			if (!roomId) {
				return { ...base, displayStatus: "gone" as const, sourceAlive: false };
			}
			const room = roomById.get(roomId);
			if (!room) {
				return { ...base, displayStatus: "gone" as const, sourceAlive: false };
			}
			if (room.kind === "dm") {
				if (!memberRoomIds.has(roomId)) {
					return { ...base, displayStatus: "gone" as const, sourceAlive: false };
				}
			} else {
				if (!room.narratorId || !isNarratorReadable(room.narratorId)) {
					return { ...base, displayStatus: "gone" as const, sourceAlive: false };
				}
			}
			return { ...base, displayStatus: base.status };
		});
	} catch (err) {
		logger.warn("notification-center: batch displayStatus failed, falling back", {
			error: err instanceof Error ? err.message : String(err),
			size: bases.length,
		});
		const out: NotificationListItem[] = [];
		for (const base of bases) {
			out.push(await resolveDisplayStatus(base, principal));
		}
		return out;
	}
}

// ─── listNotifications ──────────────────────────────────────────────────────

export async function listNotifications(params: {
	userId: string;
	kind?: NotificationKind;
	status?: "unread" | "all";
	cursor?: string | null;
	limit?: number;
}): Promise<NotificationListPage> {
	const userId = params.userId;
	if (!userId) throw new ValidationError("userId is required");

	const limit = Math.min(
		Math.max(1, Math.floor(params.limit ?? NOTIFICATION_LIST_DEFAULT_LIMIT)),
		NOTIFICATION_LIST_MAX_LIMIT,
	);
	const kindFilter = isNotificationKind(params.kind) ? params.kind : null;
	const unreadOnly = params.status === "unread";
	const cursor = params.cursor ? decodeNotificationCursor(params.cursor) : null;

	// Keyset pagination on (created_at DESC, id DESC). Fetch limit+1 to learn
	// whether another page exists without a COUNT.
	const fetchLimit = limit + 1;

	const filters: SQL[] = [sql`user_id = ${userId}`];
	if (kindFilter) filters.push(sql`kind = ${kindFilter}`);
	if (unreadOnly) filters.push(sql`status = 'unread'`);
	if (cursor) {
		filters.push(
			sql`(created_at < ${cursor.createdAt} OR (created_at = ${cursor.createdAt} AND id < ${cursor.id}))`,
		);
	}
	const where = andAll(filters);

	const result = await db.all(sql`
		SELECT id, user_id, kind, project_id, chapter_id, narrator_id,
		       title, preview, link_json, source_key, status, created_at, read_at
		FROM notifications
		WHERE ${where}
		ORDER BY created_at DESC, id DESC
		LIMIT ${fetchLimit}
	`);
	const rows = ((result as unknown as NotificationRow[]) ?? []).filter(
		(r) => r && typeof r.id === "string",
	);

	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;

	const principal = await resolvePrincipalFor(userId);
	const bases = pageRows.map((row) => rowToListBase(row));
	const items = await resolveDisplayStatusBatch(bases, principal);

	const last = pageRows[pageRows.length - 1];
	const nextCursor =
		hasMore && last ? encodeNotificationCursor(Number(last.created_at), last.id) : null;

	return { items, nextCursor };
}

// ─── getUnreadCounts ────────────────────────────────────────────────────────

async function probeUnreadCount(
	userId: string,
	kind: NotificationKind | null,
): Promise<{ count: number; capped: boolean }> {
	const cap = NOTIFICATION_UNREAD_COUNT_CAP;
	const limit = cap + 1;
	const filters: SQL[] = [sql`user_id = ${userId}`, sql`status = 'unread'`];
	if (kind) filters.push(sql`kind = ${kind}`);
	const where = andAll(filters);

	const rows = await db.all(sql`
		SELECT id FROM notifications
		WHERE ${where}
		ORDER BY created_at DESC, id DESC
		LIMIT ${limit}
	`);
	const n = Array.isArray(rows) ? rows.length : 0;
	return { count: Math.min(n, cap), capped: n > cap };
}

export async function getUnreadCounts(userId: string): Promise<NotificationUnreadCounts> {
	if (!userId) throw new ValidationError("userId is required");

	const totalProbe = await probeUnreadCount(userId, null);
	const chatProbe = await probeUnreadCount(userId, "chat_message");
	const permProbe = await probeUnreadCount(userId, "permission_request");

	const lowerBound = totalProbe.capped || chatProbe.capped || permProbe.capped;
	return {
		total: totalProbe.count,
		chat_message: chatProbe.count,
		permission_request: permProbe.count,
		...(lowerBound ? { lowerBound: true } : {}),
	};
}

// ─── markNotificationsRead ──────────────────────────────────────────────────

/**
 * Owner-scoped, monotonic mark-read.
 * - `ids` present (including `[]`): only those ids; empty array updates nothing.
 * - otherwise optional `before` / `kind` filter over unread rows.
 * Already-read rows are not touched (`status = 'unread'` in the WHERE), so
 * `readAt` stays at the first mark.
 *
 * Uses `RETURNING id` for the updated count so we never run an unbounded
 * `COUNT(*)` after the write (main-thread SQLite rule).
 */
export async function markNotificationsRead(params: {
	userId: string;
	ids?: string[];
	before?: number;
	kind?: NotificationKind;
}): Promise<{ updated: number }> {
	const userId = params.userId;
	if (!userId) throw new ValidationError("userId is required");

	const now = Date.now();
	const filters: SQL[] = [sql`user_id = ${userId}`, sql`status = 'unread'`];

	if (params.ids !== undefined) {
		if (!Array.isArray(params.ids) || params.ids.length === 0) {
			return { updated: 0 };
		}
		const idList = params.ids.filter((id) => typeof id === "string" && id.length > 0);
		if (idList.length === 0) return { updated: 0 };
		filters.push(inIds(idList));
	} else {
		if (params.before !== undefined) {
			const before = Math.floor(params.before);
			if (!Number.isFinite(before) || before < 0) {
				throw new ValidationError("Invalid before timestamp");
			}
			filters.push(sql`created_at <= ${before}`);
		}
		if (params.kind !== undefined) {
			if (!isNotificationKind(params.kind)) {
				throw new ValidationError("Invalid notification kind");
			}
			filters.push(sql`kind = ${params.kind}`);
		}
	}

	const where = andAll(filters);
	const result = await db.all(sql`
		UPDATE notifications
		SET status = 'read', read_at = ${now}
		WHERE ${where}
		RETURNING id
	`);
	const updated = Array.isArray(result) ? result.length : 0;
	if (updated > 0) notifyChanged(userId);
	return { updated };
}

// ─── deleteNotification ─────────────────────────────────────────────────────

export async function deleteNotification(userId: string, id: string): Promise<void> {
	if (!userId || !id) throw new ValidationError("Notification id is required");

	const existing = await db.all(sql`
		SELECT id, user_id FROM notifications
		WHERE id = ${id}
		LIMIT 1
	`);
	const row = Array.isArray(existing)
		? (existing[0] as { id: string; user_id: string } | undefined)
		: undefined;
	// Non-owner and missing are both 404 — never confirm existence.
	if (!row || row.user_id !== userId) {
		throw new NotFoundError("Notification", id);
	}

	await db.run(sql`DELETE FROM notifications WHERE id = ${id} AND user_id = ${userId}`);
	notifyChanged(userId);
}

// ─── test helper: ensure physical table ─────────────────────────────────────

/**
 * Create the physical `notifications` table + indexes if missing.
 * Used by unit tests while package A has not yet generated the Drizzle
 * migration. Production migrate path (A) is the long-term source of DDL.
 */
export function ensureNotificationsTableForTests(sqlite: { run(query: string): unknown }): void {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS notifications (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			project_id TEXT,
			chapter_id TEXT,
			narrator_id TEXT,
			title TEXT NOT NULL DEFAULT '',
			preview TEXT NOT NULL DEFAULT '',
			link_json TEXT NOT NULL DEFAULT '{}',
			source_key TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'unread',
			created_at INTEGER NOT NULL,
			read_at INTEGER
		)
	`);
	sqlite.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_kind_source
		ON notifications(user_id, kind, source_key)
	`);
	sqlite.run(`
		CREATE INDEX IF NOT EXISTS idx_notifications_user_created
		ON notifications(user_id, created_at)
	`);
	sqlite.run(`
		CREATE INDEX IF NOT EXISTS idx_notifications_user_status_created
		ON notifications(user_id, status, created_at)
	`);
}
