import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	type LayoutCursor,
	type LayoutLineRange,
	layoutWithLines,
	measureNaturalWidth,
	prepareWithSegments,
	walkLineRanges,
} from "@chenglou/pretext";
import {
	createDiffDocument,
	type DiffLine,
	getDiffRowAnchor,
	projectDiffDocument,
} from "./diff-core";
import {
	type DiffLayoutOptions,
	type DiffRowLayout,
	type DiffRowsLayout,
	type DiffTypography,
	diffPositionAtOffset,
	diffRowAtOffset,
	diffRowBodyTop,
	diffRowTarget,
	diffTypography,
	diffVisualLineAtColumn,
	estimatedDiffRowTop,
	layoutDiffRows,
	sliceDiffFragments,
} from "./diff-layout";
import { parseUnifiedDiff } from "./parse-unified-diff";
import { resetTypographyForTest, setTypography } from "./typography";
import { findVisibleRange, spacerHeights } from "./vlist-virtualization";

const { installCanvasStub } = await import(
	"../../frontend/components/narrator/vlist/measure/test-canvas-stub"
);
beforeAll(() => installCanvasStub());
afterEach(() => resetTypographyForTest());
const line = (content: string): DiffLine => ({ type: "context", content });

/** Old materializing API is the oracle; it must not call the optimized walker. */
function materializedRowOracle(
	content: string,
	width: number,
	wrap: boolean,
	typography: DiffTypography,
): DiffRowLayout {
	if (!content) {
		return {
			content,
			visualLines: [{ start: 0, end: 0, width: 0 }],
			height: typography.lineHeight,
			width: 0,
		};
	}
	const prepared = prepareWithSegments(content, typography.font, {
		whiteSpace: "pre-wrap",
		letterSpacing: typography.letterSpacing,
	});
	if (!wrap) {
		const width = measureNaturalWidth(prepared);
		return {
			content,
			visualLines: [{ start: 0, end: content.length, width }],
			height: typography.lineHeight,
			width,
		};
	}
	// Independently translate normalized UTF-16 positions back to the source.
	const normalizedToSource = [0];
	for (let source = 0; source < content.length; source++) {
		if (content[source] === "\r" && content[source + 1] === "\n") source++;
		normalizedToSource.push(source + 1);
	}
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const consumedSourceEnd = (cursor: LayoutCursor) => {
		let { segmentIndex, graphemeIndex } = cursor;
		if (graphemeIndex === 0) {
			while (
				["soft-hyphen", "zero-width-break", "space"].includes(prepared.kinds[segmentIndex] ?? "")
			) {
				segmentIndex++;
			}
		}
		const prefix = prepared.segments.slice(0, segmentIndex).join("");
		const graphemes = Array.from(segmenter.segment(prepared.segments[segmentIndex] ?? ""));
		const partial = graphemes
			.slice(0, graphemeIndex)
			.map((part) => part.segment)
			.join("");
		return normalizedToSource[prefix.length + partial.length] ?? 0;
	};
	let end = 0;
	const visualLines = layoutWithLines(prepared, width, typography.lineHeight).lines.map((part) => {
		const start = end;
		end = consumedSourceEnd(part.end);
		return { start, end, width: part.width };
	});
	if (!visualLines.length) {
		visualLines.push({
			start: 0,
			end: consumedSourceEnd({ segmentIndex: 0, graphemeIndex: 0 }),
			width: 0,
		});
	}
	return {
		content,
		visualLines,
		height: visualLines.length * typography.lineHeight,
		width: Math.max(0, ...visualLines.map((part) => part.width)),
	};
}

