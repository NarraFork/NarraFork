/**
 * chat-measure-cache tests — the key must separate anything that changes a height.
 *
 * This is the file that guards the failure mode the cache's own header warns about:
 * a key that matches a stale entry means the NEW content is drawn into the OLD box,
 * so the row either clips or leaves a hole. Every field the key folds in gets a test
 * that changes only that field and asserts the measurement actually differs.
 *
 * The canvas stub must be installed before any pretext-backed module loads, hence
 * the dynamic imports (same convention as measure-chat-message.test.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test";

const { installCanvasStub } = await import("../narrator/vlist/measure/test-canvas-stub");
installCanvasStub();

const { chatMeasureCacheSize, measureChatMessageCached, resetChatMeasureCache } = await import(
	"./chat-measure-cache"
);

const WIDTH = 480;

beforeEach(() => {
	installCanvasStub();
	resetChatMeasureCache();
});

describe("cache identity", () => {
	test("identical inputs return the very same object", () => {
		const identity = { id: "m1", text: "hello" };
		const first = measureChatMessageCached(identity, WIDTH);
		const second = measureChatMessageCached(identity, WIDTH);
		// Reference equality, not just equal heights: that is what proves the parse and
		// frame arithmetic were skipped rather than repeated.
		expect(second).toBe(first);
		expect(chatMeasureCacheSize()).toBe(1);
	});

	test("a different width is a different entry", () => {
		const identity = { id: "m1", text: "hello" };
		measureChatMessageCached(identity, WIDTH);
		measureChatMessageCached(identity, WIDTH + 100);
		expect(chatMeasureCacheSize()).toBe(2);
	});
});

describe("key covers every height-affecting field", () => {
	test("text", () => {
		const a = measureChatMessageCached({ id: "m1", text: "one line" }, WIDTH);
		const b = measureChatMessageCached(
			{ id: "m1", text: "one line\n\nand a second paragraph" },
			WIDTH,
		);
		expect(b).not.toBe(a);
		expect(b.height).not.toBe(a.height);
	});

	test("editedAt, which is the only signal for an equal-length edit", () => {
		// The text signature is length + the first/last 64 chars, so an edit that
		// preserves those is invisible to it. `editedAt` is what makes the key miss.
		const text = `${"x".repeat(70)}MIDDLE${"y".repeat(70)}`;
		const edited = `${"x".repeat(70)}MlDDLE${"y".repeat(70)}`;
		const a = measureChatMessageCached({ id: "m1", text, editedAt: null }, WIDTH);
		const b = measureChatMessageCached(
			{ id: "m1", text: edited, editedAt: "2026-01-01T00:00:00.000Z" },
			WIDTH,
		);
		expect(b).not.toBe(a);
	});

	test("grouped, which adds or removes the header row", () => {
		const a = measureChatMessageCached({ id: "m1", text: "hi", grouped: false }, WIDTH);
		const b = measureChatMessageCached({ id: "m1", text: "hi", grouped: true }, WIDTH);
		expect(b.height).toBeLessThan(a.height);
	});

	test("deleted, which swaps the body for a placeholder", () => {
		const a = measureChatMessageCached({ id: "m1", text: "a\n\nb\n\nc" }, WIDTH);
		const b = measureChatMessageCached({ id: "m1", text: "", deleted: true }, WIDTH);
		expect(b.height).not.toBe(a.height);
		expect(b.isDeletedPlaceholder).toBe(true);
	});

	test("hasReply, even when the preview is empty in both cases", () => {
		// The regression this pins: keying the strip off `replyPreview` alone cannot
		// tell "reply to a deleted message" (empty preview, strip reserved) from "not a
		// reply at all" (no strip), so the two would share a cache entry.
		const notReply = measureChatMessageCached({ id: "m1", text: "hi", replyPreview: "" }, WIDTH);
		const replyToDeleted = measureChatMessageCached(
			{ id: "m1", text: "hi", replyPreview: "", hasReply: true },
			WIDTH,
		);
		expect(replyToDeleted).not.toBe(notReply);
		expect(replyToDeleted.height).toBeGreaterThan(notReply.height);
	});

	test("replyPreview content", () => {
		const a = measureChatMessageCached({ id: "m1", text: "hi", replyPreview: "short" }, WIDTH);
		const b = measureChatMessageCached({ id: "m1", text: "hi", replyPreview: "" }, WIDTH);
		expect(b).not.toBe(a);
	});

	test("attachments — count", () => {
		const one = measureChatMessageCached(
			{ id: "m1", text: "hi", attachments: [{ kind: "image", width: 10, height: 10 }] },
			WIDTH,
		);
		const two = measureChatMessageCached(
			{
				id: "m1",
				text: "hi",
				attachments: [
					{ kind: "image", width: 10, height: 10 },
					{ kind: "image", width: 10, height: 10 },
				],
			},
			WIDTH,
		);
		expect(two).not.toBe(one);
		expect(two.height).toBeGreaterThan(one.height);
	});

	test("attachments — image dimensions", () => {
		const short = measureChatMessageCached(
			{ id: "m1", text: "hi", attachments: [{ kind: "image", width: 100, height: 40 }] },
			WIDTH,
		);
		const tall = measureChatMessageCached(
			{ id: "m1", text: "hi", attachments: [{ kind: "image", width: 100, height: 160 }] },
			WIDTH,
		);
		expect(tall).not.toBe(short);
		expect(tall.height).toBeGreaterThan(short.height);
	});

	test("attachments — kind", () => {
		const asImage = measureChatMessageCached(
			{ id: "m1", text: "hi", attachments: [{ kind: "image", width: 100, height: 100 }] },
			WIDTH,
		);
		const asFile = measureChatMessageCached(
			{ id: "m1", text: "hi", attachments: [{ kind: "file" }] },
			WIDTH,
		);
		expect(asFile).not.toBe(asImage);
	});

	test("attachments — removing them (what a soft delete does)", () => {
		const withAttachment = measureChatMessageCached(
			{ id: "m1", text: "hi", attachments: [{ kind: "file" }] },
			WIDTH,
		);
		const without = measureChatMessageCached({ id: "m1", text: "hi", attachments: [] }, WIDTH);
		expect(without).not.toBe(withAttachment);
		expect(without.height).toBeLessThan(withAttachment.height);
	});
});

describe("eviction", () => {
	test("the cache stays bounded under many distinct messages", () => {
		for (let i = 0; i < 4_200; i++) {
			measureChatMessageCached({ id: `m${i}`, text: `body ${i}` }, WIDTH);
		}
		// A room scrolled for long enough must not grow the map without limit.
		expect(chatMeasureCacheSize()).toBeLessThanOrEqual(4_000);
	});
});
