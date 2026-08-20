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

	/**
	 * An assistant message IS a markdown body plus this element's own insets.
	 *
	 * `RenderMessageBubble`'s assistant branch hands the measured element straight to
	 * `RenderMarkdown`, whose code panel draws `MEASURE_MARKDOWN_CODE_PADDING`
	 * (11px per side: 10 xs + 1 border, per HighlightedCode.module.css). This measure
	 * used to keep its OWN copy of the code chrome at `codePaddingY: 8`, so every
	 * fenced block in an assistant message reserved 6px less than it painted — and
	 * `CODE_PANEL_BORDER`'s compensation in the renderer assumed 11 as well.
	 *
	 * Pinned as EQUALITY against `measureMarkdown` rather than as the constant 11, so
	 * the two cannot drift again regardless of what the padding becomes.
	 */
	it("measures a fenced code block exactly as measureMarkdown does", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const { measureMarkdown } = await import("./measure-markdown");
		const md = "before\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter";
		const contentWidth = 800;
		const innerWidth = contentWidth - MEASURE_MESSAGE_CONSTANTS.ASSISTANT_PAD_X * 2;

		const bubble = measureMessageBubble({ role: "assistant", text: md }, contentWidth);
		const markdown = measureMarkdown(md, innerWidth);
		expect(bubble.height).toBe(markdown.height + MEASURE_MESSAGE_CONSTANTS.ASSISTANT_PAD_Y * 2);
		// Block-for-block identical geometry, so the renderer's per-block offsets line
		// up with what it would draw for a plain markdown element.
		expect(bubble.frame.blocks.map((b) => b.height)).toEqual(
			markdown.frame.blocks.map((b) => b.height),
		);
		expect(bubble.frame.blocks.map((b) => b.top)).toEqual(markdown.frame.blocks.map((b) => b.top));
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

	// `filePath` rides along so the render layer can make the row clickable. It is
	// a pure passthrough: the measurement cache does not key on attachment data, so
	// if it EVER moved the height the vlist would serve stale geometry for every
	// bubble measured before the field existed.
	it("keeps a text-file attachment's height neutral when it carries a filePath", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const attachment = { type: "text_file", filename: "notes.txt", size: 2048 };
		const without = measureMessageBubble(
			{ role: "user", text: "see file", attachments: [attachment] },
			1000,
		);
		const withPath = measureMessageBubble(
			{
				role: "user",
				text: "see file",
				attachments: [{ ...attachment, filePath: "/repo/.narrafork/attached/notes.txt" }],
			},
			1000,
		);
		expect(withPath.height).toBe(without.height);
		expect(withPath.usedWidth).toBe(without.usedWidth);
		// The path must reach the render layer through the fixed block's data.
		const fixed = withPath.blocks.find((block) => block.kind === "fixed");
		expect(fixed?.data?.filePath).toBe("/repo/.narrafork/attached/notes.txt");
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

	it("reserves the aspect-fitted height for an image with intrinsic dimensions", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		// 16:9 screenshot; the 1000px column minus bubble padding is the fit width.
		const r = measureMessageBubble(
			{
				role: "user",
				text: "",
				attachments: [{ type: "image", imageId: "a", width: 1600, height: 900 }],
			},
			1000,
		);
		const innerWidth = 1000 - c.USER_BUBBLE_PADDING * 2;
		// 1600×900 at 976px wide → 549 tall, over the 400 cap → capped, width narrows.
		const expectedHeight = 400;
		const expectedWidth = Math.floor((expectedHeight * 1600) / 900);
		const block = r.blocks[0];
		if (block?.kind !== "fixed") throw new Error("expected a fixed attachment block");
		expect(block.height).toBe(expectedHeight);
		expect(block.displayWidth).toBe(expectedWidth);
		expect(block.data?.displayWidth).toBe(expectedWidth);
		expect(block.data?.displayHeight).toBe(expectedHeight);
		expect(r.height).toBe(
			c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP + expectedHeight,
		);
		expect(r.usedWidth).toBe(c.USER_BUBBLE_PADDING * 2 + expectedWidth);
		expect(r.usedWidth).toBeLessThanOrEqual(c.USER_BUBBLE_PADDING * 2 + innerWidth);
	});

	it("widens the bubble around a wide strip instead of squeezing it into the caption width", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble(
			{
				role: "user",
				text: "hi",
				attachments: [{ type: "image", imageId: "a", width: 1200, height: 100 }],
			},
			1000,
		);
		const innerWidth = 1000 - c.USER_BUBBLE_PADDING * 2;
		// The strip fits by width: 976 × 81 — and the bubble wraps THAT, not the
		// 2-char caption and not the dimensionless 300px floor.
		const expectedWidth = innerWidth;
		const expectedHeight = Math.floor((innerWidth * 100) / 1200);
		expect(r.usedWidth).toBe(c.USER_BUBBLE_PADDING * 2 + expectedWidth);
		const block = r.blocks[0];
		if (block?.kind !== "fixed") throw new Error("expected a fixed attachment block");
		expect(block.height).toBe(expectedHeight);
	});

	it("keeps the 300px floor for a narrow image with dimensions", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble(
			{
				role: "user",
				text: "",
				attachments: [{ type: "image", imageId: "a", width: 64, height: 64 }],
			},
			1000,
		);
		// A 64px icon does not stretch the bubble; the attachment floor wins.
		expect(r.usedWidth).toBeGreaterThanOrEqual(
			c.USER_BUBBLE_PADDING * 2 + c.USER_ATTACHMENT_MIN_CONTENT_WIDTH,
		);
		const block = r.blocks[0];
		if (block?.kind !== "fixed") throw new Error("expected a fixed attachment block");
		expect(block.height).toBe(64);
	});
});

