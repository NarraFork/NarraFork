import { beforeAll, describe, expect, test } from "bun:test";
import {
	documentBoundaryAtX,
	layoutTextDocumentLine,
	sliceDocumentVisualLine,
	type TextDocumentTypography,
} from "./text-document-layout";

let measuredFont = "";
beforeAll(() => {
	// Deterministic proportional canvas metrics. Production runs the same public
	// pretext API on the Worker's real OffscreenCanvas, not this test seam.
	const context = {
		font: "12px proportional",
		measureText(text: string) {
			measuredFont = this.font;
			let width = 0;
			for (const character of text)
				width += /[\u0300-\u036f\u200d]/u.test(character)
					? 0
					: character === "W"
						? 13
						: character === "i"
							? 3
							: character === " "
								? 4
								: (character.codePointAt(0) ?? 0) > 0xffff
									? 18
									: 7;
			return { width: width * (this.font.startsWith("24px") ? 2 : 1) };
		},
	};
	Object.assign(globalThis, {
		OffscreenCanvas: class {
			getContext() {
				return context;
			}
		},
	});
});
const options: TextDocumentTypography = {
	font: "12px proportional",
	lineHeight: 18,
	letterSpacing: 0,
	tabSize: 4,
	width: 80,
	wrap: true,
	fontRevision: 1,
	locale: "zh-CN",
};

describe("source-mapped real-font document line layout", () => {
	test("wrapping consumes source exactly and never cuts emoji/combining graphemes", () => {
		const text = "Wi中😀e\u0301\tWi中😀".repeat(20);
		const rows = layoutTextDocumentLine(text, 100, options);
		expect(rows.length).toBeGreaterThan(1);
		expect(measuredFont).toBe(options.font);
		expect(rows.map((row) => text.slice(row.start - 100, row.end - 100)).join("")).toBe(text);
		const legal = new Set(
			Array.from(
				new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(text),
				(part) => 100 + part.index,
			),
		);
		legal.add(100 + text.length);
		for (const row of rows) {
			expect(legal.has(row.start)).toBe(true);
			expect(legal.has(row.end)).toBe(true);
			for (const boundary of row.offsets) expect(legal.has(boundary)).toBe(true);
		}
	});
	test("proportional glyphs, font/spacing/width revisions and tabSize change actual geometry", () => {
		const wide = layoutTextDocumentLine("WWWWWWWW", 0, { ...options, wrap: false })[0];
		const narrow = layoutTextDocumentLine("iiiiiiii", 0, { ...options, wrap: false })[0];
		expect(wide.width).toBeGreaterThan(narrow.width * 3);
		const base = layoutTextDocumentLine("Wi ".repeat(30), 0, options);
		const larger = layoutTextDocumentLine("Wi ".repeat(30), 0, {
			...options,
			font: "24px proportional",
			fontRevision: 2,
		});
		const tighter = layoutTextDocumentLine("Wi ".repeat(30), 0, { ...options, width: 40 });
		const spaced = layoutTextDocumentLine("WiWi", 0, {
			...options,
			wrap: false,
			letterSpacing: 2,
		})[0];
		expect(larger.length).toBeGreaterThan(base.length);
		expect(tighter.length).toBeGreaterThan(base.length);
		expect(spaced.width).toBeGreaterThan(
			layoutTextDocumentLine("WiWi", 0, { ...options, wrap: false })[0].width,
		);
		const tab4 = layoutTextDocumentLine("W\tW", 0, { ...options, wrap: false, tabSize: 4 })[0];
		const tab8 = layoutTextDocumentLine("W\tW", 0, { ...options, wrap: false, tabSize: 8 })[0];
		expect(tab8.width).toBeGreaterThan(tab4.width);
		expect(
			layoutTextDocumentLine("W\tW", 0, { ...options, wrap: false, tabSize: 4 })[0].width,
		).toBe(tab4.width);
	});
	test("horizontal crop and pointer mapping are measured grapheme boundaries, not text length ratios", () => {
		const row = layoutTextDocumentLine("WiiiW😀e\u0301中".repeat(100), 300, {
			...options,
			wrap: false,
		})[0];
		const crop = sliceDocumentVisualLine(row, 300, 120);
		expect(crop.start).toBeGreaterThan(300);
		expect(crop.end - crop.start).toBeLessThan(100);
		expect(crop.points[0].x).toBe(crop.left);
		for (let i = 0; i < row.x.length; i++)
			expect(row.offsets[documentBoundaryAtX(row, row.x[i])]).toBe(row.offsets[i]);
	});
	test("100k and 1MiB single lines have bounded viewport crops but retain their full source index", () => {
		for (const length of [100_000, 1024 * 1024]) {
			const row = layoutTextDocumentLine("W".repeat(length), 0, { ...options, wrap: false })[0];
			expect(row.end).toBe(length);
			expect(row.offsets[row.offsets.length - 1]).toBe(length);
			const crop = sliceDocumentVisualLine(row, row.width / 2, 800);
			expect(crop.end - crop.start).toBeLessThan(100);
			expect(crop.points.length).toBeLessThan(100);
		}
	}, 30_000);
	test("empty and discretionary-only lines retain every original code unit", () => {
		const empty = layoutTextDocumentLine("", 20, options)[0];
		expect(empty.start).toBe(20);
		expect(empty.end).toBe(20);
		const text = "\u00ad\u200b";
		const rows = layoutTextDocumentLine(text, 10, options);
		expect(rows[0].start).toBe(10);
		expect(rows[rows.length - 1].end).toBe(12);
	});
});
