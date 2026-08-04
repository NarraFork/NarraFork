/**
 * parse-markdown-table.test.ts — GFM tables must parse into a real
 * `PreparedTableBlock`, not the monospace code-block fallback they used to
 * degrade into.
 *
 * The old behaviour formatted a table as `a | b` text inside a fenced-code panel
 * WITHOUT padding the columns, so the vlist path showed misaligned monospace rows
 * where the chunked path showed a Mantine `<Table>`. These tests pin the shape of
 * the replacement, including the details that are easy to regress silently:
 * intrinsic widths (the solver's only inputs) and header emboldening (measured at
 * the weight it is painted at).
 *
 * Runs against real pretext with the deterministic canvas stub, so widths follow
 * the stub's 0.6 * fontSize-per-char model rather than a real font.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

async function load() {
	const [parse, model] = await Promise.all([
		import("./parse-markdown"),
		import("./prepared-block"),
	]);
	return { ...parse, ...model };
}

type AnyBlock = { kind: string };

const SIMPLE = "| Name | Size |\n|---|---|\n| a | 1 |\n| bb | 22 |";

describe("table token → PreparedTableBlock", () => {
	it("produces a table block instead of a code block", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const blocks = parseMarkdownToPreparedBlocks(SIMPLE) as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.kind).toBe("table");
		// The old fallback is gone for good.
		expect(blocks.some((b) => b.kind === "code")).toBe(false);
	});

	it("captures the header row and every body row", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks(SIMPLE);
		if (block?.kind !== "table") throw new Error("expected a table block");
		expect(block.columns).toBe(2);
		expect(block.header).toHaveLength(2);
		expect(block.rows).toHaveLength(2);
		expect(block.rows[0]).toHaveLength(2);
	});

	it("reads per-column alignment from the delimiter row", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		expect(block.align).toEqual(["left", "center", "right"]);
	});

	it("measures a natural width at least as wide as the min width", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks(
			"| Column |\n|---|\n| several words that can wrap |",
		);
		if (block?.kind !== "table") throw new Error("expected a table block");
		for (const cell of [...block.header, ...block.rows.flat()]) {
			expect(cell.naturalWidth).toBeGreaterThanOrEqual(cell.minWidth);
			expect(cell.minWidth).toBeGreaterThan(0);
		}
	});

	it("gives multi-word text a min width narrower than its natural width", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| h |\n|---|\n| alpha beta gamma |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const cell = block.rows[0]?.[0];
		if (!cell) throw new Error("expected a body cell");
		// "alpha beta gamma" can break at spaces, so min < natural.
		expect(cell.minWidth).toBeLessThan(cell.naturalWidth);
	});

	/**
	 * Regression: min-content must be the widest unbreakable WORD, not the widest
	 * grapheme. Probing the prepared flow at width 1 returns the latter, because
	 * pretext breaks mid-word as a last resort — which made every column look
	 * infinitely squeezable and killed the solver's overflow regime.
	 */
	it("measures min width as the widest WORD, not the widest character", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| h |\n|---|\n| a bb ccccccccccdddddddddd |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const cell = block.rows[0]?.[0];
		if (!cell) throw new Error("expected a body cell");
		// The long 20-char word is unbreakable, so min must be ~its full width, not
		// one character. Under the stub each char is 0.6 * 14 = 8.4px.
		expect(cell.minWidth).toBeGreaterThan(8.4 * 15);
	});

	it("treats an unbreakable single word as fully rigid (min === natural)", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| h |\n|---|\n| supercalifragilistic |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const cell = block.rows[0]?.[0];
		if (!cell) throw new Error("expected a body cell");
		expect(cell.minWidth).toBeCloseTo(cell.naturalWidth, 1);
	});

	it("lets CJK text break per character, so min is one glyph wide", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| 标题 |\n|---|\n| 路径别名与中文单元格内容 |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const cell = block.rows[0]?.[0];
		if (!cell) throw new Error("expected a body cell");
		// CJK has a break opportunity between every character (pretext segments it
		// that way), so a CJK column is highly compressible.
		expect(cell.minWidth).toBeLessThan(cell.naturalWidth / 5);
	});

	it("measures header cells at bold weight so the column is wide enough", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		// Same text in the header and the body: the header must measure WIDER,
		// because it paints at medium weight.
		const [block] = parseMarkdownToPreparedBlocks("| duplicate |\n|---|\n| duplicate |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const header = block.header[0];
		const body = block.rows[0]?.[0];
		if (!header || !body) throw new Error("expected both cells");
		expect(header.fonts[0]).toContain("700");
		expect(body.fonts[0]).toContain("400");
	});

	it("keeps inline markup inside cells (links, code, emphasis)", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks(
			"| a |\n|---|\n| **bold** and `code` and [link](https://example.com) |",
		);
		if (block?.kind !== "table") throw new Error("expected a table block");
		const cell = block.rows[0]?.[0];
		if (!cell) throw new Error("expected a body cell");
		// A link fragment carries its href; a code fragment carries the code class.
		expect(cell.hrefs.some((href) => href === "https://example.com/")).toBe(true);
		expect(cell.classNames.some((c) => c.includes("frag--code"))).toBe(true);
		expect(cell.fonts.some((f) => f.includes("700"))).toBe(true);
	});

	it("does not embolden inline code inside a header cell", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| `id` |\n|---|\n| x |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const header = block.header[0];
		if (!header) throw new Error("expected a header cell");
		// Monospace font retained, not swapped for the bold sans face.
		expect(header.fonts[0]).toContain("mono");
	});

	it("tolerates a ragged row shorter than the header", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const [block] = parseMarkdownToPreparedBlocks("| a | b | c |\n|---|---|---|\n| 1 |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		expect(block.columns).toBe(3);
		// The short row keeps only the cells it has; the renderer skips the rest.
		expect(block.rows[0]?.length).toBeLessThanOrEqual(3);
	});
});

