/**
 * vlist-smooth-follow.test.ts — The chase step/gate are pure arithmetic and are
 * tested as such; the controller is exercised with a fake rAF and a fake scroll
 * position so the loop's ensure/cancel/snap boundaries are covered without a DOM.
 *
 * The invariants that matter:
 *  - the glide NEVER overshoots and always lands exactly (no residue, no fight
 *    with the pin machinery over the last pixel);
 *  - the gate is the single place that decides glide-vs-snap, so the pin effect,
 *    the bottom correction and the re-glue can never disagree;
 *  - a chase in flight never survives reader intent (cancel) or a geometry-owning
 *    transition (snapToTarget before fold/LOD capture).
 */

import { describe, expect, it } from "bun:test";
import {
	createSmoothFollower,
	resolveSmoothFollowStep,
	SMOOTH_FOLLOW_DELTA_MAX_PX,
	SMOOTH_FOLLOW_DELTA_MIN_PX,
	SMOOTH_FOLLOW_DELTA_VIEWPORT_FACTOR,
	SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS,
	SMOOTH_FOLLOW_MIN_STEP_PX,
	SMOOTH_FOLLOW_SETTLE_EPSILON_PX,
	SMOOTH_FOLLOW_TAU_MS,
	shouldSmoothFollow,
	smoothFollowMaxDelta,
} from "./smooth-scroll";

describe("smoothFollowMaxDelta — the glide bound", () => {
	it("scales with the viewport between a floor and a ceiling", () => {
		expect(smoothFollowMaxDelta(800)).toBe(800 * SMOOTH_FOLLOW_DELTA_VIEWPORT_FACTOR);
		// Tiny viewports still glide for ordinary card landings.
		expect(smoothFollowMaxDelta(100)).toBe(SMOOTH_FOLLOW_DELTA_MIN_PX);
		// Huge viewports are capped so a landing can never glide for screens on end.
		expect(smoothFollowMaxDelta(10000)).toBe(SMOOTH_FOLLOW_DELTA_MAX_PX);
	});
	it("tolerates a non-finite/zero viewport by clamping to the floor", () => {
		expect(smoothFollowMaxDelta(0)).toBe(SMOOTH_FOLLOW_DELTA_MIN_PX);
		expect(smoothFollowMaxDelta(Number.NaN)).toBe(SMOOTH_FOLLOW_DELTA_MIN_PX);
	});
});

describe("shouldSmoothFollow — the single glide-vs-snap gate", () => {
	const base = { current: 1000, viewportHeight: 800, reducedMotion: false };

	it("glides for streaming-sized growth", () => {
		expect(shouldSmoothFollow({ ...base, target: 1020 })).toBe(true); // a line
		expect(shouldSmoothFollow({ ...base, target: 1400 })).toBe(true); // a big card
	});

	it("snaps when the target is not below us (shrink / already there)", () => {
		expect(shouldSmoothFollow({ ...base, target: 1000 })).toBe(false);
		expect(shouldSmoothFollow({ ...base, target: 400 })).toBe(false);
	});

	it("snaps beyond the glide bound (loads, switches, prepend re-pins)", () => {
		expect(shouldSmoothFollow({ ...base, target: 1000 + smoothFollowMaxDelta(800) + 1 })).toBe(
			false,
		);
	});

	it("never glides under reduced motion", () => {
		expect(shouldSmoothFollow({ ...base, target: 1020, reducedMotion: true })).toBe(false);
	});
});

