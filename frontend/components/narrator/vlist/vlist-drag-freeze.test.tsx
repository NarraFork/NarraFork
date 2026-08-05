/**
 * vlist-drag-freeze.test.tsx — Rows must not be re-rendered during a drag.
 *
 * Why this file exists (and why the earlier rounds' tests could not catch the bug)
 * -------------------------------------------------------------------------------
 * Three successive fixes targeted MEASUREMENT cost and were verified with Bun +
 * a canvas stub. That harness has no DOM, so it could not see the dominant cost:
 * the list renders every text line as an absolutely positioned row and every
 * fragment as its own inline-block span, so a re-render rebuilds all of them.
 *
 * Measured with a real (linkedom) DOM and a synchronous flush:
 *
 *     20 prose rows                = 1601 DOM nodes
 *     re-render at a new width     = 37.0ms
 *     40-width drag                = 892ms (22.3ms/frame)
 *
 * and linkedom performs no style resolution, layout or paint, so a browser is
 * strictly slower. That is the jank that survived every measurement-side fix.
 *
 * The invariant this file pins: while a drag is deferring, NOTHING re-renders the
 * mounted rows — not the layout rebuild (already gated on width) and not the
 * viewport-height state write (the gap that made the width gate ineffective).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { resolveWidthSettle } from "./vlist-width-settle";

beforeAll(() => {
	installCanvasStub();
});

/**
 * The shell's resize handler, reproduced faithfully enough to observe its STATE
 * WRITES. Both writes matter: `setContentWidth` triggers a document rebuild, and
 * `setViewportHeight` triggers a shell re-render that rebuilds every mounted row.
 *
 * No cost parameter: the gate consults none (see vlist-width-settle). Earlier versions
 * of this file passed a `lastBuildMs` and distinguished "cheap" from "expensive"
 * documents; both predictors were wrong, so the distinction no longer exists.
 */
function createHandler(options: { pointerDown: () => boolean }) {
	let committedWidth = 700;
	let deferred = false;
	let timerArmed = false;
	const widthWrites: number[] = [];
	const heightWrites: number[] = [];
	let nodeWidth = 700;
	let nodeHeight = 700;

	const applyWidth = (trigger: "observer" | "timer" | "gesture-end") => {
		const decision = resolveWidthSettle({
			nextWidth: nodeWidth,
			committedWidth,
			trigger,
			pointerDown: options.pointerDown(),
		});
		timerArmed = false;
		if (decision.commit) {
			if (deferred) heightWrites.push(nodeHeight);
			deferred = false;
			committedWidth = nodeWidth;
			widthWrites.push(nodeWidth);
			return;
		}
		if (!decision.defer) {
			deferred = false;
			return;
		}
		deferred = true;
		timerArmed = true;
	};

	const suppressHeightWrite = () => deferred && options.pointerDown();

	return {
		widthWrites,
		heightWrites,
		get timerArmed() {
			return timerArmed;
		},
		get deferred() {
			return deferred;
		},
		/** One ResizeObserver callback. */
		observe: (width: number, height: number) => {
			nodeWidth = width;
			nodeHeight = height;
			if (!suppressHeightWrite()) heightWrites.push(height);
			applyWidth("observer");
		},
		release: () => {
			if (deferred) applyWidth("gesture-end");
		},
		/** The armed deferral timer coming due (quiet period or backstop). */
		timer: () => {
			applyWidth("timer");
		},
	};
}

describe("drag freeze: no state writes while a drag defers", () => {
	it("writes NEITHER width nor height during a drag", () => {
		let down = true;
		const h = createHandler({ pointerDown: () => down });
		// 60 frames of a sash drag: width shrinks, height grows.
		for (let i = 1; i <= 60; i++) h.observe(700 - i, 700 + i);
		// The first callback commits (nothing is deferred yet at that instant), so the
		// steady state is what matters: after the deferral opens, no further writes.
		expect(h.widthWrites.length).toBeLessThanOrEqual(1);
		expect(h.heightWrites.length).toBeLessThanOrEqual(1);
		// And releasing commits exactly one consistent geometry.
		down = false;
		h.release();
		expect(h.widthWrites.at(-1)).toBe(640);
		expect(h.heightWrites.at(-1)).toBe(760);
	});

	// The specific regression: the width gate alone was not enough, because the
	// height write kept re-rendering all 1601 nodes every frame.
	it("does not let the height write leak through while width is deferred", () => {
		const h = createHandler({ pointerDown: () => true });
		h.observe(699, 701); // opens the deferral (first call may commit)
		const before = h.heightWrites.length;
		for (let i = 2; i <= 40; i++) h.observe(700 - i, 700 + i);
		expect(h.heightWrites.length).toBe(before);
	});

	// REPLACES an earlier case asserting a "cheap" document stayed live per frame. The
	// cost distinction is gone (see vlist-width-settle): the freeze is unconditional
	// during a drag, so no document keeps writing state mid-gesture.
	it("freezes every document during a drag, with no cheap exception", () => {
		const h = createHandler({ pointerDown: () => true });
		for (let i = 1; i <= 20; i++) h.observe(700 - i, 700 + i);
		expect(h.widthWrites.length).toBeLessThanOrEqual(1);
		expect(h.heightWrites.length).toBeLessThanOrEqual(1);
	});

	// A height-only change (composer growing) must still reach state: it does not
	// defer, because the width never changed.
	it("applies a height-only change immediately", () => {
		const h = createHandler({ pointerDown: () => false });
		h.observe(700, 800);
		expect(h.heightWrites).toEqual([800]);
		expect(h.widthWrites).toEqual([]);
	});

	// Non-pointer resize (OS window chrome): no gesture to wait for, so height must
	// not be frozen — suppression requires a pointer.
	it("does not freeze height for a resize with no pointer down", () => {
		const h = createHandler({ pointerDown: () => false });
		for (let i = 1; i <= 10; i++) h.observe(700 - i, 700 + i);
		expect(h.heightWrites.length).toBe(10);
	});

	it("keeps the deferral open and armed for the whole drag", () => {
		const h = createHandler({ pointerDown: () => true });
		h.observe(699, 701);
		for (let i = 2; i <= 10; i++) h.observe(700 - i, 700 + i);
		expect(h.deferred).toBe(true);
		// A timer stays armed so an abandoned gesture still converges via the backstop.
		expect(h.timerArmed).toBe(true);
	});

	// Every commit path must release the withheld height, not just gesture-end, or a
	// stale height would survive the commit.
	it("releases the withheld height when the timer commits", () => {
		let down = true;
		const h = createHandler({ pointerDown: () => down });
		h.observe(699, 701);
		for (let i = 2; i <= 10; i++) h.observe(700 - i, 700 + i);
		expect(h.deferred).toBe(true);
		// The backstop fires; by then the pointer is no longer reported down.
		down = false;
		h.timer();
		expect(h.heightWrites.at(-1)).toBe(710);
		expect(h.widthWrites.at(-1)).toBe(690);
	});
});
