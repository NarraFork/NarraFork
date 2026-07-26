import { describe, expect, it } from "bun:test";
import {
	findVisibleRange,
	itemIndexAtOffset,
	layoutItems,
	resolvePinnedRowIndices,
	spacerHeights,
} from "./vlist-virtualization";

describe("layoutItems", () => {
	it("lays out items with gaps and padding", () => {
		const { items, totalHeight } = layoutItems([100, 50, 200], 10, 8, 8);
		expect(items[0]).toEqual({ top: 8, height: 100, bottom: 108 });
		expect(items[1]).toEqual({ top: 118, height: 50, bottom: 168 });
		expect(items[2]).toEqual({ top: 178, height: 200, bottom: 378 });
		// last bottom (378) + bottomPadding (8), no trailing gap
		expect(totalHeight).toBe(386);
	});

	it("handles empty list", () => {
		const { items, totalHeight } = layoutItems([], 10, 8, 8);
		expect(items).toEqual([]);
		expect(totalHeight).toBe(16);
	});

	it("handles single item without trailing gap", () => {
		const { totalHeight } = layoutItems([100], 10, 0, 0);
		expect(totalHeight).toBe(100);
	});
});

describe("findVisibleRange", () => {
	const { items } = layoutItems([100, 100, 100, 100, 100], 0, 0, 0);
	// tops: 0,100,200,300,400 ; bottoms: 100,200,300,400,500

	it("finds items intersecting the viewport", () => {
		// viewport [150, 350) → items 1,2,3 (bottoms 200,300,400 > 150; tops < 350)
		const { start, end } = findVisibleRange(items, 150, 200, 0);
		expect(start).toBe(1);
		expect(end).toBe(4); // exclusive: item index 3 is last visible, end=4
	});

	it("includes overscan", () => {
		const { start, end } = findVisibleRange(items, 150, 200, 100);
		// minY=50 → first bottom>50 is item0; maxY=450 → first top>=450 is item5
		expect(start).toBe(0);
		expect(end).toBe(5);
	});

	it("returns empty range for empty list", () => {
		expect(findVisibleRange([], 0, 100, 0)).toEqual({ start: 0, end: 0 });
	});

	it("clamps at the top", () => {
		const { start } = findVisibleRange(items, 0, 100, 0);
		expect(start).toBe(0);
	});
});

describe("spacerHeights", () => {
	const { items, totalHeight } = layoutItems([100, 100, 100, 100, 100], 0, 0, 0);

	it("computes top and bottom spacers for a mounted window", () => {
		// mount [1,4) → top = items[1].top = 100 ; bottom = total(500) - items[3].bottom(400) = 100
		const { top, bottom } = spacerHeights(items, 1, 4, totalHeight);
		expect(top).toBe(100);
		expect(bottom).toBe(100);
	});

	it("no spacers when whole list mounted", () => {
		const { top, bottom } = spacerHeights(items, 0, 5, totalHeight);
		expect(top).toBe(0);
		expect(bottom).toBe(0);
	});

	it("handles empty list", () => {
		expect(spacerHeights([], 0, 0, 0)).toEqual({ top: 0, bottom: 0 });
	});
});

describe("itemIndexAtOffset", () => {
	const { items } = layoutItems([100, 100, 100], 0, 0, 0);
	it("finds the item containing an offset", () => {
		expect(itemIndexAtOffset(items, 0)).toBe(0);
		expect(itemIndexAtOffset(items, 150)).toBe(1);
		expect(itemIndexAtOffset(items, 250)).toBe(2);
	});
	it("clamps beyond the end", () => {
		expect(itemIndexAtOffset(items, 9999)).toBe(2);
	});
});

describe("resolvePinnedRowIndices", () => {
	const window = { start: 3, end: 7 };

	it("returns nothing when nothing is pinned", () => {
		expect(resolvePinnedRowIndices(window, null)).toEqual([]);
		expect(resolvePinnedRowIndices(window, undefined)).toEqual([]);
	});

	it("returns nothing when the pinned row is already inside the window", () => {
		expect(resolvePinnedRowIndices(window, 3)).toEqual([]);
		expect(resolvePinnedRowIndices(window, 6)).toEqual([]);
	});

	it("returns the pinned index when it fell outside the window", () => {
		expect(resolvePinnedRowIndices(window, 2)).toEqual([2]);
		// end is exclusive, so the first index past the window is outside
		expect(resolvePinnedRowIndices(window, 7)).toEqual([7]);
		expect(resolvePinnedRowIndices(window, 99)).toEqual([99]);
	});

	it("ignores invalid indices", () => {
		expect(resolvePinnedRowIndices(window, -1)).toEqual([]);
		expect(resolvePinnedRowIndices(window, 1.5)).toEqual([]);
		expect(resolvePinnedRowIndices(window, Number.NaN)).toEqual([]);
	});
});
