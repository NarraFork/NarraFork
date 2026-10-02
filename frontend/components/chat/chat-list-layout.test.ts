/**
 * chat-list-layout tests — the pure decisions the list depends on.
 *
 * Grouping and anchoring are the two places a virtual list visibly misbehaves:
 * grouping depends on the PREVIOUS row (so a prepended page changes it), and
 * anchoring is what stops the viewport jumping when that page is inserted.
 */
import { describe, expect, test } from "bun:test";
import {
	findVisibleRange,
	layoutItems,
	unseenKeyArrivals,
} from "@shared/pretext-layout/vlist-virtualization";
import type { ChatMessage } from "../../lib/api/chat";
import {
	anchoredScrollTop,
	buildChatRows,
	CHAT_BOTTOM_PIN_SLACK,
	CHAT_GROUPING_WINDOW_MS,
	CHAT_OVERSCAN_PX,
	CHAT_REPLY_PREVIEW_MAX_CHARS,
	isGroupedWith,
	isPinnedToBottom,
	resolveReplyInfo,
	resolveReplyPreview,
} from "./chat-list-layout";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** Key lists for the unseen-arrivals cases (indexes model a contiguous seq). */
const KEYS_45 = Array.from({ length: 45 }, (_, i) => `k${i + 1}`);
const KEYS_41 = KEYS_45.slice(0, 41);

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
	return {
		id: overrides.id,
		roomId: "room",
		seq: overrides.seq ?? 1,
		kind: overrides.kind ?? "text",
		contentText: overrides.contentText ?? "body",
		replyToMessageId: overrides.replyToMessageId ?? null,
		// Defaults to "legacy row, no snapshot" so the existing window-resolution
		// cases keep exercising that path; snapshot cases set these explicitly.
		replyToSeq: overrides.replyToSeq ?? null,
		replyToSender: overrides.replyToSender ?? null,
		replyToPreview: overrides.replyToPreview ?? null,
		attachments: overrides.attachments ?? [],
		editedAt: null,
		deletedAt: overrides.deletedAt ?? null,
		createdAt: overrides.createdAt ?? new Date(T0).toISOString(),
		sender:
			overrides.sender === undefined
				? { id: "alice", username: "alice", avatarColor: null, avatarImageId: null }
				: overrides.sender,
	};
}

describe("guest quotes", () => {
	test("the snapshot preserves the guest label outside the loaded window", () => {
		const message = msg({
			id: "reply",
			replyToMessageId: "original",
			replyToSeq: 1,
			replyToPreview: "quoted text",
			replyToSender: {
				id: "guest:original",
				username: "固定访客",
				avatarColor: null,
				avatarImageId: null,
				isGuest: true,
			},
		});
		expect(resolveReplyInfo(message, new Map())).toMatchObject({
			authorName: "固定访客",
			authorIsGuest: true,
			state: "quoted",
		});
	});
});

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

