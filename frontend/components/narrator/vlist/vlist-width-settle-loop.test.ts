/**
 * vlist-width-settle-loop.test.ts — The resize handler's SEQUENCING.
 *
 * `vlist-width-settle.test.ts` covers the per-callback decision. This file drives
 * the loop the shell actually runs (observer callbacks → defer → timer / pointer
 * release → commit) on a clock that ADVANCES DURING A REBUILD, because the failure
 * that shipped was a sequencing/clock-coupling bug the pure decision cannot express.
 *
 * The bug, for the record: deferral used `setTimeout(140ms)` restarted by each
 * observer callback. A timeout measures WALL CLOCK, not quiet time, so it only held
 * while callbacks kept arriving faster than the delay. Simulating three drag shapes
 * showed how narrow that was:
 *
 *     continuous 60fps drag                → 0 commits during the drag
 *     bursty human drag (200ms pauses)     → 3 commits during the drag
 *     slow precise drag (160ms per move)   → 4 commits during the drag
 *
 * Each mid-drag commit costs ~100ms of blocked main thread, which pushes the next
 * observer callback further out and makes the next expiry MORE likely — positive
 * feedback. The three drag shapes below are kept as permanent regression cases.
 */

import { describe, expect, it } from "bun:test";
import {
	isExternalGeometryChange,
	isWidthFeedbackCycle,
	pushCommittedWidth,
	resolveWidthSettle,
	WIDTH_CYCLE_RING,
	WIDTH_POINTER_BACKSTOP_MS,
	type WidthSettleTrigger,
} from "./vlist-width-settle";

/**
 * How long a committed rebuild BLOCKS THE MAIN THREAD in these simulations.
 *
 * This is no longer a decision input — the gate consults no cost estimate (see
 * vlist-width-settle). It still matters here because clock blocking is what let the
 * old wall-clock timer fire mid-drag: a commit pushes the next observer callback out,
 * making the next expiry more likely. Modelling it keeps that regression detectable.
 */
const REBUILD_BLOCKS_MS = 102.7;

interface WidthChange {
	at: number;
	width: number;
}

interface DragScript {
	name: string;
	changes: WidthChange[];
	/** When the pointer is released. */
	pointerUpAt: number;
	/** False for resizes with no pointer at all (OS window chrome, toggles). */
	pointerHeld: boolean;
}

/**
 * Gap (ms) between the last width change and the release.
 *
 * A real gesture stops moving before the pointer lifts, so the final resize
 * callback precedes `pointerup`. (The reverse — a callback delivered AFTER release —
 * is possible too and is covered by its own test below, since it takes the
 * no-pointer path.)
 */
const RELEASE_GAP = 8;

/** Continuous 60fps drag: a width change every 16ms. */
function continuousDrag(): DragScript {
	const changes: WidthChange[] = [];
	for (let t = 16; t <= 800; t += 16) changes.push({ at: t, width: 700 + t / 16 });
	return {
		name: "continuous 60fps drag",
		changes,
		pointerUpAt: 800 + RELEASE_GAP,
		pointerHeld: true,
	};
}

/** Human drag: bursts separated by 200ms pauses, pointer held throughout. */
function burstyDrag(): DragScript {
	const changes: WidthChange[] = [];
	let width = 700;
	let t = 0;
	for (let burst = 0; burst < 3; burst++) {
		for (let i = 0; i < 10; i++) {
			t += 16;
			width += 1;
			changes.push({ at: t, width });
		}
		t += 200;
	}
	return {
		name: "bursty human drag (200ms pauses)",
		changes,
		pointerUpAt: t + RELEASE_GAP,
		pointerHeld: true,
	};
}

/** Slow precise drag: one move every 160ms, longer than the old quiet period. */
function slowDrag(): DragScript {
	const changes: WidthChange[] = [];
	for (let i = 1; i <= 8; i++) changes.push({ at: i * 160, width: 700 + i });
	return {
		name: "slow precise drag (160ms per move)",
		changes,
		pointerUpAt: 8 * 160 + RELEASE_GAP,
		pointerHeld: true,
	};
}

interface RunResult {
	/** Widths committed while the pointer was still held. */
	duringDrag: number[];
	/** Every committed width, in order. */
	commits: number[];
}

/**
 * Drive the real loop shape: a commit blocks the clock for the rebuild duration,
 * and width changes that come due while blocked are coalesced into one callback
 * (what a ResizeObserver actually does).
 */
