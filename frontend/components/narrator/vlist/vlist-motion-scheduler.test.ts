/**
 * vlist-motion-scheduler.test.ts — the scheduler's four contracts.
 *
 * The planners have their own unit tests; what matters here is only what the
 * scheduler adds over the three controllers it replaces:
 *
 *  1. scope-precise cancellation (not "all", not "same key only");
 *  2. one commit's ops start in ONE synchronous burst;
 *  3. one time base per event, with an explicit override channel for the LOD switch;
 *  4. nothing is retained (`fill: "none"`) and nothing throws.
 */

import { describe, expect, it } from "bun:test";
import {
	createMotionScheduler,
	drillScope,
	frameScope,
	LOD_MOTION_DURATION_MS,
	lodScope,
	MOTION_DURATION_MS,
	MOTION_EASING,
	type MotionNode,
	type MotionOp,
	type MotionSample,
	prefersReducedMotion,
	rowScope,
} from "./vlist-motion-scheduler";

interface FakeAnimation {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	cancelled: boolean;
	/** Set by the scheduler; invoked by the tests to simulate the browser finishing. */
	onfinish?: (() => void) | null;
}

/** A node that records every animation started on it, and when. */
function fakeNode(clock?: { now: number }): MotionNode & {
	animations: FakeAnimation[];
	startedAt: number[];
} {
	const animations: FakeAnimation[] = [];
	const startedAt: number[] = [];
	return {
		animations,
		startedAt,
		animate(keyframes, options) {
			// The returned object IS the recorded animation, so a test can drive the
			// `onfinish` handler the scheduler assigns to it (that is how natural
			// completion reaches `onDone`).
			const animation: FakeAnimation & { cancel: () => void } = {
				keyframes,
				options,
				cancelled: false,
				onfinish: null,
				cancel: () => {
					animation.cancelled = true;
				},
			};
			animations.push(animation);
			startedAt.push(clock ? clock.now : 0);
			return animation;
		},
	};
}

const SHIFT: Keyframe[] = [
	{ offset: 0, transform: "translateY(-200px)" },
	{ offset: 1, transform: "translateY(0px)" },
];

function op(scope: string, node: MotionNode | null, durationMs?: number): MotionOp {
	return { scope, resolve: () => node, keyframes: SHIFT, durationMs };
}

describe("scope-precise cancellation", () => {
	it("re-playing a scope cancels only that scope", () => {
		const scheduler = createMotionScheduler();
		const a = fakeNode();
		const b = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), a), op(rowScope("b"), b)]);
		scheduler.flush();

		// Second event touches row `a` only: `b` must keep playing. This is the
		// behaviour the per-row drill controller had and the fold controller lacked
		// (it cancelled everything it had started).
		scheduler.begin();
		scheduler.push([op(rowScope("a"), a)]);
		scheduler.flush();

		expect(a.animations[0]?.cancelled).toBe(true);
		expect(a.animations[1]?.cancelled).toBe(false);
		expect(b.animations[0]?.cancelled).toBe(false);
	});

	it("lets ONE event take down a row, its frame and its drill morph together", () => {
		// The case no previous controller could express: `onToggleRow` produces a fold
		// (row + frame) and a drill morph in one click, so re-toggling must replace all
		// three rather than leaving one half running to a different finish time.
		const scheduler = createMotionScheduler();
		const row = fakeNode();
		const frame = fakeNode();
		const drill = fakeNode();
		const unrelated = fakeNode();
		scheduler.begin();
		scheduler.push([
			op(rowScope("t1"), row),
			op(frameScope("run:t1"), frame),
			op(drillScope("t1::r0"), drill),
			op(rowScope("other"), unrelated),
		]);
		scheduler.flush();

		scheduler.begin();
		scheduler.push([
			op(rowScope("t1"), row),
			op(frameScope("run:t1"), frame),
			op(drillScope("t1::r0"), drill),
		]);
		scheduler.flush();

		expect(row.animations[0]?.cancelled).toBe(true);
		expect(frame.animations[0]?.cancelled).toBe(true);
		expect(drill.animations[0]?.cancelled).toBe(true);
		// The row that this event did not mention is untouched.
		expect(unrelated.animations[0]?.cancelled).toBe(false);
	});

	it("does not cancel an animation the SAME event just started", () => {
		// Cancellation happens for all scopes before any op starts, so two ops naming
		// one scope within one event cannot take each other down mid-burst.
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node), op(rowScope("a"), node)]);
		scheduler.flush();
		// Both were issued; neither was cancelled during the burst.
		expect(node.animations).toHaveLength(2);
		expect(node.animations[0]?.cancelled).toBe(false);
		expect(node.animations[1]?.cancelled).toBe(false);
	});

	it("cancelScope stops one scope and is idempotent", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		scheduler.cancelScope(rowScope("a"));
		scheduler.cancelScope(rowScope("a"));
		expect(node.animations[0]?.cancelled).toBe(true);
		expect(scheduler.activeScopeCount()).toBe(0);
	});

	it("cancel() stops everything and is idempotent", () => {
		const scheduler = createMotionScheduler();
		const a = fakeNode();
		const b = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), a), op(lodScope("u1"), b)]);
		scheduler.flush();
		scheduler.cancel();
		scheduler.cancel();
		expect(a.animations[0]?.cancelled).toBe(true);
		expect(b.animations[0]?.cancelled).toBe(true);
		expect(scheduler.activeScopeCount()).toBe(0);
	});
});

