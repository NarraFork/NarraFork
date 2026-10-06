/** Public capabilities never turn into users or narrator writes. tests/preload.ts isolates this DB. */
import { describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import {
	chatAttachments,
	chatMessages,
	chatRoomMembers,
	chatRooms,
	narratorMessages,
	narratorPublicShares,
	narrators,
	users,
} from "../../db/schema";
import { eventBus, type NarraForkEvent } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { chatNotifyTesting, setChatNotifyChannel } from "../chat-notify";
import {
	ensureNarratorDiscussionRoomForShare,
	hydrateMessageForBroadcast,
	listMessages,
	listPublicDiscussion,
	postMessage,
	postPublicDiscussion,
	resolveDmRoom,
	resolveNarratorRoom,
	softDeleteMessage,
} from "../chat-service";
import { PUBLIC_SHARE_LIMITS } from "../public-narrator-share-limits";

const timestamp = () => new Date().toISOString();

async function fixture(createRoom = true) {
	const owner = generateId();
	const narratorId = generateId();
	await db.insert(users).values({
		id: owner,
		username: `public-discussion-${generateId()}`,
		passwordHash: "x",
		role: "user",
		createdAt: timestamp(),
	});
	await db.insert(narrators).values({
		id: narratorId,
		title: "Shared discussion",
		ownerUserId: owner,
		visibility: "private",
		type: "primary",
		createdAt: timestamp(),
		updatedAt: timestamp(),
	});
	const shareId = generateId();
	const tokenHash = generateId(64);
	await db.insert(narratorPublicShares).values({
		id: shareId,
		narratorId,
		tokenHash,
		guestName: "固定访客",
		createdByUserId: owner,
		createdAt: timestamp(),
	});
	const roomId = createRoom ? await ensureNarratorDiscussionRoomForShare(narratorId) : "";
	return { owner, narratorId, roomId, shareId, tokenHash };
}

function writeIsolationSnapshot() {
	return {
		users: db.select({ count: sql<number>`count(*)` }).from(users).get()?.count,
		members: db.select({ count: sql<number>`count(*)` }).from(chatRoomMembers).get()?.count,
		narratorMessages: db.select({ count: sql<number>`count(*)` }).from(narratorMessages).get()
			?.count,
	};
}

describe("public discussion authorization and isolation", () => {
	test("creation shares the existing room and never enrolls guests", async () => {
		const f = await fixture(false);
		const before = writeIsolationSnapshot();
		const rooms = await Promise.all(
			Array.from({ length: 8 }, () => ensureNarratorDiscussionRoomForShare(f.narratorId)),
		);
		expect(new Set(rooms).size).toBe(1);
		expect(writeIsolationSnapshot()).toEqual(before);
		expect((await resolveNarratorRoom(f.narratorId, f.owner)).id).toBe(rooms[0]);
	});

	test("public GET does not lazily create a missing discussion", async () => {
		const f = await fixture(false);
		await expect(listPublicDiscussion(f)).rejects.toMatchObject({
			code: "PUBLIC_SHARE_UNAVAILABLE",
		});
		expect(
			db.select().from(chatRooms).where(eq(chatRooms.narratorId, f.narratorId)).get(),
		).toBeUndefined();
	});

	test("valid hash works; wrong hash/id, revocation, subagent and missing narrator do not", async () => {
		const f = await fixture();
		expect(await listPublicDiscussion(f)).toEqual({
			messages: [],
			hasMore: false,
			nextBeforeSeq: null,
		});
		for (const bad of [
			{ ...f, tokenHash: "wrong" },
			{ ...f, shareId: "unknown" },
		]) {
			await expect(listPublicDiscussion(bad)).rejects.toMatchObject({
				code: "PUBLIC_SHARE_UNAVAILABLE",
			});
			await expect(postPublicDiscussion({ ...bad, text: "bad" })).rejects.toMatchObject({
				code: "PUBLIC_SHARE_UNAVAILABLE",
			});
		}
		await db.update(narrators).set({ type: "subagent" }).where(eq(narrators.id, f.narratorId));
		await expect(listPublicDiscussion(f)).rejects.toThrow();
		await expect(postPublicDiscussion({ ...f, text: "bad" })).rejects.toThrow();
		await expect(ensureNarratorDiscussionRoomForShare(f.narratorId)).rejects.toThrow();
		await db.update(narrators).set({ type: "primary" }).where(eq(narrators.id, f.narratorId));
		await db
			.update(narratorPublicShares)
			.set({ revokedAt: timestamp() })
			.where(eq(narratorPublicShares.id, f.shareId));
		await expect(listPublicDiscussion(f)).rejects.toThrow();
		await expect(postPublicDiscussion({ ...f, text: "bad" })).rejects.toThrow();
		await db.delete(narrators).where(eq(narrators.id, f.narratorId));
		await expect(listPublicDiscussion(f)).rejects.toThrow();
	});

	test("forged identity/room/kind/attachments are ignored; only chat rows and room tail change", async () => {
		const f = await fixture();
		const before = writeIsolationSnapshot();
		const narratorBefore = db.select().from(narrators).where(eq(narrators.id, f.narratorId)).get();
		const forged = {
			...f,
			roomId: "forged-room",
			senderUserId: f.owner,
			guestName: "imposter",
			kind: "system",
			attachmentIds: ["secret"],
			text: "  hello guest  ",
		};
		const posted = await postPublicDiscussion(forged);
		expect(writeIsolationSnapshot()).toEqual(before);
		expect(db.select().from(narrators).where(eq(narrators.id, f.narratorId)).get()).toEqual(
			narratorBefore,
		);
		expect(posted.author).toEqual({ name: "固定访客", isGuest: true, isSelf: true });
		expect(posted.hasAttachments).toBe(false);
		const row = db.select().from(chatMessages).where(eq(chatMessages.id, posted.id)).get();
		expect(row).toMatchObject({
			roomId: f.roomId,
			senderUserId: null,
			senderShareId: f.shareId,
			senderGuestName: "固定访客",
			kind: "text",
			contentText: "hello guest",
		});
		expect(db.select().from(chatRooms).where(eq(chatRooms.id, f.roomId)).get()).toMatchObject({
			nextSeq: 2,
			lastMessagePreview: "hello guest",
			lastMessageSenderId: null,
		});
		// A share id never authenticates the ordinary station-internal send path.
		await expect(
			postMessage({ roomId: f.roomId, senderUserId: f.shareId, text: "not a user" }),
		).rejects.toThrow();
	});

	test("same-room replies only: DM, another narrator and missing ids are rejected atomically", async () => {
		const f = await fixture();
		const other = await fixture();
		const foreign = await postPublicDiscussion({ ...other, text: "other room" });
		const dm = await resolveDmRoom(f.owner, other.owner);
		const privateMessage = await postMessage({
			roomId: dm.id,
			senderUserId: f.owner,
			text: "private DM",
		});
		for (const replyToMessageId of [foreign.id, privateMessage.id, "does-not-exist"]) {
			await expect(postPublicDiscussion({ ...f, text: "reply", replyToMessageId })).rejects.toThrow(
				"not in this room",
			);
		}
		expect((await listPublicDiscussion(f)).messages).toEqual([]);
		expect(db.select().from(chatRooms).where(eq(chatRooms.id, f.roomId)).get()?.nextSeq).toBe(1);
	});

	test("transactions recheck revocation and a changed room before writing", async () => {
		for (const mutate of ["revoke", "room"] as const) {
			const f = await fixture();
			const transaction = db.transaction.bind(db);
			const intercepted = spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
				if (mutate === "revoke")
					db.update(narratorPublicShares)
						.set({ revokedAt: timestamp() })
						.where(eq(narratorPublicShares.id, f.shareId))
						.run();
				else {
					db.delete(chatRooms).where(eq(chatRooms.id, f.roomId)).run();
					db.insert(chatRooms)
						.values({
							id: generateId(),
							kind: "narrator",
							narratorId: f.narratorId,
							createdAt: timestamp(),
						})
						.run();
				}
				return transaction(callback, config);
			});
			try {
				await expect(postPublicDiscussion({ ...f, text: "too late" })).rejects.toThrow();
			} finally {
				intercepted.mockRestore();
			}
			expect(
				db
					.select({ id: chatMessages.id })
					.from(chatMessages)
					.where(eq(chatMessages.senderShareId, f.shareId))
					.all(),
			).toEqual([]);
		}
	});

	test("concurrent guests and normal users share a contiguous seq allocator", async () => {
		const f = await fixture();
		const messages = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				i % 2
					? postMessage({ roomId: f.roomId, senderUserId: f.owner, text: `user-${i}` })
					: postPublicDiscussion({ ...f, text: `guest-${i}` }),
			),
		);
		expect(messages.map((m) => m.seq).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 20 }, (_, i) => i + 1),
		);
	});

	test("revoking one link preserves names and leaves another link operational", async () => {
		const f = await fixture();
		const b = { shareId: generateId(), tokenHash: generateId(64) };
		await db.insert(narratorPublicShares).values({
			id: b.shareId,
			tokenHash: b.tokenHash,
			narratorId: f.narratorId,
			guestName: "另一访客",
			createdByUserId: f.owner,
			createdAt: timestamp(),
		});
		const first = await postPublicDiscussion({ ...f, text: "first identity" });
		await db
			.update(narratorPublicShares)
			.set({ revokedAt: timestamp() })
			.where(eq(narratorPublicShares.id, f.shareId));
		const second = await postPublicDiscussion({
			...b,
			text: "second identity",
			replyToMessageId: first.id,
		});
		expect(second.replyTo?.name).toBe("固定访客");
		const page = await listPublicDiscussion(b);
		expect(page.messages.map((m) => m.author)).toEqual([
			{ name: "固定访客", isGuest: true, isSelf: false },
			{ name: "另一访客", isGuest: true, isSelf: true },
		]);
		await db.delete(narratorPublicShares).where(eq(narratorPublicShares.id, f.shareId));
		expect(
			(await listMessages({ roomId: f.roomId, userId: f.owner })).messages[0].sender,
		).toMatchObject({ username: "固定访客", isGuest: true });
	});
});

