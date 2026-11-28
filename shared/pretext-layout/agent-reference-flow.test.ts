import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RichInlineLine } from "@chenglou/pretext/rich-inline";
import {
	materializeRichInlineLineRange,
	measureRichInlineStats,
	prepareRichInline,
	walkRichInlineLineRanges,
} from "@chenglou/pretext/rich-inline";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";
import { agentReferenceHref, agentReferenceMarker } from "../agent-reference";
import { agentReferenceMetrics, inlineFlowForWidth } from "./agent-reference-flow";
import { parseMarkdownToPreparedBlocks } from "./parse-markdown";
import type { PreparedInlineBlock, PreparedTableCell } from "./prepared-block";
import {
	accumulateFrame,
	DEFAULT_TABLE_METRICS,
	layoutTable,
	tableRowLineHeight,
} from "./prepared-block";
import { typographyMetrics } from "./pretext-fonts";
import { pretextLineMetrics } from "./pretext-metrics";
import { letterSpacingForFont, resetTypographyForTest, setTypography } from "./typography";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);
afterEach(resetTypographyForTest);

const title = "检查完整的长任务标题并保留所有中文与 long words ".repeat(8).trim();
const reference = (label = title, id = "child") => `[${label}](${agentReferenceHref(id)})`;

function firstInline(markdown: string): PreparedInlineBlock {
	const block = parseMarkdownToPreparedBlocks(markdown).find((block) => block.kind === "inline");
	if (!block || block.kind !== "inline") throw new Error("expected inline block");
	return block;
}

function paint(source: PreparedInlineBlock | PreparedTableCell, width: number): RichInlineLine[] {
	const flow = inlineFlowForWidth(source, width);
	const lines: RichInlineLine[] = [];
	walkRichInlineLineRanges(flow, width, (range) => {
		lines.push(materializeRichInlineLineRange(flow, range));
	});
	return lines;
}