function runScript(script: DragScript, rebuildBlocksMs = REBUILD_BLOCKS_MS): RunResult {
	let clock = 0;
	let committedWidth = 700;
	let nodeWidth = 700;
	let timerDueAt: number | null = null;
	let deferred = false;
	let index = 0;
	let released = false;
	const commits: number[] = [];
	const duringDrag: number[] = [];

	const pointerDownNow = () => script.pointerHeld && clock < script.pointerUpAt;

	const evaluate = (trigger: WidthSettleTrigger) => {
		const decision = resolveWidthSettle({
			nextWidth: nodeWidth,
			committedWidth,
			trigger,
			pointerDown: pointerDownNow(),
		});
		timerDueAt = null;
		if (decision.commit) {
			deferred = false;
			committedWidth = nodeWidth;
			commits.push(nodeWidth);
			if (clock < script.pointerUpAt) duringDrag.push(nodeWidth);
			clock += rebuildBlocksMs; // the rebuild blocks the main thread
			return;
		}
		if (!decision.defer) {
			deferred = false;
			return;
		}
		deferred = true;
		timerDueAt = clock + decision.deferForMs;
	};

	// Event loop over: pending width changes, the armed timer, and the release.
	for (let guard = 0; guard < 10_000; guard++) {
		const nextChange = script.changes[index];
		const nextChangeAt = nextChange ? nextChange.at : Number.POSITIVE_INFINITY;
		const nextTimerAt = timerDueAt ?? Number.POSITIVE_INFINITY;
		const releaseAt =
			script.pointerHeld && !released ? script.pointerUpAt : Number.POSITIVE_INFINITY;
		const next = Math.min(nextChangeAt, nextTimerAt, releaseAt);
		if (!Number.isFinite(next)) break;

		if (releaseAt === next) {
			clock = Math.max(clock, releaseAt);
			released = true;
			// The tracker only calls back when a deferral is outstanding.
			if (deferred) evaluate("gesture-end");
			continue;
		}
		if (nextTimerAt === next) {
			clock = Math.max(clock, nextTimerAt);
			evaluate("timer");
			continue;
		}
		clock = Math.max(clock, nextChangeAt);
		for (let pending = script.changes[index]; pending && pending.at <= clock; ) {
			nodeWidth = pending.width;
			index++;
			pending = script.changes[index];
		}
		evaluate("observer");
	}
	return { duringDrag, commits };
}

describe("width settle loop — no rebuild during a pointer drag", () => {
	// The three shapes that broke the wall-clock version. All must now be silent
	// until release, including the paused ones.
	for (const script of [continuousDrag(), burstyDrag(), slowDrag()]) {
		it(`commits nothing mid-drag: ${script.name}`, () => {
			const { duringDrag } = runScript(script);
			expect(duringDrag).toEqual([]);
		});

		it(`commits exactly once, at the final width: ${script.name}`, () => {
			const { commits } = runScript(script);
			const finalWidth = script.changes.at(-1)?.width ?? 0;
			expect(commits).toEqual([finalWidth]);
		});
	}

	// REPLACES an earlier case asserting that a "cheap" document stayed live per frame.
	// That behaviour was deliberately given up: it depended on predicting rebuild cost,
	// and both predictors were wrong (measurement time missed the DOM; row count missed
	// a ~30x per-row content variance, which made two panels either side of a splitter
	// disagree — one froze, one did not). The freeze is now unconditional during a drag.
	//
	// The user-visible trade is nil: during a gesture the reader is watching the
	// divider, not reading text.
	it("freezes during a drag regardless of how cheap the rebuild is", () => {
		const script = continuousDrag();
		// A rebuild that costs almost nothing must still not commit mid-drag.
		const { duringDrag, commits } = runScript(script, 0.5);
		expect(duringDrag).toEqual([]);
		expect(commits).toEqual([script.changes.at(-1)?.width ?? 0]);
	});

	// A resize with no pointer (OS window chrome, programmatic toggle) has no
	// release to wait for, so it must settle on the quiet period instead of hanging.
	it("settles a non-pointer resize without waiting for a gesture", () => {
		const changes: WidthChange[] = [];
		for (let t = 16; t <= 200; t += 16) changes.push({ at: t, width: 700 + t / 16 });
		const { commits } = runScript({
			name: "window resize",
			changes,
			pointerUpAt: 0,
			pointerHeld: false,
		});
		expect(commits.length).toBeGreaterThanOrEqual(1);
		expect(commits.at(-1)).toBe(changes.at(-1)?.width);
	});

	// The dangerous inverse of the fix: a release we never observe must not wedge the
	// list at a stale width forever. The backstop makes convergence unconditional.
	//
	// An earlier implementation RE-ARMED here (reasoning that a held pointer is
	// always a real drag) and this test is what exposed it: the width never
	// committed at all.
	it("converges via the backstop when a pointer release is never seen", () => {
		const changes: WidthChange[] = [{ at: 16, width: 900 }];
		// A release far beyond the backstop models a lost pointerup / pointercancel.
		const { commits, duringDrag } = runScript({
			name: "lost pointerup",
			changes,
			pointerUpAt: WIDTH_POINTER_BACKSTOP_MS * 10,
			pointerHeld: true,
		});
		expect(commits).toEqual([900]);
		// It is still deferred (never committed per-frame); the single commit arrives
		// only after the width has been idle for the whole backstop.
		expect(duringDrag).toEqual([900]);
	});

	// The backstop must not cut into a live drag: a drag keeps re-arming it, so even
	// a very long gesture commits once, on release.
	it("is not cut short by the backstop during a long continuous drag", () => {
		const changes: WidthChange[] = [];
		// 6 seconds of dragging — twice the backstop.
		for (let t = 16; t <= 6000; t += 16) changes.push({ at: t, width: 700 + t / 16 });
		const { duringDrag, commits } = runScript({
			name: "long drag",
			changes,
			pointerUpAt: 6000 + RELEASE_GAP,
			pointerHeld: true,
		});
		expect(duringDrag).toEqual([]);
		expect(commits).toEqual([changes.at(-1)?.width ?? 0]);
	});
});