describe("one commit, one synchronous burst", () => {
	it("starts nothing until flush", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node)]);
		expect(node.animations).toHaveLength(0);
		scheduler.flush();
		expect(node.animations).toHaveLength(1);
	});

	it("issues every op of one event at the same instant", () => {
		// Two halves of one movement must not start a frame apart. The clock only
		// advances between flushes, so equal timestamps prove a single burst.
		const clock = { now: 0 };
		const scheduler = createMotionScheduler();
		const row = fakeNode(clock);
		const drill = fakeNode(clock);
		scheduler.begin();
		scheduler.push([op(rowScope("a"), row)]);
		clock.now = 16; // a later layout effect in the SAME commit contributes
		scheduler.push([op(drillScope("a::r0"), drill)]);
		clock.now = 32;
		scheduler.flush();
		expect(row.startedAt[0]).toBe(32);
		expect(drill.startedAt[0]).toBe(32);
	});

	it("joins an already-open batch instead of replacing it", () => {
		// Several layout effects call begin() in one commit; the first opens, the rest
		// join. A begin() that reset the batch would drop the earlier effect's ops.
		const scheduler = createMotionScheduler();
		const a = fakeNode();
		const b = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), a)]);
		scheduler.begin();
		scheduler.push([op(rowScope("b"), b)]);
		scheduler.flush();
		expect(a.animations).toHaveLength(1);
		expect(b.animations).toHaveLength(1);
	});

	it("ignores ops pushed with no open batch", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		expect(node.animations).toHaveLength(0);
	});

	it("flush with an empty batch is a no-op and closes it", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.flush();
		// The batch is closed, so a late push is ignored rather than leaking into the
		// next event.
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		expect(node.animations).toHaveLength(0);
	});

	it("resolves nodes at flush time, skipping rows that left the window", () => {
		const scheduler = createMotionScheduler();
		const present = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("gone"), null), op(rowScope("here"), present)]);
		scheduler.flush();
		expect(present.animations).toHaveLength(1);
		// Only the resolvable op holds a scope.
		expect(scheduler.activeScopeCount()).toBe(1);
	});
});

describe("one time base per event", () => {
	it("defaults every op to the shared duration and easing", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		expect(node.animations[0]?.options.duration).toBe(MOTION_DURATION_MS);
		expect(node.animations[0]?.options.easing).toBe(MOTION_EASING);
	});

	it("applies an event-level override to every op in the event", () => {
		// The LOD switch: one duration for the whole re-theme, not per node.
		const scheduler = createMotionScheduler();
		const a = fakeNode();
		const b = fakeNode();
		scheduler.begin();
		scheduler.push([op(lodScope("u1"), a), op(lodScope("u2"), b)], LOD_MOTION_DURATION_MS);
		scheduler.flush();
		expect(a.animations[0]?.options.duration).toBe(LOD_MOTION_DURATION_MS);
		expect(b.animations[0]?.options.duration).toBe(LOD_MOTION_DURATION_MS);
	});

	it("lets a single op override the event's duration", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node, 90)]);
		scheduler.flush();
		expect(node.animations[0]?.options.duration).toBe(90);
	});

	it("does not carry an override into the next event", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(lodScope("u1"), node)], LOD_MOTION_DURATION_MS);
		scheduler.flush();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		expect(node.animations[1]?.options.duration).toBe(MOTION_DURATION_MS);
	});

	it("keeps the LOD base longer than the shared base, deliberately", () => {
		// Pinned so the two cannot be "tidied" into one: a level switch re-themes the
		// whole document and needs the extra time (see the constant's note).
		expect(LOD_MOTION_DURATION_MS).toBeGreaterThan(MOTION_DURATION_MS);
	});
});