/** Full field comparison includes exact row geometry and out-of-projection extent. */
function materializedLayoutOracle(
	lines: readonly DiffLine[],
	options: DiffLayoutOptions,
): DiffRowsLayout {
	const typography = options.typography ?? diffTypography();
	const wordWrap = options.wordWrap ?? false;
	const startRow = options.startRow ?? 0;
	const totalRows = options.totalRows ?? lines.length;
	const contentWidth = Math.max(1, options.contentWidth);
	const characters = options.lineNoWidth == null ? 2 : options.lineNoWidth * 2 + 2;
	const gutterWidth = measureNaturalWidth(
		prepareWithSegments("0".repeat(characters), typography.font, {
			whiteSpace: "pre-wrap",
			letterSpacing: typography.letterSpacing,
		}),
	);
	const rows = lines.map(({ content }) =>
		materializedRowOracle(content, Math.max(1, contentWidth - gutterWidth), wordWrap, typography),
	);
	const allHunks = options.hunks ?? [];
	const hunks = new Map(
		allHunks
			.filter((hunk) => hunk.rowIndex >= startRow && hunk.rowIndex < startRow + rows.length)
			.map((hunk) => [hunk.rowIndex - startRow, hunk]),
	);
	const hunkHeight = typography.lineHeight + 2;
	const beforeHeight =
		startRow * typography.lineHeight +
		allHunks.filter((hunk) => hunk.rowIndex < startRow).length * hunkHeight;
	const afterHeight =
		Math.max(0, totalRows - startRow - rows.length) * typography.lineHeight +
		allHunks.filter((hunk) => hunk.rowIndex >= startRow + rows.length).length * hunkHeight;
	let bottom = beforeHeight;
	const items = rows.map((row, index) => {
		const top = bottom;
		const height = row.height + (hunks.has(index) ? hunkHeight : 0);
		bottom += height;
		return { top, height, bottom };
	});
	return {
		items,
		totalHeight: bottom + afterHeight,
		rows,
		hunks,
		allHunks,
		startRow,
		totalRows,
		beforeHeight,
		afterHeight,
		gutterWidth,
		contentWidth,
		wordWrap,
		typography,
		maxWidth: Math.max(contentWidth, ...rows.map((row) => row.width + gutterWidth)),
	};
}