/**
 * FEEDBACK, not external input.
 *
 * Every script above drives the width from OUTSIDE (a drag, a window resize), so a
 * commit can never influence the next observed width. The other shape needs no user
 * at all and is the one that can spin:
 *
 *     commit → re-measure → total height changes → vertical scrollbar appears or
 *            disappears → clientWidth changes by ~15px → commit → …
 *
 * ── What stops it, and what does NOT ─────────────────────────────────────────
 *
 * NOT the `!changed` early-out. A commit moves `committedWidth` to the value just
 * observed, so in an alternating source the next hop differs from the new reference
 * just as much and commits again — an A→B→A source commits once per hop indefinitely.
 *
 * NOT measure-layer monotonicity either, which is what an earlier round of this file
 * asserted. The claim was that document height is monotone non-increasing in width, so
 * a scrollbar that appears can never become unnecessary. `measure-media.ts` breaks it
 * by design: `image_generation` reserves its image area by aspect ratio, so the block
 * gets TALLER as the column widens. Driven through the real layout builder, a document
 * of those blocks on a 380x1656 viewport commits 59 times in 60 hops (333 ↔ 348), and
 * 35317 viewport/message-count combinations in the ordinary 360-560px range do the
 * same. See the "reachable 2-cycle" group below, which drives the real measure stack.
 *
 * What terminates it is the STRUCTURAL cycle guard: `resolveWidthSettle` refuses a
 * commit that would continue an A B A B alternation of committed widths. That bounds
 * every cycle at `WIDTH_CYCLE_RING` commits without assuming anything about content.
 */
