import { describe, expect, it } from "bun:test";
import {
	FOLD_MAX_SHIFT_PX,
	type FoldRowGeometry,
	isAnimatableShift,
	isFoldCaptureUsable,
	planFoldMotion,
	visualShift,
} from "./vlist-fold-animation";

function geometry(entries: Array<[string, number, number]>): Map<string, FoldRowGeometry> {
	return new Map(entries.map(([key, top, height]) => [key, { top, height }]));
}

/**
 * The common case: the fold happened at or below the viewport top, so the anchored
 * rebuild had no scroll correction to make and document offsets ARE screen offsets.
 */
function still(
	before: Map<string, FoldRowGeometry>,
	after: Map<string, FoldRowGeometry>,
): {
	before: Map<string, FoldRowGeometry>;
	after: Map<string, FoldRowGeometry>;
	beforeScrollTop: number;
	afterScrollTop: number;
} {
	return { before, after, beforeScrollTop: 0, afterScrollTop: 0 };
}

describe("planFoldMotion", () => {
	it("reveals the toggled row and shifts everything the fold pushed down", () => {
		// card grows 40 → 240; the two rows below it move down by 200.
		const before = geometry([
			["a", 0, 100],
			["card", 104, 40],
			["b", 148, 60],
			["c", 212, 60],
		]);
		const after = geometry([
			["a", 0, 100],
			["card", 104, 240],
			["b", 348, 60],
			["c", 412, 60],
		]);
		const motions = planFoldMotion({ ...still(before, after), toggledKey: "card" });
		const byKey = new Map(motions.map((m) => [m.key, m]));

		// The row above the fold did not move, so it is not animated at all.
		expect(byKey.has("a")).toBe(false);
		// The toggled row keeps its final box and uncovers the new 200px.
		expect(byKey.get("card")).toEqual({ key: "card", kind: "reveal", fromInsetBottom: 200 });
		// Rows below start where they used to be and slide to their committed offset.
		expect(byKey.get("b")).toEqual({ key: "b", kind: "shift", fromOffset: -200 });
		expect(byKey.get("c")).toEqual({ key: "c", kind: "shift", fromOffset: -200 });
	});

	it("collapses by sliding the rows below up, with no reveal on the card", () => {
		// The expanded body is already unmounted when this plan runs, so there is
		// nothing left to clip away — the closing gap IS the animation.
		const before = geometry([
			["card", 0, 240],
			["b", 244, 60],
		]);
		const after = geometry([
			["card", 0, 40],
			["b", 44, 60],
		]);
		const motions = planFoldMotion({ ...still(before, after), toggledKey: "card" });
		const byKey = new Map(motions.map((m) => [m.key, m]));
		expect(byKey.has("card")).toBe(false);
		expect(byKey.get("b")).toEqual({ key: "b", kind: "shift", fromOffset: 200 });
	});

	it("slides the toggled row itself when a fold above it moved it on screen", () => {
		// It shrank (no reveal) AND moved: it must still travel with its neighbours
		// rather than being the one row that teleports.
		const before = geometry([["card", 300, 240]]);
		const after = geometry([["card", 100, 40]]);
		const motions = planFoldMotion({ ...still(before, after), toggledKey: "card" });
		expect(motions).toEqual([{ key: "card", kind: "shift", fromOffset: 200 }]);
	});

	it("gives the toggled row BOTH a reveal and a shift when expanding at the bottom", () => {
		// Pinned to the bottom: growing the card by 200 is answered with a +200
		// scrollTop write, so the card's header visibly travels up 200px while its body
		// unrolls. Emitting only the reveal left the one row that most obviously moved
		// as the only one that teleported.
		const before = geometry([["card", 500, 40]]);
		const after = geometry([["card", 500, 240]]);
		const motions = planFoldMotion({
			before,
			after,
			toggledKey: "card",
			beforeScrollTop: 300,
			afterScrollTop: 500,
		});
		expect(motions).toEqual([
			{ key: "card", kind: "reveal", fromInsetBottom: 200 },
			{ key: "card", kind: "shift", fromOffset: 200 },
		]);
	});

	it("leaves rows the anchored rebuild held still completely un-animated", () => {
		// Expanding a card above the viewport top shifts every following row by +200 in
		// the document, and the anchor answers with +200 scrollTop — so on screen those
		// rows did not move at all. Planning from raw document offsets would invent a
		// 200px slide for each of them, which is the artifact the anchor exists to
		// prevent.
		const before = geometry([
			["card", 0, 40],
			["b", 44, 60],
			["c", 108, 60],
		]);
		const after = geometry([
			["card", 0, 240],
			["b", 244, 60],
			["c", 308, 60],
		]);
		const motions = planFoldMotion({
			before,
			after,
			toggledKey: "card",
			beforeScrollTop: 1000,
			afterScrollTop: 1200,
		});
		// Neither following row is touched. The card itself is off-screen above and its
		// own top edge genuinely did move relative to the viewport, so it is allowed to
		// report that — it is not one of the rows the anchor held still.
		expect(motions.map((m) => m.key)).not.toContain("b");
		expect(motions.map((m) => m.key)).not.toContain("c");
	});

	it("ignores rows that were not mounted before the toggle", () => {
		// A fold that grows the document pulls new rows into the window. They have no
		// "from" geometry, and inventing one is what makes rows fly in from nowhere.
		const before = geometry([["card", 0, 40]]);
		const after = geometry([
			["card", 0, 240],
			["fresh", 244, 60],
		]);
		const motions = planFoldMotion({ ...still(before, after), toggledKey: "card" });
		expect(motions.map((m) => m.key)).toEqual(["card"]);
	});

	it("ignores rows that unmounted during the toggle", () => {
		const before = geometry([
			["card", 0, 240],
			["gone", 244, 60],
		]);
		const after = geometry([["card", 0, 40]]);
		const motions = planFoldMotion({ ...still(before, after), toggledKey: "card" });
		expect(motions).toEqual([]);
	});

	it("skips a toggled row whose own height did not change", () => {
		// A trace whose fold only affected a child: there is nothing to uncover, so it
		// must not get a degenerate zero-length clip animation.
		const before = geometry([["trace", 0, 80]]);
		const after = geometry([["trace", 0, 80]]);
		expect(planFoldMotion({ ...still(before, after), toggledKey: "trace" })).toEqual([]);
	});

	it("drops shifts too large to read as motion", () => {
		const before = geometry([
			["card", 0, 40],
			["far", 44, 60],
		]);
		const after = geometry([
			["card", 0, 40],
			["far", 44 + FOLD_MAX_SHIFT_PX + 1, 60],
		]);
		const motions = planFoldMotion({ ...still(before, after), toggledKey: "card" });
		// Sliding across tens of thousands of pixels in 200ms is a blur that loses the
		// reader's line; past the bound the row simply appears at its new offset.
		expect(motions).toEqual([]);
	});

	it("drops a reveal too large to read as motion", () => {
		const before = geometry([["card", 0, 40]]);
		const after = geometry([["card", 0, 40 + FOLD_MAX_SHIFT_PX + 1]]);
		expect(planFoldMotion({ ...still(before, after), toggledKey: "card" })).toEqual([]);
	});

	it("emits nothing when a rebuild moved nothing", () => {
		const before = geometry([
			["a", 0, 100],
			["b", 104, 60],
		]);
		const after = geometry([
			["a", 0, 100],
			["b", 104, 60],
		]);
		expect(planFoldMotion({ ...still(before, after), toggledKey: "a" })).toEqual([]);
	});
});

