/**
 * useChat cache-transform tests.
 *
 * These cover the rules that replaced per-message `invalidateQueries`. The risk
 * they guard is not a wrong pixel but a wrong NUMBER shown to the user, plus a
 * silent regression back to refetch-per-message: `/chat/rooms` and `/chat/unread`
 * probe unread once per membership, so an invalidate on every frame is an N+1 on
 * the server's single SQLite thread.
 *
 * The transforms are pure (cache in → cache out), so no QueryClient or socket is
 * involved here. Each returns `null` for "cannot patch, refetch instead", and
 * that fallback is asserted as deliberately as the happy path.
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatRoomSummary, ChatUnreadSummary } from "./useChat";
import {
	applyChatMessageToRooms,
	applyChatReadToRooms,
	applyChatUnreadToSummary,
	chatPreviewFromText,
} from "./useChat";

function room(overrides: Partial<ChatRoomSummary> & { id: string }): ChatRoomSummary {
	return {
		id: overrides.id,
		kind: overrides.kind ?? "dm",
		narratorId: overrides.narratorId ?? null,
		lastMessageAt: overrides.lastMessageAt ?? null,
		lastMessagePreview: overrides.lastMessagePreview ?? null,
		lastMessageSenderId: overrides.lastMessageSenderId ?? null,
		peer: overrides.peer ?? null,
		unread: overrides.unread ?? 0,
		unreadCapped: overrides.unreadCapped ?? false,
		lastReadSeq: overrides.lastReadSeq ?? 0,
		muted: overrides.muted ?? false,
	};
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
	return {
		id: overrides.id ?? "m1",
		roomId: overrides.roomId ?? "r1",
		seq: overrides.seq ?? 1,
		kind: overrides.kind ?? "text",
		contentText: overrides.contentText ?? "hello",
		replyToMessageId: overrides.replyToMessageId ?? null,
		replyToSeq: overrides.replyToSeq ?? null,
		replyToSender: overrides.replyToSender ?? null,
		replyToPreview: overrides.replyToPreview ?? null,
		attachments: overrides.attachments ?? [],
		editedAt: overrides.editedAt ?? null,
		deletedAt: overrides.deletedAt ?? null,
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
		sender:
			overrides.sender === undefined
				? { id: "alice", username: "alice", avatarColor: null, avatarImageId: null }
				: overrides.sender,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
//
// This must stay byte-identical to the server's `truncatePreview`: the same
// room's preview comes from here while live and from the server after a refetch.
// ─────────────────────────────────────────────────────────────────────────────

describe("chatPreviewFromText", () => {
	test("collapses whitespace runs and trims", () => {
		expect(chatPreviewFromText("  a\n\nb\t c  ")).toBe("a b c");
	});

	test("keeps a body at exactly the limit whole", () => {
		const exact = "x".repeat(120);
		expect(chatPreviewFromText(exact)).toBe(exact);
	});

	test("appends the ellipsis past the limit", () => {
		const long = "x".repeat(121);
		const preview = chatPreviewFromText(long);
		expect(preview).toBe(`${"x".repeat(120)}…`);
		// The ellipsis is one char, so the string is limit + 1 — not limit.
		expect(preview.length).toBe(121);
	});

	test("collapse happens before the length check", () => {
		// 200 raw chars that collapse to 99, i.e. over the limit before collapsing and
		// under it after. Measuring the raw length would truncate a body that fits.
		const spaced = Array.from({ length: 50 }, () => "a   ").join("");
		expect(chatPreviewFromText(spaced)).toBe(Array.from({ length: 50 }, () => "a").join(" "));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Room list
// ─────────────────────────────────────────────────────────────────────────────

describe("applyChatMessageToRooms", () => {
	test("patches preview, timestamp and sender in place", () => {
		const rooms = [room({ id: "r1", lastMessageAt: "2026-01-01T00:00:00.000Z" })];
		const next = applyChatMessageToRooms(
			rooms,
			"r1",
			message({ contentText: "  new   body ", createdAt: "2026-01-02T00:00:00.000Z" }),
		);
		expect(next?.[0].lastMessagePreview).toBe("new body");
		expect(next?.[0].lastMessageAt).toBe("2026-01-02T00:00:00.000Z");
		expect(next?.[0].lastMessageSenderId).toBe("alice");
	});

	test("does not mutate the cached array or its rooms", () => {
		const rooms = [room({ id: "r1", lastMessagePreview: "old" })];
		applyChatMessageToRooms(rooms, "r1", message({ contentText: "new" }));
		expect(rooms[0].lastMessagePreview).toBe("old");
	});

	test("re-sorts newest-activity-first, matching the server order", () => {
		const rooms = [
			room({ id: "r1", lastMessageAt: "2026-01-03T00:00:00.000Z" }),
			room({ id: "r2", lastMessageAt: "2026-01-02T00:00:00.000Z" }),
		];
		const next = applyChatMessageToRooms(
			rooms,
			"r2",
			message({ createdAt: "2026-01-04T00:00:00.000Z" }),
		);
		expect(next?.map((r) => r.id)).toEqual(["r2", "r1"]);
	});

	test("leaves unread alone — the unread frame owns that number", () => {
		const rooms = [room({ id: "r1", unread: 3 })];
		const next = applyChatMessageToRooms(rooms, "r1", message());
		expect(next?.[0].unread).toBe(3);
	});

	test("a deleted message shows an empty preview, not the body", () => {
		const rooms = [room({ id: "r1" })];
		const next = applyChatMessageToRooms(
			rooms,
			"r1",
			message({ contentText: "secret", deletedAt: "2026-01-02T00:00:00.000Z" }),
		);
		expect(next?.[0].lastMessagePreview).toBe("");
	});

	test("null for an unknown room: only a refetch knows the peer snapshot", () => {
		expect(applyChatMessageToRooms([room({ id: "r1" })], "r2", message())).toBeNull();
	});

	test("null when the list has not loaded", () => {
		expect(applyChatMessageToRooms(undefined, "r1", message())).toBeNull();
	});

	test("a senderless system message clears the sender rather than keeping the old one", () => {
		const rooms = [room({ id: "r1", lastMessageSenderId: "alice" })];
		const next = applyChatMessageToRooms(rooms, "r1", message({ sender: null }));
		expect(next?.[0].lastMessageSenderId).toBeNull();
	});
});

describe("applyChatReadToRooms", () => {
	test("zeroes unread and advances the watermark", () => {
		const rooms = [room({ id: "r1", unread: 5, unreadCapped: true, lastReadSeq: 2 })];
		const next = applyChatReadToRooms(rooms, "r1", 9);
		expect(next?.[0]).toMatchObject({ unread: 0, unreadCapped: false, lastReadSeq: 9 });
	});

	test("the watermark never moves backwards", () => {
		const rooms = [room({ id: "r1", lastReadSeq: 9 })];
		expect(applyChatReadToRooms(rooms, "r1", 4)?.[0].lastReadSeq).toBe(9);
	});

	test("null for an unknown or unloaded list", () => {
		expect(applyChatReadToRooms([room({ id: "r1" })], "r2", 1)).toBeNull();
		expect(applyChatReadToRooms(undefined, "r1", 1)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Unread summary
//
// Two server rules are reproduced here and each has its own test: `byRoom` omits
// zero-unread rooms, and `dmTotal` counts unmuted DM rooms only.
// ─────────────────────────────────────────────────────────────────────────────

function summary(overrides: Partial<ChatUnreadSummary> = {}): ChatUnreadSummary {
	return {
		dmTotal: overrides.dmTotal ?? 0,
		dmTotalCapped: overrides.dmTotalCapped ?? false,
		byRoom: overrides.byRoom ?? {},
	};
}

describe("applyChatUnreadToSummary", () => {
	test("writes the frame's count and adds it to dmTotal", () => {
		const next = applyChatUnreadToSummary(summary(), "r1", 3, "dm");
		expect(next).toEqual({ dmTotal: 3, dmTotalCapped: false, byRoom: { r1: 3 } });
	});

	test("adjusts dmTotal by the delta, not by the new value", () => {
		const before = summary({ dmTotal: 7, byRoom: { r1: 2, r2: 5 } });
		const next = applyChatUnreadToSummary(before, "r1", 4, "dm");
		expect(next?.dmTotal).toBe(9);
		expect(next?.byRoom).toEqual({ r1: 4, r2: 5 });
	});

	test("zero deletes the key, matching the server's omission of empty rooms", () => {
		const before = summary({ dmTotal: 4, byRoom: { r1: 4 } });
		const next = applyChatUnreadToSummary(before, "r1", 0, "dm");
		expect(next?.byRoom).not.toHaveProperty("r1");
		expect(next?.dmTotal).toBe(0);
	});

	test("a narrator room lands in byRoom but never in dmTotal", () => {
		const next = applyChatUnreadToSummary(summary({ dmTotal: 2 }), "n1", 6, "narrator");
		expect(next?.byRoom).toEqual({ n1: 6 });
		expect(next?.dmTotal).toBe(2);
	});

	test("a muted room is excluded from both byRoom and the total", () => {
		const next = applyChatUnreadToSummary(summary({ dmTotal: 1 }), "r1", 5, "dm", true);
		expect(next?.byRoom).not.toHaveProperty("r1");
		expect(next?.dmTotal).toBe(1);
	});

	test("dmTotal never goes negative when the cached total is behind", () => {
		const before = summary({ dmTotal: 0, byRoom: { r1: 3 } });
		expect(applyChatUnreadToSummary(before, "r1", 0, "dm")?.dmTotal).toBe(0);
	});

	test("null when the room kind is unknown — dmTotal cannot be decided", () => {
		expect(applyChatUnreadToSummary(summary(), "r1", 3, undefined)).toBeNull();
	});

	test("null when the summary has not loaded", () => {
		expect(applyChatUnreadToSummary(undefined, "r1", 3, "dm")).toBeNull();
	});

	test("null when either delta endpoint sits at the probe ceiling", () => {
		// At the ceiling the count means "at least 100", so a delta is meaningless.
		expect(applyChatUnreadToSummary(summary(), "r1", 100, "dm")).toBeNull();
		const capped = summary({ dmTotal: 100, byRoom: { r1: 100 } });
		expect(applyChatUnreadToSummary(capped, "r1", 3, "dm")).toBeNull();
	});

	test("a capped narrator room is still patched: it is not part of the total", () => {
		const next = applyChatUnreadToSummary(summary(), "n1", 100, "narrator");
		expect(next?.byRoom).toEqual({ n1: 100 });
	});

	test("clears dmTotalCapped once the total reaches zero", () => {
		const before = summary({ dmTotal: 4, dmTotalCapped: true, byRoom: { r1: 4 } });
		expect(applyChatUnreadToSummary(before, "r1", 0, "dm")?.dmTotalCapped).toBe(false);
	});

	test("does not mutate the input summary", () => {
		const before = summary({ dmTotal: 2, byRoom: { r1: 2 } });
		applyChatUnreadToSummary(before, "r1", 5, "dm");
		expect(before).toEqual({ dmTotal: 2, dmTotalCapped: false, byRoom: { r1: 2 } });
	});
});
