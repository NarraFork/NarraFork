import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-reasoning → measure-markdown → parse-markdown call pretext at
// prepare time).
beforeAll(() => {
	installCanvasStub();
});

describe("resolveReasoningDisplayText / resolveReasoningForm", () => {
	it("prefers translated text, falls back to raw text", async () => {
		const { resolveReasoningDisplayText } = await import("./measure-reasoning");
		expect(resolveReasoningDisplayText({ text: "raw", translatedText: "翻译" })).toBe("翻译");
		expect(resolveReasoningDisplayText({ text: "raw" })).toBe("raw");
		expect(resolveReasoningDisplayText({})).toBe("");
	});

	it("selects the streaming form only when streaming with no text yet", async () => {
		const { resolveReasoningForm } = await import("./measure-reasoning");
		expect(resolveReasoningForm({ isStreaming: true, text: "" }, 5)).toBe("streaming");
		// Streaming WITH content is shown expanded (live full feedback).
		expect(resolveReasoningForm({ isStreaming: true, text: "hi" }, 5)).toBe("expanded");
	});

	it("selects count at low LOD, collapsed at mid/high LOD, expanded on override", async () => {
		const { resolveReasoningForm } = await import("./measure-reasoning");
		const data = { text: "some reasoning" };
		expect(resolveReasoningForm(data, 1)).toBe("count");
		expect(resolveReasoningForm(data, 2)).toBe("count");
		expect(resolveReasoningForm(data, 3)).toBe("collapsed");
		expect(resolveReasoningForm(data, 5)).toBe("collapsed");
		expect(resolveReasoningForm(data, 6)).toBe("collapsed");
		// Explicit expand overrides the LOD-driven collapse.
		expect(resolveReasoningForm(data, 5, { expanded: true })).toBe("expanded");
		expect(resolveReasoningForm(data, 1, { expanded: true })).toBe("expanded");
	});
});

describe("measureReasoning — non-expanded forms are a single fixed row", () => {
	it("streaming (no text) is a single fixed header row with no body blocks", async () => {
		const { measureReasoning, REASONING_HEADER_ROW_HEIGHT } = await import("./measure-reasoning");
		const r = measureReasoning({ isStreaming: true, text: "" }, 600, 5);
		expect(r.form).toBe("streaming");
		expect(r.height).toBe(REASONING_HEADER_ROW_HEIGHT);
		expect(r.blocks).toHaveLength(0);
	});

	it("L2 low-LOD collapses to the count line (fixed 20.8→21px row)", async () => {
		const { measureReasoning, REASONING_COUNT_LINE_HEIGHT, MEASURE_REASONING_CONSTANTS } =
			await import("./measure-reasoning");
		const r = measureReasoning({ text: "long reasoning body", stepCount: 4 }, 600, 2);
		expect(r.form).toBe("count");
		expect(r.height).toBe(REASONING_COUNT_LINE_HEIGHT);
		expect(r.stepCount).toBe(4);
		// Row = py*2 + max(icon 16, xs line 17) = 4 + 17 = 21.
		const c = MEASURE_REASONING_CONSTANTS;
		expect(r.height).toBe(
			c.REASONING_ROW_PADDING_Y * 2 + Math.max(c.REASONING_ICON_SIZE, c.REASONING_XS_LINE_HEIGHT),
		);
		expect(r.blocks).toHaveLength(0);
	});

	it("collapsed (mid/high LOD) is the header-only single row", async () => {
		const { measureReasoning, REASONING_HEADER_ROW_HEIGHT } = await import("./measure-reasoning");
		const r = measureReasoning({ text: "some reasoning text here" }, 600, 5);
		expect(r.form).toBe("collapsed");
		expect(r.height).toBe(REASONING_HEADER_ROW_HEIGHT);
		expect(r.charCount).toBe("some reasoning text here".length);
		expect(r.blocks).toHaveLength(0);
	});
});

