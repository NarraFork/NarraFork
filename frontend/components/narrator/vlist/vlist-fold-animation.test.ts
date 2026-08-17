import { describe, expect, it } from "bun:test";
import {
	FOLD_MAX_SHIFT_PX,
	type FoldRowGeometry,
	isAnimatableShift,
	isFoldCaptureUsable,
	planFoldFrameMotion,
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

	it("needs the POST-correction scrollTop at the bottom, not the value it starts from", () => {
		// The case above assumes the pin has already happened. This one pins down WHY
		// the caller must not simply read `node.scrollTop` while pinned to the bottom.
		//
		// Same expand as above (card grows 200 at document top 500, viewport pinned so
		// scrollTop travels 300 → 500), but planned from the scrollTop the container
		// still holds during the layout phase. The document did not move the card's top
		// edge, so with scrollDelta 0 the plan says "nothing shifted" — the card's
		// header teleports 200px up while its body unrolls, which is precisely the
		// artifact the shift half exists to prevent.
		const before = geometry([["card", 500, 40]]);
		const after = geometry([["card", 500, 240]]);
		const stale = planFoldMotion({
			before,
			after,
			toggledKey: "card",
			beforeScrollTop: 300,
			// UNCORRECTED: the pin has not written yet.
			afterScrollTop: 300,
		});
		expect(stale).toEqual([{ key: "card", kind: "reveal", fromInsetBottom: 200 }]);
		expect(stale.some((m) => m.kind === "shift")).toBe(false);

		// Rows below the card are wrong the same way, and more visibly: they DO move in
		// the document, and with an uncorrected scroll delta the plan invents a 200px
		// downward slide for rows the pin is about to hold still on screen.
		const beforeBelow = geometry([
			["card", 500, 40],
			["b", 544, 60],
		]);
		const afterBelow = geometry([
			["card", 500, 240],
			["b", 744, 60],
		]);
		expect(
			planFoldMotion({
				before: beforeBelow,
				after: afterBelow,
				toggledKey: "card",
				beforeScrollTop: 300,
				afterScrollTop: 300,
			}).find((m) => m.key === "b"),
		).toEqual({ key: "b", kind: "shift", fromOffset: -200 });
		// With the corrected (predicted) value the row is left alone, because on screen
		// the pin held it exactly where it was.
		expect(
			planFoldMotion({
				before: beforeBelow,
				after: afterBelow,
				toggledKey: "card",
				beforeScrollTop: 300,
				afterScrollTop: 500,
			}).find((m) => m.key === "b"),
		).toBeUndefined();
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

describe("planFoldFrameMotion", () => {
	it("grows a frame's bottom edge when a card inside the run expanded", () => {
		// The artifact this exists for: the border was written at its final 440px on the
		// commit frame while the cards inside it were still animating into place.
		const motions = planFoldFrameMotion({
			before: geometry([["run:t1", 100, 240]]),
			after: geometry([["run:t1", 100, 440]]),
			beforeScrollTop: 0,
			afterScrollTop: 0,
		});
		expect(motions).toEqual([
			{ key: "run:t1", from: { top: 100, height: 240 }, to: { top: 100, height: 440 } },
		]);
	});

	it("shrinks a frame's bottom edge on collapse", () => {
		// Unlike a row, a frame CAN animate on collapse: its box is derived from the
		// rows, so the closing gap is expressible as a height change on a live element.
		const motions = planFoldFrameMotion({
			before: geometry([["run:t1", 100, 440]]),
			after: geometry([["run:t1", 100, 240]]),
			beforeScrollTop: 0,
			afterScrollTop: 0,
		});
		expect(motions).toEqual([
			{ key: "run:t1", from: { top: 100, height: 440 }, to: { top: 100, height: 240 } },
		]);
	});

	it("travels a whole frame when a fold ABOVE the run displaced it", () => {
		// Top edge moves, size does not. Gating on the height delta alone would have
		// dropped this case entirely.
		const motions = planFoldFrameMotion({
			before: geometry([["run:t1", 100, 240]]),
			after: geometry([["run:t1", 300, 240]]),
			beforeScrollTop: 0,
			afterScrollTop: 0,
		});
		expect(motions).toEqual([
			{ key: "run:t1", from: { top: 100, height: 240 }, to: { top: 300, height: 240 } },
		]);
	});

	it("starts from where the reader last saw the frame, not from its old document offset", () => {
		// Expanding a card above the viewport top shifts the document by +200 and the
		// anchor answers with +200 scrollTop: the frame did not move on screen, so it
		// must not animate at all.
		const motions = planFoldFrameMotion({
			before: geometry([["run:t1", 100, 240]]),
			after: geometry([["run:t1", 300, 240]]),
			beforeScrollTop: 1000,
			afterScrollTop: 1200,
		});
		expect(motions).toEqual([]);
	});

	it("animates the moving edge while a visually-still edge holds its committed value", () => {
		// The run's document top moved +200 (a fold above it) and the anchor absorbed
		// exactly that into scrollTop, so its top held still ON SCREEN — while a card
		// inside it grew by 200, moving only the bottom edge. The `from` box must
		// therefore start at the COMMITTED top (300), not at the stale document top
		// (100) the reader never saw at that scroll position.
		const motions = planFoldFrameMotion({
			before: geometry([["run:t1", 100, 240]]),
			after: geometry([["run:t1", 300, 440]]),
			beforeScrollTop: 0,
			afterScrollTop: 200,
		});
		expect(motions).toEqual([
			{ key: "run:t1", from: { top: 300, height: 240 }, to: { top: 300, height: 440 } },
		]);
	});

	it("ignores frames absent from either side", () => {
		// A run that only exists after the fold has no box to travel from; one that is
		// gone has nothing left to animate.
		const motions = planFoldFrameMotion({
			before: geometry([["run:gone", 0, 100]]),
			after: geometry([["run:fresh", 0, 100]]),
			beforeScrollTop: 0,
			afterScrollTop: 0,
		});
		expect(motions).toEqual([]);
	});

	it("emits nothing for a frame that did not move", () => {
		const box = geometry([["run:t1", 100, 240]]);
		expect(
			planFoldFrameMotion({ before: box, after: box, beforeScrollTop: 0, afterScrollTop: 0 }),
		).toEqual([]);
	});

	it("ignores sub-pixel drift", () => {
		expect(
			planFoldFrameMotion({
				before: geometry([["run:t1", 100, 240.4]]),
				after: geometry([["run:t1", 100.2, 240]]),
				beforeScrollTop: 0,
				afterScrollTop: 0,
			}),
		).toEqual([]);
	});

	it("drops a frame whose movement is too large to read, matching its rows", () => {
		// The rows inside would refuse this shift, and a border that animates while its
		// contents teleport is worse than both jumping together.
		expect(
			planFoldFrameMotion({
				before: geometry([["run:t1", 100, 240]]),
				after: geometry([["run:t1", 100, 240 + FOLD_MAX_SHIFT_PX + 1]]),
				beforeScrollTop: 0,
				afterScrollTop: 0,
			}),
		).toEqual([]);
	});

	it("drops the whole frame when one edge is readable and the other is not", () => {
		// Animating only the readable edge would deform the box mid-flight.
		expect(
			planFoldFrameMotion({
				before: geometry([["run:t1", 100, 240]]),
				after: geometry([["run:t1", 300, 240 + FOLD_MAX_SHIFT_PX + 1]]),
				beforeScrollTop: 0,
				afterScrollTop: 0,
			}),
		).toEqual([]);
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
	/** A capture taken at revision 7, level 4, t=1000. */
	const capture = (over: Partial<{ documentRevision: number; capturedAt: number; lod: number }>) =>
		({ documentRevision: 7, capturedAt: 1000, lod: 4, ...over }) as {
			documentRevision: number;
			capturedAt: number;
			lod: number;
		};

	it("requires a capture", () => {
		expect(isFoldCaptureUsable(null, 7, 1000, 4)).toBe(false);
	});

	it("rejects a capture taken against a different document revision", () => {
		// A live WS patch / older page landed between the click and the commit: the
		// delta would mix the user's fold with a change they did not make.
		expect(isFoldCaptureUsable(capture({ documentRevision: 6 }), 7, 1010, 4)).toBe(false);
	});

	it("accepts a fresh capture on the same revision and level", () => {
		expect(isFoldCaptureUsable(capture({}), 7, 1010, 4)).toBe(true);
	});

	it("expires a stale capture so an unrelated later commit cannot consume it", () => {
		expect(isFoldCaptureUsable(capture({}), 7, 2000, 4)).toBe(false);
		expect(isFoldCaptureUsable(capture({}), 7, 1400, 4)).toBe(true);
	});

	/**
	 * The LOD check is the one no other discriminator can stand in for: an LOD switch
	 * advances NO document revision (it is a build option, exactly like a fold), so a
	 * fold followed by a pinch inside the age bound passes both other checks. Consuming
	 * the capture there puts the fold controller and the LOD morph controller on the
	 * same node's `transform` in one frame, with an undefined winner.
	 */
	it("rejects a capture whose level moved (a pinch right after a fold)", () => {
		expect(isFoldCaptureUsable(capture({ lod: 4 }), 7, 1010, 3)).toBe(false);
		expect(isFoldCaptureUsable(capture({ lod: 4 }), 7, 1010, 5)).toBe(false);
	});
});