describe("retains nothing, throws nothing", () => {
	it("runs every animation with fill: none", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		expect(node.animations[0]?.options.fill).toBe("none");
	});

	it("degrades silently without WAAPI and when animate throws", () => {
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([
			op(rowScope("no-waapi"), {}),
			{
				scope: rowScope("throws"),
				resolve: () => ({
					animate: () => {
						throw new Error("unsupported");
					},
				}),
				keyframes: SHIFT,
			},
		]);
		expect(() => scheduler.flush()).not.toThrow();
		expect(scheduler.activeScopeCount()).toBe(0);
	});

	it("survives a resolver that throws", () => {
		// A row torn down between plan and flush must not take the whole event down.
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("bad"),
				resolve: () => {
					throw new Error("detached");
				},
				keyframes: SHIFT,
			},
			op(rowScope("good"), node),
		]);
		expect(() => scheduler.flush()).not.toThrow();
		expect(node.animations).toHaveLength(1);
	});
});

/**
 * `onDone` exists for the one motion that is not purely decorative: closing a drilled-in
 * card animates a box whose CONTENT React would otherwise unmount in frame one, so the
 * shell keeps that card mounted for the duration and releases it here.
 *
 * A MISSED call leaves a card painted forever; a DOUBLE call would clear state belonging
 * to the next interaction. Every exit path is covered below.
 */
describe("onDone: exactly once, on every exit path", () => {
	function doneOp(scope: string, node: MotionNode | null, calls: string[]): MotionOp {
		return {
			scope,
			resolve: () => node,
			keyframes: SHIFT,
			onDone: () => calls.push(scope),
		};
	}

	it("fires when the animation finishes naturally", () => {
		const calls: string[] = [];
		const node = fakeNode();
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("a"), node, calls)]);
		scheduler.flush();
		expect(calls).toEqual([]);
		// Drive the WAAPI completion the way the browser would.
		(node.animations[0] as unknown as { onfinish?: () => void }).onfinish?.();
		expect(calls).toEqual([rowScope("a")]);
	});

	it("fires when a re-play of the same scope cancels it", () => {
		const calls: string[] = [];
		const node = fakeNode();
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("a"), node, calls)]);
		scheduler.flush();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("a"), node, calls)]);
		scheduler.flush();
		// The FIRST op was released; the second is still running.
		expect(calls).toEqual([rowScope("a")]);
	});

	it("fires on teardown", () => {
		const calls: string[] = [];
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("a"), fakeNode(), calls)]);
		scheduler.flush();
		scheduler.cancel();
		expect(calls).toEqual([rowScope("a")]);
	});

	it("fires immediately when the op could never start (no node, no WAAPI)", () => {
		// Nothing will ever finish it, so waiting would keep a card mounted forever.
		const calls: string[] = [];
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("gone"), null, calls), doneOp(rowScope("bare"), {}, calls)]);
		scheduler.flush();
		expect(calls).toEqual([rowScope("gone"), rowScope("bare")]);
	});

	it("fires when the resolver throws", () => {
		const calls: string[] = [];
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("bad"),
				resolve: () => {
					throw new Error("detached");
				},
				keyframes: SHIFT,
				onDone: () => calls.push("bad"),
			},
		]);
		scheduler.flush();
		expect(calls).toEqual(["bad"]);
	});

	it("does not fire twice when finish follows cancel", () => {
		const calls: string[] = [];
		const node = fakeNode();
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("a"), node, calls)]);
		scheduler.flush();
		scheduler.cancelScope(rowScope("a"));
		// A late `finish` from the cancelled animation must be a no-op.
		(node.animations[0] as unknown as { onfinish?: () => void }).onfinish?.();
		expect(calls).toEqual([rowScope("a")]);
	});

	it("does not fire twice when cancel() follows a natural finish", () => {
		const calls: string[] = [];
		const node = fakeNode();
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([doneOp(rowScope("a"), node, calls)]);
		scheduler.flush();
		(node.animations[0] as unknown as { onfinish?: () => void }).onfinish?.();
		scheduler.cancel();
		expect(calls).toEqual([rowScope("a")]);
	});

	it("isolates a throwing callback from the rest of the event", () => {
		const calls: string[] = [];
		const scheduler = createMotionScheduler();
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("throws"),
				resolve: () => null,
				keyframes: SHIFT,
				onDone: () => {
					throw new Error("cleanup failed");
				},
			},
			doneOp(rowScope("ok"), null, calls),
		]);
		expect(() => scheduler.flush()).not.toThrow();
		expect(calls).toEqual([rowScope("ok")]);
	});
});

