import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { NotificationListItem } from "@shared/notification-center";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const service = await import("../notification-center-service");
const {
	clampNotificationText,
	decodeNotificationCursor,
	deleteNotification,
	encodeNotificationCursor,
	ensureNotificationsTableForTests,
	getUnreadCounts,
	listNotifications,
	markNotificationsRead,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_RETENTION_MAX_AGE_MS,
	onNotificationCenterChanged,
	parseNotificationLink,
	recordNotifications,
	syncChatNotificationReads,
} = service;
const { notificationListQuerySchema, notificationMarkReadSchema } = await import(
	"../../lib/validators/notifications"
);
let now = Date.now();
const alice = "alice";
const bob = "bob";

function notification(
	id: string,
	options: {
		userId?: string;
		kind?: "chat_message" | "permission_request";
		sourceKey?: string;
		roomId?: string;
		createdAt?: number;
		status?: string;
		readAt?: number | null;
	} = {},
) {
	sqlite.run(
		`INSERT INTO notifications
		(id,user_id,kind,source_key,title,preview,link_json,status,created_at,read_at,project_id,chapter_id,narrator_id)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		[
			id,
			options.userId ?? alice,
			options.kind ?? "chat_message",
			options.sourceKey ?? id,
			"secret sender",
			`secret preview ${id}`,
			JSON.stringify({ type: "chat_room", roomId: options.roomId ?? "room" }),
			options.status ?? "unread",
			options.createdAt ?? now,
			options.readAt ?? null,
			"secret-project",
			"secret-chapter",
			"secret-narrator",
		],
	);
}

function room(id = "room", lastReadSeq = 0) {
	sqlite.run("INSERT INTO chat_rooms (id,kind,dm_key,created_at) VALUES (?,'dm',?,?)", [
		id,
		id,
		new Date(now).toISOString(),
	]);
	sqlite.run(
		"INSERT INTO chat_room_members (id,room_id,user_id,last_read_seq,joined_at) VALUES (?,?,?,?,?)",
		[`member-${id}`, id, alice, lastReadSeq, new Date(now).toISOString()],
	);
}

function message(id: string, roomId: string, seq: number, deleted = false) {
	sqlite.run(
		"INSERT INTO chat_messages (id,room_id,seq,content_text,created_at,deleted_at) VALUES (?,?,?,?,?,?)",
		[
			id,
			roomId,
			seq,
			"large source content must not be read",
			new Date(now).toISOString(),
			deleted ? new Date(now).toISOString() : null,
		],
	);
}

function permission(
	id: string,
	options: { owner?: string; decidedAt?: string; context?: boolean } = {},
) {
	if (options.context) {
		sqlite.run(
			"INSERT OR IGNORE INTO projects (id,name,owner_user_id,created_at,updated_at) VALUES ('project','Project title',?,?,?)",
			[alice, new Date(now).toISOString(), new Date(now).toISOString()],
		);
		sqlite.run(
			"INSERT OR IGNORE INTO chapters (id,project_id,title,branch,base_branch,created_at,updated_at) VALUES ('chapter','project','Chapter title','feature','main',?,?)",
			[new Date(now).toISOString(), new Date(now).toISOString()],
		);
	}
	sqlite.run(
		"INSERT INTO narrators (id,title,owner_user_id,visibility,write_audience,chapter_id,created_at,updated_at) VALUES (?,? ,?,'private','owner',?,?,?)",
		[
			`n-${id}`,
			"Narrator",
			options.owner ?? alice,
			options.context ? "chapter" : null,
			new Date(now).toISOString(),
			new Date(now).toISOString(),
		],
	);
	sqlite.run(
		"INSERT INTO narrator_messages (id,narrator_id,role,content_json,created_at) VALUES (?,?,'assistant','[]',?)",
		[`m-${id}`, `n-${id}`, new Date(now).toISOString()],
	);
	sqlite.run(
		"INSERT INTO narrator_tool_calls (id,narrator_id,message_id,tool_use_id,tool_name,status,permission_decided_at,created_at) VALUES (?,?,?,?,'Bash','pending',?,?)",
		[id, `n-${id}`, `m-${id}`, `use-${id}`, options.decidedAt ?? null, new Date(now).toISOString()],
	);
	notification(`notification-${id}`, { kind: "permission_request", sourceKey: id });
}

function expectGone(item: NotificationListItem | undefined) {
	expect(item).toBeDefined();
	if (!item) throw new Error("Expected unavailable notification");
	expect(item).toMatchObject({
		sourceState: "gone",
		sourceKey: null,
		title: "",
		preview: "",
		link: { type: "unavailable" },
		projectId: null,
		chapterId: null,
		narratorId: null,
		projectTitle: null,
		chapterTitle: null,
		groupKey: `notification:${item.id}`,
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	ensureNotificationsTableForTests(sqlite);
	now = Date.now() - 1000;
	for (const id of [alice, bob])
		sqlite.run(
			"INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?,?,'user',?)",
			[id, id, "x", new Date(now).toISOString()],
		);
});
afterAll(() => {
	mock.restore();
	mock.module("../../db", () => realDb);
	cleanDb(sqlite);
});

describe("write and boundary helpers", () => {
	test("safe strict links, clamps, cursor validation and filter binding", async () => {
		expect(clampNotificationText("x".repeat(300), 120)).toHaveLength(120);
		expect(clampNotificationText(undefined, 120)).toBe("");
		for (const raw of [
			null,
			{},
			{ type: "narrator" },
			{ roomId: "x" },
			{ type: "chat_room", roomId: "" },
		])
			expect(parseNotificationLink(raw)).toEqual({ type: "unavailable" });
		const cursor = encodeNotificationCursor(now, "id", "chat_message", "unread");
		expect(decodeNotificationCursor(cursor)).toEqual({
			createdAt: now,
			id: "id",
			kind: "chat_message",
			status: "unread",
		});
		for (const raw of [
			"",
			"!!!",
			"x".repeat(513),
			Buffer.from(
				JSON.stringify({ createdAt: now, id: "x".repeat(65), kind: null, status: "all" }),
			).toString("base64url"),
		])
			expect(() => decodeNotificationCursor(raw)).toThrow(ValidationError);
		await expect(listNotifications({ userId: alice, cursor })).rejects.toThrow(ValidationError);
	});

	test("deduped inserts directly notify eventBus once; invalid links fail closed", async () => {
		room();
		message("source", "room", 1);
		const events: unknown[] = [];
		const handler = (event: unknown) => {
			events.push(event);
		};
		eventBus.on("notification_center_changed", handler);
		try {
			const input = {
				userId: alice,
				kind: "chat_message" as const,
				sourceKey: "source",
				title: "sender",
				preview: "x".repeat(300),
				link: { type: "chat_room" as const, roomId: "room" },
			};
			await recordNotifications([input, input]);
			await recordNotifications([input]);
			expect(events).toHaveLength(1);
			const row = (await listNotifications({ userId: alice })).items[0];
			expect(row.preview).toHaveLength(NOTIFICATION_PREVIEW_MAX_LENGTH);
			expect(row.readAt).toBeNull();
			await recordNotifications([
				{ ...input, sourceKey: "invalid", link: {} as typeof input.link },
			]);
			expectGone(
				(await listNotifications({ userId: alice })).items.find((item) => item.id !== row.id),
			);
		} finally {
			eventBus.off("notification_center_changed", handler);
		}
	});

	test("projection failure does not reject source operation", async () => {
		sqlite.run("DROP TABLE notifications");
		await expect(
			recordNotifications([
				{
					userId: alice,
					kind: "chat_message",
					sourceKey: "x",
					title: "",
					preview: "",
					link: { type: "unavailable" },
				},
			]),
		).resolves.toBeUndefined();
		ensureNotificationsTableForTests(sqlite);
	});
});

describe("whole-window grouping and derived source state", () => {
	test("interleaved rooms aggregate before pagination without gaps or duplicate room rows", async () => {
		for (const id of ["a", "b", "c"]) room(id);
		for (let i = 0; i < 9; i++) {
			const id = `msg-${i}`;
			const roomId = ["a", "b", "c"][i % 3];
			message(id, roomId, i + 1);
			notification(id, { roomId, createdAt: now + i });
		}
		const seen: NotificationListItem[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 5; i++) {
			const page = await listNotifications({ userId: alice, limit: 1, cursor });
			seen.push(...page.items);
			cursor = page.nextCursor;
			expect(page.asOf).toBeGreaterThanOrEqual(now);
			if (!cursor) break;
		}
		expect(seen.map((item) => item.groupKey)).toEqual([
			"chat_room:c",
			"chat_room:b",
			"chat_room:a",
		]);
		expect(seen.every((item) => item.groupSize === 3)).toBe(true);
		expect(new Set(seen.flatMap((item) => item.notificationIds)).size).toBe(9);
		expect(await getUnreadCounts(alice)).toEqual({
			unreadConversations: 3,
			unreadActivities: 3,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		});
	});

	test("late projection cannot replace the latest source preview or duplicate a static page", async () => {
		room("room");
		room("other");
		message("latest", "room", 2);
		message("delayed", "room", 1);
		message("between", "other", 1);
		notification("latest", { createdAt: now });
		notification("between", { roomId: "other", createdAt: now + 1 });
		notification("delayed", { createdAt: now + 2 });
		const first = await listNotifications({ userId: alice, limit: 1 });
		expect(first.items[0]).toMatchObject({
			id: "delayed",
			createdAt: now + 2,
			sourceKey: "latest",
			preview: "secret preview latest",
			groupSize: 2,
		});
		const second = await listNotifications({ userId: alice, limit: 1, cursor: first.nextCursor });
		expect(second.items.map((item) => item.groupKey)).toEqual(["chat_room:other"]);
		expect(second.nextCursor).toBeNull();
	});

	test("partial source reads and explicit single-event reads count only effective unread", async () => {
		room("room", 1);
		for (let seq = 1; seq <= 3; seq++) {
			message(`m${seq}`, "room", seq);
			notification(`m${seq}`, { createdAt: now + seq });
		}
		await markNotificationsRead({ userId: alice, scope: "items", ids: ["m3"] });
		expect((await listNotifications({ userId: alice, status: "unread" })).items).toHaveLength(1);
		expect((await getUnreadCounts(alice)).unreadConversations).toBe(1);
		sqlite.run("UPDATE chat_room_members SET last_read_seq = 2, last_read_at = ?", [
			new Date(now + 10).toISOString(),
		]);
		expect((await getUnreadCounts(alice)).unreadActivities).toBe(0);
		expect((await listNotifications({ userId: alice, status: "unread" })).items).toHaveLength(0);
		expect((await syncChatNotificationReads("room", alice, 2)).updated).toBe(2);
	});

	test("source read before insertion never resurrects unread; sync only touches matching room", async () => {
		room("room", 10);
		room("other");
		message("late", "room", 1);
		message("other", "other", 1);
		notification("late");
		notification("other", { roomId: "other" });
		expect((await getUnreadCounts(alice)).unreadConversations).toBe(1);
		await syncChatNotificationReads("room", alice, 10);
		expect(sqlite.query("SELECT read_at FROM notifications WHERE id='other'").get()).toEqual({
			read_at: null,
		});
	});

	test("deleted latest message never restores its preview and cannot create ghost unread", async () => {
		room();
		message("old", "room", 1);
		message("deleted", "room", 2, true);
		notification("old", { status: "read", readAt: now });
		notification("deleted", { createdAt: now + 1 });
		const item = (await listNotifications({ userId: alice })).items[0];
		expect(item.preview).toBe("secret preview old");
		expect(item.groupSize).toBe(2);
		expect(item.readAt).not.toBeNull();
		expect((await getUnreadCounts(alice)).unreadConversations).toBe(0);
		sqlite.run("UPDATE chat_messages SET deleted_at = ?", [new Date(now).toISOString()]);
		expectGone((await listNotifications({ userId: alice })).items[0]);
		expect((await getUnreadCounts(alice)).unreadActivities).toBe(0);
	});

	test("membership revoked or message removed redacts every source field and summary count", async () => {
		room();
		message("secret", "room", 1);
		notification("secret");
		sqlite.run("DELETE FROM chat_room_members");
		expectGone((await listNotifications({ userId: alice })).items[0]);
		expect(await getUnreadCounts(alice)).toEqual({
			unreadConversations: 0,
			unreadActivities: 0,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		});
		sqlite.run("DELETE FROM chat_messages");
		expectGone((await listNotifications({ userId: alice })).items[0]);
		expect((await listNotifications({ userId: alice, status: "unread" })).items).toHaveLength(1);
	});

	test("permission uses actual source owner ACL, decision timestamp, and authorized context titles", async () => {
		permission("pending", { context: true });
		permission("decided", { decidedAt: new Date(now).toISOString() });
		permission("denied", { owner: bob });
		let items = (await listNotifications({ userId: alice })).items;
		expect(items.find((item) => item.sourceKey === "pending")).toMatchObject({
			sourceState: "active",
			narratorId: "n-pending",
			projectId: "project",
			chapterId: "chapter",
			projectTitle: "Project title",
			chapterTitle: "Chapter title",
		});
		expect(items.find((item) => item.sourceKey === "decided")?.sourceState).toBe("resolved");
		expectGone(items.find((item) => item.id === "notification-denied"));
		expect(await getUnreadCounts(alice)).toEqual({
			unreadConversations: 0,
			unreadActivities: 2,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		});
		sqlite.run("UPDATE narrators SET owner_user_id = ? WHERE id = 'n-pending'", [bob]);
		items = (await listNotifications({ userId: alice })).items;
		expectGone(items.find((item) => item.id === "notification-pending"));
	});

	test("queries whitelist source fields and SQL id batches stay at most 200", async () => {
		room();
		for (let i = 0; i < 450; i++) {
			message(`m${i}`, "room", i + 1);
			notification(`m${i}`);
		}
		const allSpy = spyOn(db, "all");
		const runSpy = spyOn(db, "run");
		try {
			await getUnreadCounts(alice);
			await markNotificationsRead({
				userId: alice,
				scope: "items",
				ids: Array.from({ length: 450 }, (_, i) => `m${i}`),
			});
			const dialect = new SQLiteSyncDialect();
			const reads = allSpy.mock.calls.map(([query]) =>
				dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]),
			);
			const sources = reads.filter((query) => query.sql.includes("FROM chat_messages"));
			expect(sources).toHaveLength(3);
			for (const query of sources) {
				expect(query.sql).not.toMatch(
					/content_text|input_json|output_json|system_prompt|background_result/,
				);
				expect(query.params.length).toBeLessThanOrEqual(202);
			}
			const updates = runSpy.mock.calls.map(([query]) =>
				dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]),
			);
			expect(updates).toHaveLength(3);
			for (const query of updates) {
				expect(query.params.length).toBeLessThanOrEqual(202);
				expect(query.sql).not.toContain("RETURNING");
			}
		} finally {
			allSpy.mockRestore();
			runSpy.mockRestore();
		}
	});
});

describe("retained window and explicit mark-read", () => {
	test("age and 500-event window apply before grouping, filters, and all-read", async () => {
		notification("too-old", {
			kind: "permission_request",
			createdAt: now - NOTIFICATION_RETENTION_MAX_AGE_MS - 1,
		});
		notification("outside-window", { kind: "permission_request", createdAt: now - 1 });
		room();
		for (let i = 0; i < 500; i++) {
			message(`w${i}`, "room", i + 1);
			notification(`w${i}`, { createdAt: now + i });
		}
		expect(
			(await listNotifications({ userId: alice, kind: "permission_request" })).items,
		).toHaveLength(0);
		const page = await listNotifications({ userId: alice });
		expect(page.items[0].notificationIds).toHaveLength(500);
		expect(
			(await markNotificationsRead({ userId: alice, scope: "all", before: page.asOf })).updated,
		).toBe(500);
		expect(
			sqlite.query("SELECT id FROM notifications WHERE status='unread' ORDER BY id").all(),
		).toEqual([{ id: "outside-window" }, { id: "too-old" }]);
	});

	test("all honors kind and asOf, items are owner-scoped and first readAt is monotonic", async () => {
		notification("old");
		notification("new", { createdAt: now + 2 });
		notification("perm", { kind: "permission_request" });
		notification("foreign", { userId: bob });
		expect(
			(
				await markNotificationsRead({
					userId: alice,
					scope: "all",
					before: now,
					kind: "chat_message",
				})
			).updated,
		).toBe(1);
		const first = sqlite.query("SELECT read_at FROM notifications WHERE id='old'").get();
		expect(
			(await markNotificationsRead({ userId: alice, scope: "items", ids: ["old", "foreign"] }))
				.updated,
		).toBe(0);
		expect(sqlite.query("SELECT read_at FROM notifications WHERE id='old'").get()).toEqual(first);
		expect((await markNotificationsRead({ userId: alice, scope: "items", ids: [] })).updated).toBe(
			0,
		);
	});

	test("service itself rejects implicit, mixed, invalid, and oversized read requests without mutation", async () => {
		notification("remain");
		for (const input of [
			{},
			{ ids: [] },
			{ scope: "all" },
			{ scope: "all", before: now, ids: [] },
			{ scope: "items", ids: [""] },
			{ scope: "items", ids: Array.from({ length: 501 }, (_, i) => `i${i}`) },
		]) {
			await expect(
				markNotificationsRead({ userId: alice, ...input } as Parameters<
					typeof markNotificationsRead
				>[0]),
			).rejects.toThrow(ValidationError);
		}
		expect(sqlite.query("SELECT read_at FROM notifications").get()).toEqual({ read_at: null });
	});

	test("counts cap grouped valid activities; gone rows do not trip lowerBound", async () => {
		for (let i = 0; i < 101; i++) permission(`p${i}`);
		expect(await getUnreadCounts(alice)).toEqual({
			unreadConversations: 0,
			unreadActivities: 99,
			conversationsLowerBound: false,
			activitiesLowerBound: true,
		});
		sqlite.run("DELETE FROM narrator_tool_calls");
		expect(await getUnreadCounts(alice)).toEqual({
			unreadConversations: 0,
			unreadActivities: 0,
			conversationsLowerBound: false,
			activitiesLowerBound: false,
		});
	});

	test("delete only belongs to owner and wrapper unsubscribes from eventBus", async () => {
		notification("own");
		const events: unknown[] = [];
		const off = onNotificationCenterChanged((event) => events.push(event));
		try {
			await expect(deleteNotification(bob, "own")).rejects.toBeInstanceOf(NotFoundError);
			await expect(deleteNotification(alice, "missing")).rejects.toBeInstanceOf(NotFoundError);
			await deleteNotification(alice, "own");
			expect(events).toHaveLength(1);
		} finally {
			off();
		}
		notification("second");
		await deleteNotification(alice, "second");
		expect(events).toHaveLength(1);
	});

	test("validators use explicit scope and shared limits", () => {
		expect(notificationListQuerySchema.parse({}).limit).toBe(30);
		expect(notificationListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
		expect(notificationMarkReadSchema.safeParse({}).success).toBe(false);
		expect(notificationMarkReadSchema.safeParse({ scope: "items", ids: [] }).success).toBe(true);
		expect(
			notificationMarkReadSchema.safeParse({ scope: "items", ids: Array(500).fill("x") }).success,
		).toBe(true);
		expect(
			notificationMarkReadSchema.safeParse({ scope: "items", ids: [], kind: "chat_message" })
				.success,
		).toBe(false);
	});
});
