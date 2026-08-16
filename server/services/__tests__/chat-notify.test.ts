/**
 * chat-notify tests — WHO hears about a chat event, and how much work that costs.
 *
 * The fan-out is the only place two deliveries with different authorization
 * stories meet, so the properties worth pinning are:
 *
 * 1. **Room subscribers get the body; everyone else gets a count.** Pushing
 *    content to someone with the room closed would be data they never asked for.
 * 2. **The sender is never notified of their own message**, and neither is anyone
 *    currently viewing the room — they already have it.
 * 3. **Badge work is per ROOM, not per recipient's whole room list.** This ran
 *    `getUnreadSummary` per recipient, which probes every room that person
 *    belongs to and discards all but one number: O(members × rooms-per-member)
 *    synchronous SQLite queries for a single posted message.
 *
 * Delivery is asserted through `setChatNotifyChannel`, the injection point that
 * exists so this file never needs a live WebSocket server.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/chat-notify.test.ts
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { users } from "../../db/schema";
import { generateId } from "../../lib/id";
import type { NarratorServerMessage } from "../../websocket/narrator-ws-types";
import { chatNotifyTesting, setChatNotifyChannel } from "../chat-notify";
import { postMessage, resolveDmRoom } from "../chat-service";

interface Recorded {
	roomBroadcasts: Array<{ roomId: string; message: NarratorServerMessage }>;
	userBroadcasts: Array<{ userId: string; message: NarratorServerMessage }>;
}

/**
 * Install a recording channel. `viewing` stands in for the set of users who have
 * the room open, which the real implementation reads off live WS subscriptions.
 */