describe("viewport-local diff layout", () => {
	test("focus crosses 500 rows without growing the projection or paint window", () => {
		const text = Array.from({ length: 2_000 }, (_, i) => `a${i}`).join("\n");
		const doc = createDiffDocument({ oldText: text, newText: text, focusSide: "new" });
		const projection = projectDiffDocument(doc);
		const layout = layoutDiffRows(projection.lines, {
			contentWidth: 640,
			startRow: projection.startRow,
			totalRows: doc.totalRows,
		});
		const target = diffRowTarget(layout, projection.focusIndex, 5);
		expect(projection.lines).toHaveLength(500);
		expect(projection.startRow).toBe(1_500);
		expect(target).not.toBeNull();
		const range = findVisibleRange(layout.items, (target?.bottom ?? 0) - 200, 200, 100);
		expect(range.end - range.start).toBeLessThan(40);
		expect(range.end).toBeGreaterThan(projection.focusIndex);
		const space = spacerHeights(layout.items, range.start, range.end, layout.totalHeight);
		const painted = layout.items
			.slice(range.start, range.end)
			.reduce((sum, row) => sum + row.height, 0);
		expect(space.top + painted + space.bottom).toBe(layout.totalHeight);
	});

	test("two projections sharing a source retain independent reading coordinates", () => {
		const text = Array.from({ length: 1_600 }, (_, i) => `x${i}`).join("\n");
		const doc = createDiffDocument({ oldText: text, newText: text, focusSide: "new" });
		const reading = projectDiffDocument(doc, { anchor: getDiffRowAnchor(doc, 200) });
		const follower = projectDiffDocument(doc);
		const readerLayout = layoutDiffRows(reading.lines, {
			contentWidth: 100,
			startRow: reading.startRow,
			totalRows: doc.totalRows,
		});
		const followerLayout = layoutDiffRows(follower.lines, {
			contentWidth: 600,
			startRow: follower.startRow,
			totalRows: doc.totalRows,
		});
		expect(reading.anchorLost).toBe(false);
		expect(reading.lines[reading.anchorIndex]?.newPoint?.line).toBe(200);
		expect(follower.startRow).toBeGreaterThan(500);
		expect(diffRowAtOffset(readerLayout, 200 * readerLayout.typography.lineHeight)).toBe(200);
		expect(followerLayout.beforeHeight).toBeGreaterThan(readerLayout.beforeHeight);
		expect(doc).not.toHaveProperty("scrollTop");
		expect(doc).not.toHaveProperty("projection");
	});

	test("pretext wraps after the gutter using the scaled font and spacing", () => {
		const rows = [line("word ".repeat(30))];
		const options = { contentWidth: 160, wordWrap: true, lineNoWidth: 3 };
		const base = layoutDiffRows(rows, options);
		const withoutNumbers = layoutDiffRows(rows, { ...options, lineNoWidth: undefined });
		expect(base.rows[0]?.height).toBeGreaterThan(withoutNumbers.rows[0]?.height ?? 0);
		setTypography({ fontScalePercent: 160, letterSpacingPercent: 10 });
		const scaled = layoutDiffRows(rows, options, base);
		expect(scaled.typography.font).toContain("17.6px");
		expect(scaled.typography.letterSpacing).toBeCloseTo(1.76);
		expect(scaled.rows[0]?.height).toBeGreaterThan(base.rows[0]?.height ?? 0);
		const horizontal = layoutDiffRows(rows, { ...options, wordWrap: false });
		expect(horizontal.rows[0]?.height).toBe(diffTypography().lineHeight);
		expect(horizontal.maxWidth).toBeGreaterThan(options.contentWidth);
	});

	test("soft-wrap source columns and pixel offsets round-trip", () => {
		const layout = layoutDiffRows([line("abcdef".repeat(30))], {
			contentWidth: 96,
			wordWrap: true,
		});
		const position = diffPositionAtOffset(layout, layout.typography.lineHeight * 6 + 4);
		expect(position?.column).toBeGreaterThan(0);
		const target = diffRowTarget(layout, position?.index ?? 0, position?.column ?? 0);
		expect((target?.top ?? 0) + (position?.pixelOffset ?? 0)).toBe(
			layout.typography.lineHeight * 6 + 4,
		);
		const end = diffRowTarget(layout, 0, 1_000);
		expect(end?.bottom).toBe(layout.items[0]?.bottom);
	});

	test("soft hyphens use source boundaries, not removed or inserted display text", () => {
		const typography = {
			font: "11px monospace",
			fontSize: 11,
			lineHeight: 15,
			letterSpacing: 0,
		};
		const content = "ab\u00adcd ef\u00adgh ij\u00adkl";
		const wide = layoutDiffRows([line("ab\u00adcd")], {
			contentWidth: 500,
			wordWrap: true,
			typography,
		});
		expect(wide.rows[0]?.visualLines.map(({ start, end }) => [start, end])).toEqual([[0, 5]]);
		// 13.2px gutter + 22px text: each discretionary break paints "ab-",
		// but its source range includes SHY, never the synthetic ASCII hyphen.
		const narrow = layoutDiffRows([line(content)], {
			contentWidth: 35.2,
			wordWrap: true,
			typography,
		});
		expect(narrow.rows[0]?.visualLines.map(({ start, end }) => [start, end])).toEqual([
			[0, 3],
			[3, 6],
			[6, 9],
			[9, 12],
			[12, 15],
			[15, 17],
		]);
		const hidden = layoutDiffRows([line(content)], {
			contentWidth: 48,
			wordWrap: true,
			typography,
		});
		expect(hidden.rows[0]?.visualLines.map(({ start, end }) => [start, end])).toEqual([
			[0, 6],
			[6, 12],
			[12, 17],
		]);
	});

	for (const content of [
		"ab\u00adcd",
		"ab\u00adcd ef\u00adgh ij\u00adkl",
		"\u00adab\u00ad\u00adcd\u00ad",
		"\u00ad\u00ad",
		"👩‍💻\t\u00ad",
		"👩‍💻\t\u00ad\u00ad",
		"\u00ad\u00ad👩‍💻\t\u00ad\u00ad",
		"\u00ad👩‍💻\t\u00ad中\t\u00ad\u00ad",
		"ordinary characters with spaces   ",
		"\t变量 = '你好😀';  ".repeat(3),
		"abc👩‍💻de👨‍👩‍👧‍👦fg e\u0301\u00ad好😀xyz".repeat(3),
		" \t  \t ",
		"a\r\nb\rc\fd",
	]) {
		for (const contentWidth of [1, 35, 48, 65, 90, 500]) {
			test(`source slices and column anchors round-trip: ${JSON.stringify(content)}, width ${contentWidth}`, () => {
				const layout = layoutDiffRows([line(content)], { contentWidth, wordWrap: true });
				const row = layout.rows[0];
				expect(row).toBeDefined();
				if (!row) return;
				const visuals = row.visualLines;
				const graphemeBoundaries = new Set([
					...Array.from(
						new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(content),
						(part) => part.index,
					),
					content.length,
				]);
				expect(visuals.length).toBeGreaterThan(0);
				expect(visuals[0]?.start).toBe(0);
				expect(visuals.at(-1)?.end).toBe(content.length);
				expect(visuals.map(({ start, end }) => content.slice(start, end)).join("")).toBe(content);
				const parts = Array.from({ length: content.length }, (_, i) => ({
					content: content[i] ?? "",
					color: String(i),
				}));
				expect(
					visuals.flatMap(({ start, end }) => sliceDiffFragments(parts, start, end) ?? []),
				).toEqual(parts);
				for (const [index, visual] of visuals.entries()) {
					expect(visual.start).toBe(index === 0 ? 0 : visuals[index - 1]?.end);
					expect(graphemeBoundaries.has(visual.start)).toBe(true);
					expect(graphemeBoundaries.has(visual.end)).toBe(true);
					expect(visual.end).toBeGreaterThan(visual.start);
					for (let column = visual.start; column < visual.end; column++) {
						expect(diffVisualLineAtColumn(row, column)).toBe(index);
						const target = diffRowTarget(layout, 0, column);
						expect(target?.top).toBe(index * layout.typography.lineHeight);
						const anchor = diffPositionAtOffset(layout, (target?.top ?? 0) + 3);
						expect(anchor?.column).toBe(visual.start);
						expect(anchor?.pixelOffset).toBe(3);
						expect(diffRowTarget(layout, 0, anchor?.column ?? 0)).toEqual(target);
					}
				}
				expect(diffRowTarget(layout, 0, content.length)?.bottom).toBe(layout.totalHeight);
			});
		}
	}

	test("fixed-seed mixtures preserve every source unit at all tested widths", () => {
		const alphabet = ["a", "\u00ad", "中", "😀", "👩‍💻", "\t", " "];
		let seed = 17;
		const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (let sample = 0; sample < 150; sample++) {
			const length = 1 + (next() % 30);
			const content = Array.from({ length }, () => alphabet[next() % alphabet.length]).join("");
			for (const contentWidth of [14, 27, 65, 180]) {
				const layout = layoutDiffRows([line(content)], { contentWidth, wordWrap: true });
				const row = layout.rows[0];
				expect(row).toBeDefined();
				if (!row) return;
				expect(row.visualLines.map(({ start, end }) => content.slice(start, end)).join("")).toBe(
					content,
				);
				let previousEnd = 0;
				for (const [index, visual] of row.visualLines.entries()) {
					expect(visual.start).toBe(previousEnd);
					expect(visual.end).toBeGreaterThan(visual.start);
					previousEnd = visual.end;
					for (let column = visual.start; column < visual.end; column++) {
						expect(diffVisualLineAtColumn(row, column)).toBe(index);
						const target = diffRowTarget(layout, 0, column);
						const anchor = diffPositionAtOffset(layout, (target?.top ?? 0) + 3);
						expect(anchor?.column).toBe(visual.start);
						expect(anchor?.pixelOffset).toBe(3);
						expect(diffRowTarget(layout, 0, anchor?.column ?? 0)).toEqual(target);
					}
				}
				expect(previousEnd).toBe(content.length);
			}
		}
	});

	test("reuses unchanged row layouts only from the preceding local projection", () => {
		const options = { contentWidth: 120, wordWrap: true };
		const initial = layoutDiffRows([line("keep"), line("old")], options);
		const updated = layoutDiffRows([line("keep"), line("new")], options, initial);
		expect(updated.rows[0]).toBe(initial.rows[0]);
		expect(updated.rows[1]).not.toBe(initial.rows[1]);
		const resized = layoutDiffRows([line("keep")], { ...options, contentWidth: 70 }, updated);
		expect(resized.rows[0]).not.toBe(updated.rows[0]);
		expect(updated.rows).toHaveLength(2);
	});

	test("Git hunk bands contribute geometry without changing row data", () => {
		const parsed = parseUnifiedDiff(
			"@@ -12,2 +12,2 @@ first\n same\n-old\n+new\n@@ -90 +90 @@ far\n end",
		);
		const layout = layoutDiffRows(parsed.lines, { contentWidth: 500, hunks: parsed.hunks });
		expect(layout.hunks.size).toBe(2);
		expect(layout.totalHeight).toBe(
			parsed.lines.length * layout.typography.lineHeight + 2 * (layout.typography.lineHeight + 2),
		);
		expect(diffRowBodyTop(layout, 0)).toBe(layout.typography.lineHeight + 2);
		expect(layout.rows.map((row) => row.content)).toEqual(parsed.lines.map((row) => row.content));
	});

	test("wrapped ranges preserve CJK, tabs, astral characters and colour partitions", () => {
		const content = "\t变量 = '你好😀';  ".repeat(5);
		const layout = layoutDiffRows([line(content)], { contentWidth: 110, wordWrap: true });
		const visuals = layout.rows[0]?.visualLines ?? [];
		expect(visuals.map((part) => content.slice(part.start, part.end)).join("")).toBe(content);
		const tokens = [
			{ content: "abc", color: "red" },
			{ content: "def", color: "blue" },
		];
		expect(sliceDiffFragments(tokens, 2, 5)).toEqual([
			{ content: "c", color: "red" },
			{ content: "de", color: "blue" },
		]);
		const words = [{ value: "abc", removed: true }, { value: "def" }];
		expect(sliceDiffFragments(words, 1, 4)).toEqual([
			{ value: "bc", removed: true },
			{ value: "d" },
		]);
		expect(tokens[0]?.content).toBe("abc");
	});

	test("scroll coordinates retain Git hunk geometry beyond the current 500-row projection", () => {
		const parsed = parseUnifiedDiff(
			Array.from(
				{ length: 1_500 },
				(_, index) => `@@ -${index + 1} +${index + 1} @@\n row${index}`,
			).join("\n"),
		);
		const layout = layoutDiffRows(parsed.lines.slice(500, 1_000), {
			contentWidth: 400,
			startRow: 500,
			totalRows: parsed.lines.length,
			hunks: parsed.hunks,
		});
		const rowHeight = layout.typography.lineHeight * 2 + 2;
		for (const index of [0, 200, 499, 500, 999, 1_100, 1_499]) {
			expect(diffRowAtOffset(layout, index * rowHeight + 1)).toBe(index);
		}
		expect(layout.totalHeight).toBe(1_500 * rowHeight);
	});

	test("empty rows and empty documents have finite geometry", () => {
		expect(layoutDiffRows([], { contentWidth: 0 }).totalHeight).toBe(0);
		const layout = layoutDiffRows([line("")], { contentWidth: 1, wordWrap: true });
		expect(layout.rows[0]?.height).toBe(layout.typography.lineHeight);
		expect(diffRowTarget(layout, 0, 0)?.top).toBe(0);
	});
});