describe("width settle loop — scrollbar feedback", () => {
	/**
	 * Run a closed loop where each commit CHANGES THE NEXT OBSERVED WIDTH.
	 *
	 * @param delta     px the scrollbar's appearance/disappearance adds or removes.
	 * @param alternate true → the scrollbar toggles on every commit (the 2-cycle the
	 *                  real measure layer can produce); false → it appears once and
	 *                  stays.
	 * @param guard     false → drive the decision WITHOUT the cycle history, to show
	 *                  the loop is unbounded when the guard cannot see the alternation.
	 */
	function runFeedback(delta: number, alternate: boolean, iterations = 100, guard = true) {
		let committedWidth = 700;
		let nodeWidth = 700 - delta; // the first re-measure grew a scrollbar
		let scrollbarVisible = true;
		let recent: readonly number[] = [];
		const commits: number[] = [];

		for (let i = 0; i < iterations; i++) {
			const decision = resolveWidthSettle({
				nextWidth: nodeWidth,
				committedWidth,
				// No pointer: this is the pure feedback path, with nothing to wait for. The
				// timer trigger is what a settled quiet period delivers.
				trigger: i === 0 ? "observer" : "timer",
				pointerDown: false,
				recentCommittedWidths: guard ? recent : undefined,
			});
			if (!decision.commit && !decision.defer) break; // converged or pinned
			if (decision.commit) {
				committedWidth = nodeWidth;
				commits.push(nodeWidth);
				recent = pushCommittedWidth(recent, nodeWidth);
				// The rebuild the commit triggers changes the width right back.
				if (alternate) {
					scrollbarVisible = !scrollbarVisible;
					nodeWidth = scrollbarVisible ? 700 - delta : 700;
				}
			}
		}
		return commits;
	}

	// The one-directional shape: the scrollbar appears and stays. One commit, silence.
	//
	// This is also what catches a threshold-based rewrite of the `!changed` test: a
	// gate like `Math.abs(diff) > 20` would swallow a 15px scrollbar swing entirely
	// and this expectation would read `[]`.
	it("settles in ONE commit when a scrollbar appears and stays", () => {
		expect(runFeedback(15, false)).toEqual([685]);
	});

	for (const delta of [8, 15, 17, 40]) {
		it(`settles in one commit for a ${delta}px one-directional swing`, () => {
			expect(runFeedback(delta, false)).toEqual([700 - delta]);
		});
	}

	// Sub-pixel feedback is absorbed by the rounding comparison, before the guard is
	// even consulted. `clientWidth` is an integer in every browser we target, so this
	// is headroom rather than a live case.
	it("ignores a sub-pixel wobble entirely, even alternating", () => {
		expect(runFeedback(0.4, true)).toEqual([]);
	});

	// WITHOUT the cycle history the loop is unbounded — one commit per hop, forever.
	// This is the pre-fix behaviour, kept so the guard's necessity stays visible: it is
	// the shape that a monotonicity argument was supposed to rule out and does not.
	it("is unbounded when the cycle guard has no history to work from", () => {
		const commits = runFeedback(15, true, 40, false);
		expect(commits.length).toBe(39);
		expect(new Set(commits)).toEqual(new Set([685, 700]));
	});

	// WITH the guard the same source is bounded. This is the termination proof the
	// width loop rests on, and it holds no matter how long the source keeps alternating.
	it("bounds a strictly alternating source at the ring size", () => {
		for (const iterations of [20, 100, 1000]) {
			const commits = runFeedback(15, true, iterations);
			expect(commits.length).toBeLessThanOrEqual(WIDTH_CYCLE_RING);
		}
	});

	// The guard must bound the cycle whatever the scrollbar's thickness is — it keys on
	// the ALTERNATION, not on any particular delta.
	for (const delta of [8, 12, 15, 17, 40]) {
		it(`bounds an alternating ${delta}px swing`, () => {
			expect(runFeedback(delta, true, 500).length).toBeLessThanOrEqual(WIDTH_CYCLE_RING);
		});
	}
});

/**
 * REPEATED PANEL TOGGLES — the shape that wedged the column, reported from the app.
 *
 * "Open the right dock, close it, open, close, open — the fifth one never resizes the
 * chat, and no amount of toggling fixes it after that."
 *
 * A toggle is real input with NO POINTER GESTURE: a button click, a keyboard shortcut,
 * a restored layout. It flips the list between exactly two widths, which is the very
 * A B A B alternation the cycle guard matches on — and `gesture-end` was the ring's
 * only reset, so the ring filled up and never drained:
 *
 *     toggle 1 open  → commit, ring [600]
 *     toggle 2 close → commit, ring [600 1000]
 *     toggle 3 open  → commit, ring [600 1000 600]
 *     toggle 4 close → commit, ring [600 1000 600 1000]
 *     toggle 5 open  → PINNED, and so is every toggle after it
 *
 * What separates the two sources without a gesture is the OUTER BOX: a scrollbar moves
 * `clientWidth` only, while a host resize moves `offsetWidth`. These tests drive the
 * toggle loop with those two measurements to pin both directions — a toggle always
 * commits, and feedback on a constant box is still bounded.
 */
