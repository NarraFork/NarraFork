import { expect, test } from "bun:test";
import { buildAnchors, lineForScrollTop, scrollTopForLine } from "./editor-scroll-sync";

// A document where block heights are deliberately NON-linear in line count:
// a 3-line heading 100px tall, a 10-line paragraph 150px tall, a 1-line fence
// marker owning 300px — exactly the case proportional sync gets wrong.
const anchors = buildAnchors([
	{ line: 0, top: 0, height: 100 },
	{ line: 3, top: 100, height: 150 },
	{ line: 13, top: 250, height: 300 },
	{ line: 14, top: 550, height: 50 },
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
		{ line: 2, top: 100, height: 100 },
		{ line: 4, top: 200, height: 40 },
	]);
});

test("scrollTopForLine is exact at anchor lines", () => {
	expect(scrollTopForLine(anchors, 0)).toBe(0);
	expect(scrollTopForLine(anchors, 3)).toBe(100);
	expect(scrollTopForLine(anchors, 13)).toBe(250);
	expect(scrollTopForLine(anchors, 14)).toBe(550);
});

test("scrollTopForLine interpolates BETWEEN anchors by line, not by total height", () => {
	// Line 8 is 5/10 of the way from line 3 to line 13: 100 + 0.5 * 150 — NOT
	// 5/10 of the whole document's pixels (which would be ~212).
	expect(scrollTopForLine(anchors, 8)).toBe(175);
	// One line into the 10-line paragraph: 10% of its 150px block.
	expect(scrollTopForLine(anchors, 4)).toBe(115);
	// Negative/head offsets pin to the top.
	expect(scrollTopForLine(anchors, -5)).toBe(0);
});

test("lineForScrollTop inverts the anchor interpolation", () => {
	expect(lineForScrollTop(anchors, 0, 20, 10)).toBe(0);
	expect(lineForScrollTop(anchors, 100, 20, 10)).toBe(3);
	expect(lineForScrollTop(anchors, 250, 20, 10)).toBe(13);
	// Mid paragraph: offset 175 sits between anchor 3 (top 100) and anchor 13
	// (top 250) → 3 + 0.5 * 10.
	expect(lineForScrollTop(anchors, 175, 20, 10)).toBe(8);
	// Past the last anchor: extend at the fallback line height, clamped to lineCount.
	expect(lineForScrollTop(anchors, 650, 30, 10)).toBe(24);
	expect(lineForScrollTop(anchors, 99999, 20, 10)).toBe(20);
});

test("round-trip: a fractional editor line lands on the same preview offset it came from", () => {
	for (const offset of [30, 130, 240, 400, 560]) {
		const line = lineForScrollTop(anchors, offset, 20, 10);
		expect(scrollTopForLine(anchors, line, 10)).toBeCloseTo(offset, 5);
	}
});

test("empty anchors degrade gracefully", () => {
	expect(scrollTopForLine([], 5)).toBeNull();
	expect(lineForScrollTop([], 100, 20, 10)).toBe(0);
});