/**
 * Interruption must be SEAMLESS: a re-played scope resumes from where the motion it
 * replaces visually got to.
 *
 * `fill: "none"` makes a cancelled animation's node read the committed style instantly, so
 * without sampling first, the second of two rapid clicks starts from the position the
 * previous fold had already committed — a visible jump. The sample therefore has to be
 * taken BEFORE the cancel, which is the ordering these tests pin.
 */
describe("interruption: keyframes builders receive the outgoing progress", () => {
	function progressNode(elapsed: number, duration: number) {
		const animations: Array<{ cancelled: boolean }> = [];
		return {
			animations,
			animate() {
				const anim = {
					cancelled: false,
					currentTime: elapsed,
					effect: { getTiming: () => ({ duration }) },
					cancel() {
						anim.cancelled = true;
						// A cancelled WAAPI animation drops its time; sampling after this point
						// would read null, which is exactly why the scheduler samples first.
						anim.currentTime = 0;
					},
				};
				animations.push(anim);
				return anim;
			},
		};
	}

	it("hands null to the builder when the scope was idle", () => {
		const scheduler = createMotionScheduler();
		const seen: Array<MotionSample | null> = [];
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("a"),
				resolve: () => fakeNode(),
				keyframes: (p) => {
					seen.push(p);
					return SHIFT;
				},
			},
		]);
		scheduler.flush();
		expect(seen).toEqual([null]);
	});

	it("samples the outgoing animation's progress and passes it on", () => {
		const scheduler = createMotionScheduler();
		const node = progressNode(50, 200); // a quarter of the way through
		scheduler.begin();
		scheduler.push([{ scope: rowScope("a"), resolve: () => node, keyframes: SHIFT }]);
		scheduler.flush();

		const seen: Array<MotionSample | null> = [];
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("a"),
				resolve: () => node,
				keyframes: (p) => {
					seen.push(p);
					return SHIFT;
				},
			},
		]);
		scheduler.flush();
		expect(seen[0]?.progress).toBeCloseTo(0.25, 6);
		// And the outgoing animation really was stopped.
		expect(node.animations[0]?.cancelled).toBe(true);
	});

	it("clamps a sampled progress into 0..1", () => {
		// `currentTime` can exceed the duration on a finished-but-uncleaned animation.
		const scheduler = createMotionScheduler();
		const node = progressNode(500, 200);
		scheduler.begin();
		scheduler.push([{ scope: rowScope("a"), resolve: () => node, keyframes: SHIFT }]);
		scheduler.flush();
		const seen: Array<MotionSample | null> = [];
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("a"),
				resolve: () => node,
				keyframes: (p) => {
					seen.push(p);
					return SHIFT;
				},
			},
		]);
		scheduler.flush();
		expect(seen[0]?.progress).toBe(1);
	});

	it("falls back to null where the environment exposes no timing", () => {
		// The linkedom test DOM and older WebViews: the fold still works, it just starts
		// from the committed geometry as it did before resuming existed.
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([{ scope: rowScope("a"), resolve: () => node, keyframes: SHIFT }]);
		scheduler.flush();
		const seen: Array<MotionSample | null> = [];
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("a"),
				resolve: () => node,
				keyframes: (p) => {
					seen.push(p);
					return SHIFT;
				},
			},
		]);
		scheduler.flush();
		expect(seen).toEqual([null]);
	});

	it("survives a builder that throws, releasing that op only", () => {
		const scheduler = createMotionScheduler();
		const calls: string[] = [];
		const ok = fakeNode();
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("bad"),
				resolve: () => fakeNode(),
				keyframes: () => {
					throw new Error("plan failed");
				},
				onDone: () => calls.push("bad"),
			},
			{ scope: rowScope("ok"), resolve: () => ok, keyframes: SHIFT },
		]);
		expect(() => scheduler.flush()).not.toThrow();
		expect(calls).toEqual(["bad"]);
		expect(ok.animations).toHaveLength(1);
	});

	it("gives one scope's sample to the FIRST op naming it within an event", () => {
		// Two ops on one scope are one movement; only the first can have interrupted
		// something, so both must not each believe they replaced a running animation.
		const scheduler = createMotionScheduler();
		const node = progressNode(100, 200);
		scheduler.begin();
		scheduler.push([{ scope: rowScope("a"), resolve: () => node, keyframes: SHIFT }]);
		scheduler.flush();
		const seen: Array<MotionSample | null> = [];
		scheduler.begin();
		scheduler.push([
			{
				scope: rowScope("a"),
				resolve: () => node,
				keyframes: (p) => {
					seen.push(p);
					return SHIFT;
				},
			},
			{
				scope: rowScope("a"),
				resolve: () => node,
				keyframes: (p) => {
					seen.push(p);
					return SHIFT;
				},
			},
		]);
		scheduler.flush();
		expect(seen[0]?.progress).toBeCloseTo(0.5, 6);
		// The second op sees the same sample rather than a stale/absent one.
		expect(seen[1]?.progress).toBeCloseTo(0.5, 6);
	});
});

