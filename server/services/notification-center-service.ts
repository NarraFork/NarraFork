/** Bounded event history. Source ACL and read watermarks are authoritative, not the projection. */
import {
	type MarkNotificationsReadBody,
	NOTIFICATION_CENTER_CHANGED_WS_TYPE,
	NOTIFICATION_FANOUT_MAX_RECIPIENTS,
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_RETENTION_MAX_AGE_MS,
	NOTIFICATION_RETENTION_MAX_ROWS,
	NOTIFICATION_UNREAD_COUNT_CAP,
	type NotificationKind,
	type NotificationLink,
	type NotificationListItem,
	type NotificationListPage,
	type NotificationUnreadCounts,
} from "@shared/notification-center";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { notificationMarkReadSchema } from "../lib/validators/notifications";
import { narratorReadableWhere } from "./narrator-acl";

export type {
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationPersistentStatus,
	NotificationSourceState,
	NotificationUnreadCounts,
} from "@shared/notification-center";
export {
	NOTIFICATION_FANOUT_MAX_RECIPIENTS,
	NOTIFICATION_LIST_DEFAULT_LIMIT,
	NOTIFICATION_LIST_MAX_LIMIT,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_RETENTION_MAX_AGE_MS,
	NOTIFICATION_RETENTION_MAX_ROWS,
	NOTIFICATION_UNREAD_COUNT_CAP,
} from "@shared/notification-center";

export const NOTIFICATION_TITLE_MAX_LENGTH = 200;
export const NOTIFICATION_SQL_BATCH_SIZE = 200;

export interface NotificationCenterChangeEvent {
	userId: string;
	kinds?: NotificationKind[];
}

/** Compatibility subscription, backed exclusively by the existing event bus. */
export function onNotificationCenterChanged(
	listener: (event: NotificationCenterChangeEvent) => void,
): () => void {
	eventBus.on(NOTIFICATION_CENTER_CHANGED_WS_TYPE, listener);
	return () => eventBus.off(NOTIFICATION_CENTER_CHANGED_WS_TYPE, listener);
}

export function notifyNotificationCenterChanged(userId: string, kinds?: NotificationKind[]): void {
	eventBus.emit({ type: NOTIFICATION_CENTER_CHANGED_WS_TYPE, userId, kinds });
}

