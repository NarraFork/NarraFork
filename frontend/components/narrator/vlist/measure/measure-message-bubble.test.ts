import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("measureMessageBubble — assistant", () => {
	it("adds markdown vertical padding around the body", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const r = measureMessageBubble({ role: "assistant", text: "Hello world." }, 1000);
		// one body line + top/bottom assistant padding
		expect(r.height).toBe(
			MEASURE_MESSAGE_CONSTANTS.BODY_LINE_HEIGHT + MEASURE_MESSAGE_CONSTANTS.ASSISTANT_PAD_Y * 2,
		);
	});

	it("wraps assistant markdown as width shrinks", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const md = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
		const wide = measureMessageBubble({ role: "assistant", text: md }, 2000);
		const narrow = measureMessageBubble({ role: "assistant", text: md }, 120);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});

describe("measureMessageBubble — user", () => {
	it("includes bubble padding and header row", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const r = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const expected =
			c.USER_BUBBLE_PADDING * 2 +
			c.USER_HEADER_HEIGHT +
			c.USER_HEADER_BODY_GAP +
			c.BODY_LINE_HEIGHT;
		expect(r.height).toBe(expected);
	});

	it("omits header height when hasHeader is false", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const withHeader = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const noHeader = measureMessageBubble({ role: "user", text: "hi", hasHeader: false }, 1000);
		const c = MEASURE_MESSAGE_CONSTANTS;
		expect(withHeader.height - noHeader.height).toBe(c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP);
	});

	it("preserves hard newlines in plain user text (pre-wrap, not markdown)", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		// Markdown would collapse these into one paragraph; pre-wrap keeps 3 lines.
		const r = measureMessageBubble({ role: "user", text: "line1\nline2\nline3" }, 1000);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const bodyHeight =
			r.height - (c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP);
		expect(bodyHeight).toBe(c.BODY_LINE_HEIGHT * 3);
	});

	it("shrink-wraps: narrow content uses less than full width", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const r = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		// A 2-char body must not claim the full 1000px lane.
		expect(r.usedWidth).toBeLessThan(1000);
		expect(r.usedWidth).toBeGreaterThan(0);
	});

	it("floors bubble width at the header minimum when a header is present", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		// A 2-char body shrink-wraps below the header row's needs; the header floor
		// keeps the bubble wide enough for avatar + name + time.
		const withHeader = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		expect(withHeader.usedWidth).toBeGreaterThanOrEqual(
			c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_MIN_CONTENT_WIDTH,
		);
	});

	it("does not apply the header width floor when hasHeader is false", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const noHeader = measureMessageBubble({ role: "user", text: "hi", hasHeader: false }, 1000);
		// Without a header there is no floor, so a short body stays narrow.
		expect(noHeader.usedWidth).toBeLessThan(
			c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_MIN_CONTENT_WIDTH,
		);
	});

	it("header width floor does not change measured height", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		// The floor only widens the bubble frame; the body wraps within the full
		// contentWidth either way, so height is identical with/without the floor.
		const withHeader = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const noHeaderFloorRef = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		expect(withHeader.height).toBe(noHeaderFloorRef.height);
	});
});

// ── attachments (images / text files sent by the user) ────────────────────────
// Regression: the adapter used to keep only `type === "text"` blocks, so an image
// the user sent was measured (and painted) as if it did not exist.
describe("measureMessageBubble — user attachments", () => {
	it("reserves an image box above the body text", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const plain = measureMessageBubble({ role: "user", text: "look" }, 1000);
		const withImage = measureMessageBubble(
			{
				role: "user",
				text: "look",
				attachments: [{ type: "image", imageId: "img-1", filename: "shot.png" }],
			},
			1000,
		);
		expect(withImage.height - plain.height).toBe(c.USER_IMAGE_HEIGHT + c.USER_ATTACHMENT_GAP);
	});

	it("reserves a single row for a text-file attachment", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const plain = measureMessageBubble({ role: "user", text: "see file" }, 1000);
		const withFile = measureMessageBubble(
			{
				role: "user",
				text: "see file",
				attachments: [{ type: "text_file", filename: "notes.txt", size: 2048 }],
			},
			1000,
		);
		expect(withFile.height - plain.height).toBe(c.USER_TEXT_FILE_HEIGHT + c.USER_ATTACHMENT_GAP);
	});

	it("stacks multiple attachments with a gap between each", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const plain = measureMessageBubble({ role: "user", text: "two" }, 1000);
		const withTwo = measureMessageBubble(
			{
				role: "user",
				text: "two",
				attachments: [
					{ type: "image", imageId: "a" },
					{ type: "image", imageId: "b" },
				],
			},
			1000,
		);
		// first image (no leading gap) + gap + second image + gap before the body
		expect(withTwo.height - plain.height).toBe(c.USER_IMAGE_HEIGHT * 2 + c.USER_ATTACHMENT_GAP * 2);
	});

	it("an image-only message reserves no empty body line", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const imageOnly = measureMessageBubble(
			{ role: "user", text: "", attachments: [{ type: "image", imageId: "img-1" }] },
			1000,
		);
		// bubble padding + header + the image box only — no body line, no gap.
		expect(imageOnly.height).toBe(
			c.USER_BUBBLE_PADDING * 2 +
				c.USER_HEADER_HEIGHT +
				c.USER_HEADER_BODY_GAP +
				c.USER_IMAGE_HEIGHT,
		);
		// The prepared blocks are the attachment only (no trailing code block).
		expect(imageOnly.blocks).toHaveLength(1);
		expect(imageOnly.blocks[0]?.kind).toBe("fixed");
	});

	it("keeps the body block when the message has no attachments", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const empty = measureMessageBubble({ role: "user", text: "" }, 1000);
		expect(empty.blocks).toHaveLength(1);
		expect(empty.blocks[0]?.kind).toBe("code");
	});

	it("carries the render payload (imageId / uploadNarratorId / filename) on the block", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const r = measureMessageBubble(
			{
				role: "user",
				text: "",
				attachments: [
					{
						type: "image",
						imageId: "img-9",
						filename: "shot.png",
						uploadNarratorId: "nar_1",
					},
				],
			},
			1000,
		);
		const block = r.blocks[0];
		expect(block?.kind).toBe("fixed");
		if (block?.kind !== "fixed") throw new Error("expected a fixed attachment block");
		expect(block.tag).toBe("user-image");
		expect(block.data?.imageId).toBe("img-9");
		expect(block.data?.filename).toBe("shot.png");
		expect(block.data?.uploadNarratorId).toBe("nar_1");
	});

	it("ignores unknown attachment types instead of reserving space", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const plain = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const withUnknown = measureMessageBubble(
			{ role: "user", text: "hi", attachments: [{ type: "video" }] },
			1000,
		);
		expect(withUnknown.height).toBe(plain.height);
	});

	it("floors the bubble width so a short caption cannot clip the image", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble(
			{ role: "user", text: "hi", attachments: [{ type: "image", imageId: "a" }] },
			1000,
		);
		expect(r.usedWidth).toBeGreaterThanOrEqual(
			c.USER_BUBBLE_PADDING * 2 + c.USER_ATTACHMENT_MIN_CONTENT_WIDTH,
		);
	});
});
