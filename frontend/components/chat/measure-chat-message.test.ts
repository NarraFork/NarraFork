/**
 * measure-chat-message tests.
 *
 * Assert the height MODEL (chrome + line-count × line-height), not pixel-perfect
 * font metrics — real-font accuracy is a browser concern, and the canvas stub
 * gives a deterministic 0.6 × fontSize advance per character.
 *
 * The stub MUST be installed before any pretext-backed module is imported, hence
 * the dynamic `await import()` below (the same convention the narrator measure
 * tests use).
 */
import { beforeAll, describe, expect, test } from "bun:test";

// Dynamic import: the canvas stub has to exist before pretext is loaded.
const { installCanvasStub } = await import("../narrator/vlist/measure/test-canvas-stub");
installCanvasStub();

const {
	attachmentsSignature,
	boundChatBody,
	CHAT_ATTACHMENT_BLOCK_GAP,
	CHAT_ATTACHMENT_GAP,
	CHAT_BODY_MAX_CHARS,
	CHAT_BUBBLE_PADDING_X,
	CHAT_BUBBLE_PADDING_Y,
	CHAT_DELETED_BODY_HEIGHT,
	CHAT_FILE_CHIP_HEIGHT,
	CHAT_HEADER_GAP,
	CHAT_HEADER_HEIGHT,
	CHAT_IMAGE_FALLBACK_HEIGHT,
	CHAT_IMAGE_MAX_HEIGHT,
	CHAT_IMAGE_MAX_WIDTH,
	CHAT_REPLY_GAP,
	CHAT_REPLY_LINE_HEIGHT,
	measureChatMessage,
	prepareChatMessageMeasurer,
} = await import("./measure-chat-message");

const WIDTH = 480;

/** Chrome-only height, i.e. what an empty body would cost. */
function chromeHeight(opts: { header?: boolean; reply?: boolean } = {}): number {
	let h = CHAT_BUBBLE_PADDING_Y * 2;
	if (opts.header !== false) h += CHAT_HEADER_HEIGHT + CHAT_HEADER_GAP;
	if (opts.reply) h += CHAT_REPLY_LINE_HEIGHT + CHAT_REPLY_GAP;
	return h;
}

beforeAll(() => {
	// Idempotent-safe; keeps the stub installed if another suite replaced it.
	installCanvasStub();
});

describe("single line", () => {
	test("height is chrome + one body line", () => {
		const measured = measureChatMessage({ text: "hello" }, WIDTH);
		expect(measured.height).toBe(chromeHeight() + measured.bodyHeight);
		expect(measured.bodyHeight).toBeGreaterThan(0);
		expect(measured.hasHeader).toBe(true);
		expect(measured.hasReply).toBe(false);
	});

	test("grouped messages drop exactly the header row and its gap", () => {
		const withHeader = measureChatMessage({ text: "hello" }, WIDTH);
		const grouped = measureChatMessage({ text: "hello", grouped: true }, WIDTH);
		expect(withHeader.height - grouped.height).toBe(CHAT_HEADER_HEIGHT + CHAT_HEADER_GAP);
		expect(grouped.hasHeader).toBe(false);
	});

	test("a reply strip adds exactly one xs line and its gap", () => {
		const plain = measureChatMessage({ text: "hello" }, WIDTH);
		const replying = measureChatMessage({ text: "hello", replyPreview: "earlier" }, WIDTH);
		expect(replying.height - plain.height).toBe(CHAT_REPLY_LINE_HEIGHT + CHAT_REPLY_GAP);
		expect(replying.hasReply).toBe(true);
	});

	test("a blank reply preview is not a reply", () => {
		const measured = measureChatMessage({ text: "hello", replyPreview: "   " }, WIDTH);
		expect(measured.hasReply).toBe(false);
	});
});