// ── slash-command bubbles ─────────────────────────────────────────────────────
// Regression: the adapter dropped `commandText`, so a `/command` bubble measured
// (and painted) the server-side EXPANSION as its plain body — a one-line command
// became a screen-tall wall of prompt template.
describe("measureMessageBubble — slash command", () => {
	/** A prompt expansion long enough to overflow the single preview line. */
	const LONG_EXPANSION =
		"You are a changelog generator. Read the git log, group the commits by type, " +
		"and produce a bilingual summary with one bullet per user-visible change.";

	const commandBubble = async () => {
		const mod = await import("./measure-message-bubble");
		return mod;
	};

	it("collapsed height is constant regardless of expansion length", async () => {
		const { measureMessageBubble } = await commandBubble();
		const short = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/generate-changelog" },
			600,
		);
		const huge = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION.repeat(50), commandText: "/generate-changelog" },
			600,
		);
		expect(huge.height).toBe(short.height);
	});

	it("collapsed height = chrome + command line + one preview line + toggle", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await commandBubble();
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/generate-changelog" },
			600,
		);
		expect(r.height).toBe(
			c.USER_BUBBLE_PADDING * 2 +
				c.USER_HEADER_HEIGHT +
				c.USER_HEADER_BODY_GAP +
				c.COMMAND_LINE_HEIGHT +
				c.COMMAND_ROW_GAP +
				c.COMMAND_PREVIEW_LINE_HEIGHT +
				c.COMMAND_ROW_GAP +
				c.COMMAND_TOGGLE_HEIGHT,
		);
	});

	it("folds the expansion instead of growing with it like a plain bubble", async () => {
		const { measureMessageBubble } = await commandBubble();
		const text = LONG_EXPANSION.repeat(20);
		// The plain form pays for every wrapped line of the expansion; the command
		// form pays for exactly one preview line, so it stays at the short constant.
		const asPlain = measureMessageBubble({ role: "user", text }, 600);
		const asCommand = measureMessageBubble({ role: "user", text, commandText: "/skill" }, 600);
		const shortCommand = measureMessageBubble(
			{ role: "user", text: "ok", commandText: "/skill" },
			600,
		);
		expect(asPlain.height).toBeGreaterThan(500);
		// Same height as a 2-char expansion, plus only the toggle row this one needs.
		expect(asCommand.height).toBeLessThan(asPlain.height);
		expect(asCommand.height - shortCommand.height).toBeLessThan(30);
	});

	it("marks the command form and reports the overflow / fold state", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble } = await commandBubble();
		const r = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/generate-changelog" },
			600,
		);
		expect(isMeasuredCommandBubble(r)).toBe(true);
		if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
		expect(r.commandText).toBe("/generate-changelog");
		expect(r.overflows).toBe(true);
		expect(r.expanded).toBe(false);
		expect(r.toggleTop).toBeGreaterThan(r.bodyTop);
	});

	it("omits the toggle when the expansion already fits one preview line", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
			await commandBubble();
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble({ role: "user", text: "ok", commandText: "/clear" }, 600);
		if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
		expect(r.overflows).toBe(false);
		expect(r.toggleTop).toBe(-1);
		expect(r.height).toBe(
			c.USER_BUBBLE_PADDING * 2 +
				c.USER_HEADER_HEIGHT +
				c.USER_HEADER_BODY_GAP +
				c.COMMAND_LINE_HEIGHT +
				c.COMMAND_ROW_GAP +
				c.COMMAND_PREVIEW_LINE_HEIGHT,
		);
	});

	it("a command with no expansion is just the command line", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
			await commandBubble();
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble({ role: "user", text: "", commandText: "/clear" }, 600);
		if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
		expect(r.bodyTop).toBe(-1);
		expect(r.toggleTop).toBe(-1);
		expect(r.height).toBe(
			c.USER_BUBBLE_PADDING * 2 +
				c.USER_HEADER_HEIGHT +
				c.USER_HEADER_BODY_GAP +
				c.COMMAND_LINE_HEIGHT,
		);
	});

	it("expanding grows the height by the expansion's wrapped lines", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
			await commandBubble();
		const c = MEASURE_MESSAGE_CONSTANTS;
		const collapsed = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
			600,
		);
		const expanded = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
			600,
			5,
			{ expanded: true },
		);
		if (!isMeasuredCommandBubble(expanded)) throw new Error("expected the command form");
		expect(expanded.expanded).toBe(true);
		expect(expanded.height).toBeGreaterThan(collapsed.height);
		// The delta is whole preview lines: the collapsed form already paid for one.
		const delta = expanded.height - collapsed.height;
		expect(delta % c.COMMAND_PREVIEW_LINE_HEIGHT).toBe(0);
	});

	it("cannot be expanded when there is nothing hidden", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble } = await commandBubble();
		const collapsed = measureMessageBubble({ role: "user", text: "ok", commandText: "/c" }, 600);
		const asked = measureMessageBubble({ role: "user", text: "ok", commandText: "/c" }, 600, 5, {
			expanded: true,
		});
		if (!isMeasuredCommandBubble(asked)) throw new Error("expected the command form");
		expect(asked.expanded).toBe(false);
		expect(asked.height).toBe(collapsed.height);
	});

	it("uses the injected toggle labels", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble } = await commandBubble();
		const collapsed = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
			600,
			5,
			{ showLabel: "显示展开后的提示词", hideLabel: "收起展开后的提示词" },
		);
		const expanded = measureMessageBubble(
			{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
			600,
			5,
			{ expanded: true, showLabel: "显示展开后的提示词", hideLabel: "收起展开后的提示词" },
		);
		if (!isMeasuredCommandBubble(collapsed) || !isMeasuredCommandBubble(expanded))
			throw new Error("expected the command form");
		expect(collapsed.toggleLabel).toBe("显示展开后的提示词");
		expect(expanded.toggleLabel).toBe("收起展开后的提示词");
	});

	it("bounds the measured expansion so a pathological prompt cannot stall layout", async () => {
		const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
			await commandBubble();
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble(
			{ role: "user", text: "x".repeat(c.COMMAND_EXPANSION_MAX_CHARS + 5000), commandText: "/x" },
			600,
		);
		if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
		expect(r.expansionText).toHaveLength(c.COMMAND_EXPANSION_MAX_CHARS);
	});

	it("keeps the header width floor so the avatar row is not clipped", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await commandBubble();
		const c = MEASURE_MESSAGE_CONSTANTS;
		const r = measureMessageBubble({ role: "user", text: "", commandText: "/c" }, 1000);
		expect(r.usedWidth).toBeGreaterThanOrEqual(
			c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_MIN_CONTENT_WIDTH,
		);
	});

	/**
	 * The bubble SHRINK-WRAPS, so the box the expansion is painted in is
	 * `usedWidth - padding*2`, not the full available inner width. Judging overflow
	 * against the full width answered a question about a box that does not exist:
	 * a short expansion inside a bubble shrunk to the command's width got
	 * `overflows=false` → no toggle → and the render copy then ellipsis-clipped the
	 * one preview line. The content was unreachable, with no control to reveal it.
	 */
	describe("overflow is judged against the SHRUNK bubble, not the full width", () => {
		it("reports the shrink-wrapped box as the width the body was measured for", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			const r = measureMessageBubble(
				{ role: "user", text: "a moderately long single-line expansion", commandText: "/c" },
				900,
			);
			if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
			// The bubble really is shrink-wrapped well below the frame, and the render
			// copy lays the body out at `contentWidth` — so that must be the inner box,
			// not the 876px the frame could have offered.
			expect(r.usedWidth).toBeLessThan(900);
			expect(r.contentWidth).toBe(r.usedWidth - c.USER_BUBBLE_PADDING * 2);
		});

		it("offers a toggle for a single line too wide for the box to show", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble } = await commandBubble();
			// An unbreakable URL wraps to ONE pretext line that is still wider than the
			// bubble, so the render copy ellipsis-clips it. Judged against the full
			// frame width this looked like "fits", and with no toggle the tail was
			// permanently unreachable.
			const r = measureMessageBubble(
				{ role: "user", text: `https://example.com/${"a".repeat(200)}`, commandText: "/c" },
				300,
			);
			if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
			expect(r.overflows).toBe(true);
			expect(r.toggleTop).toBeGreaterThan(r.bodyTop);
		});

		it("does not clip an expansion narrower than the bubble it shares with the command", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			// A long command widens the bubble; the short expansion genuinely fits, so
			// no toggle is correct here.
			const r = measureMessageBubble(
				{ role: "user", text: "ok", commandText: "/generate-changelog --with-a-long-flag" },
				900,
			);
			if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
			expect(r.overflows).toBe(false);
			expect(r.toggleTop).toBe(-1);
			expect(r.height).toBe(
				c.USER_BUBBLE_PADDING * 2 +
					c.USER_HEADER_HEIGHT +
					c.USER_HEADER_BODY_GAP +
					c.COMMAND_LINE_HEIGHT +
					c.COMMAND_ROW_GAP +
					c.COMMAND_PREVIEW_LINE_HEIGHT,
			);
		});

		it("never reports a body that fits a box narrower than the box it measured", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			// Whatever the input, "no toggle" must imply "the single preview line
			// genuinely holds everything at the width that gets painted".
			for (const [commandText, text] of [
				["/c", "short"],
				["/c", "a moderately long single-line expansion that will not fit a narrow bubble"],
				["/a-very-long-command-name --flag=value", "short"],
				["/c", "one\ntwo"],
				["/c", ""],
			] as const) {
				const r = measureMessageBubble({ role: "user", text, commandText }, 900);
				if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
				if (r.overflows || r.expansionText.length === 0) continue;
				const innerUsed = r.usedWidth - c.USER_BUBBLE_PADDING * 2;
				// One preview line at the painted width must be enough — otherwise the
				// render copy clips with no way to reveal.
				expect(r.expansionText).not.toContain("\n");
				expect(r.contentWidth).toBe(innerUsed);
			}
		});

		it("keeps the expanded height consistent with the painted (narrower) box", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			const expanded = measureMessageBubble(
				{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
				900,
				5,
				{ expanded: true },
			);
			if (!isMeasuredCommandBubble(expanded)) throw new Error("expected the command form");
			const bodyHeight =
				expanded.height -
				(c.USER_BUBBLE_PADDING * 2 +
					c.USER_HEADER_HEIGHT +
					c.USER_HEADER_BODY_GAP +
					c.COMMAND_LINE_HEIGHT +
					c.COMMAND_ROW_GAP +
					c.COMMAND_ROW_GAP +
					c.COMMAND_TOGGLE_HEIGHT);
			const lines = bodyHeight / c.COMMAND_PREVIEW_LINE_HEIGHT;
			expect(Number.isInteger(lines)).toBe(true);
			// The narrower painted box wraps to at least as many lines as the full
			// frame would; the old code counted the WIDER box and under-reserved.
			expect(lines).toBeGreaterThan(1);
		});
	});

	/**
	 * CONTRACT.md §6 lets a consumer render absolutely from `frame`, so the frame
	 * must describe the same geometry `height` does. It used to come from
	 * `accumulateFrame`, which walks the FULLY EXPANDED body — so a collapsed
	 * bubble reported a frame taller than itself, undetectably at the type level.
	 */
	describe("frame agrees with the reported height", () => {
		it("matches the collapsed geometry", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			const r = measureMessageBubble(
				{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
				600,
			);
			if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
			const chrome = c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP;
			expect(r.frame.contentHeight).toBe(r.height - chrome);
			// Block tops mirror the explicit fields the render copy positions from.
			expect(r.frame.blocks[0]?.top).toBe(r.commandTop);
			expect(r.frame.blocks[1]?.top).toBe(r.bodyTop);
			// Collapsed = exactly one preview line, whatever the expansion wraps to.
			expect(r.frame.blocks[1]?.height).toBe(c.COMMAND_PREVIEW_LINE_HEIGHT);
		});

		it("matches the expanded geometry", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			const r = measureMessageBubble(
				{ role: "user", text: LONG_EXPANSION, commandText: "/x" },
				600,
				5,
				{ expanded: true },
			);
			if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
			const chrome = c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP;
			expect(r.frame.contentHeight).toBe(r.height - chrome);
			expect((r.frame.blocks[1]?.height ?? 0) % c.COMMAND_PREVIEW_LINE_HEIGHT).toBe(0);
			expect(r.frame.blocks[1]?.height).toBeGreaterThan(c.COMMAND_PREVIEW_LINE_HEIGHT);
		});

		it("reports the shrink-wrapped inner width, not the full frame width", async () => {
			const { measureMessageBubble, isMeasuredCommandBubble, MEASURE_MESSAGE_CONSTANTS } =
				await commandBubble();
			const c = MEASURE_MESSAGE_CONSTANTS;
			const r = measureMessageBubble({ role: "user", text: "ok", commandText: "/c" }, 900);
			if (!isMeasuredCommandBubble(r)) throw new Error("expected the command form");
			expect(r.frame.usedWidth).toBe(r.usedWidth - c.USER_BUBBLE_PADDING * 2);
			expect(r.frame.usedWidth).toBeLessThan(900);
		});
	});
});
