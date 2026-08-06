import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

/**
 * streaming-table-repro.test.ts — a GFM table whose cells hold `$price/秒` values
 * must SURVIVE the vlist path's pre-lex math extraction.
 *
 * The regression this locks down: `extractInlineMath` runs BEFORE `marked.lexer`
 * and pairs an inline `$` with the next `$` it can find. Because the search used
 * to cross newlines, the opening `$` of one table row's `$0.0192/秒` paired with
 * the next row's `$0.0416/秒`, swallowing the rows in between — including the
 * `|---|` delimiter — into a fake formula. marked then saw only inline text and
 * the table painted as raw monospace source (the screenshot's symptom). The fix
 * confines inline math to a single line.
 *
 * A minimal KaTeX stand-in keeps the math path active (the bug lives in the TEXT
 * rewrite upstream of KaTeX, so `renderToString` only needs to not throw).
 */
const fakeKatex = {
	renderToString(latex: string) {
		return `<span class="katex">${latex}</span>`;
	},
	// measureKatex walks the HTML tree for the width; a single text-ish node with a
	// positive width keeps the math atom alive so the test can see it in the cell.
	__renderToHTMLTree() {
		return {
			type: "span",
			classes: ["katex"],
			children: [],
			height: 0.6,
			depth: 0.1,
			maxFontSize: 1,
			style: {},
		};
	},
};

const MATH_SUPPORT = {
	katex: fakeKatex,
	glyphWidth: () => 8,
	glyphVertical: () => ({ ascent: 10, descent: 2 }),
} as never;

/** The document shape from the report: several tables of `$x/秒` prices. */
const PRICE_TABLE_MD = [
	"按最近可核验的汇率 **$1 = ¥6.7713** 换算。([es.investing.com](https://es.investing.com/currencies/usd-cny-historical-data))",
	"",
	"**最便宜：Seedance 1.5 Pro 480P，约 ¥0.130/秒。**",
	"",
	"| 模型 | 分辨率 | Comet 美元价 | 约合人民币 |",
	"|---|---:|---:|---:|",
	"| Seedance 1.5 Pro | 480P | $0.0192/秒 | **¥0.130/秒** |",
	"| Seedance 1.5 Pro | 720P | $0.0416/秒 | ¥0.282/秒 |",
	"| Seedance 1.5 Pro | 1080P | $0.0928/秒 | ¥0.628/秒 |",
	"| Seedance 2.0 Mini | 480P | $0.032/秒 | **¥0.217/秒** |",
	"",
	"Seedance 的详细模型页列出了以上版本。([cometapi.com](https://www.cometapi.com/models/doubao/))",
	"",
	"| 模型 | 分辨率 | Comet 美元价 | 约合人民币 |",
	"|---|---:|---:|---:|",
	"| HappyHorse 1.1 | 720P | $0.112/秒 | **¥0.758/秒** |",
	"| HappyHorse 1.1 | 1080P | $0.144/秒 | ¥0.975/秒 |",
].join("\n");

const countTables = (blocks: readonly { kind: string }[]) =>
	blocks.filter((b) => b.kind === "table").length;

beforeAll(() => installCanvasStub());

describe("vlist math extraction preserves price tables", () => {
	it("keeps every table when math support is active (whole-document parse)", async () => {
		const { parseMarkdownToPreparedBlocks } = await import("@shared/pretext-layout/parse-markdown");
		const withMath = parseMarkdownToPreparedBlocks(PRICE_TABLE_MD, MATH_SUPPORT);
		const withoutMath = parseMarkdownToPreparedBlocks(PRICE_TABLE_MD, undefined);
		// The no-math baseline must see both tables, and math extraction must match it.
		expect(countTables(withoutMath)).toBe(2);
		expect(countTables(withMath)).toBe(2);
	});

	it("never produces a cross-line fake formula from price cells", async () => {
		const { splitMathOutsideCode } = await import("@shared/pretext-layout/math-delimiters");
		const mathSegs = splitMathOutsideCode(PRICE_TABLE_MD).filter((s) => s.kind !== "text");
		// No `$price/秒` cell should be promoted to math (these are literal dollars).
		expect(mathSegs).toEqual([]);
		// And the text must reassemble to exactly the source (nothing swallowed).
		const reassembled = splitMathOutsideCode(PRICE_TABLE_MD)
			.map((s) =>
				s.kind === "text" ? s.text : s.kind === "display-math" ? `$$${s.latex}$$` : `$${s.latex}$`,
			)
			.join("");
		expect(reassembled).toBe(PRICE_TABLE_MD);
	});

	it("keeps the table through the incremental streaming path", async () => {
		const { getStreamingPreparedBlocks, resetStreamingBlockCache } = await import(
			"./streaming-block-cache"
		);
		resetStreamingBlockCache();
		// Feed the body in small append-only chunks, as a token stream does.
		for (let end = 5; end < PRICE_TABLE_MD.length; end += 5) {
			getStreamingPreparedBlocks("price", PRICE_TABLE_MD.slice(0, end));
		}
		const finalBlocks = getStreamingPreparedBlocks("price", PRICE_TABLE_MD);
		expect(countTables(finalBlocks)).toBe(2);
		resetStreamingBlockCache();
	});

	it("still renders a REAL inline formula inside a table cell", async () => {
		// Use the real KaTeX runtime (the same infra RenderMarkdown.table-math.test
		// uses): a stubbed `measureKatex` collapses the atom to width 0, which the
		// prepared layer then drops — that is a test-harness artefact, not the bug.
		const { ensureKatexLoaded } = await import("./katex-runtime");
		const md = "| expr | note |\n|---|---|\n| $x^2$ | math |";
		await ensureKatexLoaded(md);
		const { parseMarkdownToPreparedBlocks } = await import("@shared/pretext-layout/parse-markdown");
		const { markdownMathSupport } = await import("./measure/math-support");
		const blocks = parseMarkdownToPreparedBlocks(md, markdownMathSupport());
		const table = blocks.find((b) => b.kind === "table");
		if (table?.kind !== "table") throw new Error("expected a table block");
		// The single-line formula inside the cell still resolves to a math atom.
		expect(table.rows[0]?.[0]?.mathHtmls?.find((m) => m)?.latex).toBe("x^2");
	});
});
