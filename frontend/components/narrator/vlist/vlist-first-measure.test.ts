/**
 * vlist-first-measure.test.ts — The FIRST measurement commits immediately.
 *
 * The list starts with `contentWidth = 0`, a sentinel meaning "not measured yet". The
 * first ResizeObserver pass — which the layout effect runs synchronously at mount — is
 * therefore not a width CHANGE but this list learning how wide it is, and it must
 * reach state before the browser paints.
 *
 * Routed through `resolveWidthSettle` it did not: with no pointer down, an observer
 * callback DEFERS for WIDTH_SETTLE_DELAY_MS. So the placeholder painted a frame at the
 * sentinel geometry and the column jumped to its real width 140ms later, which was the
 * first of the mount-time width jumps.
 *
 * The fast path must not weaken the rest of the gate, so the same handler shape is
 * driven through the sequences that matter afterwards: a drag still freezes, a
 * pointer-free resize still settles on the quiet period, and the feedback-cycle guard
 * still sees only real commits. That is why this reproduces the handler (as
 * vlist-drag-freeze does) rather than testing the sentinel comparison in isolation —
 * the property is about ORDER, not arithmetic.
 */

import { describe, expect, it } from "bun:test";
import {
	pushCommittedWidth,
	resolveWidthSettle,
	WIDTH_SETTLE_DELAY_MS,
	type WidthSettleTrigger,
} from "./vlist-width-settle";

/**
 * The shell's `applyWidth`, reproduced with its first-measurement fast path.
 *
 * Mirrors PretextExactMessageList: the sentinel test runs BEFORE the settle decision,
 * commits without arming a timer, and leaves the cycle ring untouched.
 */
function createHandler(options: { pointerDown?: () => boolean } = {}) {
	const pointerDown = options.pointerDown ?? (() => false);
	let committedWidth = 0;
	let deferred = false;
	let armedDelay: number | null = null;
	let recent: readonly number[] = [];
	const commits: number[] = [];
	/** Commits that consulted the settle decision (i.e. everything but the first). */
	const settledCommits: number[] = [];
	let nodeWidth = 0;

	const applyWidth = (trigger: WidthSettleTrigger) => {
		if (committedWidth === 0) {
			committedWidth = nodeWidth;
			commits.push(nodeWidth);
			armedDelay = null;
			deferred = false;
			return;
		}
		const decision = resolveWidthSettle({
			nextWidth: nodeWidth,
			committedWidth,
			trigger,
			pointerDown: pointerDown(),
			recentCommittedWidths: recent,
		});
		armedDelay = null;
		if (decision.commit) {
			deferred = false;
			recent = trigger === "gesture-end" ? [] : pushCommittedWidth(recent, nodeWidth);
			committedWidth = nodeWidth;
			commits.push(nodeWidth);
			settledCommits.push(nodeWidth);
			return;
		}
		if (!decision.defer) {
			deferred = false;
			return;
		}
		deferred = true;
		armedDelay = decision.deferForMs;
	};

	return {
		commits,
		settledCommits,
		get deferred() {
			return deferred;
		},
		get armedDelay() {
			return armedDelay;
		},
		get committedWidth() {
			return committedWidth;
		},
		get cycleRing() {
			return recent;
		},
		observe: (width: number) => {
			nodeWidth = width;
			applyWidth("observer");
		},
		timer: () => applyWidth("timer"),
		release: () => {
			if (deferred) applyWidth("gesture-end");
		},
	};
}

describe("first measurement", () => {
	it("commits on the very first observer callback, with nothing deferred", () => {
		const h = createHandler();
		h.observe(768);
		expect(h.commits).toEqual([768]);
		expect(h.deferred).toBe(false);
		// No timer armed: waiting is what produced the visible jump.
		expect(h.armedDelay).toBeNull();
	});

	it("does not consult the settle decision for the first measurement", () => {
		const h = createHandler();
		h.observe(768);
		expect(h.settledCommits).toEqual([]);
	});

	// The fast path must not depend on the absence of a gesture: a narrator opened
	// while the reader happens to be holding a mouse button must still paint at its
	// real width, because there is no previous width to keep painting instead.
	it("commits the first measurement even while a pointer is down", () => {
		const h = createHandler({ pointerDown: () => true });
		h.observe(640);
		expect(h.commits).toEqual([640]);
		expect(h.deferred).toBe(false);
	});

	// Anything AFTER the first measurement is an ordinary width change again.
	it("hands every later change back to the settle decision", () => {
		const h = createHandler();
		h.observe(768);
		h.observe(600);
		expect(h.commits).toEqual([768]);
		expect(h.deferred).toBe(true);
		expect(h.armedDelay).toBe(WIDTH_SETTLE_DELAY_MS);
		h.timer();
		expect(h.commits).toEqual([768, 600]);
		expect(h.settledCommits).toEqual([600]);
	});

	it("still freezes a drag that starts after the first measurement", () => {
		let down = false;
		const h = createHandler({ pointerDown: () => down });
		h.observe(900);
		down = true;
		for (let i = 1; i <= 30; i++) h.observe(900 - i);
		// Nothing committed mid-drag; the first measurement remains the only commit.
		expect(h.commits).toEqual([900]);
		down = false;
		h.release();
		expect(h.commits).toEqual([900, 870]);
	});

	// The cycle guard counts commits that could oscillate. A first measurement has no
	// prior hop to alternate with, so recording it would shift the ring by one and
	// could mask (or fake) an alternation.
	it("keeps the first measurement out of the feedback-cycle ring", () => {
		const h = createHandler();
		h.observe(768);
		expect(h.cycleRing).toEqual([]);
		h.observe(753);
		h.timer();
		expect(h.cycleRing).toEqual([753]);
	});

	// A zero-width viewport (detached / display:none) must not be mistaken for a
	// measurement, or the list would commit 0 and never re-arm. `clientWidth` 0 is
	// clamped to 1 by resolveNarratorColumnWidth, which is what makes the sentinel
	// unambiguous — pinned here because the two facts are only safe together.
	it("treats a clamped 1px measurement as measured, so the sentinel is unambiguous", () => {
		const h = createHandler();
		h.observe(1);
		expect(h.committedWidth).toBe(1);
		// And the real width that follows is an ordinary change, not a second "first".
		h.observe(800);
		expect(h.deferred).toBe(true);
		h.timer();
		expect(h.commits).toEqual([1, 800]);
	});
});
