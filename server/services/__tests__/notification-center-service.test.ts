/**
 * Notification center service tests — Phase 1 / task package B.
 *
 * Properties locked by docs/plans/notification-center-phase1.md §4 / §8.2:
 * 1. insert dedupes on (userId, kind, sourceKey)
 * 2. list walks with a keyset cursor without gaps/repeats
 * 3. markRead only touches the caller and is monotonic on readAt
 * 4. preview/title clamp at write time
 * 5. unread counts are capped (LIMIT cap+1, never bare COUNT)
 * 6. displayStatus: resolved when permission decided; gone when ACL denies
 * 7. delete of a foreign/missing row is 404
 *
 * The `notifications` table is created in-test (package A has not yet shipped
 * the Drizzle migration). Source tables used by displayStatus (narrators,
 * narrator_tool_calls, chat_rooms, chat_room_members) come from the normal
 * migration set via getTestDb().
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	chatRoomMembers,
	chatRooms,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { NotFoundError, ValidationError } from "../../lib/errors";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));

const {
	clampNotificationText,
	decodeNotificationCursor,
	deleteNotification,
	encodeNotificationCursor,
	ensureNotificationsTableForTests,
	getUnreadCounts,
	listNotifications,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	NOTIFICATION_UNREAD_COUNT_CAP,
	onNotificationCenterChanged,
	recordNotifications,
} = await import("../notification-center-service");

const { notificationListQuerySchema, notificationMarkReadSchema } = await import(
	"../../lib/validators/notifications"
);

const nowIso = "2026-09-21T00:00:00.000Z";
let alice: string;
let bob: string;
let baseTime = 1_700_000_000_000;

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: nowIso,
	});
	return id;
}

async function insertNotificationRow(values: {
	id: string;
	userId: string;
	kind: string;
	sourceKey: string;
	title?: string;
	preview?: string;
	link?: unknown;
	status?: string;
	createdAt: number;
	readAt?: number | null;
	narratorId?: string | null;
	projectId?: string | null;
	chapterId?: string | null;
}) {
	sqlite.run(
		`INSERT INTO notifications (
			id, user_id, kind, project_id, chapter_id, narrator_id,
			title, preview, link_json, source_key, status, created_at, read_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			values.id,
			values.userId,
			values.kind,
			values.projectId ?? null,
			values.chapterId ?? null,
			values.narratorId ?? null,
			values.title ?? "t",
			values.preview ?? "p",
			JSON.stringify(values.link ?? { type: "narrator", narratorId: "n" }),
			values.sourceKey,
			values.status ?? "unread",
			values.createdAt,
			values.readAt ?? null,
		],
	);
}

function chatInput(userId: string, sourceKey: string, preview: string, createdAt?: number) {
	return {
		userId,
		kind: "chat_message" as const,
		sourceKey,
		title: "New message",
		preview,
		link: { type: "chat_room" as const, roomId: "room-missing" },
		createdAt: createdAt ?? baseTime++,
	};
}

beforeEach(async () => {
	cleanDb(sqlite);
	ensureNotificationsTableForTests(sqlite);
	alice = await makeUser("nc-alice");
	bob = await makeUser("nc-bob");
	baseTime = 1_700_000_000_000;
});

afterAll(() => {
	mock.restore();
	mock.module("../../db", () => realDb);
	cleanDb(sqlite);
});

describe("pure helpers", () => {
	test("clamps preview to the shared max length and keeps ellipsis", () => {
		const long = "x".repeat(NOTIFICATION_PREVIEW_MAX_LENGTH + 40);
		const clamped = clampNotificationText(long, NOTIFICATION_PREVIEW_MAX_LENGTH);
		expect(clamped).toHaveLength(NOTIFICATION_PREVIEW_MAX_LENGTH);
		expect(clamped.endsWith("…")).toBe(true);
		expect(clampNotificationText("ok", NOTIFICATION_PREVIEW_MAX_LENGTH)).toBe("ok");
		expect(clampNotificationText(undefined, NOTIFICATION_PREVIEW_MAX_LENGTH)).toBe("");
	});

	test("cursor round-trips and rejects garbage", () => {
		const cursor = encodeNotificationCursor(1_700_000_000_123, "abcDEF_123");
		expect(decodeNotificationCursor(cursor)).toEqual({
			createdAt: 1_700_000_000_123,
			id: "abcDEF_123",
		});
		for (const bad of ["", "!!!", "a".repeat(600), Buffer.from("no-sep").toString("base64url")]) {
			expect(() => decodeNotificationCursor(bad)).toThrow(ValidationError);
		}
	});
});

describe("recordNotifications dedupe + clamp", () => {
	test("duplicate (userId, kind, sourceKey) inserts only once", async () => {
		const longPreview = "y".repeat(500);
		await recordNotifications([
			chatInput(alice, "msg-1", longPreview, baseTime),
			chatInput(alice, "msg-1", "second-should-ignored", baseTime + 1),
		]);

		const page = await listNotifications({ userId: alice, status: "all" });
		expect(page.items).toHaveLength(1);
		expect(page.items[0].sourceKey).toBe("msg-1");
		expect(page.items[0].preview).toHaveLength(NOTIFICATION_PREVIEW_MAX_LENGTH);
		expect(page.items[0].status).toBe("unread");
	});

	test("failure inside record does not throw to the caller", async () => {
		// Drop the table to force a storage error.
		sqlite.run("DROP TABLE notifications");
		await expect(recordNotifications([chatInput(alice, "boom", "x")])).resolves.toBeUndefined();
		ensureNotificationsTableForTests(sqlite);
	});

	test("empty ids path is a no-op markRead", async () => {
		const result = await (await import("../notification-center-service")).markNotificationsRead({
			userId: alice,
			ids: [],
		});
		expect(result.updated).toBe(0);
	});
});

describe("list cursor pagination", () => {
	test("walks all rows without gaps or repeats", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const id = `n-${i}-${generateId(6)}`;
			ids.push(id);
			await insertNotificationRow({
				id,
				userId: alice,
				kind: "chat_message",
				sourceKey: `src-${i}`,
				link: { type: "chat_room", roomId: "room-x" },
				createdAt: baseTime + i,
			});
		}

		const seen: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 5; page++) {
			const result = await listNotifications({
				userId: alice,
				status: "all",
				limit: 2,
				cursor,
			});
			for (const item of result.items) seen.push(item.id);
			cursor = result.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
		// Newest first
		expect(seen[0]).toBe(ids[4]);
		expect(seen[seen.length - 1]).toBe(ids[0]);
	});

	test("status=unread filters and list never returns another user's rows", async () => {
		await insertNotificationRow({
			id: "own-unread",
			userId: alice,
			kind: "chat_message",
			sourceKey: "a1",
			createdAt: baseTime + 1,
			status: "unread",
		});
		await insertNotificationRow({
			id: "own-read",
			userId: alice,
			kind: "chat_message",
			sourceKey: "a2",
			createdAt: baseTime + 2,
			status: "read",
			readAt: baseTime + 2,
		});
		await insertNotificationRow({
			id: "bob-row",
			userId: bob,
			kind: "chat_message",
			sourceKey: "b1",
			createdAt: baseTime + 3,
		});

		const unread = await listNotifications({ userId: alice, status: "unread" });
		expect(unread.items.map((i) => i.id)).toEqual(["own-unread"]);
		const all = await listNotifications({ userId: alice, status: "all" });
		expect(all.items.map((i) => i.id).sort()).toEqual(["own-read", "own-unread"]);
	});
});

describe("unread counts are capped", () => {
	test("hits cap and sets lowerBound", async () => {
		const cap = NOTIFICATION_UNREAD_COUNT_CAP;
		for (let i = 0; i < cap + 15; i++) {
			await insertNotificationRow({
				id: `u-${i}`,
				userId: alice,
				kind: i % 2 === 0 ? "chat_message" : "permission_request",
				sourceKey: `s-${i}`,
				createdAt: baseTime + i,
			});
		}
		const counts = await getUnreadCounts(alice);
		expect(counts.total).toBe(cap);
		expect(counts.lowerBound).toBe(true);
		expect(counts.chat_message).toBeLessThanOrEqual(cap);
		expect(counts.permission_request).toBeLessThanOrEqual(cap);
	});
});

describe("markRead ownership + monotonic readAt", () => {
	test("only updates the caller's unread rows and preserves first readAt", async () => {
		const t1 = baseTime + 10;
		await insertNotificationRow({
			id: "m-alice",
			userId: alice,
			kind: "chat_message",
			sourceKey: "m1",
			createdAt: t1,
		});
		await insertNotificationRow({
			id: "m-bob",
			userId: bob,
			kind: "chat_message",
			sourceKey: "m2",
			createdAt: t1,
		});

		const first = await (await import("../notification-center-service")).markNotificationsRead({
			userId: alice,
			ids: ["m-alice", "m-bob"],
		});
		expect(first.updated).toBe(1);

		const aliceRows = sqlite
			.query("SELECT status, read_at FROM notifications WHERE id = 'm-alice'")
			.all() as Array<{ status: string; read_at: number }>;
		const bobRows = sqlite
			.query("SELECT status, read_at FROM notifications WHERE id = 'm-bob'")
			.all() as Array<{ status: string; read_at: number }>;
		expect(aliceRows[0].status).toBe("read");
		expect(aliceRows[0].read_at).toBeGreaterThan(0);
		expect(bobRows[0].status).toBe("unread");
		expect(bobRows[0].read_at).toBeNull();

		const firstReadAt = aliceRows[0].read_at;
		// Second mark must not move readAt (row already read → filtered out).
		const second = await (await import("../notification-center-service")).markNotificationsRead({
			userId: alice,
			ids: ["m-alice"],
		});
		expect(second.updated).toBe(0);
		const again = sqlite
			.query("SELECT read_at FROM notifications WHERE id = 'm-alice'")
			.all() as Array<{ read_at: number }>;
		expect(again[0].read_at).toBe(firstReadAt);
	});
});

describe("displayStatus derivation", () => {
	test("permission_request: resolved when tool call decided; gone when not readable", async () => {
		const narratorId = "narr-own";
		await db.insert(narrators).values({
			id: narratorId,
			ownerUserId: alice,
			visibility: "private",
			writeAudience: "owner",
			title: "Own narrator",
			createdAt: nowIso,
			updatedAt: nowIso,
		});
		await db.insert(narratorMessages).values({
			id: `msg-${narratorId}`,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: nowIso,
		});
		await db.insert(narratorToolCalls).values({
			id: "tool-pending",
			narratorId,
			messageId: `msg-${narratorId}`,
			toolUseId: "tu-pending",
			toolName: "Bash",
			status: "pending",
			createdAt: nowIso,
		});
		await db.insert(narratorToolCalls).values({
			id: "tool-done",
			narratorId,
			messageId: `msg-${narratorId}`,
			toolUseId: "tu-done",
			toolName: "Bash",
			status: "success",
			permissionDecidedBy: alice,
			permissionDecidedAt: nowIso,
			createdAt: nowIso,
		});

		await insertNotificationRow({
			id: "perm-pending",
			userId: alice,
			kind: "permission_request",
			sourceKey: "tool-pending",
			narratorId,
			link: { type: "narrator", narratorId },
			createdAt: baseTime + 1,
		});
		await insertNotificationRow({
			id: "perm-done",
			userId: alice,
			kind: "permission_request",
			sourceKey: "tool-done",
			narratorId,
			link: { type: "narrator", narratorId },
			createdAt: baseTime + 2,
		});
		// Bob is not owner of a private narrator → gone even if tool is pending.
		await insertNotificationRow({
			id: "perm-bob",
			userId: bob,
			kind: "permission_request",
			sourceKey: "tool-pending",
			narratorId,
			link: { type: "narrator", narratorId },
			createdAt: baseTime + 3,
		});
		// Missing tool call → gone.
		await insertNotificationRow({
			id: "perm-missing",
			userId: alice,
			kind: "permission_request",
			sourceKey: "tool-missing",
			narratorId,
			link: { type: "narrator", narratorId },
			createdAt: baseTime + 4,
		});

		const alicePage = await listNotifications({ userId: alice, status: "all", limit: 50 });
		const byId = Object.fromEntries(alicePage.items.map((i) => [i.id, i]));
		expect(byId["perm-pending"]?.displayStatus).toBe("unread");
		expect(byId["perm-pending"]?.sourceAlive).toBe(true);
		expect(byId["perm-done"]?.displayStatus).toBe("resolved");
		// M1: narrator still readable → resolved stays navigable (sourceAlive true).
		expect(byId["perm-done"]?.sourceAlive).toBe(true);
		expect(byId["perm-missing"]?.displayStatus).toBe("gone");

		const bobPage = await listNotifications({ userId: bob, status: "all", limit: 50 });
		const bobBy = Object.fromEntries(bobPage.items.map((i) => [i.id, i]));
		expect(bobBy["perm-bob"]?.displayStatus).toBe("gone");
	});

	test("chat_message: gone when room membership is missing", async () => {
		const roomId = "room-dm-1";
		await db.insert(chatRooms).values({
			id: roomId,
			kind: "dm",
			dmKey: `${alice}:${bob}`,
			createdAt: nowIso,
		});
		await db.insert(chatRoomMembers).values({
			id: generateId(),
			roomId,
			userId: alice,
			lastReadSeq: 0,
			joinedAt: nowIso,
		});

		await insertNotificationRow({
			id: "chat-alice",
			userId: alice,
			kind: "chat_message",
			sourceKey: "chat-1",
			link: { type: "chat_room", roomId },
			createdAt: baseTime + 1,
		});
		await insertNotificationRow({
			id: "chat-bob",
			userId: bob,
			kind: "chat_message",
			sourceKey: "chat-1",
			link: { type: "chat_room", roomId },
			createdAt: baseTime + 1,
		});

		const alicePage = await listNotifications({ userId: alice, status: "all" });
		const aliceItem = alicePage.items.find((i) => i.id === "chat-alice");
		// Room exists but alice has no ACL source for gone — membership present
		// so displayStatus keeps the persistent status; gone path is covered by bob.
		// Note: room kind dm + membership → readable → unread.
		expect(aliceItem?.displayStatus).toBe("unread");

		const bobPage = await listNotifications({ userId: bob, status: "all" });
		const bobItem = bobPage.items.find((i) => i.id === "chat-bob");
		expect(bobItem?.displayStatus).toBe("gone");
	});
});

describe("delete ownership", () => {
	test("foreign and missing notifications both 404", async () => {
		await insertNotificationRow({
			id: "del-own",
			userId: alice,
			kind: "chat_message",
			sourceKey: "d1",
			createdAt: baseTime,
		});

		const service = await import("../notification-center-service");
		await expect(service.deleteNotification(bob, "del-own")).rejects.toBeInstanceOf(NotFoundError);
		await expect(service.deleteNotification(alice, "no-such-id")).rejects.toBeInstanceOf(
			NotFoundError,
		);

		await service.deleteNotification(alice, "del-own");
		const rows = sqlite.query("SELECT id FROM notifications WHERE id = 'del-own'").all();
		expect(rows).toHaveLength(0);
	});
});

describe("change hook", () => {
	test("record + delete notify subscribers without throwing", async () => {
		const events: Array<{ userId: string }> = [];
		const off = onNotificationCenterChanged((e) => {
			events.push({ userId: e.userId });
		});
		await recordNotifications([chatInput(alice, "hook-1", "hello")]);
		await deleteNotification(alice, (await listNotifications({ userId: alice })).items[0].id);
		off();
		expect(events.some((e) => e.userId === alice)).toBe(true);
	});
});

describe("validators", () => {
	test("list query bounds limit and kind", () => {
		expect(notificationListQuerySchema.parse({}).limit).toBe(30);
		expect(notificationListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
		expect(notificationListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
		expect(notificationListQuerySchema.safeParse({ kind: "nope" }).success).toBe(false);
		expect(
			notificationListQuerySchema.parse({ kind: "permission_request", status: "unread" }),
		).toMatchObject({ kind: "permission_request", status: "unread" });
	});

	test("mark-read body accepts empty (mark-all) and bounds ids", () => {
		expect(notificationMarkReadSchema.parse({})).toEqual({});
		expect(notificationMarkReadSchema.safeParse({ before: -1 }).success).toBe(false);
		expect(
			notificationMarkReadSchema.safeParse({
				ids: Array.from({ length: 201 }, (_, i) => `id-${i}`),
			}).success,
		).toBe(false);
		expect(notificationMarkReadSchema.safeParse({ ids: [] }).success).toBe(true);
	});
});
