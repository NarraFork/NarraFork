/**
 * chat-list-layout tests — the pure decisions the list depends on.
 *
 * Grouping and anchoring are the two places a virtual list visibly misbehaves:
 * grouping depends on the PREVIOUS row (so a prepended page changes it), and
 * anchoring is what stops the viewport jumping when that page is inserted.
 */
import { describe, expect, test } from "bun:test";
import { findVisibleRange, layoutItems } from "@shared/pretext-layout/vlist-virtualization";
import type { ChatMessage } from "../../lib/api/chat";
import { unseenArrivals } from "./ChatMessageList";
import {
	anchoredScrollTop,
	buildChatRows,
	CHAT_BOTTOM_PIN_SLACK,
	CHAT_GROUPING_WINDOW_MS,
	CHAT_OVERSCAN_PX,
	CHAT_REPLY_PREVIEW_MAX_CHARS,
	isGroupedWith,
	isPinnedToBottom,
	resolveReplyPreview,
	toMeasureIdentity,
} from "./chat-list-layout";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
	return {
		id: overrides.id,
		roomId: "room",
		seq: overrides.seq ?? 1,
		kind: overrides.kind ?? "text",
		contentText: overrides.contentText ?? "body",
		replyToMessageId: overrides.replyToMessageId ?? null,
		editedAt: null,
		deletedAt: overrides.deletedAt ?? null,
		createdAt: overrides.createdAt ?? new Date(T0).toISOString(),
		sender:
			overrides.sender === undefined
				? { id: "alice", username: "alice", avatarColor: null, avatarImageId: null }
				: overrides.sender,
	};
}

describe("grouping", () => {
	test("same author inside the window is grouped", () => {
		const first = msg({ id: "a", seq: 1 });
		const second = msg({ id: "b", seq: 2, createdAt: new Date(T0 + 30_000).toISOString() });
		expect(isGroupedWith(first, second)).toBe(true);
	});

	test("same author past the window is not grouped", () => {
		const first = msg({ id: "a", seq: 1 });
		const second = msg({
			id: "b",
			seq: 2,
			createdAt: new Date(T0 + CHAT_GROUPING_WINDOW_MS + 1).toISOString(),
		});
		expect(isGroupedWith(first, second)).toBe(false);
	});

	test("a different author is never grouped", () => {
		const first = msg({ id: "a", seq: 1 });
		const second = msg({
			id: "b",
			seq: 2,
			createdAt: new Date(T0 + 1_000).toISOString(),
			sender: { id: "bob", username: "bob", avatarColor: null, avatarImageId: null },
		});
		expect(isGroupedWith(first, second)).toBe(false);
	});

	test("the first row is never grouped", () => {
		expect(isGroupedWith(undefined, msg({ id: "a" }))).toBe(false);
	});

	test("a reply opens a new group, so its header is drawn", () => {
		const first = msg({ id: "a", seq: 1 });
		const second = msg({
			id: "b",
			seq: 2,
			createdAt: new Date(T0 + 1_000).toISOString(),
			replyToMessageId: "a",
		});
		expect(isGroupedWith(first, second)).toBe(false);
	});

	test("system rows never group with text rows", () => {
		const system = msg({ id: "a", kind: "system", sender: null });
		const text = msg({ id: "b", seq: 2, createdAt: new Date(T0 + 1_000).toISOString() });
		expect(isGroupedWith(system, text)).toBe(false);
	});

	test("prepending older history re-decides the first row's grouping", () => {
		const younger = msg({ id: "b", seq: 2, createdAt: new Date(T0 + 30_000).toISOString() });
		const alone = buildChatRows([younger]);
		expect(alone[0].grouped).toBe(false);

		const older = msg({ id: "a", seq: 1 });
		const withHistory = buildChatRows([older, younger]);
		// Same message, now grouped — which is exactly why grouping cannot be a
		// per-row decision inside the render pass.
		expect(withHistory[1].grouped).toBe(true);
	});
});

describe("reply previews", () => {
	test("resolve from the loaded window", () => {
		const target = msg({ id: "a", contentText: "the original" });
		const reply = msg({ id: "b", seq: 2, replyToMessageId: "a" });
		const byId = new Map([[target.id, target]]);
		expect(resolveReplyPreview(reply, byId)).toBe("the original");
	});

	test("collapse whitespace and truncate", () => {
		const target = msg({ id: "a", contentText: `x  y\n\n${"z".repeat(400)}` });
		const reply = msg({ id: "b", seq: 2, replyToMessageId: "a" });
		const preview = resolveReplyPreview(reply, new Map([[target.id, target]])) ?? "";
		expect(preview.length).toBeLessThanOrEqual(CHAT_REPLY_PREVIEW_MAX_CHARS + 1);
		expect(preview).not.toContain("\n");
	});

	test("a target outside the window yields null, not a fetch", () => {
		const reply = msg({ id: "b", seq: 2, replyToMessageId: "missing" });
		expect(resolveReplyPreview(reply, new Map())).toBeNull();
	});

	test("a deleted target previews as empty, not as its old body", () => {
		const target = msg({ id: "a", contentText: "", deletedAt: new Date(T0).toISOString() });
		const reply = msg({ id: "b", seq: 2, replyToMessageId: "a" });
		expect(resolveReplyPreview(reply, new Map([[target.id, target]]))).toBe("");
	});

	test("a message with no reply has no preview", () => {
		expect(resolveReplyPreview(msg({ id: "a" }), new Map())).toBeNull();
	});
});