describe("reply info states", () => {
	test("the stored snapshot wins over the loaded window", () => {
		// The window holds an EDITED version of the target; the snapshot holds what it
		// said when it was quoted. The snapshot is what the strip must show, otherwise
		// a later edit silently rewrites history in every quote of it.
		const target = msg({ id: "a", contentText: "edited afterwards" });
		const reply = msg({
			id: "b",
			seq: 2,
			replyToMessageId: "a",
			replyToSeq: 1,
			replyToPreview: "what it said when quoted",
			replyToSender: { id: "zoe", username: "zoe", avatarColor: null, avatarImageId: null },
		});
		const info = resolveReplyInfo(reply, new Map([[target.id, target]]));
		expect(info?.state).toBe("quoted");
		expect(info?.preview).toBe("what it said when quoted");
		expect(info?.authorName).toBe("zoe");
		expect(info?.targetSeq).toBe(1);
	});

	test("a snapshot resolves even when the target is NOT loaded", () => {
		// The whole point of the snapshot: quoting something 300 messages back used to
		// render as "this message was deleted".
		const reply = msg({
			id: "b",
			seq: 400,
			replyToMessageId: "far-away",
			replyToSeq: 7,
			replyToPreview: "an old decision",
			replyToSender: { id: "zoe", username: "zoe", avatarColor: null, avatarImageId: null },
		});
		const info = resolveReplyInfo(reply, new Map());
		expect(info?.state).toBe("quoted");
		expect(info?.preview).toBe("an old decision");
		expect(info?.targetSeq).toBe(7);
	});

	test("an EMPTY snapshot preview means deleted, not unavailable", () => {
		const reply = msg({
			id: "b",
			seq: 2,
			replyToMessageId: "a",
			replyToSeq: 1,
			replyToPreview: "",
		});
		expect(resolveReplyInfo(reply, new Map())?.state).toBe("deleted");
	});

	test("a legacy row with an unloaded target is 'unavailable', not 'deleted'", () => {
		// Three distinct truths, and reporting the wrong one is the original defect:
		// "we cannot see it from here" is not "it was deleted".
		const reply = msg({ id: "b", seq: 2, replyToMessageId: "gone" });
		expect(resolveReplyInfo(reply, new Map())?.state).toBe("unavailable");
	});

	test("a legacy row resolves from the window, author included", () => {
		const target = msg({
			id: "a",
			contentText: "legacy body",
			sender: { id: "zoe", username: "zoe", avatarColor: null, avatarImageId: null },
		});
		const reply = msg({ id: "b", seq: 2, replyToMessageId: "a" });
		const info = resolveReplyInfo(reply, new Map([[target.id, target]]));
		expect(info?.state).toBe("quoted");
		expect(info?.preview).toBe("legacy body");
		expect(info?.authorName).toBe("zoe");
		// Taken from the resolved target, so a jump still knows where to go.
		expect(info?.targetSeq).toBe(1);
	});

	test("a non-reply has no reply info at all", () => {
		expect(resolveReplyInfo(msg({ id: "a" }), new Map())).toBeNull();
	});

	test("buildChatRows only feeds the measure layer a preview for a real quote", () => {
		const rows = buildChatRows([
			msg({ id: "a", seq: 1 }),
			msg({ id: "b", seq: 2, replyToMessageId: "a", replyToSeq: 1, replyToPreview: "" }),
			msg({ id: "c", seq: 3, replyToMessageId: "a", replyToSeq: 1, replyToPreview: "quoted" }),
		]);
		// A deleted/unavailable target draws a fixed label whose width cannot change the
		// single-line strip height, so it contributes no preview string.
		expect(rows[1].replyPreview).toBe("");
		expect(rows[1].reply?.state).toBe("deleted");
		expect(rows[2].replyPreview).toBe("quoted");
		// Not a reply at all → null, which is how the measure layer tells the two apart.
		expect(rows[0].replyPreview).toBeNull();
		expect(rows[0].reply).toBeNull();
	});
});

describe("attachments in rows", () => {
	const attachment = {
		id: "att1",
		kind: "image" as const,
		filename: "shot.png",
		mediaType: "image/png",
		sizeBytes: 10,
		width: 100,
		height: 50,
	};

	test("an attachment opens a new visual group", () => {
		// A headerless bubble containing only a thumbnail gives the reader no author and
		// no timestamp for content they may well want to attribute.
		const rows = buildChatRows([
			msg({ id: "a", seq: 1 }),
			msg({
				id: "b",
				seq: 2,
				createdAt: new Date(T0 + 1_000).toISOString(),
				attachments: [attachment],
			}),
		]);
		expect(rows[1].grouped).toBe(false);
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
		expect(unseenKeyArrivals("k40", KEYS_45)).toBe(5);
	});

	test("a single message counts once", () => {
		expect(unseenKeyArrivals("k40", KEYS_41)).toBe(1);
	});

	test("a room's first page is not new traffic", () => {
		expect(unseenKeyArrivals("", KEYS_45)).toBe(0);
	});

	test("a shrinking or replaced tail is a prepend or cache swap, not an arrival", () => {
		expect(unseenKeyArrivals("k45", KEYS_45.slice(0, 40))).toBe(0);
		expect(unseenKeyArrivals("k45", KEYS_45)).toBe(0);
		expect(unseenKeyArrivals("gone", KEYS_45)).toBe(0);
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