describe("width settle loop — repeated programmatic panel toggles", () => {
	/** Outer width the host gives the list, per dock state. */
	const BOX_OPEN = 632;
	const BOX_CLOSED = 1032;
	/** Content column widths those boxes resolve to (gutters removed). */
	const COLUMN_OPEN = 600;
	const COLUMN_CLOSED = 1000;

	/**
	 * Toggle a dock panel `times` times with no pointer at all.
	 *
	 * @param reportBox false → omit the outer-box measurements, reproducing the shipped
	 *                  behaviour so the regression stays visible.
	 */
	function runToggles(times: number, reportBox = true) {
		let committedWidth = COLUMN_CLOSED;
		let committedBoxWidth: number | undefined = reportBox ? BOX_CLOSED : undefined;
		let recent: readonly number[] = [];
		let open = false;
		const commits: number[] = [];

		for (let toggle = 0; toggle < times; toggle++) {
			open = !open;
			const boxWidth = reportBox ? (open ? BOX_OPEN : BOX_CLOSED) : undefined;
			const nextWidth = open ? COLUMN_OPEN : COLUMN_CLOSED;
			// The observer defers on the quiet period (no pointer), then the timer decides.
			const deferral = resolveWidthSettle({
				nextWidth,
				committedWidth,
				trigger: "observer",
				pointerDown: false,
				recentCommittedWidths: recent,
				boxWidth,
				committedBoxWidth,
			});
			const decision = deferral.defer
				? resolveWidthSettle({
						nextWidth,
						committedWidth,
						trigger: "timer",
						pointerDown: false,
						recentCommittedWidths: recent,
						boxWidth,
						committedBoxWidth,
					})
				: deferral;
			if (!decision.commit) continue;
			const external = isExternalGeometryChange(boxWidth, committedBoxWidth);
			recent = external ? [] : pushCommittedWidth(recent, nextWidth);
			committedWidth = nextWidth;
			committedBoxWidth = boxWidth;
			commits.push(nextWidth);
		}
		return commits;
	}

	// THE regression: every toggle must apply, however many came before it.
	it("commits every toggle, including the fifth and beyond", () => {
		const commits = runToggles(12);
		expect(commits.length).toBe(12);
		// Strictly alternating, so the column always matches the dock state.
		for (const [index, width] of commits.entries()) {
			expect(width).toBe(index % 2 === 0 ? COLUMN_OPEN : COLUMN_CLOSED);
		}
	});

	// The exact reported count, called out so a partial fix cannot pass the case above
	// by coincidence.
	it("does not stop resizing at the fifth toggle", () => {
		expect(runToggles(5).at(-1)).toBe(COLUMN_OPEN);
		expect(runToggles(5).length).toBe(5);
	});

	// The pre-fix behaviour, kept as the counterexample: with no outer-box measurement
	// the guard cannot tell a toggle from feedback, so it pins after four commits.
	it("wedges after WIDTH_CYCLE_RING commits when the outer box is not reported", () => {
		const commits = runToggles(12, false);
		expect(commits.length).toBe(WIDTH_CYCLE_RING);
	});
});

/**
 * The guard must not damp a LEGITIMATE width change.
 *
 * This is the hazard that kept damping out of earlier rounds: a user dragging a
 * splitter back to a previous width is a real action that must apply, and a naive
 * "refuse a width we have seen" rule would freeze it. The separation is structural, on
 * two facts rather than on content:
 *
 *   1. `gesture-end` is checked BEFORE the guard, so pointer-driven input always
 *      commits (and the shell clears the ring on that path).
 *   2. Feedback has a BINARY cause (scrollbar present or not), so it can only produce
 *      two strictly alternating widths. Requiring the full A B A B pattern means a
 *      genuinely new width breaks the match and releases the guard.
 */
describe("width settle cycle guard — external input still wins", () => {
	/** Ring for a width that has already proven it oscillates. */
	const oscillating = (): readonly number[] => {
		let ring: readonly number[] = [];
		for (const w of [700, 685, 700, 685]) ring = pushCommittedWidth(ring, w);
		return ring;
	};

	it("pins a pinned-cycle width when the source is measurement feedback", () => {
		const decision = resolveWidthSettle({
			nextWidth: 700,
			committedWidth: 685,
			trigger: "timer",
			pointerDown: false,
			recentCommittedWidths: oscillating(),
		});
		expect(decision.commit).toBe(false);
		expect(decision.defer).toBe(false);
	});

	// THE case that must not regress: the user drags the sash back to a width that
	// feedback had just pinned. A gesture is external input, so it commits.
	it("commits a user drag back to the very width the cycle was pinned at", () => {
		const decision = resolveWidthSettle({
			nextWidth: 700,
			committedWidth: 685,
			trigger: "gesture-end",
			pointerDown: false,
			recentCommittedWidths: oscillating(),
		});
		expect(decision.commit).toBe(true);
	});

	// A third distinct width cannot be part of the two-value alternation, so it must
	// commit even on the pure feedback path — otherwise a real window resize arriving
	// during a settled cycle would be swallowed.
	it("commits a width the alternation could not have produced", () => {
		const decision = resolveWidthSettle({
			nextWidth: 640,
			committedWidth: 685,
			trigger: "timer",
			pointerDown: false,
			recentCommittedWidths: oscillating(),
		});
		expect(decision.commit).toBe(true);
	});

	// A single there-and-back (A B A) is ordinary resize traffic, not a cycle. Damping
	// it would freeze a width the user asked for, so the window requires the full
	// repeat before it engages.
	it("does not pin a single there-and-back", () => {
		let ring: readonly number[] = [];
		for (const w of [700, 685, 700] as const) ring = pushCommittedWidth(ring, w);
		const decision = resolveWidthSettle({
			nextWidth: 685,
			committedWidth: 700,
			trigger: "timer",
			pointerDown: false,
			recentCommittedWidths: ring,
		});
		expect(decision.commit).toBe(true);
	});

	// A monotonic sweep (an ordinary window resize) must never look like a cycle.
	it("never pins a monotonically changing width", () => {
		let ring: readonly number[] = [];
		let committedWidth = 700;
		for (let width = 701; width <= 900; width++) {
			const decision = resolveWidthSettle({
				nextWidth: width,
				committedWidth,
				trigger: "timer",
				pointerDown: false,
				recentCommittedWidths: ring,
			});
			expect(decision.commit).toBe(true);
			ring = pushCommittedWidth(ring, width);
			committedWidth = width;
		}
	});

	it("keeps the ring bounded at WIDTH_CYCLE_RING entries", () => {
		let ring: readonly number[] = [];
		for (let i = 0; i < 50; i++) ring = pushCommittedWidth(ring, 700 + i);
		expect(ring.length).toBe(WIDTH_CYCLE_RING);
		expect(ring.at(-1)).toBe(749);
	});

	// The ring rounds on the way in, so a fractional width cannot write two entries
	// for one physical width and hide the alternation from the guard.
	it("rounds recorded widths so a fractional wobble cannot mask a cycle", () => {
		let ring: readonly number[] = [];
		for (const w of [700.2, 685.4, 699.8, 685.1]) ring = pushCommittedWidth(ring, w);
		expect(ring).toEqual([700, 685, 700, 685]);
		expect(isWidthFeedbackCycle(ring, 700)).toBe(true);
	});

	it("needs a full window before it can pin anything", () => {
		let ring: readonly number[] = [];
		for (const w of [700, 685, 700]) ring = pushCommittedWidth(ring, w);
		expect(isWidthFeedbackCycle(ring, 685)).toBe(false);
		expect(isWidthFeedbackCycle([], 700)).toBe(false);
	});

	// A constant width is not an alternation (and `!changed` handles it earlier anyway).
	it("does not treat a constant width as a cycle", () => {
		let ring: readonly number[] = [];
		for (const w of [700, 700, 700, 700]) ring = pushCommittedWidth(ring, w);
		expect(isWidthFeedbackCycle(ring, 700)).toBe(false);
	});
});