describe("resolveSmoothFollowStep — convergence without overshoot", () => {
	it("settles exactly when the remaining distance is within epsilon", () => {
		const step = resolveSmoothFollowStep({
			current: 1000,
			target: 1000 + SMOOTH_FOLLOW_SETTLE_EPSILON_PX / 2,
			dtMs: 16.7,
		});
		expect(step).toEqual({ next: 1000 + SMOOTH_FOLLOW_SETTLE_EPSILON_PX / 2, settled: true });
	});

	it("approaches exponentially: monotonic, target-bounded, and lands exactly", () => {
		let current = 1000;
		const target = 1100;
		const seen: number[] = [];
		for (let frame = 0; frame < 600; frame++) {
			const step = resolveSmoothFollowStep({ current, target, dtMs: 16.7 });
			expect(step.next).toBeGreaterThan(current); // monotonic
			expect(step.next).toBeLessThanOrEqual(target); // never overshoots
			current = step.next;
			seen.push(current);
			if (step.settled) break;
		}
		expect(current).toBe(target); // landed exactly, in finite frames
		// The step floor also SHORTENS the glide: the exponential tail used to creep
		// sub-pixel for a dozen frames (~32 frames total), now the last few px are
		// covered at 1px/frame.
		expect(seen.length).toBeLessThan(30);
	});

	/**
	 * THE STUTTER REGRESSION. A pure exponential shrinks its step with the remaining
	 * distance, so the tail of every glide advanced by fractions of a pixel — which
	 * does not move the RENDERED position (device-pixel snapping). The picture froze
	 * for several frames, then lurched a whole pixel: juddering at the end of every
	 * single glide, i.e. the part the reader looks at most.
	 */
	it("never plans a sub-pixel frame (no still frames, no 1px lurch)", () => {
		for (const target of [1003, 1020, 1100, 1480]) {
			let current = 1000;
			for (let frame = 0; frame < 600; frame++) {
				const step = resolveSmoothFollowStep({ current, target, dtMs: 16.7 });
				const advanced = step.next - current;
				if (step.settled) break;
				// Every non-settling frame must move at least a whole device pixel.
				expect(advanced).toBeGreaterThanOrEqual(1 - 1e-9);
				current = step.next;
			}
		}
	});

	it("the floor still cannot overshoot the target", () => {
		// A remaining distance below the floor must be clamped to the remainder, never
		// stepped a full pixel past the bottom. Exercised with a custom epsilon so the
		// settle branch does not answer first.
		const step = resolveSmoothFollowStep({
			current: 1000,
			target: 1000.4,
			dtMs: 16.7,
			settleEpsilonPx: 0.1,
		});
		expect(step.next).toBeLessThanOrEqual(1000.4);
	});

	it("keeps the 1px/frame run short (no long invisible tail)", () => {
		// The floor removes sub-pixel stalls but replaces them with constant 1px
		// frames; without a matching settle epsilon that run was ~6 frames of motion
		// nobody can see, appended to every glide.
		for (const target of [1020, 1060, 1200]) {
			let current = 1000;
			let onePxFrames = 0;
			for (let frame = 0; frame < 600; frame++) {
				const step = resolveSmoothFollowStep({ current, target, dtMs: 16.7 });
				if (step.settled) break;
				if (step.next - current <= 1 + 1e-9) onePxFrames++;
				current = step.next;
			}
			expect(onePxFrames).toBeLessThanOrEqual(3);
		}
	});

	it("caps velocity for large landings", () => {
		const step = resolveSmoothFollowStep({ current: 0, target: 1500, dtMs: 16.7 });
		expect(step.next).toBeLessThanOrEqual(SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS * 16.7 + 1e-9);
		expect(step.settled).toBe(false);
	});

	it("is dt-aware over the bulk of the travel: two half-steps match one full step", () => {
		// Delta kept large enough that the exponential term dominates: both the
		// velocity cap and the step FLOOR deliberately break exact dt-equivalence when
		// they engage (the cap bounds speed, the floor beats per-frame pixel snapping).
		const full = resolveSmoothFollowStep({ current: 0, target: 200, dtMs: 33.4 });
		const halfA = resolveSmoothFollowStep({ current: 0, target: 200, dtMs: 16.7 });
		const halfB = resolveSmoothFollowStep({ current: halfA.next, target: 200, dtMs: 16.7 });
		expect(halfB.next).toBeCloseTo(full.next, 5);
	});

	it("does not move on a zero-length frame", () => {
		// The step floor must not turn "no time passed" into a 1px teleport — that
		// would also break the dt-equivalence above.
		const step = resolveSmoothFollowStep({ current: 100, target: 500, dtMs: 0 });
		expect(step).toEqual({ next: 100, settled: false });
	});
});