const oracleContents = [
	"",
	"short unique ASCII",
	"const extraordinarilyLongIdentifier = 'payload'; ".repeat(16),
	"变量你好世界，这是一个很长的中文行。".repeat(12),
	"😀👩‍💻👨‍👩‍👧‍👦e\u0301🇨🇳 ".repeat(8),
	"\talpha\t中\t😀\t  ",
	"first\r\n\r\n👩‍💻second\r\nlast\r\n",
	"ab\u00adcd ef\u00adgh ij\u00adkl",
	"\u00ad\u200b\u00ad👩‍💻\t\u00ad中\t\u200b\u00ad",
	"\u200b\u00ad\u200b\u00ad",
	"ab\u200bcd\u200bef\u200b",
	" \t  \t ",
	"a\r\nb\rc\fd",
];

function expectAnchorsMatch(actual: DiffRowsLayout, expected: DiffRowsLayout): void {
	for (const index of new Set([0, Math.floor(actual.rows.length / 2), actual.rows.length - 1])) {
		const row = actual.rows[index];
		if (!row) continue;
		for (const visual of row.visualLines) {
			for (const column of new Set([
				visual.start,
				visual.end,
				Math.floor((visual.start + visual.end) / 2),
			])) {
				expect(diffRowTarget(actual, index, column)).toEqual(
					diffRowTarget(expected, index, column),
				);
			}
			const target = diffRowTarget(actual, index, visual.start);
			const top = (target?.top ?? 0) + 3;
			expect(diffPositionAtOffset(actual, top)).toEqual(diffPositionAtOffset(expected, top));
			expect(diffRowAtOffset(actual, top)).toBe(diffRowAtOffset(expected, top));
		}
	}
	for (const index of [0, actual.startRow - 1, actual.startRow, actual.totalRows - 1]) {
		if (index < 0) continue;
		expect(estimatedDiffRowTop(actual, index, true)).toBe(
			estimatedDiffRowTop(expected, index, true),
		);
	}
	for (const top of [0, actual.beforeHeight - 1, actual.totalHeight - 1, actual.totalHeight]) {
		expect(diffRowAtOffset(actual, top)).toBe(diffRowAtOffset(expected, top));
	}
}

