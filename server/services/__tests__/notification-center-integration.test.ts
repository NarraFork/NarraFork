/**
 * Notification center integration — DM fan-out → real recordNotifications →
 * listNotifications for the peer (task package F / C leftover).
 *
 * Unlike notification-fanout.test.ts (which injects a recording writer), this
 * file keeps production resolution: `setRecordNotifications(null)` so fan-out
 * calls B's real `recordNotifications`.
 *
 * DB path: tests/preload.ts points NARRAFORK_HOME at a temp directory and runs
 * the full Drizzle migration set (including 0181 notifications). Never touches
 * production `~/.narrafork/narrafork.db`.
 *
 * Run: bun test --isolate server/services/__tests__/notification-center-integration.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chatRoomMembers, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { postMessage, resolveDmRoom } from "../chat-service";
import {
	ensureNotificationsTableForTests,
	getUnreadCounts,
	listNotifications,
	markNotificationsRead,
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	onNotificationCenterChanged,
	recordNotifications,
} from "../notification-center-service";
import { fanoutChatMessageNotifications, setRecordNotifications } from "../notification-fanout";

// Same handle as production modules (preload temp home).
const { db: rawDb } = await import("../../db");
const sqlite = (rawDb as { $client?: { run(sql: string): unknown } }).$client;

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function setMemberFlag(
	roomId: string,
	userId: string,
	patch: { muted?: boolean; lastReadSeq?: number },
): Promise<void> {
	const all = await db.select().from(chatRoomMembers);
	const target = all.find((row) => row.roomId === roomId && row.userId === userId);
	if (!target) throw new Error("membership not found");
	await db.update(chatRoomMembers).set(patch).where(eq(chatRoomMembers.id, target.id));
}

beforeEach(async () => {
	// Production path: fan-out must call B's real recordNotifications.
	setRecordNotifications(null);
	if (sqlite) {
		try {
			ensureNotificationsTableForTests(sqlite);
		} catch {
			// Migration 0181 may already have created the table.
		}
	}
});

afterEach(() => {
	setRecordNotifications(null);
});

afterAll(() => {
	setRecordNotifications(null);
});

describe("DM fan-out → recordNotifications → listNotifications (real service)", () => {
	test("peer sees the projected row; sender is excluded; sourceKey dedupes", async () => {
		const sender = await makeUser("int-sender");
		const peer = await makeUser("int-peer");
		const room = await resolveDmRoom(sender, peer);

		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "integration hello body",
		});

		const event = {
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
			roomKind: "dm" as const,
		};

		await fanoutChatMessageNotifications(event);
		// Replay must not create a second row (unique userId+kind+sourceKey).
		await fanoutChatMessageNotifications(event);

		const peerPage = await listNotifications({ userId: peer, status: "all" });
		expect(peerPage.items).toHaveLength(1);
		const row = peerPage.items[0];
		expect(row.kind).toBe("chat_message");
		expect(row.sourceKey).toBe(posted.id);
		expect(row.link).toEqual({ type: "chat_room", roomId: room.id });
		expect(row.preview).toContain("integration hello body");
		expect(row.status).toBe("unread");
		expect(row.title.length).toBeGreaterThan(0);

		const senderPage = await listNotifications({ userId: sender, status: "all" });
		expect(senderPage.items).toHaveLength(0);

		const counts = await getUnreadCounts(peer);
		expect(counts.chat_message).toBe(1);
		expect(counts.total).toBeGreaterThanOrEqual(1);
	});

	test("long preview is truncated at write time to the shared max", async () => {
		const sender = await makeUser("int-trunc-sender");
		const peer = await makeUser("int-trunc-peer");
		const room = await resolveDmRoom(sender, peer);
		const long = "z".repeat(400);
		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: long,
		});

		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		const page = await listNotifications({ userId: peer, status: "all" });
		expect(page.items).toHaveLength(1);
		// Write-time clamp is ≤ shared max and keeps a visible ellipsis when truncated.
		expect(page.items[0].preview.length).toBeLessThanOrEqual(NOTIFICATION_PREVIEW_MAX_LENGTH);
		expect(page.items[0].preview.endsWith("…")).toBe(true);
		expect(page.items[0].preview.length).toBeLessThan(long.length);
		expect(page.items[0].preview).not.toBe(long);
	});

	test("muted peer gets no projected row even through the real writer", async () => {
		const sender = await makeUser("int-mute-sender");
		const peer = await makeUser("int-mute-peer");
		const room = await resolveDmRoom(sender, peer);
		await setMemberFlag(room.id, peer, { muted: true });

		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "muted should not see this",
		});
		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		const page = await listNotifications({ userId: peer, status: "all" });
		expect(page.items).toHaveLength(0);
	});

	test("markRead after integration write only moves the peer and fires change hook", async () => {
		const sender = await makeUser("int-read-sender");
		const peer = await makeUser("int-read-peer");
		const outsider = await makeUser("int-read-outsider");
		const room = await resolveDmRoom(sender, peer);

		const posted = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "mark me",
		});
		await fanoutChatMessageNotifications({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		// Unrelated unread for outsider — must survive peer markRead.
		await recordNotifications([
			{
				userId: outsider,
				kind: "chat_message",
				sourceKey: `other-${posted.id}`,
				title: "other",
				preview: "other",
				link: { type: "chat_room", roomId: "room-x" },
			},
		]);

		const events: Array<{ userId: string; kinds?: string[] }> = [];
		const off = onNotificationCenterChanged((e) => events.push(e));
		const result = await markNotificationsRead({ userId: peer });
		off();

		expect(result.updated).toBe(1);
		expect(events.some((e) => e.userId === peer)).toBe(true);

		const peerPage = await listNotifications({ userId: peer, status: "all" });
		expect(peerPage.items[0].status).toBe("read");
		expect(peerPage.items[0].readAt).not.toBeNull();

		const outsiderPage = await listNotifications({ userId: outsider, status: "all" });
		expect(outsiderPage.items[0].status).toBe("unread");
	});
});
