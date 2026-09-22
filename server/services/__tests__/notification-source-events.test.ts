import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	notifications,
	users,
} from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { markRead, postMessage, resolveDmRoom, softDeleteMessage } from "../chat-service";
import {
	getUnreadCounts,
	listNotifications,
	recordNotifications,
} from "../notification-center-service";
import {
	initNotificationFanout,
	notificationFanoutTesting,
	setRecordNotifications,
	stopNotificationFanout,
} from "../notification-fanout";

async function makeUser() {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `source-${id}`,
		passwordHash: "test",
		createdAt: new Date().toISOString(),
	});
	return id;
}

beforeEach(() => {
	setRecordNotifications(null);
	initNotificationFanout();
});

afterEach(async () => {
	await stopNotificationFanout();
	setRecordNotifications(null);
});

describe("committed source → activity writer → user invalidation", () => {
	test("source posts project without a WebSocket consumer and re-init does not duplicate listeners", async () => {
		const sender = await makeUser();
		const peer = await makeUser();
		const room = await resolveDmRoom(sender, peer);
		let writes = 0;
		setRecordNotifications(async (inputs) => {
			writes++;
			await recordNotifications(inputs);
		});
		initNotificationFanout();
		initNotificationFanout();
		const events: unknown[] = [];
		const listener = (event: { userId: string }) => {
			if (event.userId === peer) events.push(event);
		};
		eventBus.on("notification_center_changed", listener);
		try {
			await postMessage({ roomId: room.id, senderUserId: sender, text: "private body" });
			await notificationFanoutTesting.drain();
			expect(writes).toBe(1);
			const page = await listNotifications({ userId: peer });
			expect(page.items).toHaveLength(1);
			expect(page.items[0].preview).toBe("private body");
			expect(events).toHaveLength(1);
			expect(JSON.stringify(events)).not.toContain("private body");
			expect(await getUnreadCounts(peer)).toMatchObject({ unreadConversations: 1 });
		} finally {
			eventBus.off("notification_center_changed", listener);
		}
	});

	test("partial reading and sending synchronize only the committed source watermark", async () => {
		const sender = await makeUser();
		const peer = await makeUser();
		const room = await resolveDmRoom(sender, peer);
		const first = await postMessage({ roomId: room.id, senderUserId: sender, text: "first" });
		await notificationFanoutTesting.drain();
		await postMessage({ roomId: room.id, senderUserId: sender, text: "second" });
		await notificationFanoutTesting.drain();
		expect((await listNotifications({ userId: peer })).items[0].groupSize).toBe(2);
		await markRead(room.id, peer, first.seq);
		await notificationFanoutTesting.drain();
		expect((await getUnreadCounts(peer)).unreadConversations).toBe(1);
		const partial = await db
			.select({ status: notifications.status })
			.from(notifications)
			.where(eq(notifications.userId, peer));
		expect(partial.filter((row) => row.status === "read")).toHaveLength(1);

		await postMessage({
			roomId: room.id,
			senderUserId: peer,
			text: "reply reads earlier messages",
		});
		await notificationFanoutTesting.drain();
		expect((await getUnreadCounts(peer)).unreadConversations).toBe(0);
		const stored = await db
			.select({ status: notifications.status })
			.from(notifications)
			.where(eq(notifications.userId, peer));
		expect(stored.every((row) => row.status === "read")).toBe(true);
		expect((await listNotifications({ userId: peer })).items[0].readAt).not.toBeNull();
	});

	test("message deletion invalidates unopened recipients and never returns the deleted preview", async () => {
		const sender = await makeUser();
		const peer = await makeUser();
		const room = await resolveDmRoom(sender, peer);
		const message = await postMessage({
			roomId: room.id,
			senderUserId: sender,
			text: "withdrawn secret",
		});
		await notificationFanoutTesting.drain();
		const changed: string[] = [];
		const listener = (event: { userId: string }) => changed.push(event.userId);
		eventBus.on("notification_center_changed", listener);
		try {
			await softDeleteMessage(room.id, message.id, sender, false);
			await notificationFanoutTesting.drain();
			expect(changed).toContain(peer);
			const page = await listNotifications({ userId: peer });
			expect(JSON.stringify(page)).not.toContain("withdrawn secret");
			expect((await getUnreadCounts(peer)).unreadConversations).toBe(0);
		} finally {
			eventBus.off("notification_center_changed", listener);
		}
	});

	test("permission offers pass through the registered real writer and stopped listeners stay silent", async () => {
		const owner = await makeUser();
		const narratorId = generateId();
		const messageId = generateId();
		const requestId = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: narratorId,
			ownerUserId: owner,
			visibility: "private",
			title: "Needs review",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id: requestId,
			narratorId,
			messageId,
			toolUseId: generateId(),
			toolName: "Bash",
			status: "pending",
			createdAt: now,
		});
		eventBus.emit({ type: "narrator:permission_request", narratorId, requestId });
		await notificationFanoutTesting.drain();
		expect((await listNotifications({ userId: owner })).items).toHaveLength(1);
		const stored = await db
			.select({ id: notifications.id })
			.from(notifications)
			.where(eq(notifications.userId, owner));
		await db.delete(notifications).where(eq(notifications.id, stored[0].id));
		await stopNotificationFanout();
		eventBus.emit({ type: "narrator:permission_request", narratorId, requestId });
		await notificationFanoutTesting.drain();
		expect((await listNotifications({ userId: owner })).items).toHaveLength(0);
	});
});