/**
 * The 2-cycle is REACHABLE through the real measure stack.
 *
 * An earlier round of this file asserted the opposite: that total document height is
 * monotone non-increasing in width, so a scrollbar that appears can never become
 * unnecessary and the feedback is one-directional. That assertion was vacuous — its
 * fixture was markdown only (prose, tables, code), which is the family that really is
 * monotone, so it could never see the kind that is not.
 *
 * `measure-media.ts` breaks monotonicity BY DESIGN: `image_generation` reserves its
 * image area by aspect ratio against the live column, so the block gets TALLER as the
 * column widens (200px → 306px across a 320 → 532px column for a 1024x512 image, then
 * saturating). That is correct product behaviour — the renderer sizes the frame
 * `min(100%, displayWidth)` with `objectFit: contain` — so the invariant is what has to
 * give, not the image.
 *
 * These tests therefore assert the two things that are actually true and load-bearing:
 * the counterexample is reachable via segment-adapter → registry → measureMedia, and
 * the resulting feedback loop is BOUNDED by the cycle guard rather than by monotonicity.
 */
describe("scrollbar feedback through the real measure stack", () => {
	/** Padding the shell subtracts per side (PretextExactMessageList PAGE_PADDING). */
	const PAGE_PADDING = 16;

	async function loadStack() {
		const { installCanvasStub } = await import("./measure/test-canvas-stub");
		installCanvasStub();
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");
		const { resolveNarratorColumnWidth } = await import("@frontend/lib/narrator-content-column");
		return { buildPretextDocumentLayout, recentRunSegmentMessageIds, resolveNarratorColumnWidth };
	}

	/** A generated-image block whose reserved height grows with the column. */
	const imageMessage = (id: string, seq: number) => ({
		id,
		seq,
		role: "assistant",
		contentJson: [
			{ type: "image_generation", status: "completed", width: 1024, height: 512, result: "x" },
		],
		toolCalls: [],
		children: [],
	});

	// The counterexample itself, measured through the SAME path the list uses
	// (segment-adapter classifies image_generation as `media` → registry → measureMedia),
	// not by calling the measure function directly.
	it("height GROWS with width for a generated image (monotonicity is false)", async () => {
		const { buildPretextDocumentLayout, recentRunSegmentMessageIds } = await loadStack();
		const messages = [imageMessage("m0", 0)];
		const heightAt = (width: number) =>
			buildPretextDocumentLayout(messages as never[], {
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 5,
				widthBucket: width,
				contentWidth: width,
				viewportHeight: 900,
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			}).items.reduce((sum, item) => sum + item.measured.height, 0);

		// 1px steps: a 5px stride skips the `Math.round` flip points where the growth
		// actually shows up, which is how the earlier sweep missed this entirely.
		const growth: string[] = [];
		let previous = heightAt(320);
		for (let width = 321; width <= 560; width++) {
			const height = heightAt(width);
			if (height > previous) growth.push(`${width}px: ${height} > ${previous}`);
			previous = height;
		}
		// The point of the test: a WIDER column produced a TALLER document, repeatedly.
		expect(growth.length).toBeGreaterThan(50);
		expect(heightAt(560)).toBeGreaterThan(heightAt(320));
	});

	/**
	 * Drive the shell's real feedback physics over the real measure stack.
	 *
	 * The viewport is `overflow: auto` with no `scrollbar-gutter` reservation
	 * (PretextExactMessageList), so the scrollbar's presence changes `clientWidth`:
	 *
	 *     clientWidth  = viewportWidth - (document taller than viewport ? scrollbar : 0)
	 *     contentWidth = resolveNarratorColumnWidth(clientWidth, PAGE_PADDING, false)
	 */
	async function runRealFeedback(options: {
		messageCount: number;
		viewportWidth: number;
		viewportHeight: number;
		scrollbarPx: number;
		hops: number;
		guard: boolean;
	}) {
		const { buildPretextDocumentLayout, recentRunSegmentMessageIds, resolveNarratorColumnWidth } =
			await loadStack();
		const messages = Array.from({ length: options.messageCount }, (_, i) =>
			imageMessage(`m${i}`, i),
		);
		const heightAt = (width: number) =>
			buildPretextDocumentLayout(messages as never[], {
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 5,
				widthBucket: width,
				contentWidth: width,
				viewportHeight: options.viewportHeight,
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			}).items.reduce((sum, item) => sum + item.measured.height, 0);

		let committedWidth = resolveNarratorColumnWidth(options.viewportWidth, PAGE_PADDING, false);
		let scrollbarVisible = heightAt(committedWidth) > options.viewportHeight;
		let recent: readonly number[] = [];
		const commits: number[] = [];

		for (let hop = 0; hop < options.hops; hop++) {
			const clientWidth = options.viewportWidth - (scrollbarVisible ? options.scrollbarPx : 0);
			const nextWidth = resolveNarratorColumnWidth(clientWidth, PAGE_PADDING, false);
			const decision = resolveWidthSettle({
				nextWidth,
				committedWidth,
				trigger: hop === 0 ? "observer" : "timer",
				pointerDown: false,
				recentCommittedWidths: options.guard ? recent : undefined,
			});
			if (!decision.commit && !decision.defer) break;
			if (decision.commit) {
				committedWidth = nextWidth;
				commits.push(nextWidth);
				recent = pushCommittedWidth(recent, nextWidth);
				scrollbarVisible = heightAt(nextWidth) > options.viewportHeight;
			}
		}
		return commits;
	}

	// The reproduction, with the guard blinded: the loop commits on EVERY hop with no
	// user input at all. This is what the monotonicity claim was supposed to rule out.
	it("spins without bound when the guard cannot see the alternation", async () => {
		const commits = await runRealFeedback({
			messageCount: 8,
			viewportWidth: 380,
			viewportHeight: 1656,
			scrollbarPx: 15,
			hops: 60,
			guard: false,
		});
		expect(commits.length).toBe(59);
		// A true 2-cycle: every hop lands on one of exactly two widths.
		expect(new Set(commits).size).toBe(2);
	});

	// The fix: the same physics, bounded.
	it("is bounded by the cycle guard on the same viewport", async () => {
		const commits = await runRealFeedback({
			messageCount: 8,
			viewportWidth: 380,
			viewportHeight: 1656,
			scrollbarPx: 15,
			hops: 400,
			guard: true,
		});
		expect(commits.length).toBeLessThanOrEqual(WIDTH_CYCLE_RING);
	});

	// The oscillation is not tied to one viewport or one platform's scrollbar. A single
	// generated image at 553x300 is enough, which is why this counts as a live defect
	// rather than a corner case.
	for (const shape of [
		{ messageCount: 1, viewportWidth: 553, viewportHeight: 300, scrollbarPx: 15 },
		{ messageCount: 2, viewportWidth: 420, viewportHeight: 420, scrollbarPx: 12 },
		{ messageCount: 4, viewportWidth: 500, viewportHeight: 900, scrollbarPx: 17 },
	]) {
		it(`bounds the cycle at ${shape.viewportWidth}x${shape.viewportHeight} (${shape.scrollbarPx}px bar)`, async () => {
			const commits = await runRealFeedback({ ...shape, hops: 300, guard: true });
			expect(commits.length).toBeLessThanOrEqual(WIDTH_CYCLE_RING);
		});
	}
});