/** Fake rAF: callbacks queue up and run when the test advances the clock. */
function createFakeRaf() {
	let nextId = 1;
	const pending = new Map<number, (time: number) => void>();
	return {
		raf: (callback: (time: number) => void) => {
			const id = nextId++;
			pending.set(id, callback);
			return id;
		},
		cancelRaf: (handle: number) => {
			pending.delete(handle);
		},
		runFrame: (time: number) => {
			const callbacks = [...pending.entries()];
			pending.clear();
			for (const [, callback] of callbacks) callback(time);
		},
		get pendingCount() {
			return pending.size;
		},
	};
}

function createFollowerHarness(options?: { reducedMotion?: boolean; bidirectional?: boolean }) {
	const raf = createFakeRaf();
	const state = {
		current: 1000,
		target: 1100,
		viewportHeight: 800,
		writes: [] as Array<{ kind: "instant" | "chase"; value: number }>,
	};
	const follower = createSmoothFollower({
		readCurrent: () => state.current,
		readTarget: () => state.target,
		getViewportHeight: () => state.viewportHeight,
		writeInstant: (value) => {
			state.current = value;
			state.writes.push({ kind: "instant", value });
		},
		writeChase: (value) => {
			state.current = value;
			state.writes.push({ kind: "chase", value });
		},
		isReducedMotion: () => options?.reducedMotion === true,
		canAnimate: options?.bidirectional ? undefined : shouldSmoothFollow,
		raf: raf.raf,
		cancelRaf: raf.cancelRaf,
		now: () => 0,
	});
	/** Run n 60Hz frames; the harness clock starts at t=0 (ensure's `now()`). */
	const runFrames = (count: number) => {
		for (let frame = 1; frame <= count; frame++) raf.runFrame(frame * 16.7);
	};
	return { follower, raf, state, runFrames };
}

