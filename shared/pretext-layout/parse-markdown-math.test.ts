/**
 * parse-markdown-math.test.ts — LaTeX support in the prepared-block parser.
 *
 * The pretext vlist path never went through remark-math, so math used to fall
 * through as literal text. These tests cover the three things that make math
 * work inside a zero-DOM height model:
 *
 *   1. Display math becomes its own measured block (exact height, not a 64px guess).
 *   2. Inline math becomes a FIXED-WIDTH ATOM in the pretext flow: it occupies
 *      exactly its measured width and never splits across a line break.
 *   3. LaTeX reaches KaTeX verbatim — marked's inline lexer must not mangle it
 *      (`$a*b*c$` would otherwise come back with `*b*` turned into emphasis).
 *
 * A canvas stub is installed first so pretext's real line-breaking arithmetic
 * runs deterministically without a browser (see measure/test-canvas-stub.ts).
 */

import { afterAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";

// pretext measures text through a canvas, so the stub must be installed before
// importing anything pretext-backed. It is a GLOBAL, so it is disposed after this
// file to avoid leaking into tests that assert on a canvas-free environment.
const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const katexModule = await import("katex");
const { measureRichInlineStats } = await import("@chenglou/pretext/rich-inline");
const { parseMarkdownToPreparedBlocks, KATEX_PLACEHOLDER_HEIGHT } = await import(
	"./parse-markdown"
);
const { MARKDOWN_CONSTANTS } = await import("./parse-markdown");

type AnyBlock = ReturnType<typeof parseMarkdownToPreparedBlocks>[number];
type InlineBlock = Extract<AnyBlock, { kind: "inline" }>;
type UnknownBlock = Extract<AnyBlock, { kind: "unknown" }>;

const math = { katex: katexModule.default as never };

function parse(markdown: string) {
	return parseMarkdownToPreparedBlocks(markdown, math);
}

/** All math fragments across a block list, in order. */
function mathFragments(blocks: readonly AnyBlock[]) {
	const out: Array<NonNullable<NonNullable<InlineBlock["mathHtmls"]>[number]>> = [];
	for (const block of blocks) {
		if (block.kind !== "inline") continue;
		for (const fragment of block.mathHtmls ?? []) {
			if (fragment) out.push(fragment);
		}
	}
	return out;
}

describe("display math", () => {
	it("peels $$…$$ out of a paragraph into its own measured block", () => {
		const blocks = parse("Before.\n\n$$\\int_0^1 x^2 dx$$\n\nAfter.");
		const unknown = blocks.filter((b): b is UnknownBlock => b.kind === "unknown");
		expect(unknown).toHaveLength(1);
		expect(unknown[0]?.tag).toBe("katex");
		// The surrounding prose stays as ordinary inline blocks.
		expect(blocks.filter((b) => b.kind === "inline").length).toBeGreaterThanOrEqual(2);
	});

	it("measures an exact height instead of the conservative placeholder", () => {
		const [block] = parse("$$\\frac{a}{b}$$").filter(
			(b): b is UnknownBlock => b.kind === "unknown",
		);
		expect(block).toBeDefined();
		expect(block?.placeholderHeight).toBeGreaterThan(0);
		expect(block?.placeholderHeight).not.toBe(KATEX_PLACEHOLDER_HEIGHT);
		// A stacked fraction is taller than a plain text line.
		expect(block?.placeholderHeight).toBeGreaterThan(MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT);
	});

	it("records the formula's own width so shrink-wrap containers do not clip it", () => {
		const [block] = parse("$$\\sum_{i=1}^{n} i^2$$").filter(
			(b): b is UnknownBlock => b.kind === "unknown",
		);
		expect(block?.intrinsicWidth).toBeGreaterThan(0);
	});

	it("carries KaTeX markup for the renderer", () => {
		const [block] = parse("$$a+b$$").filter((b): b is UnknownBlock => b.kind === "unknown");
		expect(String(block?.data?.html)).toContain("katex");
		expect(block?.data?.displayMode).toBe(true);
		expect(block?.data?.source).toBe("a+b");
	});

	it("handles a math code fence", () => {
		for (const lang of ["math", "katex", "latex"]) {
			const blocks = parse(`\`\`\`${lang}\n\\frac{1}{2}\n\`\`\``);
			const unknown = blocks.filter((b): b is UnknownBlock => b.kind === "unknown");
			expect(unknown).toHaveLength(1);
			expect(unknown[0]?.tag).toBe("katex");
			expect(unknown[0]?.intrinsicWidth).toBeGreaterThan(0);
		}
	});

	it("converts \\[…\\] display delimiters", () => {
		const blocks = parse("Result: \\[ x = \\frac{-b}{2a} \\] done");
		const unknown = blocks.filter((b): b is UnknownBlock => b.kind === "unknown");
		expect(unknown).toHaveLength(1);
		expect(unknown[0]?.data?.source).toContain("frac");
	});

	it("keeps the conservative placeholder when KaTeX is unavailable", () => {
		// No math support injected: nothing may be measured, so the block must fall
		// back to the reserved placeholder rather than reporting a bogus height.
		const blocks = parseMarkdownToPreparedBlocks("```math\n\\frac{1}{2}\n```");
		const [block] = blocks.filter((b): b is UnknownBlock => b.kind === "unknown");
		expect(block?.placeholderHeight).toBe(KATEX_PLACEHOLDER_HEIGHT);
		expect(block?.intrinsicWidth).toBeUndefined();
	});
});

describe("inline math atoms", () => {
	it("reserves exactly the measured formula width in the pretext flow", () => {
		// This is the contract that keeps the zero-DOM model honest: the atom's
		// footprint in the flow must equal the width KaTeX will actually paint.
		for (const latex of ["E = mc^2", "\\frac{1}{2}", "\\sum_{i=1}^{n} i", "x^2"]) {
			const [block] = parse(`$${latex}$`).filter((b): b is InlineBlock => b.kind === "inline");
			expect(block).toBeDefined();
			if (!block) continue;
			const fragment = block.mathHtmls?.find((m) => m);
			expect(fragment).toBeDefined();
			const natural = measureRichInlineStats(block.flow, Number.MAX_SAFE_INTEGER).maxLineWidth;
			expect(natural).toBeCloseTo(fragment?.width ?? 0, 6);
		}
	});

	it("never splits a formula across a line break", () => {
		const [block] = parse(
			"The result is $\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}$ which follows.",
		).filter((b): b is InlineBlock => b.kind === "inline");
		expect(block).toBeDefined();
		if (!block) return;
		const atomWidth = block.mathHtmls?.find((m) => m)?.width ?? 0;
		// Even squeezed well below the paragraph width, no line may be narrower
		// than the atom — i.e. the atom moved whole rather than being broken up.
		for (const width of [300, 200, 170]) {
			const stats = measureRichInlineStats(block.flow, width);
			expect(stats.maxLineWidth).toBeGreaterThanOrEqual(atomWidth - 0.01);
		}
	});

	it("raises the block line height for a tall formula", () => {
		const plain = parse("just prose").filter((b): b is InlineBlock => b.kind === "inline")[0];
		const withMath = parse("a fraction $\\frac{a}{b}$ inline").filter(
			(b): b is InlineBlock => b.kind === "inline",
		)[0];
		expect(plain?.lineHeight).toBe(MARKDOWN_CONSTANTS.BODY_LINE_HEIGHT);
		expect(withMath?.lineHeight).toBeGreaterThan(plain?.lineHeight ?? 0);
	});

	it("leaves the line height alone for short formulas", () => {
		// A formula no taller than the text line must not inflate paragraph spacing.
		const blocks = parse("value $x$ here").filter((b): b is InlineBlock => b.kind === "inline");
		const fragment = blocks[0]?.mathHtmls?.find((m) => m);
		expect(blocks[0]?.lineHeight).toBeGreaterThanOrEqual(Math.ceil(fragment?.height ?? 0));
	});

	it("adds no math payload to formula-free text", () => {
		const [block] = parse("plain paragraph").filter((b): b is InlineBlock => b.kind === "inline");
		expect(block?.mathHtmls).toBeUndefined();
	});

	it("keeps surrounding prose as separate fragments", () => {
		const [block] = parse("mass $E$ energy").filter((b): b is InlineBlock => b.kind === "inline");
		// prose + atom + prose, and only the atom carries math.
		expect(block?.mathHtmls?.filter((m) => m)).toHaveLength(1);
		expect((block?.mathHtmls?.length ?? 0) >= 3).toBe(true);
	});

	it("converts \\(…\\) inline delimiters", () => {
		const fragments = mathFragments(parse("energy \\(E=mc^2\\) here"));
		expect(fragments).toHaveLength(1);
		expect(fragments[0]?.latex).toBe("E=mc^2");
	});

	it("handles several formulas in one paragraph", () => {
		const fragments = mathFragments(parse("$a_1$ and $b_2$ and $c_3$"));
		expect(fragments.map((f) => f.latex)).toEqual(["a_1", "b_2", "c_3"]);
	});
});

describe("LaTeX reaches KaTeX verbatim", () => {
	it("protects emphasis-like markup inside a formula", () => {
		// Fed straight to marked, `$a*b*c$` returns `*b*` as an <em> token and the
		// formula is destroyed. The sentinel extraction must prevent that.
		const fragments = mathFragments(parse("$a*b*c$ product"));
		expect(fragments).toHaveLength(1);
		expect(fragments[0]?.latex).toBe("a*b*c");
	});

	it("protects underscores used as subscripts", () => {
		const fragments = mathFragments(parse("$x_1 + y_2 + z_3$"));
		expect(fragments[0]?.latex).toBe("x_1 + y_2 + z_3");
	});

	it("preserves backslash commands and braces", () => {
		const latex = "\\frac{\\alpha_i}{\\beta^2}";
		const fragments = mathFragments(parse(`$${latex}$`));
		expect(fragments[0]?.latex).toBe(latex);
	});
});

describe("math inside other markdown structures", () => {
	it("works in list items", () => {
		const fragments = mathFragments(parse("- first $x_1$\n- second $y_2$"));
		expect(fragments.map((f) => f.latex)).toEqual(["x_1", "y_2"]);
	});

	it("works inside bold text", () => {
		const fragments = mathFragments(parse("**bold $z^2$ math**"));
		expect(fragments[0]?.latex).toBe("z^2");
	});

	it("works inside a blockquote", () => {
		const fragments = mathFragments(parse("> quoted $a+b$ formula"));
		expect(fragments[0]?.latex).toBe("a+b");
	});

	it("works in a heading", () => {
		const fragments = mathFragments(parse("## Section $E=mc^2$"));
		expect(fragments[0]?.latex).toBe("E=mc^2");
	});

	it("handles math adjacent to CJK with no spaces", () => {
		const blocks = parse("值$x$的大小");
		const fragments = mathFragments(blocks);
		expect(fragments[0]?.latex).toBe("x");
	});
});

describe("code regions are never treated as math", () => {
	it("leaves a shell variable in a fenced block alone", () => {
		const blocks = parse("```sh\nexport A=$B\necho $HOME\n```");
		expect(blocks.filter((b) => b.kind === "unknown")).toHaveLength(0);
		expect(mathFragments(blocks)).toHaveLength(0);
		const code = blocks.find((b) => b.kind === "code");
		expect(code).toBeDefined();
	});

	it("leaves a shell variable in inline code alone", () => {
		const blocks = parse("run `echo $HOME` now");
		expect(mathFragments(blocks)).toHaveLength(0);
	});

	it("still parses math outside a code span", () => {
		const fragments = mathFragments(parse("value $x^2$ then `$y$` done"));
		expect(fragments.map((f) => f.latex)).toEqual(["x^2"]);
	});
});

describe("degradation", () => {
	it("keeps an unterminated formula as literal text", () => {
		// Mid-stream the closing delimiter has not arrived; nothing may render as math.
		const blocks = parse("half written $E=mc");
		expect(mathFragments(blocks)).toHaveLength(0);
		expect(blocks.filter((b) => b.kind === "unknown")).toHaveLength(0);
	});

	it("keeps a dollar amount as literal text", () => {
		expect(mathFragments(parse("it costs $5 today"))).toHaveLength(0);
	});

	it("renders an invalid formula without throwing", () => {
		const blocks = parse("broken $\\frac{$ formula");
		expect(Array.isArray(blocks)).toBe(true);
	});

	it("produces finite geometry for every fragment", () => {
		const blocks = parse("$E=mc^2$ and $$\\int_0^1 x dx$$ and $\\sqrt{a}$ and \\(b\\) and \\[c\\]");
		for (const fragment of mathFragments(blocks)) {
			expect(Number.isFinite(fragment.width)).toBe(true);
			expect(Number.isFinite(fragment.height)).toBe(true);
			expect(fragment.width).toBeGreaterThan(0);
		}
		for (const block of blocks) {
			if (block.kind !== "unknown") continue;
			expect(Number.isFinite(block.placeholderHeight)).toBe(true);
			expect(block.placeholderHeight).toBeGreaterThan(0);
		}
	});

	it("leaves formula-free markdown byte-identical to the no-math path", () => {
		const markdown =
			"# Title\n\nSome **bold** text.\n\n- item one\n- item two\n\n```ts\nconst a = 1;\n```";
		const withSupport = parseMarkdownToPreparedBlocks(markdown, math);
		const without = parseMarkdownToPreparedBlocks(markdown);
		expect(withSupport.map((b) => b.kind)).toEqual(without.map((b) => b.kind));
		expect(withSupport.map((b) => (b.kind === "inline" ? b.lineHeight : 0))).toEqual(
			without.map((b) => (b.kind === "inline" ? b.lineHeight : 0)),
		);
	});
});