describe("public projection and live identity", () => {
	test("REST, broadcast hydration and quote snapshots agree on guest identity", async () => {
		const f = await fixture();
		const guest = await postPublicDiscussion({ ...f, text: "guest original" });
		const reply = await postMessage({
			roomId: f.roomId,
			senderUserId: f.owner,
			text: "answer",
			replyToMessageId: guest.id,
		});
		const page = await listMessages({ roomId: f.roomId, userId: f.owner });
		const stored = db.select().from(chatMessages).where(eq(chatMessages.id, guest.id)).get();
		if (!stored) throw new Error("fixture vanished");
		const hydrated = await hydrateMessageForBroadcast(stored);
		expect(hydrated).toEqual(page.messages[0]);
		expect(reply.replyToSender).toEqual(hydrated.sender);
		expect(reply).toEqual(page.messages[1]);
		expect(hydrated.sender).toEqual({
			id: `guest:${guest.id}`,
			username: "固定访客",
			avatarColor: null,
			avatarImageId: null,
			isGuest: true,
		});
		const broadcasts: unknown[] = [];
		const badges: string[] = [];
		setChatNotifyChannel({
			broadcastToChatRoom: (_room, message) => broadcasts.push(message),
			broadcastToUser: (user) => badges.push(user),
			getChatRoomSubscriberUserIds: () => new Set(),
		});
		try {
			await chatNotifyTesting.onMessageCreated(
				{ roomId: f.roomId, messageId: guest.id, seq: guest.seq, senderUserId: null },
				{
					listRoomUnread: async (_room, exclude) => {
						expect([...exclude]).toEqual([]);
						return [{ userId: f.owner, unread: 1 }];
					},
				},
			);
			expect(broadcasts).toEqual([{ type: "chat:message", roomId: f.roomId, message: hydrated }]);
			expect(badges).toEqual([f.owner]);
		} finally {
			setChatNotifyChannel(null);
		}
	});

	test("public DTOs omit user, avatar, room, link and attachment identities", async () => {
		const f = await fixture();
		const original = await postMessage({
			roomId: f.roomId,
			senderUserId: f.owner,
			text: "member text",
		});
		await db.insert(chatAttachments).values({
			id: generateId(),
			roomId: f.roomId,
			messageId: original.id,
			uploaderUserId: f.owner,
			kind: "file",
			filename: "sensitive-filename",
			storedName: "hidden-disk-path",
			mediaType: "text/plain",
			sizeBytes: 12,
			createdAt: timestamp(),
		});
		await postPublicDiscussion({ ...f, text: "guest reply", replyToMessageId: original.id });
		const page = await listPublicDiscussion(f);
		expect(page.messages[0].hasAttachments).toBe(true);
		const json = JSON.stringify(page);
		for (const secret of [
			f.owner,
			f.roomId,
			f.shareId,
			f.tokenHash,
			"sensitive-filename",
			"hidden-disk-path",
			"avatar",
			"senderUserId",
		])
			expect(json).not.toContain(secret);
		expect(Object.keys(page.messages[0]).sort()).toEqual(
			["id", "seq", "text", "author", "createdAt", "deletedAt", "replyTo", "hasAttachments"].sort(),
		);
	});

	test("body, cursor and response budgets hold without pagination gaps", async () => {
		const f = await fixture();
		for (const text of ["", " ", "x".repeat(PUBLIC_SHARE_LIMITS.discussionChars + 1)])
			await expect(postPublicDiscussion({ ...f, text })).rejects.toThrow();
		await expect(listPublicDiscussion({ ...f, beforeSeq: -1 })).rejects.toThrow();
		await expect(listPublicDiscussion({ ...f, limit: Number.NaN })).rejects.toThrow();
		for (let i = 0; i < 30; i++) await postPublicDiscussion({ ...f, text: "\u0001".repeat(8000) });
		const first = await listPublicDiscussion({ ...f, limit: 100 });
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
			PUBLIC_SHARE_LIMITS.responseBytes,
		);
		expect(first.hasMore).toBe(true);
		expect(first.messages.length).toBeLessThan(30);
		const second = await listPublicDiscussion({
			...f,
			beforeSeq: first.nextBeforeSeq ?? undefined,
			limit: 100,
		});
		expect([...second.messages, ...first.messages].map((m) => m.seq)).toEqual(
			Array.from({ length: 30 }, (_, i) => i + 1),
		);
		const latest = first.messages.at(-1);
		if (!latest) throw new Error("missing fixture");
		await db
			.update(chatMessages)
			.set({ contentText: "z".repeat(100_000) })
			.where(eq(chatMessages.id, latest.id));
		const bounded = (await listPublicDiscussion({ ...f, limit: 1 })).messages[0];
		expect(bounded.text).toEndWith("[Content truncated]");
		expect(bounded.text.length).toBeLessThan(8100);
	});

	test("service deletion emits exactly one bus event, including narrator routing", async () => {
		const f = await fixture();
		const guest = await postPublicDiscussion({ ...f, text: "delete me" });
		const events: NarraForkEvent[] = [];
		const listener = (event: NarraForkEvent) => {
			if (event.type === "chat:message_deleted" && event.messageId === guest.id) events.push(event);
		};
		eventBus.on("chat:message_deleted", listener);
		try {
			await Promise.all([
				softDeleteMessage(f.roomId, guest.id, f.owner, true),
				softDeleteMessage(f.roomId, guest.id, f.owner, true),
			]);
			await softDeleteMessage(f.roomId, guest.id, f.owner, true);
		} finally {
			eventBus.off("chat:message_deleted", listener);
		}
		expect(events).toEqual([
			{
				type: "chat:message_deleted",
				roomId: f.roomId,
				messageId: guest.id,
				narratorId: f.narratorId,
			},
		]);
		expect((await listPublicDiscussion(f)).messages[0]).toMatchObject({
			text: "",
			hasAttachments: false,
			author: { name: "固定访客", isGuest: true },
		});
		const broadcasts: unknown[] = [];
		setChatNotifyChannel({
			broadcastToChatRoom: (_room, message) => broadcasts.push(message),
			broadcastToUser: () => {},
			getChatRoomSubscriberUserIds: () => new Set(),
		});
		try {
			await chatNotifyTesting.onMessageDeleted({ roomId: f.roomId, messageId: guest.id });
		} finally {
			setChatNotifyChannel(null);
		}
		expect(broadcasts).toEqual([
			{ type: "chat:message_deleted", roomId: f.roomId, messageId: guest.id },
		]);
	});
});
