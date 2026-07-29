/**
 * parse-markdown-units.test.ts — `parseMarkdownUnits` must be a faithful
 * decomposition of `parseMarkdownToPreparedBlocks`.
 *
 * This is the seam that makes incremental preparation of streaming markdown possible:
 * the lexer reports where top-level blocks actually begin and end, so a caller never
 * has to guess. An earlier attempt DID guess (freeze everything before the last blank
 * line) and was wrong wherever later text can still change an earlier block — inside a
 * fenced code block a blank line is ordinary content, so the guess tore one code block
 * into several and the reader watched earlier output mutate mid-stream.
 *
 * Two properties are therefore pinned here:
 *   1. concatenating the units' blocks equals a whole-document parse, and
 *   2. `consumedLength` locates the exact source offset where the next unit begins
 *      (it must include the `space` tokens that carry blank lines, or a caller using it
 *      as a resume point can never advance).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

async function load() {
	const [parse, math] = await Promise.all([
		import("./parse-markdown"),
		import("../../frontend/components/narrator/vlist/measure/math-support"),
	]);
	return { ...parse, math: math.markdownMathSupport };
}

/** Shapes whose structure depends on text that arrives later. */
const FIXTURES: Record<string, string> = {
	paragraphs: "第一段\n\n第二段\n\n第三段",
	"code with blank line": "说明\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n尾",
	"unterminated fence": "开始\n\n```ts\nconst a = 1;",
	"loose list": "说明：\n\n- 一\n\n- 二\n\n- 三\n\n结论",
	"nested loose list": "列表：\n\n- 外\n\n  - 内\n\n- 外2\n\n完",
	"indented code": "示例：\n\n    l1\n\n    l2\n\n结束",
	headings: "# 一\n\n正文\n\n## 二\n\n正文2\n\n#### 四\n\n正文4",
	"setext headings": "标题\n====\n\n正文\n\n小标题\n----\n\n尾",
	table: "数据：\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n后",
	blockquote: "引用：\n\n> 一\n>\n> 二\n\n之后",
	"horizontal rule": "上\n\n---\n\n下",
	math: "公式：\n\n$$a^2+b^2=c^2$$\n\n之后 $x$ 行内",
	"many blank lines": "一\n\n\n\n二\n\n\n三",
};

describe("parseMarkdownUnits — equals a whole-document parse", () => {
	for (const [name, text] of Object.entries(FIXTURES)) {
		it(`decomposes without changing the result: ${name}`, async () => {
			const { parseMarkdownUnits, parseMarkdownToPreparedBlocks, math } = await load();
			const units = parseMarkdownUnits(text, math());
			const joined = units.flatMap((unit) => unit.blocks);
			const whole = parseMarkdownToPreparedBlocks(text, math());
			expect(joined.length).toBe(whole.length);
			// Compare the height-bearing shape, block by block.
			expect(joined.map(shapeOf)).toEqual(whole.map(shapeOf));
		});

		it(`reports consumedLength as a usable resume offset: ${name}`, async () => {
			const { parseMarkdownUnits, math } = await load();
			const units = parseMarkdownUnits(text, math());
			// Monotonic, never past the source, and the last unit accounts for everything
			// except trailing whitespace-only tokens.
			let previous = 0;
			for (const unit of units) {
				expect(unit.consumedLength).toBeGreaterThan(previous);
				expect(unit.consumedLength).toBeLessThanOrEqual(text.length);
				previous = unit.consumedLength;
			}
			// Slicing at a unit boundary must reproduce that unit's own source.
			const first = units[0];
			if (first) expect(text.slice(0, first.consumedLength)).toContain(first.raw);
		});
	}
});

describe("parseMarkdownUnits — continuation vs document start", () => {
	it("gives the first unit no top margin at the document start", async () => {
		const { parseMarkdownUnits, math } = await load();
		const units = parseMarkdownUnits("第一段\n\n第二段", math());
		expect(units[0]?.isFirst).toBe(true);
		expect(marginOf(units[0])).toBe(0);
		// A later block carries its contextual margin.
		expect(marginOf(units[1])).toBeGreaterThan(0);
	});

	it("keeps the contextual margin when the slice is a CONTINUATION", async () => {
		const { parseMarkdownUnits, parseMarkdownToPreparedBlocks, math } = await load();
		// This is the incremental caller's case: preparing only the live remainder. Without
		// the flag its first unit would be treated as the document's first block and lose
		// one block margin — a silent few-pixel drift per settled boundary.
		const whole = parseMarkdownToPreparedBlocks("第一段\n\n第二段", math());
		const continuation = parseMarkdownUnits("第二段", math(), { continuation: true });
		expect(continuation[0]?.isFirst).toBe(false);
		expect(marginOf(continuation[0])).toBe((whole[1] as { marginTop?: number })?.marginTop);
	});

	it("splits at a unit boundary with byte-identical results", async () => {
		const { parseMarkdownUnits, parseMarkdownToPreparedBlocks, math } = await load();
		const text = "说明\n\n```ts\nconst a=1;\n\nconst b=2;\n```\n\n尾声";
		const units = parseMarkdownUnits(text, math());
		const whole = parseMarkdownToPreparedBlocks(text, math());
		// Settle everything before the last unit, prepare the rest as a continuation.
		const boundaryUnit = units[units.length - 2];
		if (!boundaryUnit) throw new Error("expected at least two units");
		const boundary = boundaryUnit.consumedLength;
		const settled = parseMarkdownUnits(text.slice(0, boundary), math());
		const live = parseMarkdownUnits(text.slice(boundary), math(), { continuation: true });
		const rejoined = [...settled, ...live].flatMap((unit) => unit.blocks);
		expect(rejoined.map(shapeOf)).toEqual(whole.map(shapeOf));
	});
});

describe("parseMarkdownUnits — reuse hook", () => {
	it("returns the cached blocks verbatim and skips re-preparation", async () => {
		const { parseMarkdownUnits, math } = await load();
		const text = "第一段\n\n第二段\n\n第三段";
		const first = parseMarkdownUnits(text, math());
		const cache = new Map(first.map((unit) => [`${unit.isFirst}:${unit.raw}`, unit.blocks]));
		let hits = 0;
		const second = parseMarkdownUnits(text, math(), {
			reuse: (raw, isFirst) => {
				const hit = cache.get(`${isFirst}:${raw}`);
				if (hit) hits++;
				return hit;
			},
		});
		expect(hits).toBe(first.length);
		// Same references, i.e. the expensive pretext work really was skipped.
		for (const [index, unit] of second.entries()) {
			expect(unit.blocks).toBe(first[index]?.blocks);
		}
	});
});

function shapeOf(block: unknown): string {
	const value = block as {
		type?: unknown;
		marginTop?: unknown;
		lineHeight?: unknown;
		height?: unknown;
		lang?: unknown;
	};
	return [value.type, value.marginTop, value.lineHeight, value.height, value.lang].join(":");
}

function marginOf(unit: { blocks: unknown[] } | undefined): number | undefined {
	return (unit?.blocks[0] as { marginTop?: number } | undefined)?.marginTop;
}