describe("agent reference inline atoms", () => {
	test("shares body typography and fixed chrome, including scaled and tight lines", () => {
		for (const fontScalePercent of [70, 100, 180]) {
			for (const lineHeightScalePercent of [60, 100, 185]) {
				setTypography({ fontScalePercent, lineHeightScalePercent, letterSpacingPercent: 15 });
				const metrics = agentReferenceMetrics();
				expect(metrics).toEqual({
					font: typographyMetrics().font.body,
					height: Math.max(20, typographyMetrics().line.body),
					maxWidth: 240,
					chromeWidth: 34,
					paddingX: 6,
					marginX: 2,
					statusWidth: 18,
					letterSpacing: letterSpacingForFont(typographyMetrics().font.body),
				});
				const block = firstInline(reference("任务"));
				expect(block.fonts).toEqual([metrics.font]);
				expect(block.lineHeight).toBeGreaterThanOrEqual(metrics.height);
			}
		}
	});

	test("flattens emphasis, code and whitespace into one complete single-line title", () => {
		const block = firstInline(`**${reference("  **检查** `src/a.ts`\n  与 *窄列*  ")}**`);
		expect(block.classNames).toEqual(["vlist-frag agent-reference-atom is-link"]);
		expect(block.hrefs).toEqual([agentReferenceMarker("child")]);
		expect(block.fonts).toEqual([agentReferenceMetrics().font]);
		const refs = block.agentReferences;
		expect(refs?.items).toHaveLength(1);
		expect(refs?.items[0]?.text).toBe("检查 src/a.ts 与 窄列");
		expect(refs?.items[0]?.break).toBe("never");
		expect(refs?.atoms).toHaveLength(1);
		expect(paint(block, 45)[0]?.fragments).toHaveLength(1);
		expect(paint(block, 45)[0]?.fragments[0]?.text).toBe("检查 src/a.ts 与 窄列");
	});

	test("treats explicit label breaks as spaces without creating another block", () => {
		const source = reference("first  \n**second  \nthird**");
		const blocks = parseMarkdownToPreparedBlocks(source);
		expect(blocks).toHaveLength(1);
		expect(firstInline(source).agentReferences?.items[0]?.text).toBe("first second third");
	});

	test("keeps the body font inside headings and image alt/math source inside the title", () => {
		const block = firstInline(`# ${reference("**任务** ![图说明](image.png)")}`);
		expect(block.fonts).toEqual([agentReferenceMetrics().font]);
		expect(block.agentReferences?.items[0]?.text).toBe("任务 图说明");
		let mathCalls = 0;
		const [mathBlock] = parseMarkdownToPreparedBlocks(reference("验算 $a*b*c$"), {
			katex: {
				__renderToHTMLTree() {
					mathCalls++;
					throw new Error("reference titles must remain plain text");
				},
				renderToString() {
					mathCalls++;
					throw new Error("reference titles must remain plain text");
				},
			},
		});
		if (mathBlock?.kind !== "inline") throw new Error("expected inline math title");
		expect(mathCalls).toBe(0);
		expect(mathBlock.agentReferences?.items[0]?.text).toBe("验算 $a*b*c$");
		expect(mathBlock.mathHtmls).toBeUndefined();
	});

	test("uses the real agent id when the normalized title is empty", () => {
		for (const label of ["", "   "]) {
			const block = firstInline(reference(label, "child-fallback"));
			expect(block.agentReferences?.items[0]?.text).toBe("child-fallback");
			expect(paint(block, 100)).toEqual(paint(firstInline(reference("child-fallback")), 100));
		}
	});

	test("caps the complete title with negative extraWidth rather than clipping its source", () => {
		for (const letterSpacingPercent of [-5, 0, 25]) {
			setTypography({ letterSpacingPercent });
			const block = firstInline(reference());
			expect(block.agentReferences?.items[0]?.text).toBe(title);
			expect(block.agentReferences?.items[0]?.extraWidth).toBeLessThan(0);
			const lines = paint(block, 500);
			expect(lines).toHaveLength(1);
			expect(lines[0]?.fragments).toHaveLength(1);
			expect(lines[0]?.fragments[0]?.text).toBe(title);
			expect(lines[0]?.fragments[0]?.occupiedWidth).toBeCloseTo(240, 6);
		}
	});

	test("adds only chrome to a short label using exactly the same letter spacing", () => {
		setTypography({ letterSpacingPercent: 15 });
		const block = firstInline(reference("测试 abc"));
		const { font, letterSpacing, chromeWidth } = agentReferenceMetrics();
		const plain = prepareRichInline([{ text: "测试 abc", font, break: "never", letterSpacing }]);
		const natural = measureRichInlineStats(plain, 1000).maxLineWidth;
		expect(paint(block, 1000)[0]?.width).toBeCloseTo(natural + chromeWidth, 6);
	});

	test("never merges adjacent equal-target references", () => {
		const block = firstInline(`${reference("任务")}${reference("任务")}`);
		expect(block.agentReferences?.atoms).toHaveLength(2);
		expect(block.agentReferences?.items.map((item) => item.text)).toEqual(["任务", "任务"]);
		expect(paint(block, 1000)[0]?.fragments).toHaveLength(2);
	});

	test("includes both chip margins when deciding whether adjacent references fit", () => {
		const single = firstInline(reference("任务"));
		const width = paint(single, 1000)[0]?.width;
		if (width === undefined) throw new Error("missing atom width");
		const adjacent = firstInline(`${reference("任务")}${reference("任务")}`);
		expect(agentReferenceMetrics().marginX * 2).toBe(4);
		expect(paint(adjacent, width * 2)).toHaveLength(1);
		expect(paint(adjacent, width * 2 - 1)).toHaveLength(2);
	});

	test("moves the whole capped atom to a fresh line, not the remainder of the current line", () => {
		const block = firstInline(`before ${reference()}`);
		const lines = paint(block, 260);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.fragments.map((fragment) => fragment.text)).toEqual(["before"]);
		expect(lines[1]?.fragments.map((fragment) => fragment.text)).toEqual([title]);
		expect(lines[1]?.width).toBeCloseTo(240, 6);
		expect(inlineFlowForWidth(block, 260)).toBe(block.flow);
	});

	test("measures and paints the same whole atom at every narrow content width", () => {
		const block = firstInline(reference());
		for (const width of [1, 15, 30, 80, 120, 239.5, 240, 360]) {
			const lines = paint(block, width);
			const metrics = pretextLineMetrics(block, width);
			expect(lines).toHaveLength(1);
			expect(lines[0]?.fragments).toHaveLength(1);
			expect(lines[0]?.fragments[0]?.text).toBe(title);
			expect(lines[0]?.fragments[0]?.occupiedWidth).toBeCloseTo(Math.min(width, 240), 6);
			expect(metrics.lineCount).toBe(lines.length);
			expect(metrics.maxLineWidth).toBeCloseTo(lines[0]?.width ?? 0, 6);
		}
	});

	test("uses the nested list/quote content column, not the outer frame width", () => {
		const block = firstInline(`> - ${reference()}`);
		expect(block.contentLeft).toBeGreaterThan(0);
		const width = 150;
		const frame = accumulateFrame([block], width, pretextLineMetrics);
		const lines = paint(block, width - block.contentLeft);
		expect(frame.usedWidth).toBeCloseTo(width, 6);
		expect(frame.blocks[0]?.height).toBe(block.lineHeight);
		expect(lines[0]?.fragments[0]?.occupiedWidth).toBeCloseTo(width - block.contentLeft, 6);
	});

	test("keeps source items immutable, supports serialization and bounds its width cache", () => {
		const block = firstInline(reference());
		const refs = block.agentReferences;
		if (!refs) throw new Error("missing reference metadata");
		const serialized = JSON.stringify(refs);
		for (const item of refs.items) Object.freeze(item);
		Object.freeze(refs.items);
		const first = inlineFlowForWidth(block, 60);
		expect(inlineFlowForWidth(block, 60)).toBe(first);
		for (const width of [70, 80, 90, 100]) inlineFlowForWidth(block, width);
		expect(inlineFlowForWidth(block, 60)).not.toBe(first);
		expect(inlineFlowForWidth(block, 1000)).toBe(block.flow);
		expect(JSON.stringify(refs)).toBe(serialized);
		expect(paint(block, 1000)[0]?.width).toBeCloseTo(240, 6);
		const restored = { ...block, agentReferences: structuredClone(refs) };
		expect(paint(restored, 80)).toEqual(paint(block, 80));
	});

	test("does not recompute reference geometry for status-only paint updates", () => {
		const block = firstInline(reference());
		const flow = inlineFlowForWidth(block, 80);
		for (const status of ["unknown", "running", "completed", "unavailable"]) {
			const updated = { ...block, data: { agentStatus: status } };
			expect(inlineFlowForWidth(updated, 80)).toBe(flow);
			expect(pretextLineMetrics(updated, 80)).toEqual(pretextLineMetrics(block, 80));
		}
	});

	test("does not retain raw inputs or change normal Markdown flow", () => {
		const block = firstInline("ordinary **bold** and `code` [link](https://example.com)");
		expect(block.agentReferences).toBeUndefined();
		expect(block.classNames.some((name) => name.includes("is-strong"))).toBe(true);
		expect(block.classNames.some((name) => name.includes("frag--code"))).toBe(true);
		for (const width of [1, 50, 500]) expect(inlineFlowForWidth(block, width)).toBe(block.flow);
		const [table] = parseMarkdownToPreparedBlocks("| header |\n|---|\n| ordinary text |");
		if (table?.kind !== "table") throw new Error("expected table");
		for (const cell of [...table.header, ...table.rows.flat()]) {
			expect(cell.agentReferences).toBeUndefined();
			expect(cell.inlineHeight).toBeUndefined();
		}
	});

	test("never turns invalid agent destinations into reference atoms", () => {
		for (const href of ["nf-agent://open?id=bad/id", "nf-agent://open?id=a&extra=1"]) {
			const block = firstInline(`[**normal** \`code\`](${href})`);
			expect(block.agentReferences).toBeUndefined();
			expect(block.classNames.some((name) => name.includes("is-strong"))).toBe(true);
			expect(block.classNames.some((name) => name.includes("frag--code"))).toBe(true);
		}
	});
});