export function clampNotificationText(value: string | null | undefined, maxLength: number): string {
	const text = typeof value === "string" ? value : "";
	if (maxLength <= 0) return "";
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

interface NotificationCursor {
	createdAt: number;
	id: string;
	kind: NotificationKind | null;
	status: "unread" | "all";
}

export function encodeNotificationCursor(
	createdAt: number,
	id: string,
	kind: NotificationKind | null = null,
	status: "unread" | "all" = "all",
): string {
	return Buffer.from(JSON.stringify({ createdAt, id, kind, status })).toString("base64url");
}

export function decodeNotificationCursor(cursor: string): NotificationCursor {
	try {
		if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			!value ||
			Object.keys(value).sort().join(",") !== "createdAt,id,kind,status" ||
			!Number.isSafeInteger(value.createdAt) ||
			value.createdAt < 0 ||
			!isId(value.id) ||
			(value.kind !== null && !isNotificationKind(value.kind)) ||
			(value.status !== "all" && value.status !== "unread")
		)
			throw new Error();
		return value;
	} catch {
		throw new ValidationError("Invalid notification cursor");
	}
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

export function parseNotificationLink(raw: unknown): NotificationLink {
	if (!raw || typeof raw !== "object") return { type: "unavailable" };
	const value = raw as Record<string, unknown>;
	if (value.type === "chat_room" && isId(value.roomId)) {
		return { type: "chat_room", roomId: value.roomId };
	}
	if (value.type === "narrator" && isId(value.narratorId)) {
		return { type: "narrator", narratorId: value.narratorId };
	}
	return { type: "unavailable" };
}

function isNotificationKind(value: unknown): value is NotificationKind {
	return value === "chat_message" || value === "permission_request";
}

function chunks<T>(items: T[]): T[][] {
	const result: T[][] = [];
	for (let offset = 0; offset < items.length; offset += NOTIFICATION_SQL_BATCH_SIZE) {
		result.push(items.slice(offset, offset + NOTIFICATION_SQL_BATCH_SIZE));
	}
	return result;
}

function boundIds(ids: string[]) {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}

interface NotificationRow {
	id: string;
	kind: NotificationKind;
	title: string;
	preview: string;
	link_json: string;
	source_key: string;
	status: string;
	created_at: number;
	read_at: number | null;
}

/** Always select the event window BEFORE kind/status filters. No request catches up old backlog. */
async function loadWindow(userId: string, now: number): Promise<NotificationRow[]> {
	return db.all<NotificationRow>(sql`
		SELECT id, kind, title, preview, link_json, source_key, status, created_at, read_at
		FROM notifications WHERE user_id = ${userId}
		AND created_at >= ${now - NOTIFICATION_RETENTION_MAX_AGE_MS}
		ORDER BY created_at DESC, id DESC LIMIT ${NOTIFICATION_RETENTION_MAX_ROWS}
	`);
}

function rowBase(row: NotificationRow): NotificationListItem {
	return {
		id: row.id,
		groupKey: `notification:${row.id}`,
		notificationIds: [row.id],
		kind: row.kind,
		projectId: null,
		chapterId: null,
		narratorId: null,
		projectTitle: null,
		chapterTitle: null,
		title: "",
		preview: "",
		link: { type: "unavailable" },
		sourceKey: null,
		sourceState: "gone",
		createdAt: row.created_at,
		readAt: row.read_at ?? (row.status === "read" ? row.created_at : null),
		groupSize: 1,
	};
}

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

/** Best-effort projection: storage or downstream listener failures never undo the source write. */
export async function recordNotifications(inputs: RecordNotificationInput[]): Promise<void> {
	if (!Array.isArray(inputs) || inputs.length === 0) return;
	if (inputs.length > NOTIFICATION_FANOUT_MAX_RECIPIENTS) {
		logger.warn("notification-center: fan-out truncated", { requested: inputs.length });
	}
	const touched = new Map<string, Set<NotificationKind>>();
	for (const input of inputs.slice(0, NOTIFICATION_FANOUT_MAX_RECIPIENTS)) {
		if (!input || !isId(input.userId) || !isId(input.sourceKey) || !isNotificationKind(input.kind))
			continue;
		try {
			const link = parseNotificationLink(input.link);
			const createdAt =
				Number.isSafeInteger(input.createdAt) && (input.createdAt as number) >= 0
					? (input.createdAt as number)
					: Date.now();
			db.run(sql`
				INSERT INTO notifications (
					id, user_id, kind, project_id, chapter_id, narrator_id,
					title, preview, link_json, source_key, status, created_at, read_at
				) VALUES (
					${generateId()}, ${input.userId}, ${input.kind},
					${isId(input.projectId) ? input.projectId : null},
					${isId(input.chapterId) ? input.chapterId : null},
					${link.type === "narrator" ? link.narratorId : null},
					${clampNotificationText(input.title, NOTIFICATION_TITLE_MAX_LENGTH)},
					${clampNotificationText(input.preview, NOTIFICATION_PREVIEW_MAX_LENGTH)},
					${JSON.stringify(link)}, ${input.sourceKey}, 'unread', ${createdAt}, NULL
				) ON CONFLICT (user_id, kind, source_key) DO NOTHING
			`);
			if ((db.all<{ count: number }>(sql`SELECT changes() AS count`)[0]?.count ?? 0) > 0) {
				const kinds = touched.get(input.userId) ?? new Set<NotificationKind>();
				kinds.add(input.kind);
				touched.set(input.userId, kinds);
			}
		} catch (error) {
			logger.warn("notification-center: record failed", {
				userId: input.userId,
				error: String(error),
			});
		}
	}
	for (const [userId, kinds] of touched) notifyNotificationCenterChanged(userId, [...kinds]);
}

interface MessageSource {
	id: string;
	roomId: string;
	seq: number;
	deletedAt: string | null;
	roomKind: string;
	lastReadSeq: number | null;
	lastReadAt: string | null;
}

/** PK lookups with membership joined by (room_id,user_id); never reads message bodies. */
async function loadMessageSources(rows: NotificationRow[], userId: string) {
	const result = new Map<string, MessageSource>();
	const ids = rows.filter((row) => row.kind === "chat_message").map((row) => row.source_key);
	for (const batch of chunks([...new Set(ids)])) {
		const found = db.all<MessageSource>(sql`
			SELECT m.id, m.room_id AS roomId, m.seq, m.deleted_at AS deletedAt,
			       r.kind AS roomKind, member.last_read_seq AS lastReadSeq,
			       member.last_read_at AS lastReadAt
			FROM chat_messages m INNER JOIN chat_rooms r ON r.id = m.room_id
			LEFT JOIN chat_room_members member ON member.room_id = r.id AND member.user_id = ${userId}
			WHERE m.id IN (${boundIds(batch)}) LIMIT ${NOTIFICATION_SQL_BATCH_SIZE}
		`);
		for (const row of found) result.set(row.id, row);
	}
	return result;
}

interface PermissionSource {
	id: string;
	narratorId: string;
	status: string;
	decidedBy: string | null;
	decidedAt: string | null;
}

async function deriveActivities(userId: string, now: number): Promise<NotificationListItem[]> {
	const started = performance.now();
	const rows = await loadWindow(userId, now);
	const messages = await loadMessageSources(rows, userId);
	const tools = new Map<string, PermissionSource>();
	const toolIds = rows
		.filter((row) => row.kind === "permission_request")
		.map((row) => row.source_key);
	for (const batch of chunks([...new Set(toolIds)])) {
		const found = db.all<PermissionSource>(sql`
			SELECT id, narrator_id AS narratorId, status,
			permission_decided_by AS decidedBy, permission_decided_at AS decidedAt
			FROM narrator_tool_calls WHERE id IN (${boundIds(batch)}) LIMIT ${NOTIFICATION_SQL_BATCH_SIZE}
		`);
		for (const tool of found) tools.set(tool.id, tool);
	}

	const principal = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	const contexts = new Map<
		string,
		{
			narratorId: string;
			chapterId: string | null;
			chapterTitle: string | null;
			projectId: string | null;
			projectTitle: string | null;
		}
	>();
	for (const batch of chunks([...new Set([...tools.values()].map((tool) => tool.narratorId))])) {
		const found = await db
			.select({
				narratorId: narrators.id,
				chapterId: chapters.id,
				chapterTitle: sql<
					string | null
				>`substr(${chapters.title}, 1, ${NOTIFICATION_TITLE_MAX_LENGTH})`,
				projectId: projects.id,
				projectTitle: sql<
					string | null
				>`substr(${projects.name}, 1, ${NOTIFICATION_TITLE_MAX_LENGTH})`,
			})
			.from(narrators)
			.leftJoin(chapters, eq(chapters.id, narrators.chapterId))
			.leftJoin(
				projects,
				eq(projects.id, sql`coalesce(${chapters.projectId}, ${narrators.contextProjectId})`),
			)
			.where(
				and(
					inArray(narrators.id, batch),
					narratorReadableWhere({ userId, isAdmin: principal?.role === "admin" }),
				),
			)
			.limit(NOTIFICATION_SQL_BATCH_SIZE);
		for (const context of found) contexts.set(context.narratorId, context);
	}

	// Internal room identity is never serialized for inaccessible/deleted sources.
	const grouped = new Map<string, NotificationListItem[]>();
	for (const row of rows) {
		const item = rowBase(row);
		let key = item.groupKey;
		if (row.kind === "chat_message") {
			const source = messages.get(row.source_key);
			let storedLink: NotificationLink = { type: "unavailable" };
			try {
				storedLink = parseNotificationLink(JSON.parse(row.link_json));
			} catch {
				/* fail closed */
			}
			if (
				source?.roomKind === "dm" &&
				source.lastReadSeq !== null &&
				storedLink.type === "chat_room" &&
				storedLink.roomId === source.roomId
			) {
				key = `chat_room:${source.roomId}`;
				if (!source.deletedAt) {
					Object.assign(item, {
						title: row.title,
						preview: row.preview,
						sourceKey: row.source_key,
						sourceState: "active",
						link: { type: "chat_room", roomId: source.roomId },
						groupKey: key,
					});
					if (item.readAt === null && source.seq <= source.lastReadSeq) {
						const readAt = source.lastReadAt ? Date.parse(source.lastReadAt) : NaN;
						item.readAt = Number.isFinite(readAt) ? readAt : row.created_at;
					}
				}
			}
		} else if (row.kind === "permission_request") {
			const tool = tools.get(row.source_key);
			const context = tool && contexts.get(tool.narratorId);
			if (tool && context) {
				Object.assign(item, context, {
					title: row.title,
					preview: row.preview,
					sourceKey: row.source_key,
					sourceState:
						tool.status === "pending" && !tool.decidedBy && !tool.decidedAt ? "active" : "resolved",
					link: { type: "narrator", narratorId: tool.narratorId },
				});
			}
		}
		const members = grouped.get(key) ?? [];
		members.push(item);
		grouped.set(key, members);
	}
	const activities = [...grouped.values()].map((members) => {
		const valid = members.filter((item) => item.sourceState !== "gone");
		const visible = valid.length ? valid : members;
		// Preview order is the source sequence, not notification insertion order: projections
		// may arrive out of order. Keep the event ordering anchor separate for pagination.
		const representative = visible.reduce((latest, item) => {
			const seq = item.sourceKey ? (messages.get(item.sourceKey)?.seq ?? 0) : 0;
			const latestSeq = latest.sourceKey ? (messages.get(latest.sourceKey)?.seq ?? 0) : 0;
			return seq > latestSeq ? item : latest;
		});
		const anchor = members[0];
		return {
			...representative,
			id: anchor.id,
			createdAt: anchor.createdAt,
			groupKey:
				representative.sourceState === "gone"
					? `notification:${anchor.id}`
					: representative.groupKey,
			notificationIds: members.flatMap((item) => item.notificationIds),
			groupSize: members.length,
			readAt: visible.some((item) => item.readAt === null)
				? null
				: Math.max(...visible.map((item) => item.readAt as number)),
		};
	});
	const elapsedMs = performance.now() - started;
	if (elapsedMs > 25)
		logger.warn("notification-center: slow activity projection", {
			userId,
			elapsedMs,
			events: rows.length,
			groups: activities.length,
		});
	return activities.sort(
		(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
	);
}

export async function listNotifications(params: {
	userId: string;
	kind?: NotificationKind;
	status?: "unread" | "all";
	cursor?: string | null;
	limit?: number;
}): Promise<NotificationListPage> {
	if (!isId(params.userId)) throw new ValidationError("userId is required");
	if (params.kind !== undefined && !isNotificationKind(params.kind))
		throw new ValidationError("Invalid notification kind");
	if (params.status !== undefined && params.status !== "all" && params.status !== "unread")
		throw new ValidationError("Invalid notification status");
	const limit = Math.min(
		NOTIFICATION_LIST_MAX_LIMIT,
		Math.max(1, Math.floor(params.limit ?? NOTIFICATION_LIST_DEFAULT_LIMIT)),
	);
	if (!Number.isFinite(limit)) throw new ValidationError("Invalid notification limit");
	const kind = params.kind ?? null;
	const status = params.status ?? "all";
	const cursor = params.cursor != null ? decodeNotificationCursor(params.cursor) : null;
	if (cursor && (cursor.kind !== kind || cursor.status !== status))
		throw new ValidationError("Notification cursor filter mismatch");
	const asOf = Date.now();
	const activities = (await deriveActivities(params.userId, asOf)).filter(
		(item) =>
			(!kind || item.kind === kind) &&
			(status !== "unread" || item.readAt === null) &&
			(!cursor ||
				item.createdAt < cursor.createdAt ||
				(item.createdAt === cursor.createdAt && item.id < cursor.id)),
	);
	const items = activities.slice(0, limit);
	const last = items.at(-1);
	return {
		items,
		asOf,
		nextCursor:
			activities.length > limit && last
				? encodeNotificationCursor(last.createdAt, last.id, kind, status)
				: null,
	};
}

export async function getUnreadCounts(userId: string): Promise<NotificationUnreadCounts> {
	if (!isId(userId)) throw new ValidationError("userId is required");
	const unread = (await deriveActivities(userId, Date.now())).filter(
		(item) => item.readAt === null && item.sourceState !== "gone",
	);
	const conversations = unread.filter(
		(item) => item.kind === "chat_message" && item.sourceState === "active",
	).length;
	return {
		unreadConversations: Math.min(conversations, NOTIFICATION_UNREAD_COUNT_CAP),
		unreadActivities: Math.min(unread.length, NOTIFICATION_UNREAD_COUNT_CAP),
		conversationsLowerBound: conversations > NOTIFICATION_UNREAD_COUNT_CAP,
		activitiesLowerBound: unread.length > NOTIFICATION_UNREAD_COUNT_CAP,
	};
}

async function updateReadIds(userId: string, ids: string[]): Promise<{ updated: number }> {
	let updated = 0;
	const now = Date.now();
	for (const batch of chunks([...new Set(ids)])) {
		db.run(sql`
			UPDATE notifications SET status = 'read', read_at = coalesce(read_at, ${now})
			WHERE user_id = ${userId} AND status = 'unread' AND id IN (${boundIds(batch)})
		`);
		updated += db.all<{ count: number }>(sql`SELECT changes() AS count`)[0]?.count ?? 0;
	}
	if (updated > 0) notifyNotificationCenterChanged(userId);
	return { updated };
}

export async function markNotificationsRead(
	params: MarkNotificationsReadBody & { userId: string },
): Promise<{ updated: number }> {
	const { userId, ...body } = params;
	if (!isId(userId)) throw new ValidationError("userId is required");
	const parsed = notificationMarkReadSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	if (parsed.data.scope === "items") return updateReadIds(userId, parsed.data.ids);
	const { before, kind } = parsed.data;
	const rows = await loadWindow(userId, Date.now());
	return updateReadIds(
		userId,
		rows
			.filter((row) => row.created_at <= before && (!kind || row.kind === kind))
			.map((row) => row.id),
	);
}

/** Called after source read commits. Query-time derivation still closes insert/read races. */
export async function syncChatNotificationReads(
	roomId: string,
	userId: string,
	lastReadSeq: number,
): Promise<{ updated: number }> {
	if (!isId(roomId) || !isId(userId) || !Number.isSafeInteger(lastReadSeq) || lastReadSeq < 0) {
		throw new ValidationError("Invalid chat read watermark");
	}
	const rows = await loadWindow(userId, Date.now());
	const messages = await loadMessageSources(rows, userId);
	return updateReadIds(
		userId,
		rows
			.filter((row) => {
				const source = messages.get(row.source_key);
				return (
					row.kind === "chat_message" && source?.roomId === roomId && source.seq <= lastReadSeq
				);
			})
			.map((row) => row.id),
	);
}

export async function deleteNotification(userId: string, id: string): Promise<void> {
	if (!isId(userId) || !isId(id)) throw new ValidationError("Notification id is required");
	db.run(sql`DELETE FROM notifications WHERE id = ${id} AND user_id = ${userId}`);
	if (!db.all<{ count: number }>(sql`SELECT changes() AS count`)[0]?.count)
		throw new NotFoundError("Notification", id);
	notifyNotificationCenterChanged(userId);
}

/** Test fixtures only; production DDL is generated from schema.ts. */
export function ensureNotificationsTableForTests(sqlite: { run(query: string): unknown }): void {
	sqlite.run(`CREATE TABLE IF NOT EXISTS notifications (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
		project_id TEXT, chapter_id TEXT, narrator_id TEXT,
		title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
		link_json TEXT NOT NULL DEFAULT '{}', source_key TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'unread', created_at INTEGER NOT NULL, read_at INTEGER
	)`);
	sqlite.run(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_kind_source ON notifications(user_id, kind, source_key)`,
	);
	sqlite.run(
		`CREATE INDEX IF NOT EXISTS idx_notifications_user_created_id ON notifications(user_id, created_at, id)`,
	);
	sqlite.run(
		`CREATE INDEX IF NOT EXISTS idx_notifications_user_status_created_id ON notifications(user_id, status, created_at, id)`,
	);
}
