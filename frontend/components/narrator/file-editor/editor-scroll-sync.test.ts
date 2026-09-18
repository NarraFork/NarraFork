import { expect, test } from "bun:test";
import { buildAnchors, lineForScrollTop, scrollTopForLine } from "./editor-scroll-sync";

// A document where block heights are deliberately NON-linear in line count.
const anchors = buildAnchors([
	{ line: 0, top: 0, height: 100 },
	{ line: 3, top: 100, height: 150 },
	{ line: 13, top: 250, height: 300 },
	{ line: 14, top: 550, height: 50 },
	// Same as VS Code's final data-line sentinel at markdownDocument.lineCount.
	{ line: 15, top: 600, height: 1 },
]);

test("buildAnchors sorts, truncates heights to the next anchor and dedupes lines", () => {
	const built = buildAnchors([
		{ line: 4, top: 200, height: 40 },
		{ line: 0, top: 0, height: 500 }, // contains the others
		{ line: 2, top: 100, height: 40 },
		{ line: 2, top: 120, height: 40 }, // same source line as previous
	]);
	expect(built).toEqual([
		{ line: 0, top: 0, height: 100 },
		{ line: 2, top: 100, height: 40 },
		{ line: 4, top: 200, height: 40 },
	]);
});

test("scrollTopForLine is exact at anchor lines", () => {
	expect(scrollTopForLine(anchors, 0)).toBe(0);
	expect(scrollTopForLine(anchors, 3)).toBe(100);
	expect(scrollTopForLine(anchors, 13)).toBe(250);
	expect(scrollTopForLine(anchors, 14)).toBe(550);
});

test("scrollTopForLine interpolates inside a block's pixel span", () => {
	// Lines inside a multi-line block reveal the block's own midway pixels, so
	// walking the source through the block walks the preview through it.
	expect(scrollTopForLine(anchors, 8)).toBe(175);
	expect(scrollTopForLine(anchors, 4)).toBe(115);
	expect(scrollTopForLine(anchors, -5)).toBe(0);
});

test("a multi-source-line table no longer collapses to a single jump", () => {
	// Table: source lines 10..29 rendered as ONE anchored wrapper 400px tall,
	// paragraph anchors on either side. The old block-end+gap mapping pinned
	// the preview to the table's bottom edge for every line inside it.
	const tableAnchors = buildAnchors([
		{ line: 0, top: 0, height: 50 },
		{ line: 10, top: 50, height: 400 },
		{ line: 30, top: 450, height: 40 },
		{ line: 40, top: 490, height: 1 },
	]);
	expect(scrollTopForLine(tableAnchors, 10)).toBe(50);
	expect(scrollTopForLine(tableAnchors, 20)).toBe(250);
	expect(scrollTopForLine(tableAnchors, 29)).toBeCloseTo(50 + (19 / 20) * 400, 5);
});

test("scrollTopForLine and lineForScrollTop round-trip", () => {
	for (const line of [0, 1, 3, 4.5, 8, 12.9, 13, 13.5, 14]) {
		const top = scrollTopForLine(anchors, line);
		expect(top).not.toBeNull();
		expect(lineForScrollTop(anchors, top as number, 15, 10)).toBeCloseTo(line, 5);
	}
});

test("lineForScrollTop interpolates the visible block interval", () => {
	expect(lineForScrollTop(anchors, 0, 20, 10)).toBe(0);
	expect(lineForScrollTop(anchors, 100, 20, 10)).toBe(3);
	expect(lineForScrollTop(anchors, 250, 20, 10)).toBe(13);
	// Midway through the block from source line 3 to source line 13.
	expect(lineForScrollTop(anchors, 175, 20, 10)).toBe(8);
	// The sentinel bounds the tail at the document line count.
	expect(lineForScrollTop(anchors, 650, 15, 10)).toBe(15);
	expect(lineForScrollTop(anchors, 99999, 20, 10)).toBe(20);
});

test("empty anchors degrade gracefully", () => {
	expect(scrollTopForLine([], 5)).toBeNull();
	expect(lineForScrollTop([], 100, 20, 10)).toBe(0);
});