describe("agent references inside table columns", () => {
	test("uses capped max-content, shrinkable min-content and regular body font in header cells", () => {
		const [table] = parseMarkdownToPreparedBlocks(`| ${reference()} |\n|---|\n| ${reference()} |`);
		if (table?.kind !== "table") throw new Error("expected table");
		for (const cell of [...table.header, ...table.rows.flat()]) {
			expect(cell.naturalWidth).toBeCloseTo(240, 6);
			expect(cell.minWidth).toBe(34);
			expect(cell.fonts).toEqual([agentReferenceMetrics().font]);
			expect(cell.inlineHeight).toBe(agentReferenceMetrics().height);
		}
	});

	test("forwards reference metadata to frame measurement and paints within solved columns", () => {
		const [table] = parseMarkdownToPreparedBlocks(
			`| ${reference()} | ${reference(title, "other")} |\n|---|---|\n| ${reference()} | ${reference()} |`,
		);
		if (table?.kind !== "table") throw new Error("expected table");
		for (const width of [120, 180, 300]) {
			const layout = layoutTable(
				table,
				width,
				(block, columnWidth) => {
					if (block.kind !== "inline") throw new Error("expected inline cell adapter");
					expect(block.agentReferences).toBeDefined();
					const lines = paint(block, columnWidth);
					const metrics = pretextLineMetrics(block, columnWidth);
					expect(metrics.lineCount).toBe(lines.length);
					expect(metrics.maxLineWidth).toBeLessThanOrEqual(columnWidth + 1e-6);
					return metrics;
				},
				DEFAULT_TABLE_METRICS,
			);
			expect(layout.overflowing).toBe(false);
			expect(layout.tableWidth).toBeLessThanOrEqual(width);
			for (const rowHeight of layout.rowHeights) {
				expect(rowHeight).toBe(
					agentReferenceMetrics().height + DEFAULT_TABLE_METRICS.paddingY * 2 + 1,
				);
			}
		}
	});

	test("raises table rows for the fixed minimum atom height at tight line spacing", () => {
		setTypography({ fontScalePercent: 70, lineHeightScalePercent: 60 });
		const [table] = parseMarkdownToPreparedBlocks(`| h |\n|---|\n| ${reference()} |`);
		if (table?.kind !== "table") throw new Error("expected table");
		expect(table.lineHeight).toBeLessThan(20);
		const row = table.rows[0];
		if (!row) throw new Error("missing body row");
		expect(tableRowLineHeight(row, table.lineHeight)).toBe(20);
		expect(tableRowLineHeight(table.header, table.lineHeight)).toBe(table.lineHeight);
		const layout = layoutTable(table, 100, pretextLineMetrics, DEFAULT_TABLE_METRICS);
		expect(layout.overflowing).toBe(false);
		expect(layout.rowHeights[1]).toBe(20 + DEFAULT_TABLE_METRICS.paddingY * 2 + 1);
	});
});