describe("measureReasoning — expanded form = header + markdown body", () => {
	it("expanded height = header + body padding + markdown height", async () => {
		const { measureReasoning, REASONING_HEADER_ROW_HEIGHT, REASONING_BODY_PADDING_Y } =
			await import("./measure-reasoning");
		const { measureMarkdown } = await import("./measure-markdown");
		const { reasoningBodyInnerWidth } = await import("./measure-reasoning");

		const text = "Hello world.";
		const r = measureReasoning({ text }, 600, 5, { expanded: true });
		expect(r.form).toBe("expanded");

		const inner = reasoningBodyInnerWidth(600);
		const md = measureMarkdown(text, inner);
		expect(r.height).toBe(
			REASONING_HEADER_ROW_HEIGHT + REASONING_BODY_PADDING_Y * 2 + md.frame.contentHeight,
		);
		// Body markdown blocks flow through to the renderer.
		expect(r.blocks.length).toBeGreaterThan(0);
		expect(r.blocks[0]?.kind).toBe("inline");
		// contentWidth is the inner body width (renderer re-materializes here).
		expect(r.contentWidth).toBe(inner);
		expect(r.bodyTop).toBe(REASONING_HEADER_ROW_HEIGHT);
	});

	it("expanded body grows with more markdown lines", async () => {
		const { measureReasoning } = await import("./measure-reasoning");
		const one = measureReasoning({ text: "First paragraph." }, 600, 5, { expanded: true });
		const two = measureReasoning({ text: "First paragraph.\n\nSecond paragraph." }, 600, 5, {
			expanded: true,
		});
		expect(two.height).toBeGreaterThan(one.height);
	});

	it("expanded body wraps into more lines as width shrinks", async () => {
		const { measureReasoning } = await import("./measure-reasoning");
		const text = "one two three four five six seven eight nine ten eleven twelve thirteen";
		const wide = measureReasoning({ text }, 2000, 5, { expanded: true });
		const narrow = measureReasoning({ text }, 120, 5, { expanded: true });
		expect(narrow.height).toBeGreaterThan(wide.height);
	});

	it("adds a translation-toggle row when both raw + translated text exist", async () => {
		const { measureReasoning, REASONING_TRANSLATION_TOGGLE_HEIGHT } = await import(
			"./measure-reasoning"
		);
		const withoutToggle = measureReasoning({ text: "Some reasoning." }, 600, 5, {
			expanded: true,
		});
		const withToggle = measureReasoning(
			{ text: "Some reasoning.", translatedText: "Some reasoning." },
			600,
			5,
			{ expanded: true },
		);
		expect(withToggle.hasTranslationToggle).toBe(true);
		expect(withToggle.height).toBe(withoutToggle.height + REASONING_TRANSLATION_TOGGLE_HEIGHT);
	});
});

describe("measureReasoning — LOD / expand toggles change the form and height", () => {
	it("switching LOD changes the height model (count vs collapsed vs expanded)", async () => {
		const { measureReasoning, REASONING_HEADER_ROW_HEIGHT } = await import("./measure-reasoning");
		// A body long enough that the expanded form is clearly taller than a row.
		const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";

		const count = measureReasoning({ text }, 300, 2);
		const collapsed = measureReasoning({ text }, 300, 5);
		const expanded = measureReasoning({ text }, 300, 5, { expanded: true });

		// Count + collapsed are both single fixed rows (same height model).
		expect(count.form).toBe("count");
		expect(collapsed.form).toBe("collapsed");
		expect(count.height).toBe(REASONING_HEADER_ROW_HEIGHT);
		expect(collapsed.height).toBe(REASONING_HEADER_ROW_HEIGHT);

		// Expanding reveals the markdown body → strictly taller.
		expect(expanded.form).toBe("expanded");
		expect(expanded.height).toBeGreaterThan(collapsed.height);
	});

	it("prepareReasoningMeasurer parses once and re-measures across widths/LODs", async () => {
		const { prepareReasoningMeasurer, REASONING_HEADER_ROW_HEIGHT } = await import(
			"./measure-reasoning"
		);
		const measure = prepareReasoningMeasurer({
			text: "a fairly long recurring reasoning phrase repeated for wrapping purposes here",
		});
		const collapsed = measure(300, 5);
		const wide = measure(2000, 5, { expanded: true });
		const narrow = measure(120, 5, { expanded: true });
		expect(collapsed.height).toBe(REASONING_HEADER_ROW_HEIGHT);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});