describe("wrapping", () => {
	test("a narrower box is never shorter", () => {
		const text = "the quick brown fox jumps over the lazy dog ".repeat(6);
		const wide = measureChatMessage({ text }, 800);
		const narrow = measureChatMessage({ text }, 300);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	test("body height grows in whole line boxes", () => {
		// One 0.6em-per-char line at width W fits roughly W / (14 * 0.6) chars.
		const oneLine = measureChatMessage({ text: "x".repeat(10) }, WIDTH);
		const twoLines = measureChatMessage({ text: `${"x".repeat(10)}\n\n${"y".repeat(10)}` }, WIDTH);
		expect(twoLines.bodyHeight).toBeGreaterThan(oneLine.bodyHeight);
	});

	test("wrap width is the padded inner width, and render must use it", () => {
		const measured = measureChatMessage({ text: "hello" }, WIDTH);
		expect(measured.contentWidth).toBe(WIDTH - CHAT_BUBBLE_PADDING_X * 2);
	});
});

describe("shrink wrap", () => {
	test("a short message does not claim the full width", () => {
		const measured = measureChatMessage({ text: "hi" }, 900);
		expect(measured.usedWidth).toBeLessThan(900);
	});

	test("usedWidth never exceeds the space given", () => {
		const measured = measureChatMessage({ text: "z".repeat(4_000) }, 320);
		expect(measured.usedWidth).toBeLessThanOrEqual(320);
	});

	test("a one-word message is still at least as wide as its header", () => {
		const withHeader = measureChatMessage({ text: "ok" }, 900);
		const grouped = measureChatMessage({ text: "ok", grouped: true }, 900);
		// The header floor applies only when the header is drawn.
		expect(withHeader.usedWidth).toBeGreaterThan(grouped.usedWidth);
	});
});

describe("markdown structures", () => {
	test("a fenced code block is taller than the same text as prose", () => {
		const prose = measureChatMessage({ text: "const a = 1;\nconst b = 2;" }, WIDTH);
		const code = measureChatMessage({ text: "```ts\nconst a = 1;\nconst b = 2;\n```" }, WIDTH);
		expect(code.bodyHeight).toBeGreaterThan(prose.bodyHeight);
	});

	test("a list produces one block per item", () => {
		const measured = measureChatMessage({ text: "- one\n- two\n- three" }, WIDTH);
		expect(measured.blocks.length).toBeGreaterThanOrEqual(3);
	});

	test("a table is measured, not treated as unknown", () => {
		const measured = measureChatMessage({ text: "| a | b |\n| - | - |\n| 1 | 2 |" }, WIDTH);
		expect(measured.blocks.some((b) => b.kind === "table")).toBe(true);
		expect(measured.bodyHeight).toBeGreaterThan(0);
	});

	test("a blockquote is measured", () => {
		const plain = measureChatMessage({ text: "quoted" }, WIDTH);
		const quoted = measureChatMessage({ text: "> quoted" }, WIDTH);
		expect(quoted.bodyHeight).toBeGreaterThanOrEqual(plain.bodyHeight);
	});

	/**
	 * The zero-unknown-height property the design depends on: with no math support
	 * and no inline images, nothing needs a post-hoc DOM correction pass.
	 */
	test("no prepared block is unknown-height", () => {
		const bodies = [
			"plain text",
			"**bold** and `code`",
			"```py\nprint(1)\n```",
			"| a | b |\n| - | - |\n| 1 | 2 |",
			"- a\n- b",
			"# heading\n\nbody",
			"$x^2$ and $$y$$",
			"![img](https://example.com/a.png)",
			"```mermaid\ngraph TD; A-->B;\n```",
		];
		for (const text of bodies) {
			const measured = measureChatMessage({ text }, WIDTH);
			const unknown = measured.blocks.filter((b) => b.kind === "unknown");
			expect(unknown).toHaveLength(0);
		}
	});

	/**
	 * Mermaid is the only construct the parser makes unknown-height. Chat does not
	 * implement unknown-height forwarding, so a placeholder would reserve space
	 * nothing ever fills — the fence is retagged to a plain code block instead, and
	 * the reader sees the diagram source at an exact height.
	 */
	test("a mermaid fence degrades to a measured code block", () => {
		const measured = measureChatMessage(
			{ text: "```mermaid\ngraph TD; A-->B;\nC-->D;\n```" },
			WIDTH,
		);
		expect(measured.blocks.some((b) => b.kind === "unknown")).toBe(false);
		expect(measured.blocks.some((b) => b.kind === "code")).toBe(true);
		// The source survives, so nothing the author wrote is lost.
		expect(measured.bodyText).toContain("graph TD");
	});

	test("the word mermaid in prose is untouched", () => {
		const text = "we should use mermaid for that";
		expect(boundChatBody(text)).toBe(text);
	});

	test("tilde-fenced mermaid is retagged too", () => {
		const measured = measureChatMessage({ text: "~~~mermaid\ngraph TD; A-->B;\n~~~" }, WIDTH);
		expect(measured.blocks.some((b) => b.kind === "unknown")).toBe(false);
	});
});

describe("deleted messages", () => {
	test("render a fixed placeholder line, not a measured body", () => {
		const measured = measureChatMessage({ text: "", deleted: true }, WIDTH);
		expect(measured.isDeletedPlaceholder).toBe(true);
		expect(measured.bodyHeight).toBe(CHAT_DELETED_BODY_HEIGHT);
		expect(measured.blocks).toHaveLength(0);
		expect(measured.bodyText).toBe("");
	});

	test("a whitespace-only body is treated as a placeholder too", () => {
		const measured = measureChatMessage({ text: "   \n  " }, WIDTH);
		expect(measured.isDeletedPlaceholder).toBe(true);
	});

	test("the placeholder height does not depend on width", () => {
		const wide = measureChatMessage({ text: "", deleted: true }, 900);
		const narrow = measureChatMessage({ text: "", deleted: true }, 200);
		expect(narrow.height).toBe(wide.height);
	});
});

describe("body bound", () => {
	test("measure and render share the same prefix", () => {
		const long = "a".repeat(CHAT_BODY_MAX_CHARS + 500);
		const measured = measureChatMessage({ text: long }, WIDTH);
		expect(measured.bodyText.length).toBe(CHAT_BODY_MAX_CHARS);
		expect(measured.bodyText).toBe(boundChatBody(long));
	});

	test("short bodies pass through untouched", () => {
		expect(boundChatBody("short")).toBe("short");
	});
});

describe("prepared reuse", () => {
	test("the measurer closure gives identical heights to a direct call", () => {
		const data = { text: "reuse me across widths ".repeat(8) };
		const measurer = prepareChatMessageMeasurer(data);
		for (const width of [240, 400, 640, 900]) {
			expect(measurer(width).height).toBe(measureChatMessage(data, width).height);
		}
	});

	test("passing preparedBlocks does not change the result", () => {
		const data = { text: "**hi** there\n\nsecond paragraph" };
		const direct = measureChatMessage(data, WIDTH);
		const reused = measureChatMessage(data, WIDTH, { preparedBlocks: direct.blocks });
		expect(reused.height).toBe(direct.height);
		expect(reused.bodyHeight).toBe(direct.bodyHeight);
	});
});

describe("reply strip", () => {
	test("an explicit hasReply reserves the strip even with no quoted text", () => {
		// This is the case the old preview-derived rule silently dropped: a reply to a
		// deleted message has an empty preview but still needs the strip, or the row
		// reads as an ordinary message answering nothing.
		const withStrip = measureChatMessage({ text: "answering", hasReply: true }, WIDTH);
		const without = measureChatMessage({ text: "answering" }, WIDTH);
		expect(withStrip.hasReply).toBe(true);
		expect(withStrip.height - without.height).toBe(CHAT_REPLY_LINE_HEIGHT + CHAT_REPLY_GAP);
	});

	test("hasReply: false wins over a non-empty preview", () => {
		const measured = measureChatMessage(
			{ text: "body", hasReply: false, replyPreview: "stale preview" },
			WIDTH,
		);
		expect(measured.hasReply).toBe(false);
	});
});

describe("attachments", () => {
	const image = (width: number, height: number) => ({ kind: "image" as const, width, height });
	const file = { kind: "file" as const };

	test("an image reserves an aspect-preserved box inside the max bounds", () => {
		const measured = measureChatMessage({ text: "", attachments: [image(800, 400)] }, WIDTH);
		const box = measured.attachments[0];
		expect(box.width).toBeLessThanOrEqual(CHAT_IMAGE_MAX_WIDTH);
		expect(box.height).toBeLessThanOrEqual(CHAT_IMAGE_MAX_HEIGHT);
		// 2:1 in, 2:1 out.
		expect(box.width / box.height).toBeCloseTo(2, 1);
	});

	test("a very tall image is bounded by the height, not just the width", () => {
		const measured = measureChatMessage({ text: "", attachments: [image(200, 2000)] }, WIDTH);
		const box = measured.attachments[0];
		expect(box.height).toBeLessThanOrEqual(CHAT_IMAGE_MAX_HEIGHT);
		// Without the height constraint the width cap alone would leave this 1800px tall.
		expect(box.width).toBeLessThan(CHAT_IMAGE_MAX_WIDTH);
	});

	test("a small image is never upscaled", () => {
		const measured = measureChatMessage({ text: "", attachments: [image(40, 30)] }, WIDTH);
		expect(measured.attachments[0]).toMatchObject({ width: 40, height: 30 });
	});

	test("an image with unknown dimensions falls back to a fixed height", () => {
		const measured = measureChatMessage(
			{ text: "", attachments: [{ kind: "image", width: null, height: null }] },
			WIDTH,
		);
		expect(measured.attachments[0].height).toBe(CHAT_IMAGE_FALLBACK_HEIGHT);
	});

	test("attachments stack, and the total is the sum plus the gaps", () => {
		const measured = measureChatMessage(
			{ text: "caption", attachments: [image(100, 50), image(100, 50), file] },
			WIDTH,
		);
		const [a, b, c] = measured.attachments;
		expect(b.top).toBe(a.top + a.height + CHAT_ATTACHMENT_GAP);
		expect(c.top).toBe(b.top + b.height + CHAT_ATTACHMENT_GAP);
		expect(c.height).toBe(CHAT_FILE_CHIP_HEIGHT);
		// Stacking (rather than wrapping) is what makes the height a plain sum instead
		// of a second wrap calculation the measure layer would have to reproduce.
		expect(measured.attachmentsHeight).toBe(
			a.height + b.height + c.height + CHAT_ATTACHMENT_GAP * 2 + CHAT_ATTACHMENT_BLOCK_GAP,
		);
	});

	test("the block gap is only charged when there is a body to separate from", () => {
		const withBody = measureChatMessage({ text: "caption", attachments: [file] }, WIDTH);
		const without = measureChatMessage({ text: "", attachments: [file] }, WIDTH);
		expect(withBody.attachmentsHeight - without.attachmentsHeight).toBe(CHAT_ATTACHMENT_BLOCK_GAP);
	});

	test("attachments add their height to the bubble", () => {
		const bare = measureChatMessage({ text: "caption" }, WIDTH);
		const withImage = measureChatMessage({ text: "caption", attachments: [image(100, 60)] }, WIDTH);
		expect(withImage.height - bare.height).toBe(withImage.attachmentsHeight);
	});

	test("an attachment-only message is NOT the deleted placeholder", () => {
		const measured = measureChatMessage({ text: "", attachments: [image(100, 60)] }, WIDTH);
		// Rendering it as "this message was deleted" would mislabel an image-only post.
		expect(measured.isDeletedPlaceholder).toBe(false);
		expect(measured.attachments).toHaveLength(1);
	});

	test("a deleted message reserves no attachment space even if rows are passed", () => {
		const measured = measureChatMessage(
			{ text: "", deleted: true, attachments: [image(100, 60)] },
			WIDTH,
		);
		expect(measured.isDeletedPlaceholder).toBe(true);
		expect(measured.attachments).toEqual([]);
		expect(measured.attachmentsHeight).toBe(0);
	});

	test("the bubble is at least as wide as its widest attachment", () => {
		// Without this floor a one-word caption would shrink-wrap the bubble narrower
		// than the thumbnail, which the bubble's own `overflow: hidden` would clip.
		const measured = measureChatMessage({ text: "hi", attachments: [image(240, 120)] }, WIDTH);
		const widest = Math.max(...measured.attachments.map((box) => box.width));
		expect(measured.usedWidth).toBeGreaterThanOrEqual(widest + CHAT_BUBBLE_PADDING_X * 2);
	});

	test("a narrow bubble never reserves a box wider than its content width", () => {
		const narrow = 160;
		const measured = measureChatMessage({ text: "", attachments: [image(2000, 1000)] }, narrow);
		expect(measured.attachments[0].width).toBeLessThanOrEqual(measured.contentWidth);
	});
});

describe("attachments signature", () => {
	test("distinguishes count, kind and dimensions", () => {
		const base = attachmentsSignature([{ kind: "image", width: 10, height: 10 }]);
		// Each of these changes the reserved box, so each must change the key — a
		// collision means new content drawn into a stale box.
		expect(base).not.toBe(attachmentsSignature([{ kind: "image", width: 20, height: 10 }]));
		expect(base).not.toBe(attachmentsSignature([{ kind: "image", width: 10, height: 20 }]));
		expect(base).not.toBe(attachmentsSignature([{ kind: "file" }]));
		expect(base).not.toBe(
			attachmentsSignature([
				{ kind: "image", width: 10, height: 10 },
				{ kind: "image", width: 10, height: 10 },
			]),
		);
	});

	test("no attachments and an empty list are the same empty signature", () => {
		expect(attachmentsSignature(undefined)).toBe("");
		expect(attachmentsSignature([])).toBe("");
	});
});