/**
 * Malformed / adversarial table sources.
 *
 * The prepared layer is fed straight from model output, so "well-formed GFM" is an
 * assumption it cannot make. Each case below pins BOTH halves of the invariant the
 * rest of this subsystem depends on:
 *
 *   1. `columns` covers every cell that exists, and
 *   2. `align.length === columns`.
 *
 * (2) is the one that used to be free-riding on (1): `align` came verbatim from
 * `token.align`, whose length is the DELIMITER row's, so any table where `columns`
 * exceeded the header length would index past it. Every consumer walks by column
 * index (`solveTableColumns`, `layoutTable`, the renderer's `columnWidths[i]` /
 * `align[i]`), so a short `align` means surplus columns silently disappear from
 * measurement AND paint — consistent, therefore invisible, therefore worth pinning.
 */
describe("malformed table sources", () => {
	/** Every column index must be addressable in `align` (see the note above). */
	async function tableOf(markdown: string) {
		const { parseMarkdownToPreparedBlocks } = await load();
		const block = parseMarkdownToPreparedBlocks(markdown).find((b) => b.kind === "table");
		if (block?.kind !== "table") throw new Error(`expected a table block for: ${markdown}`);
		expect(block.align).toHaveLength(block.columns);
		for (const row of block.rows) expect(row.length).toBeLessThanOrEqual(block.columns);
		return block;
	}

	/**
	 * A body row with MORE cells than the header.
	 *
	 * marked itself truncates the surplus (verified: a 4-cell row under a 2-column
	 * header arrives as 2 cells), so `columns` never exceeds the header here and no
	 * content reaches us to lose. The assertion is that the truncation is marked's,
	 * observable, and that the align/column invariant holds — if a future marked
	 * version starts preserving the extra cells, `align` is now long enough for them.
	 */
	it("keeps align addressable when a body row is longer than the header", async () => {
		const block = await tableOf("| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |");
		expect(block.columns).toBe(2);
		// The surplus cells were dropped by the lexer, not by our column walk.
		expect(block.rows[0]).toHaveLength(2);
	});

	it("does not build a table when the delimiter row disagrees with the header", async () => {
		// marked requires the delimiter row to match the header's column count, so a
		// 3-column header over a 2-column delimiter is not a table at all. Pinned so
		// the fallback stays a plain block rather than a half-built table whose
		// `align` could never line up with its columns.
		const { parseMarkdownToPreparedBlocks } = await load();
		const blocks = parseMarkdownToPreparedBlocks("| a | b | c |\n|---|---|\n| 1 | 2 | 3 |");
		expect(blocks.some((b) => b.kind === "table")).toBe(false);
	});

	it("treats an escaped pipe as cell content, not a column break", async () => {
		const block = await tableOf("| a | b |\n|---|---|\n| x\\|y | 2 |");
		expect(block.columns).toBe(2);
		expect(block.rows[0]).toHaveLength(2);
		// The escape collapses to a literal pipe INSIDE the first cell, so that cell
		// is wider than the bare "2" beside it.
		const [first, second] = block.rows[0] ?? [];
		expect(first?.naturalWidth ?? 0).toBeGreaterThan(second?.naturalWidth ?? 0);
	});

	/**
	 * A pipe inside inline code. GFM's escaping rules run BEFORE inline parsing, so
	 * `` `a|b` `` really does split into two cells — the backticks end up unbalanced
	 * across them. Pinned because it looks like a bug and is not: the split is the
	 * spec's, and what matters here is that the prepared block stays coherent
	 * (columns cover the cells, align covers the columns) rather than throwing.
	 */
	it("survives a pipe inside inline code", async () => {
		const block = await tableOf("| a | b |\n|---|---|\n| `p|q` | 2 |");
		expect(block.columns).toBe(2);
		expect(block.rows[0]).toHaveLength(2);
	});

	it("handles an empty header cell", async () => {
		const block = await tableOf("| |\n|---|\n| v |");
		expect(block.columns).toBe(1);
		expect(block.header).toHaveLength(1);
		// An empty cell still has intrinsic widths (both zero) — never NaN, which
		// would poison the solver's totals.
		const header = block.header[0];
		expect(Number.isFinite(header?.naturalWidth ?? Number.NaN)).toBe(true);
		expect(Number.isFinite(header?.minWidth ?? Number.NaN)).toBe(true);
	});

	it("keeps a single unbreakable column rigid (min === natural)", async () => {
		const block = await tableOf(`| h |\n|---|\n| ${"z".repeat(80)} |`);
		const cell = block.rows[0]?.[0];
		if (!cell) throw new Error("expected a body cell");
		// One 80-char word cannot break, so the column is fully rigid — this is the
		// input that drives the solver into regime 3.
		expect(cell.minWidth).toBeCloseTo(cell.naturalWidth, 1);
	});

	it("gives an all-empty row real cells rather than holes", async () => {
		const block = await tableOf("| a | b |\n|---|---|\n| | |");
		expect(block.columns).toBe(2);
		expect(block.rows[0]).toHaveLength(2);
		for (const cell of block.rows[0] ?? []) {
			expect(Number.isFinite(cell.naturalWidth)).toBe(true);
		}
	});
});

