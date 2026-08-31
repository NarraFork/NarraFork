/**
 * Horizontal swipe semantics for a recent-tab row.
 *
 * The two directions are NOT symmetric in consequence: right removes the tab, left only
 * moves it between the pinned and unpinned groups. A sign error therefore does not
 * degrade the gesture, it destroys work — which is the whole reason the classifier is a
 * pure function instead of two inline comparisons inside a touch handler.
 *
 * Left-swipe-to-pin exists because pinning had no touch entry point at all: the only
 * other way in is the right-click menu, and on touch that menu never opens (long-press
 * fires `contextmenu`, which the row suppresses so long-press-to-drag does not pop a
 * menu). The `canPin=false` cases below guard the rows that legitimately cannot pin.
 */

import { describe, expect, it } from "bun:test";
import { clampSwipeTravel, classifySwipeRelease, SWIPE_THRESHOLD } from "./recent-tabs-logic";

describe("classifySwipeRelease", () => {
	it("closes only past the threshold to the right", () => {
		expect(classifySwipeRelease(SWIPE_THRESHOLD + 1, true)).toBe("close");
		expect(classifySwipeRelease(SWIPE_THRESHOLD, true)).toBe("cancel");
		expect(classifySwipeRelease(SWIPE_THRESHOLD - 1, true)).toBe("cancel");
	});

	it("pins only past the threshold to the left", () => {
		expect(classifySwipeRelease(-(SWIPE_THRESHOLD + 1), true)).toBe("pin");
		expect(classifySwipeRelease(-SWIPE_THRESHOLD, true)).toBe("cancel");
		expect(classifySwipeRelease(-(SWIPE_THRESHOLD - 1), true)).toBe("cancel");
	});

	it("never closes on a leftward swipe, however far it travels", () => {
		// The asymmetry that matters: closing is destructive, pinning is not. A left
		// swipe reaching ten times the threshold must still only pin.
		expect(classifySwipeRelease(-SWIPE_THRESHOLD * 10, true)).toBe("pin");
	});

	it("cancels a leftward swipe when the row cannot be pinned", () => {
		expect(classifySwipeRelease(-(SWIPE_THRESHOLD + 1), false)).toBe("cancel");
		expect(classifySwipeRelease(-SWIPE_THRESHOLD * 10, false)).toBe("cancel");
	});

	it("still closes on a rightward swipe when the row cannot be pinned", () => {
		// Closing is independent of pinning capability; workspace children can be
		// closed but not pinned.
		expect(classifySwipeRelease(SWIPE_THRESHOLD + 1, false)).toBe("close");
	});

	it("cancels a resting row", () => {
		expect(classifySwipeRelease(0, true)).toBe("cancel");
		expect(classifySwipeRelease(0, false)).toBe("cancel");
	});
});

describe("clampSwipeTravel", () => {
	it("passes both directions through when the row can pin", () => {
		expect(clampSwipeTravel(40, true)).toBe(40);
		expect(clampSwipeTravel(-40, true)).toBe(-40);
	});

	it("suppresses left travel when the row cannot pin", () => {
		// A row that slides open, reveals nothing and springs back reads as broken,
		// so the gesture must not start at all.
		expect(clampSwipeTravel(-40, false)).toBe(0);
		expect(clampSwipeTravel(40, false)).toBe(40);
	});
});