/**
 * Monotonicity, scoped to where it actually holds.
 *
 * Text-shaped measures ARE monotone non-increasing in width: narrowing a column wraps
 * prose into more lines and makes an overflowing table or code block reserve its
 * horizontal scrollbar row. That is worth pinning, because it is what keeps the ordinary
 * case converging in one hop rather than relying on the guard every time.
 *
 * What this no longer claims is that the property is GLOBAL. Known exceptions, which
 * must not be "fixed" into monotonicity:
 *   - `image_generation` with intrinsic width/height (measure-media.ts) — aspect-ratio
 *     reservation, so height rises with width until it saturates at 512px.
 * Termination for the width loop comes from the cycle guard, not from this group.
 */
describe("layout height is monotone in width for TEXT-shaped content", () => {
	it("never grows as the column widens, across prose, tables, code, math and long words", async () => {
		const { installCanvasStub } = await import("./measure/test-canvas-stub");
		installCanvasStub();
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { recentRunSegmentMessageIds } = await import("../trace/run-segments");

		const tableRows = Array.from(
			{ length: 6 },
			(_, i) => `| 单元格内容 ${i} 需要一些宽度 | some latin cell content here ${i} | 值${i} |`,
		);
		const table = [
			"| 列一名称较长 | 列二 also fairly long header | 列三 |",
			"|---|---|---|",
			...tableRows,
		].join("\n");
		// Built with a fence constant rather than an escaped template literal, so the
		// markdown fence cannot be confused with this file's own string delimiters.
		const FENCE = "\u0060\u0060\u0060";
		const codeLines = Array.from(
			{ length: 8 },
			(_, i) => `const aVeryLongVariableName${i} = compute(${i}, "a long string literal too");`,
		);
		const code = [`${FENCE}ts`, ...codeLines, FENCE].join("\n");
		const prose = `${"普通正文 ".repeat(30)}${"latin words here ".repeat(10)}`;
		// Math: a display formula is an unbreakable box, so it is the shape most likely
		// to reserve an overflow row at a narrow column and drop it at a wide one.
		const math = [
			"公式如下：",
			"",
			"$$\\sum_{i=0}^{n} \\frac{x_i^2 + 2x_i + 1}{\\sqrt{y_i - z_i}} = \\alpha\\beta\\gamma$$",
			"",
			"行内公式 $E = mc^2$ 与 $\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt{\\pi}}{2}$ 混排。",
		].join("\n");
		// An unbreakable token far wider than any column: nothing can wrap it, so its
		// block must reserve overflow at every width rather than flipping.
		const longWord = `前缀 ${"A".repeat(400)} 后缀`;
		const bodies = [table, code, prose, math, longWord];

		const messages = Array.from({ length: 15 }, (_, i) => ({
			id: `m${i}`,
			seq: i,
			role: "assistant",
			contentJson: [{ type: "text", text: bodies[i % bodies.length] }],
			toolCalls: [],
			children: [],
		}));

		const heightAt = (width: number) =>
			buildPretextDocumentLayout(messages as never[], {
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 5,
				widthBucket: width,
				contentWidth: width,
				viewportHeight: 900,
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			}).items.reduce((sum, item) => sum + item.measured.height, 0);

		const violations: string[] = [];
		let previous = heightAt(320);
		// 1px steps through the narrow band, where `fitToBudget`'s 1px reclaim and the
		// `Math.ceil` line-count flips live. A 5px stride steps over them.
		for (let width = 321; width <= 560; width++) {
			const height = heightAt(width);
			if (height > previous) violations.push(`${width}px: ${height} > ${previous}`);
			previous = height;
		}
		// Wider band at a coarser stride, to cover ordinary desktop widths too.
		for (let width = 565; width <= 1400; width += 5) {
			const height = heightAt(width);
			if (height > previous) violations.push(`${width}px: ${height} > ${previous}`);
			previous = height;
		}
		expect(violations).toEqual([]);

		// Sanity, stronger than comparing the two endpoints: the sweep must actually
		// exercise many DISTINCT heights, or a mostly-flat fixture would satisfy
		// monotonicity without testing anything. Measured: 11 distinct heights across
		// 320-560 and 19 across the full range, i.e. the sweep really does step through
		// line-count flips rather than sitting on a plateau.
		const narrowBand = new Set<number>();
		for (let width = 320; width <= 560; width++) narrowBand.add(heightAt(width));
		expect(narrowBand.size).toBeGreaterThanOrEqual(10);
		const fullRange = new Set<number>();
		for (let width = 320; width <= 1400; width++) fullRange.add(heightAt(width));
		expect(fullRange.size).toBeGreaterThanOrEqual(18);
		// And the total change is large, so the steps are real geometry, not rounding.
		expect(heightAt(320)).toBeGreaterThan(heightAt(1400) * 1.5);
	});
});