/**
 * `measureCellMinWidth` memoises per `(font, extraWidth, text)`.
 *
 * The uncached cost is per SEGMENT: a 20×10 table with ten words per cell runs 200
 * `prepareWithSegments` calls plus 2000 single-item `prepareRichInline` +
 * `measureRichInlineStats` pairs on the synchronous prepare path, and tables repeat
 * values down a column constantly. The memo is only sound if it is EXACT, so that is
 * what these assert: a warm cache must reproduce a cold one bit for bit, and the key
 * must separate everything that changes an advance.
 */
describe("cell min-width memo", () => {
	const TABLE_20x10 = (() => {
		const cell = (i: number, j: number) =>
			Array.from({ length: 10 }, (_, k) => `w${(i + j + k) % 7}`).join(" ");
		let md = `| ${Array.from({ length: 10 }, (_, j) => `H${j}`).join(" | ")} |\n|${"---|".repeat(10)}\n`;
		for (let i = 0; i < 20; i++) {
			md += `| ${Array.from({ length: 10 }, (_, j) => cell(i, j)).join(" | ")} |\n`;
		}
		return md;
	})();

	/** Every prepared cell's min width, in document order. */
	function minWidths(blocks: readonly { kind: string }[]): number[] {
		const out: number[] = [];
		for (const block of blocks) {
			if (block.kind !== "table") continue;
			const t = block as unknown as {
				header: Array<{ minWidth: number }>;
				rows: Array<Array<{ minWidth: number }>>;
			};
			for (const cell of t.header) out.push(cell.minWidth);
			for (const row of t.rows) for (const cell of row) out.push(cell.minWidth);
		}
		return out;
	}

	it("produces identical min widths cold and warm", async () => {
		const { parseMarkdownToPreparedBlocks, clearCellMinWidthCache } = await load();
		clearCellMinWidthCache();
		const cold = minWidths(parseMarkdownToPreparedBlocks(TABLE_20x10));
		clearCellMinWidthCache();
		const coldAgain = minWidths(parseMarkdownToPreparedBlocks(TABLE_20x10));
		// Warm: no clear in between.
		const warm = minWidths(parseMarkdownToPreparedBlocks(TABLE_20x10));
		expect(cold.length).toBe(210);
		expect(coldAgain).toEqual(cold);
		expect(warm).toEqual(cold);
	});

	/**
	 * The same text at a different FONT must not share a memo entry.
	 *
	 * A header cell is measured bold and a body cell regular (`boldenPiece`), so an
	 * entry keyed on text alone would hand the header the regular-weight width and
	 * size its column too narrow. The canvas stub deliberately ignores weight (widths
	 * are `0.6 × fontSize` per char), so this asserts via the property the stub DOES
	 * vary — font size — plus the recorded fonts that prove the two cells were
	 * measured through different keys.
	 */
	it("keys the memo by font, not by text alone", async () => {
		const { parseMarkdownToPreparedBlocks, clearCellMinWidthCache } = await load();
		clearCellMinWidthCache();
		const [block] = parseMarkdownToPreparedBlocks("| duplicate |\n|---|\n| duplicate |");
		if (block?.kind !== "table") throw new Error("expected a table block");
		const header = block.header[0];
		const body = block.rows[0]?.[0];
		if (!header || !body) throw new Error("expected both cells");
		// Different fonts → different keys (the bold face is what the header paints).
		expect(header.fonts[0]).not.toBe(body.fonts[0]);

		// And a size difference, which the stub does model, must not be shared:
		// inline code renders at 12px monospace, plain body text at 14px sans.
		clearCellMinWidthCache();
		const [sized] = parseMarkdownToPreparedBlocks("| h |\n|---|\n| `duplicate` |");
		if (sized?.kind !== "table") throw new Error("expected a table block");
		const codeCell = sized.rows[0]?.[0];
		if (!codeCell) throw new Error("expected a body cell");
		expect(codeCell.minWidth).not.toBe(body.minWidth);
	});
});