describe("visualShift", () => {
	it("measures displacement as the reader saw it, not as the document recorded it", () => {
		// Row moved +200 in the document and scrollTop moved +200: on screen, nothing.
		expect(visualShift(44, 244, 200)).toBe(0);
		// Row moved +200 with the viewport held still: a real 200px slide.
		expect(visualShift(44, 244, 0)).toBe(-200);
	});
});

describe("isAnimatableShift", () => {
	it("rejects sub-pixel and non-finite deltas", () => {
		expect(isAnimatableShift(0)).toBe(false);
		expect(isAnimatableShift(0.4)).toBe(false);
		expect(isAnimatableShift(Number.NaN)).toBe(false);
		expect(isAnimatableShift(Number.POSITIVE_INFINITY)).toBe(false);
	});

	it("accepts readable deltas in both directions", () => {
		expect(isAnimatableShift(20)).toBe(true);
		expect(isAnimatableShift(-20)).toBe(true);
		expect(isAnimatableShift(FOLD_MAX_SHIFT_PX)).toBe(true);
		expect(isAnimatableShift(FOLD_MAX_SHIFT_PX + 1)).toBe(false);
	});
});

describe("isFoldCaptureUsable", () => {
	it("requires a capture", () => {
		expect(isFoldCaptureUsable(null, 7, 1000)).toBe(false);
	});

	it("rejects a capture taken against a different document revision", () => {
		// A live WS patch / older page landed between the click and the commit: the
		// delta would mix the user's fold with a change they did not make.
		expect(isFoldCaptureUsable({ documentRevision: 6, capturedAt: 1000 }, 7, 1010)).toBe(false);
	});

	it("accepts a fresh capture on the same revision", () => {
		expect(isFoldCaptureUsable({ documentRevision: 7, capturedAt: 1000 }, 7, 1010)).toBe(true);
	});

	it("expires a stale capture so an unrelated later commit cannot consume it", () => {
		expect(isFoldCaptureUsable({ documentRevision: 7, capturedAt: 1000 }, 7, 2000)).toBe(false);
		expect(isFoldCaptureUsable({ documentRevision: 7, capturedAt: 1000 }, 7, 1400)).toBe(true);
	});
});