describe("measure identity", () => {
	test("a deleted message carries empty text and the deleted flag", () => {
		const row = buildChatRows([
			msg({ id: "a", contentText: "gone", deletedAt: new Date(T0).toISOString() }),
		])[0];
		const identity = toMeasureIdentity(row);
		expect(identity.deleted).toBe(true);
		expect(identity.text).toBe("");
	});

	test("grouping and reply state reach the cache key inputs", () => {
		const rows = buildChatRows([
			msg({ id: "a", seq: 1 }),
			msg({ id: "b", seq: 2, createdAt: new Date(T0 + 1_000).toISOString() }),
		]);
		expect(toMeasureIdentity(rows[1]).grouped).toBe(true);
		expect(toMeasureIdentity(rows[0]).grouped).toBe(false);
	});
});

describe("bottom pin", () => {
	test("exactly at the bottom is pinned", () => {
		expect(isPinnedToBottom(900, 100, 1000)).toBe(true);
	});

	test("within the slack is still pinned (sub-pixel settle)", () => {
		expect(isPinnedToBottom(900 - CHAT_BOTTOM_PIN_SLACK + 1, 100, 1000)).toBe(true);
	});

	test("scrolled into history is not pinned", () => {
		expect(isPinnedToBottom(200, 100, 1000)).toBe(false);
	});

	test("a list shorter than the viewport is pinned", () => {
		expect(isPinnedToBottom(0, 500, 300)).toBe(true);
	});
});

describe("read watermark window", () => {
	// 20 rows of 100px, no gap/padding, in a 300px viewport: rows 0..2 are on
	// screen, and the overscan reaches 600px further down.
	const layout = layoutItems(new Array(20).fill(100), 0, 0, 0);
	const VIEWPORT = 300;

	test("the rendered window mounts past the fold, so it cannot be the watermark", () => {
		const rendered = findVisibleRange(layout.items, 0, VIEWPORT, CHAT_OVERSCAN_PX);
		// 300px seen + 600px overscan → 9 rows mounted. Reporting row 8 as read
		// would mark six screens' worth of messages the reader never saw, and the
		// watermark only moves forward.
		expect(rendered.end).toBe(9);
	});

	test("the seen window is exactly the viewport", () => {
		const seen = findVisibleRange(layout.items, 0, VIEWPORT, 0);
		expect(seen.start).toBe(0);
		expect(seen.end).toBe(3);
	});

	test("the seen window trails the rendered window at every scroll offset", () => {
		for (const scrollTop of [0, 150, 400, 1000, 1700]) {
			const seen = findVisibleRange(layout.items, scrollTop, VIEWPORT, 0);
			const rendered = findVisibleRange(layout.items, scrollTop, VIEWPORT, CHAT_OVERSCAN_PX);
			expect(seen.end).toBeLessThanOrEqual(rendered.end);
		}
	});

	test("scrolling down advances the seen window", () => {
		expect(findVisibleRange(layout.items, 1000, VIEWPORT, 0).end).toBe(13);
	});

	test("a history shorter than the viewport is fully seen", () => {
		const short = layoutItems([100, 100], 0, 0, 0);
		expect(findVisibleRange(short.items, 0, VIEWPORT, 0).end).toBe(2);
	});
});

describe("unseen arrivals", () => {
	test("a burst landing in one commit counts every message", () => {
		// The defect this pins: a flat +1 reported "1 new message" for five.
		expect(unseenArrivals(40, 45)).toBe(5);
	});

	test("a single message counts once", () => {
		expect(unseenArrivals(40, 41)).toBe(1);
	});

	test("a room's first page is not new traffic", () => {
		expect(unseenArrivals(0, 900)).toBe(0);
	});

	test("a shrinking tail is a prepend or cache swap, not an arrival", () => {
		expect(unseenArrivals(45, 40)).toBe(0);
		expect(unseenArrivals(45, 45)).toBe(0);
	});
});

describe("anchoring", () => {
	test("a prepended block shifts scrollTop by exactly its height", () => {
		// The anchor row moved from 40 to 640 → 600px of history was inserted.
		expect(anchoredScrollTop(100, 40, 640)).toBe(700);
	});

	test("no movement means no compensation", () => {
		expect(anchoredScrollTop(250, 80, 80)).toBe(250);
	});

	test("never returns a negative offset", () => {
		expect(anchoredScrollTop(10, 500, 0)).toBe(0);
	});
});
