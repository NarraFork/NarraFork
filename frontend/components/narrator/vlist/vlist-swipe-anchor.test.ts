/**
 * vlist-swipe-anchor.test.ts — the anchor → row-index mapping that keeps touch
 * range-selection alive across scrolling.
 *
 * The bug this locks down: with the virtual list on, swiping row A open and then
 * scrolling far enough for A to leave the mounted window silently killed the
 * second half of the gesture. `useSwipeMenu`'s unmount cleanup drops both the
 * global anchor and its close handler, and `onTouchStart` needs BOTH to treat the
 * next swipe as a range-select — so the second swipe just opened its own menu.
 *
 * Pure index arithmetic, no DOM.
 */

import { describe, expect, it } from "bun:test";
import { resolveSwipeAnchorRowIndex } from "./vlist-swipe-anchor";

/** Row 0 is a plain markdown block, row 1 a folded trace with two tool rows. */
const ROWS: readonly (readonly string[])[] = [
	["msg-m1-0"],
	["tc-t1", "sa-t1", "tc-t2", "sa-t2"],
	["msg-m3-2"],
];

const at = (index: number) => ROWS[index];

describe("resolveSwipeAnchorRowIndex", () => {
	it("returns null when there is no anchor", () => {
		expect(resolveSwipeAnchorRowIndex(null, ROWS.length, at)).toBeNull();
		expect(resolveSwipeAnchorRowIndex(undefined, ROWS.length, at)).toBeNull();
		expect(resolveSwipeAnchorRowIndex("", ROWS.length, at)).toBeNull();
	});

	it("finds an element-level anchor", () => {
		expect(resolveSwipeAnchorRowIndex("msg-m1-0", ROWS.length, at)).toBe(0);
		expect(resolveSwipeAnchorRowIndex("msg-m3-2", ROWS.length, at)).toBe(2);
	});

	it("finds an anchor that is a ROW inside a folded trace", () => {
		// The pinned unit is the trace ELEMENT, not the row: unmounting the element
		// is what destroys the row's swipe hook.
		expect(resolveSwipeAnchorRowIndex("tc-t2", ROWS.length, at)).toBe(1);
	});

	it("matches either tool alias, since the anchor carries the primary id", () => {
		// The selection index files a tool under `tc-` or `sa-` depending on child
		// messages the trace row never sees, so a row reports both.
		expect(resolveSwipeAnchorRowIndex("sa-t1", ROWS.length, at)).toBe(1);
		expect(resolveSwipeAnchorRowIndex("tc-t1", ROWS.length, at)).toBe(1);
	});

	it("returns null for an anchor outside the loaded document", () => {
		// A swipe anchor from a narrator whose document was reloaded / paged away has
		// nothing to pin; the caller must not fabricate an index.
		expect(resolveSwipeAnchorRowIndex("msg-gone-0", ROWS.length, at)).toBeNull();
	});

	it("tolerates rows that report no ids and an empty document", () => {
		expect(resolveSwipeAnchorRowIndex("msg-m1-0", 3, () => null)).toBeNull();
		expect(resolveSwipeAnchorRowIndex("msg-m1-0", 3, () => undefined)).toBeNull();
		expect(resolveSwipeAnchorRowIndex("msg-m1-0", 0, at)).toBeNull();
		expect(resolveSwipeAnchorRowIndex("msg-m1-0", -1, at)).toBeNull();
	});

	it("stops at the first match", () => {
		// Guards against a scan that keeps walking (and would report the LAST row a
		// duplicated id appears in, pinning the wrong element).
		let reads = 0;
		const counted = (index: number) => {
			reads++;
			return ROWS[index];
		};
		expect(resolveSwipeAnchorRowIndex("msg-m1-0", ROWS.length, counted)).toBe(0);
		expect(reads).toBe(1);
	});
});