describe("non-materializing cold diff layout", () => {
	test("installed range API returns the same widths and cursors as layoutWithLines", () => {
		expect(typeof walkLineRanges).toBe("function");
		for (const content of oracleContents) {
			const prepared = prepareWithSegments(content, "11px monospace", { whiteSpace: "pre-wrap" });
			for (const width of [1, 22, 90, 600]) {
				const ranges: LayoutLineRange[] = [];
				const count = walkLineRanges(prepared, width, (range) => {
					expect(range).not.toHaveProperty("text");
					ranges.push(range);
				});
				const materialized = layoutWithLines(prepared, width, 15);
				expect(count).toBe(materialized.lineCount);
				expect(ranges).toEqual(
					materialized.lines.map(({ start, end, width }) => ({ start, end, width })),
				);
			}
		}
	});

	test("range walker does not access display strings while materializing API does", () => {
		const prepared = prepareWithSegments("unique 👩‍💻 ab\u00adcd\t中\r\nnext", "11px monospace", {
			whiteSpace: "pre-wrap",
		});
		const expected = layoutWithLines(prepared, 22, 15).lines.map(({ start, end, width }) => ({
			start,
			end,
			width,
		}));
		// No namespace spy/mock: exercise the real API with a forbidden string read.
		const geometryOnly = new Proxy(prepared, {
			get(target, property, receiver) {
				if (property === "segments") throw new Error("display strings accessed");
				return Reflect.get(target, property, receiver);
			},
		});
		const ranges: LayoutLineRange[] = [];
		expect(walkLineRanges(geometryOnly, 22, (range) => ranges.push(range))).toBe(expected.length);
		expect(ranges).toEqual(expected);
		expect(() => layoutWithLines(geometryOnly, 22, 15)).toThrow("display strings accessed");
	});

	for (const contentWidth of [1, 35, 120, 600]) {
		for (const lineNoWidth of [undefined, 3]) {
			for (const wordWrap of [false, true]) {
				for (const scaled of [false, true]) {
					test(`all fields match materialized oracle: width ${contentWidth}, numbers ${lineNoWidth}, wrap ${wordWrap}, scaled ${scaled}`, () => {
						if (scaled) setTypography({ fontScalePercent: 160, letterSpacingPercent: 10 });
						const options = { contentWidth, lineNoWidth, wordWrap };
						const rows = oracleContents.map(line);
						const actual = layoutDiffRows(rows, options);
						const expected = materializedLayoutOracle(rows, options);
						expect(actual).toEqual(expected);
						expectAnchorsMatch(actual, expected);
					});
				}
			}
		}
	}

	for (const wordWrap of [false, true]) {
		test(`500 cold unique rows match full geometry without previous reuse, wrap ${wordWrap}`, () => {
			const rows = Array.from({ length: 500 }, (_, index) =>
				line(`${index}: ${oracleContents[1 + (index % (oracleContents.length - 1))]}`),
			);
			expect(new Set(rows.map(({ content }) => content)).size).toBe(500);
			const options = { contentWidth: 180, wordWrap, lineNoWidth: 4 };
			const first = layoutDiffRows(rows, options);
			const expected = materializedLayoutOracle(rows, options);
			expect(first).toEqual(expected);
			expectAnchorsMatch(first, expected);
			const coldAgain = layoutDiffRows(rows, options);
			expect(coldAgain).toEqual(expected);
			for (let index = 0; index < rows.length; index++) {
				expect(coldAgain.rows[index]).not.toBe(first.rows[index]);
			}
			const uniqueNext = rows.map(({ content }) => line(`new ${content}`));
			const next = layoutDiffRows(uniqueNext, options, first);
			expect(next).toEqual(materializedLayoutOracle(uniqueNext, options));
			const previousRows = new Set(first.rows);
			expect(next.rows.some((row) => previousRows.has(row))).toBe(false);
		});
	}

	test("context projections retain full fields, focus anchors and exact hunk extent", () => {
		const text = Array.from(
			{ length: 1_800 },
			(_, index) => `${index} \t变量👩‍💻ab\u00adcd\u200bef ${"payload ".repeat(index % 8)}`,
		).join("\n");
		const doc = createDiffDocument({ oldText: text, newText: text, focusSide: "new" });
		const hunks = parseUnifiedDiff(
			Array.from({ length: 18 }, (_, index) => `@@ -${index + 1} +${index + 1} @@ band\n x`).join(
				"\n",
			),
		).hunks.map((hunk, index) => ({ ...hunk, rowIndex: index * 100 }));
		for (const anchorRow of [0, 240, 840, 1_799]) {
			const projection = projectDiffDocument(doc, { anchor: getDiffRowAnchor(doc, anchorRow) });
			const options = {
				contentWidth: 110,
				wordWrap: true,
				lineNoWidth: 4,
				startRow: projection.startRow,
				totalRows: doc.totalRows,
				hunks,
			};
			const actual = layoutDiffRows(projection.lines, options);
			const expected = materializedLayoutOracle(projection.lines, options);
			expect(actual).toEqual(expected);
			expect(actual.allHunks).toBe(hunks);
			expect(actual.rows).toHaveLength(projection.lines.length);
			expectAnchorsMatch(actual, expected);
			for (const index of [projection.anchorIndex, projection.focusIndex]) {
				expect(diffRowTarget(actual, index, 7)).toEqual(diffRowTarget(expected, index, 7));
			}
		}
	});

	test("previous-instance reuse and geometry invalidation remain unchanged", () => {
		const rows = [line("keep 👩‍💻\t中\u00ad字"), line("other unique row")];
		const options = { contentWidth: 120, wordWrap: true, lineNoWidth: 3 };
		const previous = layoutDiffRows(rows, options);
		const reordered = [...rows].reverse();
		const retained = layoutDiffRows(reordered, options, previous);
		expect(retained.rows[0]).toBe(previous.rows[1]);
		expect(retained.rows[1]).toBe(previous.rows[0]);
		expect(retained).toEqual(materializedLayoutOracle(reordered, options));
		const typography = previous.typography;
		for (const nextOptions of [
			{ ...options, contentWidth: 121 },
			{ ...options, wordWrap: false },
			{ ...options, lineNoWidth: 4 },
			{ ...options, typography: { ...typography, font: "17px monospace", fontSize: 17 } },
			{ ...options, typography: { ...typography, lineHeight: typography.lineHeight + 1 } },
			{ ...options, typography: { ...typography, letterSpacing: typography.letterSpacing + 1 } },
		]) {
			const updated = layoutDiffRows(rows, nextOptions, previous);
			expect(updated).toEqual(materializedLayoutOracle(rows, nextOptions));
			expect(updated.rows[0]).not.toBe(previous.rows[0]);
			expect(updated.rows[1]).not.toBe(previous.rows[1]);
		}
	});
});
