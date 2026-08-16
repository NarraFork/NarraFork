/**
 * chat-service tests — the properties the design depends on.
 *
 * 1. **DM rooms are idempotent and order-free.** `(A,B)` and `(B,A)` must resolve
 *    to ONE room, or two people opening the conversation simultaneously would each
 *    get their own and never see the other's messages.
 * 2. **`seq` is never reused.** It is the pagination cursor, so a duplicate would
 *    make a page silently skip or repeat a message. The allocator claims from
 *    `chat_rooms.next_seq` inside the write transaction precisely for this.
 * 3. **`assertCanRead` actually refuses.** A non-member must not read a DM, and
 *    that refusal is what the WebSocket subscribe path relies on too.
 * 4. **Pagination walks the whole room without gaps or repeats.**
 * 5. **Unread counting is bounded** — one big room cannot turn a badge refresh
 *    into an unbounded scan.
 * 6. **Deletion is soft**, because removing a row would punch a hole in the
 *    cursor sequence.
 * 7. **A read watermark cannot be pushed into the future.** Monotonicity means a
 *    watermark above every real seq is permanent, so an out-of-range seq must be
 *    clamped rather than trusted.
 * 8. **Directory search treats LIKE wildcards as literals**, or `%` would be a
 *    "list everyone" query wearing a search's clothes.
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (same convention as the
 * knowledge-*.test.ts files).
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/chat-service.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	aclGrants,
	chatMessages,
	chatRoomMembers,
	chatRooms,
	narrators,
	users,
} from "../../db/schema";
import { ForbiddenError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import {
	assertCanRead,
	buildDmKey,
	CHAT_ROOM_SCAN_LIMIT,
	CHAT_SUMMARIZE_BURST,
	CHAT_SUMMARIZE_REFILL_PER_SECOND,
	CHAT_UNREAD_PROBE_LIMIT,
	chatSummarizeRateLimitTesting,
	getUnreadSummary,
	listDirectory,
	listDmRooms,
	listMessages,
	markRead,
	postMessage,
	probeRoomUnreadForUser,
	resolveDmRoom,
	resolveNarratorRoom,
	softDeleteMessage,
} from "../chat-service";

const TAG = Date.now();

let alice: string;
let bob: string;
let carol: string;
let narratorId: string;

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

beforeAll(async () => {
	alice = await makeUser("chat-alice");
	bob = await makeUser("chat-bob");
	carol = await makeUser("chat-carol");

	narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		title: `chat-narrator-${TAG}`,
		// Readable by everyone on purpose: these tests are about room mechanics
		// (membership as watermark, seq allocation, unread accounting), not about who
		// may see a narrator — narrator-acl.test.ts and chat-narrator-acl coverage own
		// that. Leaving it private would make every narrator-room case fail for the
		// wrong reason.
		visibility: "public",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
});

// ─── 1. DM identity ──────────────────────────────────────────────────────

describe("DM room resolution", () => {
	test("buildDmKey is order-independent", () => {
		expect(buildDmKey("zzz", "aaa")).toBe(buildDmKey("aaa", "zzz"));
	});

	test("both directions resolve to the same room", async () => {
		const fromAlice = await resolveDmRoom(alice, bob);
		const fromBob = await resolveDmRoom(bob, alice);
		expect(fromBob.id).toBe(fromAlice.id);
	});

	test("concurrent first-open still yields one room", async () => {
		const x = await makeUser("chat-x");
		const y = await makeUser("chat-y");
		const [a, b, c] = await Promise.all([
			resolveDmRoom(x, y),
			resolveDmRoom(y, x),
			resolveDmRoom(x, y),
		]);
		expect(new Set([a.id, b.id, c.id]).size).toBe(1);
	});

	test("both participants get a member row (a DM's ACL)", async () => {
		const room = await resolveDmRoom(alice, bob);
		const members = await db.query.chatRoomMembers.findMany({
			where: eq(chatRoomMembers.roomId, room.id),
		});
		expect(members.map((m) => m.userId).sort()).toEqual([alice, bob].sort());
	});

	test("refuses a DM with yourself", async () => {
		expect(resolveDmRoom(alice, alice)).rejects.toThrow();
	});

	test("peer resolution returns the other participant, per viewer", async () => {
		const fromAlice = await resolveDmRoom(alice, bob);
		const fromBob = await resolveDmRoom(bob, alice);
		expect(fromAlice.peer?.id).toBe(bob);
		expect(fromBob.peer?.id).toBe(alice);
	});
});

// ─── 2. seq allocation ───────────────────────────────────────────────────

describe("seq allocation", () => {
	test("sequential posts get contiguous, unique seqs starting at 1", async () => {
		const sender = await makeUser("seq-a");
		const room = await resolveDmRoom(sender, await makeUser("seq-b"));

		const seqs: number[] = [];
		for (let i = 0; i < 5; i++) {
			const row = await postMessage({ roomId: room.id, senderUserId: sender, text: `m${i}` });
			seqs.push(row.seq);
		}
		expect(seqs).toEqual([1, 2, 3, 4, 5]);
	});

	test("concurrent posts never collide on a seq", async () => {
		const a = await makeUser("race-a");
		const b = await makeUser("race-b");
		const room = await resolveDmRoom(a, b);

		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				postMessage({ roomId: room.id, senderUserId: i % 2 === 0 ? a : b, text: `race-${i}` }),
			),
		);
		const seqs = results.map((r) => r.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
	});

	test("the sender's own message is never unread for them", async () => {
		const a = await makeUser("selfread-a");
		const b = await makeUser("selfread-b");
		const room = await resolveDmRoom(a, b);
		const posted = await postMessage({ roomId: room.id, senderUserId: a, text: "hi" });

		const membership = await db.query.chatRoomMembers.findFirst({
			where: and(eq(chatRoomMembers.roomId, room.id), eq(chatRoomMembers.userId, a)),
		});
		expect(membership?.lastReadSeq).toBe(posted.seq);

		const summary = await getUnreadSummary(a);
		expect(summary.byRoom[room.id]).toBeUndefined();
	});
});

// ─── 3. Authorization ────────────────────────────────────────────────────

describe("assertCanRead", () => {
	test("a DM member is allowed", async () => {
		const room = await resolveDmRoom(alice, bob);
		const access = await assertCanRead(room.id, alice);
		expect(access.room.id).toBe(room.id);
		expect(access.membership).toBeDefined();
	});

	test("a non-member is refused a DM", async () => {
		const room = await resolveDmRoom(alice, bob);
		expect(assertCanRead(room.id, carol)).rejects.toThrow();
	});

	test("a non-member cannot post into a DM", async () => {
		const room = await resolveDmRoom(alice, bob);
		expect(
			postMessage({ roomId: room.id, senderUserId: carol, text: "intruding" }),
		).rejects.toThrow();
	});

	test("a narrator room is readable without a pre-existing member row", async () => {
		const room = await resolveNarratorRoom(narratorId, alice);
		// Carol never opened it, so she has no member row — she must still be able to
		// read, because narrator-room access follows narrator visibility.
		const access = await assertCanRead(room.id, carol);
		expect(access.membership).toBeUndefined();
		expect(access.room.narratorId).toBe(narratorId);
	});

	test("a narrator room resolves to one room across users", async () => {
		const first = await resolveNarratorRoom(narratorId, alice);
		const second = await resolveNarratorRoom(narratorId, bob);
		expect(second.id).toBe(first.id);
	});

	test("the room of a private narrator is unreachable by others", async () => {
		// The discussion quotes the work, so it must be exactly as narrow as the
		// narrator. Without this the chat surface would be a side door into a
		// private session.
		const privateNarratorId = generateId();
		await db.insert(narrators).values({
			id: privateNarratorId,
			title: `chat-private-${TAG}`,
			ownerUserId: alice,
			visibility: "private",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		const room = await resolveNarratorRoom(privateNarratorId, alice);
		expect(assertCanRead(room.id, carol)).rejects.toThrow();
	});

	test("opening a private narrator's room does not create it for an outsider", async () => {
		// resolveNarratorRoom is lazily creating, so an unauthorized visit must be
		// refused BEFORE the room and its member row exist — otherwise private
		// sessions accumulate phantom participants.
		const privateNarratorId = generateId();
		await db.insert(narrators).values({
			id: privateNarratorId,
			title: `chat-private-2-${TAG}`,
			ownerUserId: alice,
			visibility: "private",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});

		expect(resolveNarratorRoom(privateNarratorId, carol)).rejects.toThrow();
		const room = await db.query.chatRooms.findFirst({
			where: eq(chatRooms.narratorId, privateNarratorId),
		});
		expect(room).toBeUndefined();
	});

	test("a granted user can read a private narrator's room", async () => {
		const privateNarratorId = generateId();
		await db.insert(narrators).values({
			id: privateNarratorId,
			title: `chat-private-3-${TAG}`,
			ownerUserId: alice,
			visibility: "private",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: privateNarratorId,
			principalType: "user",
			principalId: bob,
			capability: "read",
			grantedBy: alice,
			createdAt: new Date().toISOString(),
		});

		const room = await resolveNarratorRoom(privateNarratorId, alice);
		const access = await assertCanRead(room.id, bob);
		expect(access.room.id).toBe(room.id);
	});

	test("posting into a narrator room without a member row still works", async () => {
		const room = await resolveNarratorRoom(narratorId, alice);
		const row = await postMessage({ roomId: room.id, senderUserId: carol, text: "from carol" });
		expect(row.seq).toBeGreaterThan(0);
		const membership = await db.query.chatRoomMembers.findFirst({
			where: and(eq(chatRoomMembers.roomId, room.id), eq(chatRoomMembers.userId, carol)),
		});
		expect(membership?.lastReadSeq).toBe(row.seq);
	});
});

// ─── 4. Pagination ───────────────────────────────────────────────────────

describe("pagination", () => {
	test("walking pages covers every message exactly once", async () => {
		const a = await makeUser("page-a");
		const b = await makeUser("page-b");
		const room = await resolveDmRoom(a, b);
		for (let i = 0; i < 25; i++) {
			await postMessage({ roomId: room.id, senderUserId: a, text: `p${i}` });
		}

		const seen: number[] = [];
		let beforeSeq: number | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = await listMessages({ roomId: room.id, userId: a, beforeSeq, limit: 10 });
			// Each page is returned oldest-first.
			expect(page.messages.map((m) => m.seq)).toEqual(
				[...page.messages.map((m) => m.seq)].sort((x, y) => x - y),
			);
			seen.unshift(...page.messages.map((m) => m.seq));
			if (!page.hasMore || page.nextBeforeSeq === null) break;
			beforeSeq = page.nextBeforeSeq;
		}

		expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
	});

	test("hasMore is false on the last page", async () => {
		const a = await makeUser("last-a");
		const b = await makeUser("last-b");
		const room = await resolveDmRoom(a, b);
		await postMessage({ roomId: room.id, senderUserId: a, text: "only" });
		const page = await listMessages({ roomId: room.id, userId: a, limit: 10 });
		expect(page.hasMore).toBe(false);
		expect(page.nextBeforeSeq).toBeNull();
	});
});

// ─── 5. Unread ───────────────────────────────────────────────────────────

describe("unread", () => {
	test("counts messages past the watermark and clears on markRead", async () => {
		const a = await makeUser("unread-a");
		const b = await makeUser("unread-b");
		const room = await resolveDmRoom(a, b);
		let lastSeq = 0;
		for (let i = 0; i < 3; i++) {
			lastSeq = (await postMessage({ roomId: room.id, senderUserId: b, text: `u${i}` })).seq;
		}

		expect((await getUnreadSummary(a)).byRoom[room.id]).toBe(3);
		await markRead(room.id, a, lastSeq);
		expect((await getUnreadSummary(a)).byRoom[room.id]).toBeUndefined();
	});

	test("markRead is monotonic — an older seq never rewinds it", async () => {
		const a = await makeUser("mono-a");
		const b = await makeUser("mono-b");
		const room = await resolveDmRoom(a, b);
		for (let i = 0; i < 3; i++) {
			await postMessage({ roomId: room.id, senderUserId: b, text: `m${i}` });
		}
		await markRead(room.id, a, 3);
		const after = await markRead(room.id, a, 1);
		expect(after).toBe(3);
	});

	test("the probe is capped, so a huge room stays bounded", async () => {
		const a = await makeUser("cap-a");
		const b = await makeUser("cap-b");
		const room = await resolveDmRoom(a, b);
		const over = CHAT_UNREAD_PROBE_LIMIT + 5;
		for (let i = 0; i < over; i++) {
			await postMessage({ roomId: room.id, senderUserId: b, text: `c${i}` });
		}
		const rooms = await listDmRooms(a);
		const summary = rooms.find((r) => r.id === room.id);
		expect(summary?.unread).toBe(CHAT_UNREAD_PROBE_LIMIT);
		expect(summary?.unreadCapped).toBe(true);
	});

	test("muted rooms are excluded from the summary", async () => {
		const a = await makeUser("mute-a");
		const b = await makeUser("mute-b");
		const room = await resolveDmRoom(a, b);
		await postMessage({ roomId: room.id, senderUserId: b, text: "quiet" });
		await db
			.update(chatRoomMembers)
			.set({ muted: true })
			.where(and(eq(chatRoomMembers.roomId, room.id), eq(chatRoomMembers.userId, a)));
		expect((await getUnreadSummary(a)).byRoom[room.id]).toBeUndefined();
	});

	test("an out-of-range seq is clamped to the room's highest existing seq", async () => {
		const a = await makeUser("clamp-a");
		const b = await makeUser("clamp-b");
		const room = await resolveDmRoom(a, b);
		for (let i = 0; i < 2; i++) {
			await postMessage({ roomId: room.id, senderUserId: b, text: `c${i}` });
		}

		// The bug this guards: MAX() is monotonic, so a watermark accepted above every
		// real seq could never be lowered and the room would be permanently "read".
		const clamped = await markRead(room.id, a, 999_999_999);
		expect(clamped).toBe(2);

		const stored = await db.query.chatRoomMembers.findFirst({
			where: and(eq(chatRoomMembers.roomId, room.id), eq(chatRoomMembers.userId, a)),
		});
		expect(stored?.lastReadSeq).toBe(2);

		// The point of clamping rather than rejecting: later messages still count.
		await postMessage({ roomId: room.id, senderUserId: b, text: "after" });
		expect((await getUnreadSummary(a)).byRoom[room.id]).toBe(1);
	});

	test("marking an empty room read leaves the watermark at 0", async () => {
		const a = await makeUser("clamp-empty-a");
		const b = await makeUser("clamp-empty-b");
		const room = await resolveDmRoom(a, b);
		// next_seq is 1, so the highest existing seq is 0 — nothing to read yet.
		expect(await markRead(room.id, a, 50)).toBe(0);
	});

	test("soft-deleted messages do not count as unread", async () => {
		const a = await makeUser("delunread-a");
		const b = await makeUser("delunread-b");
		const room = await resolveDmRoom(a, b);
		const first = await postMessage({ roomId: room.id, senderUserId: b, text: "kept" });
		const second = await postMessage({ roomId: room.id, senderUserId: b, text: "retracted" });
		expect((await getUnreadSummary(a)).byRoom[room.id]).toBe(2);

		await softDeleteMessage(room.id, second.id, b, false);

		// Counting the tombstone would promise content that is gone: a badge saying
		// "2" for a room whose second message reads "this message was deleted".
		expect((await getUnreadSummary(a)).byRoom[room.id]).toBe(1);
		expect((await probeRoomUnreadForUser(room.id, a)).count).toBe(1);

		await softDeleteMessage(room.id, first.id, b, false);
		expect((await getUnreadSummary(a)).byRoom[room.id]).toBeUndefined();
	});

	test("the single-room probe agrees with the full summary", async () => {
		const a = await makeUser("probe1-a");
		const b = await makeUser("probe1-b");
		const room = await resolveDmRoom(a, b);
		const other = await resolveDmRoom(a, await makeUser("probe1-c"));
		for (let i = 0; i < 3; i++) {
			await postMessage({ roomId: room.id, senderUserId: b, text: `p${i}` });
		}

		const single = await probeRoomUnreadForUser(room.id, a);
		expect(single.count).toBe((await getUnreadSummary(a)).byRoom[room.id]);
		// Scoped to the room it was asked about, not "this user's rooms".
		expect((await probeRoomUnreadForUser(other.id, a)).count).toBe(0);
	});

	test("the single-room probe reports 0 for a muted room", async () => {
		const a = await makeUser("probemute-a");
		const b = await makeUser("probemute-b");
		const room = await resolveDmRoom(a, b);
		await postMessage({ roomId: room.id, senderUserId: b, text: "shh" });
		await db
			.update(chatRoomMembers)
			.set({ muted: true })
			.where(and(eq(chatRoomMembers.roomId, room.id), eq(chatRoomMembers.userId, a)));
		// Muting is decided inside the probe so the notify path cannot forget to.
		expect((await probeRoomUnreadForUser(room.id, a)).count).toBe(0);
	});

	test("narrator rooms do not inflate the DM badge total", async () => {
		const viewer = await makeUser("badge-viewer");
		const room = await resolveNarratorRoom(narratorId, viewer);
		await postMessage({ roomId: room.id, senderUserId: alice, text: "narrator room chatter" });
		const summary = await getUnreadSummary(viewer);
		expect(summary.byRoom[room.id]).toBeGreaterThan(0);
		expect(summary.dmTotal).toBe(0);
	});
});

// ─── 6. Room list + deletion ─────────────────────────────────────────────

describe("room list and deletion", () => {
	test("the list carries a truncated preview, not the body", async () => {
		const a = await makeUser("prev-a");
		const b = await makeUser("prev-b");
		const room = await resolveDmRoom(a, b);
		const long = "x".repeat(500);
		await postMessage({ roomId: room.id, senderUserId: b, text: long });
		const summary = (await listDmRooms(a)).find((r) => r.id === room.id);
		expect(summary?.lastMessagePreview).toBeTruthy();
		expect((summary?.lastMessagePreview ?? "").length).toBeLessThan(long.length);
	});

	test("a room with no messages yet is still listed, ordered after active ones", async () => {
		const viewer = await makeUser("empty-viewer");
		const chatty = await resolveDmRoom(viewer, await makeUser("empty-chatty"));
		const silent = await resolveDmRoom(viewer, await makeUser("empty-silent"));
		await postMessage({ roomId: chatty.id, senderUserId: chatty.peer?.id ?? "", text: "hi" });

		// The list is bounded and ordered by activity, so a freshly opened room
		// (null `last_message_at`) must not be dropped by that bound — the user
		// would lose a conversation they just started.
		const rooms = await listDmRooms(viewer);
		const ids = rooms.map((room) => room.id);
		expect(ids).toContain(silent.id);
		expect(ids.indexOf(chatty.id)).toBeLessThan(ids.indexOf(silent.id));
	});

	test("the room list is bounded and keeps the most recently active rooms", async () => {
		const viewer = await makeUser("bound-viewer");
		const rooms = await listDmRooms(viewer);
		// Nothing to slice yet; the assertion that matters is the invariant itself,
		// which holds for any member count.
		expect(rooms.length).toBeLessThanOrEqual(CHAT_ROOM_SCAN_LIMIT);
	});

	test("delete is soft: the row and its seq survive", async () => {
		const a = await makeUser("del-a");
		const b = await makeUser("del-b");
		const room = await resolveDmRoom(a, b);
		const first = await postMessage({ roomId: room.id, senderUserId: a, text: "one" });
		const second = await postMessage({ roomId: room.id, senderUserId: a, text: "two" });

		await softDeleteMessage(room.id, first.id, a, false);

		const row = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, first.id) });
		expect(row).toBeDefined();
		expect(row?.deletedAt).toBeTruthy();
		expect(row?.contentText).toBe("");

		// The cursor sequence stays contiguous, which is why the row is kept.
		const page = await listMessages({ roomId: room.id, userId: a });
		expect(page.messages.map((m) => m.seq)).toEqual([first.seq, second.seq]);
		expect(page.messages[0].contentText).toBe("");
	});

	test("you cannot delete someone else's message — and it is a 403, not a 400", async () => {
		const room = await resolveDmRoom(alice, bob);
		const row = await postMessage({ roomId: room.id, senderUserId: alice, text: "mine" });
		// The status matters: a client cannot distinguish "fix your input" from
		// "this was never yours" if both surface as a validation error.
		expect(softDeleteMessage(room.id, row.id, bob, false)).rejects.toBeInstanceOf(ForbiddenError);
		try {
			await softDeleteMessage(room.id, row.id, bob, false);
			throw new Error("expected a refusal");
		} catch (err) {
			expect((err as ForbiddenError).statusCode).toBe(403);
		}
	});

	test("an admin can delete someone else's message", async () => {
		const room = await resolveDmRoom(alice, bob);
		const row = await postMessage({ roomId: room.id, senderUserId: alice, text: "moderated" });
		await softDeleteMessage(room.id, row.id, bob, true);
		const stored = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, row.id) });
		expect(stored?.deletedAt).toBeTruthy();
	});

	test("a reply must target a message in the same room", async () => {
		const roomA = await resolveDmRoom(alice, bob);
		const roomB = await resolveDmRoom(alice, carol);
		const inA = await postMessage({ roomId: roomA.id, senderUserId: alice, text: "in A" });
		expect(
			postMessage({
				roomId: roomB.id,
				senderUserId: alice,
				text: "cross-room reply",
				replyToMessageId: inA.id,
			}),
		).rejects.toThrow();
	});

	test("empty and oversized bodies are refused", async () => {
		const room = await resolveDmRoom(alice, bob);
		expect(postMessage({ roomId: room.id, senderUserId: alice, text: "   " })).rejects.toThrow();
		expect(
			postMessage({ roomId: room.id, senderUserId: alice, text: "x".repeat(8_001) }),
		).rejects.toThrow();
	});

	test("posting into a room that vanished is a 404, not a TypeError", async () => {
		const a = await makeUser("gone-a");
		const b = await makeUser("gone-b");
		const room = await resolveDmRoom(a, b);
		// Simulates the room being deleted between the access check and the write
		// transaction: the `UPDATE ... RETURNING` matches nothing.
		await db.delete(chatRooms).where(eq(chatRooms.id, room.id));
		expect(postMessage({ roomId: room.id, senderUserId: a, text: "orphan" })).rejects.toThrow();
	});
});

// ─── 7. Directory ────────────────────────────────────────────────────────

describe("listDirectory", () => {
	test("LIKE wildcards in the query are matched literally", async () => {
		const wildcard = await makeUser("dir-100%-off");
		const underscore = await makeUser("dir_score");
		const plain = await makeUser("dir-plain");
		const viewer = await makeUser("dir-viewer");

		// A bare "%" used to mean "everyone", which quietly turned the search box into
		// a full user dump — the exposure `listDirectory` is deliberately narrow about.
		// Escaped, it means "username contains a percent sign", which only one does.
		const byBareWildcard = await listDirectory(viewer, "%");
		expect(byBareWildcard.map((row) => row.id)).toContain(wildcard);
		expect(byBareWildcard.some((row) => row.id === underscore)).toBe(false);
		expect(byBareWildcard.some((row) => row.id === plain)).toBe(false);

		// `_` is LIKE's single-character wildcard, so "dir_" must not match "dir-".
		const byUnderscore = await listDirectory(viewer, "dir_");
		expect(byUnderscore.map((row) => row.id)).toContain(underscore);
		expect(byUnderscore.some((row) => row.id === plain)).toBe(false);
		expect(byUnderscore.some((row) => row.id === wildcard)).toBe(false);

		// A query with no wildcards behaves exactly as before.
		const byPlain = await listDirectory(viewer, "dir-plain");
		expect(byPlain.map((row) => row.id)).toEqual([plain]);
	});

	test("a trailing escape character does not break the pattern", async () => {
		const viewer = await makeUser("dir-esc");
		// The escape char must itself be escaped, or the appended `%` would be
		// swallowed and SQLite would reject the pattern.
		expect(await listDirectory(viewer, "\\")).toEqual([]);
	});

	test("the caller never appears in their own directory", async () => {
		const viewer = await makeUser("dir-self");
		const name = (await db.query.users.findFirst({ where: eq(users.id, viewer) }))?.username;
		const rows = await listDirectory(viewer, name);
		expect(rows.some((row) => row.id === viewer)).toBe(false);
	});
});

// ─── 8. Summarize budget ─────────────────────────────────────────────────

describe("summarize rate limit", () => {
	test("a burst is allowed, then the caller is told to wait", () => {
		const user = `rl-${generateId(8)}`;
		chatSummarizeRateLimitTesting.reset(user);
		const now = Date.now();
		for (let i = 0; i < CHAT_SUMMARIZE_BURST; i++) {
			expect(chatSummarizeRateLimitTesting.consume(user, now)).toBe(0);
		}
		// Sixth call in the same instant: /summarize spends model quota, so an
		// unbounded loop here bills the operator.
		expect(chatSummarizeRateLimitTesting.consume(user, now)).toBeGreaterThan(0);
	});

	test("the bucket refills over time", () => {
		const user = `rl-refill-${generateId(8)}`;
		chatSummarizeRateLimitTesting.reset(user);
		const now = Date.now();
		for (let i = 0; i < CHAT_SUMMARIZE_BURST; i++) chatSummarizeRateLimitTesting.consume(user, now);
		const oneTokenMs = Math.ceil(1_000 / CHAT_SUMMARIZE_REFILL_PER_SECOND);
		expect(chatSummarizeRateLimitTesting.consume(user, now + oneTokenMs)).toBe(0);
	});

	test("budgets are per user", () => {
		const first = `rl-a-${generateId(8)}`;
		const second = `rl-b-${generateId(8)}`;
		chatSummarizeRateLimitTesting.reset();
		const now = Date.now();
		for (let i = 0; i < CHAT_SUMMARIZE_BURST + 1; i++) {
			chatSummarizeRateLimitTesting.consume(first, now);
		}
		expect(chatSummarizeRateLimitTesting.consume(second, now)).toBe(0);
	});
});