describe("createSmoothFollower — the rAF edge", () => {
	it("glides a streaming-sized growth to an exact landing", () => {
		const { follower, state, runFrames } = createFollowerHarness();
		follower.ensure();
		expect(follower.isActive()).toBe(true);
		runFrames(60);
		expect(follower.isActive()).toBe(false);
		expect(state.current).toBe(1100);
		// Intermediate frames use the LIGHT write; only the landing uses the full one.
		const kinds = state.writes.map((write) => write.kind);
		expect(kinds.slice(0, -1).every((kind) => kind === "chase")).toBe(true);
		expect(kinds[kinds.length - 1]).toBe("instant");
		expect(state.writes[state.writes.length - 1]?.value).toBe(1100);
	});

	it("writes instantly (and never starts a loop) beyond the glide bound", () => {
		const { follower, raf, state } = createFollowerHarness();
		state.target = 100000; // a fresh document load, not streaming growth
		follower.ensure();
		expect(follower.isActive()).toBe(false);
		expect(raf.pendingCount).toBe(0);
		expect(state.writes).toEqual([{ kind: "instant", value: 100000 }]);
	});

	it("writes instantly under reduced motion", () => {
		const { follower, state } = createFollowerHarness({ reducedMotion: true });
		follower.ensure();
		expect(follower.isActive()).toBe(false);
		expect(state.writes).toEqual([{ kind: "instant", value: 1100 }]);
	});

	it("writes instantly when the bottom shrank under the pin (rollback)", () => {
		const { follower, state } = createFollowerHarness();
		state.target = 300;
		follower.ensure();
		expect(state.writes).toEqual([{ kind: "instant", value: 300 }]);
	});

	it("is a no-op write when already at the bottom", () => {
		const { follower, raf, state } = createFollowerHarness();
		state.target = 1000; // == current
		follower.ensure();
		expect(follower.isActive()).toBe(false);
		expect(raf.pendingCount).toBe(0);
		expect(state.writes).toEqual([]);
	});

	it("chases a MOVING target without restarting (continuous streaming)", () => {
		const { follower, raf, state, runFrames } = createFollowerHarness();
		follower.ensure();
		runFrames(3);
		expect(follower.isActive()).toBe(true);
		const writesBefore = state.writes.length;
		// The bottom keeps moving away mid-chase: the loop simply re-reads it.
		state.target = 1150;
		runFrames(60);
		expect(state.current).toBe(1150);
		expect(follower.isActive()).toBe(false);
		expect(state.writes.length).toBeGreaterThan(writesBefore);
		void raf;
	});

	it("a second ensure while running neither restarts nor double-schedules", () => {
		const { follower, raf, state } = createFollowerHarness();
		follower.ensure();
		follower.ensure();
		expect(raf.pendingCount).toBe(1);
		state.target = 1050;
		follower.ensure();
		expect(raf.pendingCount).toBe(1);
	});

	it("an ensure past the bound mid-chase snaps instead of dragging a tail", () => {
		const { follower, state, runFrames } = createFollowerHarness();
		follower.ensure();
		runFrames(2);
		state.target = 100000; // a huge landing while gliding
		follower.ensure();
		expect(follower.isActive()).toBe(false);
		expect(state.current).toBe(100000);
		expect(state.writes[state.writes.length - 1]).toEqual({ kind: "instant", value: 100000 });
	});

	it("a target that shrinks below us mid-chase lands instantly", () => {
		const { follower, state, runFrames } = createFollowerHarness();
		follower.ensure();
		runFrames(2);
		state.target = 100; // rollback beneath the pin
		runFrames(1);
		expect(follower.isActive()).toBe(false);
		expect(state.current).toBe(100);
	});

	it("cancel stops the loop without any further write (reader intent)", () => {
		const { follower, raf, state, runFrames } = createFollowerHarness();
		follower.ensure();
		runFrames(2);
		const writesAtCancel = state.writes.length;
		follower.cancel();
		expect(follower.isActive()).toBe(false);
		expect(raf.pendingCount).toBe(0);
		runFrames(5);
		expect(state.writes.length).toBe(writesAtCancel);
	});

	it("snapToTarget lands exactly and only while a chase is running", () => {
		const { follower, state, runFrames } = createFollowerHarness();
		// No chase: snap is a no-op (a fold click without streaming changes nothing).
		follower.snapToTarget();
		expect(state.writes).toEqual([]);
		// Mid-chase: the fold/LOD capture needs settled geometry NOW.
		follower.ensure();
		runFrames(2);
		follower.snapToTarget();
		expect(follower.isActive()).toBe(false);
		expect(state.current).toBe(1100);
		expect(state.writes[state.writes.length - 1]).toEqual({ kind: "instant", value: 1100 });
	});

	it("chases at 120Hz exactly as at 60Hz (dt-correctness end to end)", () => {
		const at60 = createFollowerHarness();
		at60.follower.ensure();
		for (let frame = 1; frame <= 12; frame++) at60.raf.runFrame(frame * 16.7);
		const at120 = createFollowerHarness();
		at120.follower.ensure();
		for (let frame = 1; frame <= 24; frame++) at120.raf.runFrame(frame * 8.35);
		expect(at120.state.current).toBeCloseTo(at60.state.current, 1);
	});
});

describe("constants stay coherent", () => {
	it("tau and velocity are the documented defaults", () => {
		expect(SMOOTH_FOLLOW_TAU_MS).toBe(100);
		expect(SMOOTH_FOLLOW_MAX_VELOCITY_PX_PER_MS).toBe(4);
	});

	it("settles a few px out rather than creeping to zero", () => {
		// The exponential tail is infinitely long, so the epsilon is what decides when
		// to stop caring. Measured on a real 20px growth, dropping this to 1px added
		// ~6 frames of 1px/frame motion nobody can see. The shell already reads
		// anything within 1px (BOTTOM_DISTANCE_EPSILON) as "at the bottom", and the
		// final write is the exact target either way.
		expect(SMOOTH_FOLLOW_SETTLE_EPSILON_PX).toBe(3);
	});

	it("floors the step at one device pixel, at or below the settle epsilon", () => {
		// A floor ABOVE the epsilon could step past the settle band, making the last
		// frame jump rather than land.
		expect(SMOOTH_FOLLOW_MIN_STEP_PX).toBe(1);
		expect(SMOOTH_FOLLOW_MIN_STEP_PX).toBeLessThanOrEqual(SMOOTH_FOLLOW_SETTLE_EPSILON_PX);
	});
});