/**
 * `holdEndState` is the narrow exception to `fill: "none"`.
 *
 * A collapsing drill-down's card header is unmounted by the same event that ends its
 * morph (both are 200ms). Dropping the transform on the final frame snapped the header
 * back to its un-morphed position for exactly one frame before React removed it — a
 * visible downward flash. Holding the end state bridges it.
 */
describe("holdEndState", () => {
	it("defaults to fill: none, so no motion leaves residue", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([op(rowScope("a"), node)]);
		scheduler.flush();
		expect(node.animations[0]?.options.fill).toBe("none");
	});

	it("holds the final keyframe only when asked", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([{ ...op(drillScope("t::r0"), node), holdEndState: true }]);
		scheduler.flush();
		expect(node.animations[0]?.options.fill).toBe("forwards");
	});

	it("still cancels a held animation on teardown, so nothing is left applied", () => {
		// A `forwards` fill would otherwise outlive the list.
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		scheduler.begin();
		scheduler.push([{ ...op(drillScope("t::r0"), node), holdEndState: true }]);
		scheduler.flush();
		scheduler.cancel();
		expect(node.animations[0]?.cancelled).toBe(true);
	});

	it("still cancels a held animation when its scope is re-played", () => {
		const scheduler = createMotionScheduler();
		const node = fakeNode();
		const held = { ...op(drillScope("t::r0"), node), holdEndState: true };
		scheduler.begin();
		scheduler.push([held]);
		scheduler.flush();
		scheduler.begin();
		scheduler.push([held]);
		scheduler.flush();
		expect(node.animations[0]?.cancelled).toBe(true);
		expect(node.animations[1]?.cancelled).toBe(false);
	});
});

describe("scope names", () => {
	it("keeps the four families disjoint", () => {
		// One node carries data-nf-row-key AND data-nf-unit, so a row motion and an LOD
		// morph on the same element must NOT share a cancel domain by accident.
		const names = [rowScope("x"), frameScope("x"), drillScope("x"), lodScope("x")];
		expect(new Set(names).size).toBe(4);
	});
});

describe("prefersReducedMotion", () => {
	it("returns false where matchMedia is unavailable", () => {
		expect(prefersReducedMotion()).toBe(false);
	});
});
