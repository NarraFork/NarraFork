import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (parse-markdown / measure-markdown call pretext at prepare time).
beforeAll(() => {
	installCanvasStub();
});

describe("measureMarkdown", () => {
	it("measures a single short paragraph as one line (deterministic)", async () => {
		const { measureMarkdown } = await import("./measure-markdown");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");
		const result = measureMarkdown("Hello world.", 1000);
		// One paragraph, first block marginTop 0 → height == one body line.
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]!.kind).toBe("inline");
		expect(result.height).toBe(MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT);
	});

	it("wraps a long paragraph into multiple lines as width shrinks", async () => {
		const { measureMarkdown } = await import("./measure-markdown");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");
		const md = "one two three four five six seven eight nine ten eleven twelve";
		const wide = measureMarkdown(md, 2000);
		const narrow = measureMarkdown(md, 80);
		expect(wide.height).toBe(MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT);
		expect(narrow.height).toBeGreaterThan(wide.height);
		// Height must be an integer multiple of the body line height.
		expect(narrow.height % MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT).toBe(0);
	});

	it("adds paragraph margins between blocks (first block has no top margin)", async () => {
		const { measureMarkdown } = await import("./measure-markdown");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");
		const one = measureMarkdown("First paragraph.", 1000);
		const two = measureMarkdown("First paragraph.\n\nSecond paragraph.", 1000);
		const line = MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT;
		expect(one.height).toBe(line);
		// two lines + one inter-paragraph margin
		expect(two.height).toBe(line * 2 + MARKDOWN_CONSTANTS.PARAGRAPH_MARGIN_TOP);
	});

	it("measures fenced code with per-line height + vertical padding", async () => {
		const { measureMarkdown, MEASURE_MARKDOWN_CODE_PADDING } = await import("./measure-markdown");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");
		const md = "```\nline1\nline2\nline3\n```";
		const result = measureMarkdown(md, 1000);
		expect(result.blocks[0]!.kind).toBe("code");
		// 3 code lines × code line height + top/bottom padding (no lang label).
		const expected = 3 * MARKDOWN_CONSTANTS.CODE_LINE_HEIGHT + MEASURE_MARKDOWN_CODE_PADDING.y * 2;
		expect(result.height).toBe(expected);
	});

	it("reserves extra top padding for code blocks with a language label", async () => {
		const { measureMarkdown } = await import("./measure-markdown");
		const { MARKDOWN_CONSTANTS } = await import("../parse-markdown");
		const noLang = measureMarkdown("```\nx = 1\n```", 1000);
		const withLang = measureMarkdown("```js\nx = 1\n```", 1000);
		expect(withLang.height).toBe(noLang.height + MARKDOWN_CONSTANTS.CODE_LANG_EXTRA_TOP);
	});

	it("prepareMarkdownMeasurer parses once and re-measures at different widths", async () => {
		const { prepareMarkdownMeasurer } = await import("./measure-markdown");
		const measure = prepareMarkdownMeasurer(
			"alpha beta gamma delta epsilon zeta eta theta iota kappa",
		);
		const wide = measure(2000);
		const narrow = measure(60);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("produces a heading taller than body text", async () => {
		const { measureMarkdown } = await import("./measure-markdown");
		const heading = measureMarkdown("# Title", 1000);
		const body = measureMarkdown("Title", 1000);
		expect(heading.height).toBeGreaterThan(body.height);
	});
});