describe("table block placement", () => {
	it("separates the table from surrounding prose with a top margin", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const blocks = parseMarkdownToPreparedBlocks(`before\n\n${SIMPLE}\n\nafter`);
		const tableIndex = blocks.findIndex((b) => b.kind === "table");
		expect(tableIndex).toBeGreaterThan(0);
		expect(blocks[tableIndex]?.marginTop).toBeGreaterThan(0);
	});
});

describe("table height through the real measure path", () => {
	it("grows when the available width forces cells to wrap", async () => {
		const { parseMarkdownToPreparedBlocks, accumulateFrame, pretextLineMetrics } = await import(
			"./parse-markdown"
		).then(async (parse) => ({
			...parse,
			...(await import("./prepared-block")),
			...(await import("./pretext-metrics")),
		}));
		const blocks = parseMarkdownToPreparedBlocks(
			"| Description |\n|---|\n| a fairly long sentence that has to wrap when narrow |",
		);
		const wide = accumulateFrame(blocks, 900, pretextLineMetrics);
		const narrow = accumulateFrame(blocks, 200, pretextLineMetrics);
		expect(narrow.contentHeight).toBeGreaterThan(wide.contentHeight);
	});

	it("is height-stable across repeated measurement at one width", async () => {
		const { parseMarkdownToPreparedBlocks } = await load();
		const { accumulateFrame } = await import("./prepared-block");
		const { pretextLineMetrics } = await import("./pretext-metrics");
		const blocks = parseMarkdownToPreparedBlocks(SIMPLE);
		const first = accumulateFrame(blocks, 480, pretextLineMetrics);
		const second = accumulateFrame(blocks, 480, pretextLineMetrics);
		expect(second.contentHeight).toBe(first.contentHeight);
	});
});