function record(viewing: string[] = []): Recorded {
	const recorded: Recorded = { roomBroadcasts: [], userBroadcasts: [] };
	setChatNotifyChannel({
		broadcastToChatRoom: (roomId, message) => {
			recorded.roomBroadcasts.push({ roomId, message });
		},
		broadcastToUser: (userId, message) => {
			recorded.userBroadcasts.push({ userId, message });
		},
		getChatRoomSubscriberUserIds: () => new Set(viewing),
	});
	return recorded;
}

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `notify-${label}-${generateId(6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

let alice: string;
let bob: string;

beforeAll(async () => {
	alice = await makeUser("alice");
	bob = await makeUser("bob");
});

afterEach(() => {
	setChatNotifyChannel(null);
});

describe("message fan-out", () => {
	test("subscribers get the row, absent members get a count", async () => {
		const room = await resolveDmRoom(alice, bob);
		const posted = await postMessage({ roomId: room.id, senderUserId: alice, text: "hello" });

		const recorded = record();
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: alice,
		});

		expect(recorded.roomBroadcasts).toHaveLength(1);
		const roomMessage = recorded.roomBroadcasts[0].message;
		expect(roomMessage.type).toBe("chat:message");
		// The body only goes to the room channel, whose members authorized at
		// subscribe time.
		if (roomMessage.type === "chat:message") {
			expect(roomMessage.message.contentText).toBe("hello");
			expect(roomMessage.message.sender?.id).toBe(alice);
		}

		// Bob is a member and not viewing, so he gets an id + count and no content.
		expect(recorded.userBroadcasts).toHaveLength(1);
		expect(recorded.userBroadcasts[0].userId).toBe(bob);
		const badge = recorded.userBroadcasts[0].message;
		expect(badge.type).toBe("chat:unread_changed");
		if (badge.type === "chat:unread_changed") {
			expect(badge.roomId).toBe(room.id);
			expect(badge.unread).toBe(1);
			expect(badge).not.toHaveProperty("message");
		}
	});

	test("the sender never gets a badge for their own message", async () => {
		const sender = await makeUser("self-sender");
		const peer = await makeUser("self-peer");
		const room = await resolveDmRoom(sender, peer);
		const posted = await postMessage({ roomId: room.id, senderUserId: sender, text: "mine" });

		const recorded = record();
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		expect(recorded.userBroadcasts.map((entry) => entry.userId)).toEqual([peer]);
	});

	test("someone currently viewing the room gets no badge", async () => {
		const sender = await makeUser("view-sender");
		const viewer = await makeUser("view-viewer");
		const room = await resolveDmRoom(sender, viewer);
		const posted = await postMessage({ roomId: room.id, senderUserId: sender, text: "seen" });

		const recorded = record([viewer]);
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		// They already received `chat:message` on the room channel and will mark it
		// read; a badge on top of that would flash a count for a room they are in.
		expect(recorded.roomBroadcasts).toHaveLength(1);
		expect(recorded.userBroadcasts).toHaveLength(0);
	});

	test("a deleted body is not resurrected by the fan-out", async () => {
		const sender = await makeUser("del-sender");
		const peer = await makeUser("del-peer");
		const room = await resolveDmRoom(sender, peer);
		const posted = await postMessage({ roomId: room.id, senderUserId: sender, text: "oops" });
		const { softDeleteMessage } = await import("../chat-service");
		await softDeleteMessage(room.id, posted.id, sender, false);

		const recorded = record();
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		const message = recorded.roomBroadcasts[0].message;
		if (message.type === "chat:message") {
			expect(message.message.contentText).toBe("");
			expect(message.message.deletedAt).toBeTruthy();
		}
	});

	test("a vanished message is dropped rather than broadcast", async () => {
		const room = await resolveDmRoom(alice, bob);
		const recorded = record();
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: "does-not-exist",
			seq: 1,
			senderUserId: alice,
		});
		expect(recorded.roomBroadcasts).toHaveLength(0);
		expect(recorded.userBroadcasts).toHaveLength(0);
	});
});

describe("badge cost is scoped to one room", () => {
	test("the badge reports THIS room's count, not the recipient's total", async () => {
		const sender = await makeUser("scope-sender");
		const recipient = await makeUser("scope-recipient");

		// The recipient also has unread messages in several OTHER rooms. A summary
		// over all their rooms would still produce the right number for the posted
		// room, so the assertion below is deliberately about the value being the
		// per-room count rather than anything aggregated.
		for (let i = 0; i < 4; i++) {
			const noise = await resolveDmRoom(recipient, await makeUser(`scope-noise-${i}`));
			const noiseSender = (noise.peer?.id ?? "") as string;
			for (let j = 0; j <= i; j++) {
				await postMessage({ roomId: noise.id, senderUserId: noiseSender, text: `n${i}-${j}` });
			}
		}

		const room = await resolveDmRoom(sender, recipient);
		await postMessage({ roomId: room.id, senderUserId: sender, text: "one" });
		const posted = await postMessage({ roomId: room.id, senderUserId: sender, text: "two" });

		const recorded = record();
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: posted.id,
			seq: posted.seq,
			senderUserId: sender,
		});

		expect(recorded.userBroadcasts).toHaveLength(1);
		const badge = recorded.userBroadcasts[0].message;
		if (badge.type === "chat:unread_changed") {
			// 2 = this room only. The noise rooms hold 10 more unread messages, so an
			// aggregate would read 12.
			expect(badge.unread).toBe(2);
			expect(badge.roomId).toBe(room.id);
		}
	});

	test("one batched unread lookup serves the whole fan-out", async () => {
		const sender = await makeUser("count-sender");
		const recipient = await makeUser("count-recipient");
		// Same shape as above: extra rooms that a whole-list probe would walk.
		for (let i = 0; i < 5; i++) {
			await resolveDmRoom(recipient, await makeUser(`count-noise-${i}`));
		}
		const room = await resolveDmRoom(sender, recipient);
		const posted = await postMessage({ roomId: room.id, senderUserId: sender, text: "probe me" });

		const calls: Array<{ roomId: string; exclude: string[] }> = [];
		const recorded = record();
		await chatNotifyTesting.onMessageCreated(
			{ roomId: room.id, messageId: posted.id, seq: posted.seq, senderUserId: sender },
			{
				listRoomUnread: async (roomId, exclude) => {
					calls.push({ roomId, exclude: [...exclude].sort() });
					return [{ userId: recipient, unread: 7 }];
				},
			},
		);

		// ONE lookup for the whole fan-out, scoped to this room — not one per member, and
		// not one per room each member belongs to. The sender is excluded before the
		// lookup rather than filtered out of its results.
		expect(calls).toEqual([{ roomId: room.id, exclude: [sender] }]);
		const badge = recorded.userBroadcasts[0].message;
		if (badge.type === "chat:unread_changed") expect(badge.unread).toBe(7);
	});

	test("the batched fan-out counts each member against their own watermark", async () => {
		// The real query, not the seam: one room, several members at different watermarks,
		// which is the case a single `GROUP BY room_id` cannot express.
		const sender = await makeUser("fanout-sender");
		const behind = await makeUser("fanout-behind");
		const room = await resolveDmRoom(sender, behind);

		await postMessage({ roomId: room.id, senderUserId: sender, text: "one" });
		await postMessage({ roomId: room.id, senderUserId: sender, text: "two" });
		const third = await postMessage({ roomId: room.id, senderUserId: sender, text: "three" });

		const recorded = record();
		await chatNotifyTesting.onMessageCreated({
			roomId: room.id,
			messageId: third.id,
			seq: third.seq,
			senderUserId: sender,
		});

		// The sender's own watermark advanced with each post, so they are not a recipient;
		// the peer has read nothing and owes all three.
		expect(recorded.userBroadcasts).toHaveLength(1);
		expect(recorded.userBroadcasts[0].userId).toBe(behind);
		const badge = recorded.userBroadcasts[0].message;
		if (badge.type === "chat:unread_changed") expect(badge.unread).toBe(3);
	});
});

describe("read receipts", () => {
	test("the room hears the receipt and the reader's own badge clears", async () => {
		const room = await resolveDmRoom(alice, bob);
		const recorded = record();
		await chatNotifyTesting.onRoomRead({ roomId: room.id, userId: bob, lastReadSeq: 3 });

		expect(recorded.roomBroadcasts).toHaveLength(1);
		const receipt = recorded.roomBroadcasts[0].message;
		expect(receipt.type).toBe("chat:read");
		if (receipt.type === "chat:read") {
			expect(receipt.userId).toBe(bob);
			expect(receipt.lastReadSeq).toBe(3);
		}

		// The reader may be reading in another tab that does not have this room
		// subscribed, so their badge is pushed directly too.
		expect(recorded.userBroadcasts).toHaveLength(1);
		expect(recorded.userBroadcasts[0].userId).toBe(bob);
		const cleared = recorded.userBroadcasts[0].message;
		if (cleared.type === "chat:unread_changed") expect(cleared.unread).toBe(0);
	});
});
