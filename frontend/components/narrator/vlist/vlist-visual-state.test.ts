/**
 * Tests for the visual-state store — the piece that makes interruption structural rather
 * than something to be patched afterwards.
 *
 * The properties here are the ones the keyframe architecture could not hold. Most
 * importantly: a target change mid-flight must continue from the CURRENT VISUAL POSITION,
 * because planning from the previous committed snapshot is what produced a visible jump at
 * every step of a held gesture (300px, then 127px, then 97px across three quick steps).
 */

import { describe, expect, it } from "bun:test";
import {
	convergeChannel,
	createVisualStateStore,
	MORPH_MAX_VELOCITY_PX_PER_MS,
	MORPH_MIN_STEP_PX,
	MORPH_SETTLE_EPSILON_PX,
	MORPH_SETTLE_FRAMES,
	MORPH_STATE_MAX_ENTRIES,
	MORPH_TAU_MS,
	restingTarget,
	type VisualTarget,
} from "./vlist-visual-state";

const at = (y: number, extra: Partial<VisualTarget> = {}): VisualTarget => ({
	x: 0,
	y,
	opacity: 1,
	cardness: 0,
	...extra,
});

// ── convergeChannel ───────────────────────────────────────────────────────────
describe("convergeChannel", () => {
	it("moves a fraction of the remaining distance", () => {
		// One τ covers 1 − 1/e ≈ 63.2% of the way.
		const { next } = convergeChannel(0, 100, MORPH_TAU_MS, { maxVelocity: undefined });
		expect(next).toBeCloseTo(100 * (1 - Math.exp(-1)), 6);
	});

	it("is symmetric in sign — a morph has no privileged direction", () => {
		// The scroll-follow this borrows from only ever chases downward; a morph reverses, so
		// the step works on magnitude and re-applies the sign.
		const up = convergeChannel(0, 100, 16);
		const down = convergeChannel(0, -100, 16);
		expect(down.next).toBeCloseTo(-up.next, 9);
	});

	it("never overshoots, however large the frame", () => {
		// A long frame (a stalled tab) would otherwise fling the element past its target,
		// which on a reversing morph reads as a bounce.
		for (const dt of [16, 100, 1000, 10_000]) {
			const { next } = convergeChannel(0, 50, dt);
			expect(next).toBeLessThanOrEqual(50);
			expect(convergeChannel(0, -50, dt).next).toBeGreaterThanOrEqual(-50);
		}
	});

	it("does not move for a zero-length frame", () => {
		// Otherwise the floor teleports a fraction of a pixel for no elapsed time, and two
		// half-frames stop being equivalent to one whole frame.
		expect(convergeChannel(0, 100, 0).next).toBe(0);
		expect(convergeChannel(0, 100, 0).arrived).toBe(false);
	});

	it("snaps to the exact target within epsilon, so the end value is not an epsilon-sized lie", () => {
		const { next, arrived } = convergeChannel(99.9, 100, 16);
		expect(next).toBe(100);
		expect(arrived).toBe(true);
	});

	it("caps velocity so a thousand-pixel switch travels instead of teleporting", () => {
		const dt = 16;
		const { next } = convergeChannel(0, 100_000, dt, {
			maxVelocity: MORPH_MAX_VELOCITY_PX_PER_MS,
		});
		expect(next).toBeCloseTo(MORPH_MAX_VELOCITY_PX_PER_MS * dt, 6);
	});

	it("applies a floor so the tail does not degenerate into still frames plus a lurch", () => {
		// 0.1px from a 60Hz frame would be sub-device-pixel: several identical renders, then a
		// visible 1px jump.
		const { next } = convergeChannel(0, 10, 0.01, { minStep: MORPH_MIN_STEP_PX });
		expect(next).toBeGreaterThanOrEqual(MORPH_MIN_STEP_PX);
	});

	it("keeps the floor from overshooting a near-target value", () => {
		// The floor must never carry the value past the target — the remainder wins.
		const { next, arrived } = convergeChannel(0, MORPH_MIN_STEP_PX / 2, 0.01, {
			minStep: MORPH_MIN_STEP_PX,
			epsilon: 0,
		});
		expect(next).toBe(MORPH_MIN_STEP_PX / 2);
		expect(arrived).toBe(true);
	});

	it("is monotonic in dt — a longer frame never lands further from the target", () => {
		let previous = 0;
		for (const dt of [1, 2, 4, 8, 16, 32, 64]) {
			const { next } = convergeChannel(0, 500, dt, { maxVelocity: undefined });
			expect(next).toBeGreaterThanOrEqual(previous);
			previous = next;
		}
	});
});

// ── The interruption property ─────────────────────────────────────────────────
describe("interruption is structural, not a special case", () => {
	it("continues from the CURRENT VISUAL POSITION when the target changes mid-flight", () => {
		// This is the whole point of the rewrite. The keyframe version planned from the
		// previous COMMITTED snapshot, which after a cancel was where the element had snapped
		// back to — not where it visually was.
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		store.setTarget("u", at(-300)); // step 1: travel to -300
		store.step(140); // interrupted partway (the gesture throttle)
		const mid = store.get("u")?.y as number;
		expect(mid).toBeLessThan(0);
		expect(mid).toBeGreaterThan(-300);

		// Step 2 arrives while still moving. The state must not jump.
		store.setTarget("u", at(-550));
		const afterRetarget = store.get("u")?.y as number;
		expect(afterRetarget).toBe(mid); // no discontinuity at the moment of retargeting
	});

	it("reverses smoothly without passing through the committed position", () => {
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		store.setTarget("u", at(-300));
		store.step(140);
		const mid = store.get("u")?.y as number;
		// Reverse: back toward 0.
		store.setTarget("u", at(0));
		store.step(16);
		const afterReverse = store.get("u")?.y as number;
		// Moved back toward zero from where it was, and did not teleport to either end.
		expect(afterReverse).toBeGreaterThan(mid);
		expect(afterReverse).toBeLessThan(0);
	});

	it("stays continuous across three rapid steps (the held-gesture case)", () => {
		// The scenario that exposed the old design: 140ms apart, 250ms animations.
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		const seen: number[] = [];
		for (const target of [-300, -550, -750]) {
			store.setTarget("u", at(target));
			seen.push(store.get("u")?.y as number);
			store.step(140);
		}
		// Each step began exactly where the previous frame left the element: no jumps.
		expect(seen[0]).toBe(0);
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i]).toBeLessThan(seen[i - 1] as number);
			expect(Number.isFinite(seen[i] as number)).toBe(true);
		}
	});

	it("a brand-new element starts AT its target rather than animating from nowhere", () => {
		// With nothing on screen to continue from, travel would be an animation the reader
		// cannot interpret.
		const store = createVisualStateStore();
		store.setTarget("fresh", at(-500));
		expect(store.get("fresh")?.y).toBe(-500);
		expect(store.isIdle()).toBe(true);
	});
});

// ── Settling ──────────────────────────────────────────────────────────────────
describe("settling", () => {
	it("requires consecutive in-epsilon frames, so a mid-gesture coincidence cannot stop it", () => {
		expect(MORPH_SETTLE_FRAMES).toBeGreaterThan(1);
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		store.setTarget("u", at(-100));
		// Converge until within epsilon.
		for (let i = 0; i < 200 && !store.isIdle(); i++) store.step(16);
		expect(store.isIdle()).toBe(true);
		expect(store.get("u")?.y).toBe(-100);
	});

	it("reports movement while still counting down its settle frames", () => {
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		store.setTarget("u", at(MORPH_SETTLE_EPSILON_PX / 2)); // already within epsilon
		// Within epsilon but the count was reset by the retarget, so frames are still owed.
		expect(store.isIdle()).toBe(false);
		let guard = 0;
		while (!store.isIdle() && guard++ < 10) store.step(16);
		expect(store.isIdle()).toBe(true);
	});

	it("lands on the EXACT target, not epsilon away from it", () => {
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		store.setTarget("u", at(-42.7, { opacity: 0.3, cardness: 1 }));
		for (let i = 0; i < 500 && !store.isIdle(); i++) store.step(16);
		const s = store.get("u");
		expect(s?.y).toBe(-42.7);
		expect(s?.opacity).toBe(0.3);
		expect(s?.cardness).toBe(1);
	});

	it("step() returns false only once nothing needs another frame", () => {
		const store = createVisualStateStore();
		store.setTarget("u", at(0));
		store.setTarget("u", at(-100));
		let moving = true;
		let frames = 0;
		while (moving && frames++ < 500) moving = store.step(16);
		expect(moving).toBe(false);
		expect(store.isIdle()).toBe(true);
	});
});

// ── Reclamation ───────────────────────────────────────────────────────────────
describe("reclamation", () => {
	it("keeps an unadmitted entry until it settles, so a fade-out is not frozen", () => {
		const store = createVisualStateStore();
		store.setTarget("gone", at(0));
		store.setTarget("gone", at(0, { opacity: 0 })); // fading out
		store.retain(new Set()); // no longer admitted
		expect(store.sweep()).toBe(0);
		expect(store.size()).toBe(1);
		for (let i = 0; i < 500 && !store.isIdle(); i++) store.step(16);
		expect(store.sweep()).toBe(1);
		expect(store.size()).toBe(0);
	});

	it("keeps admitted entries regardless of settling", () => {
		const store = createVisualStateStore();
		store.setTarget("stay", restingTarget(0));
		store.retain(new Set(["stay"]));
		store.sweep();
		expect(store.size()).toBe(1);
	});

	it("enforces a hard ceiling so a long session cannot grow without bound", () => {
		const store = createVisualStateStore();
		for (let i = 0; i < MORPH_STATE_MAX_ENTRIES + 50; i++) {
			store.setTarget(`u${i}`, restingTarget(0));
			// Advance the frame counter so eviction has a meaningful LRU order.
			store.step(16);
		}
		store.retain(new Set([...Array(MORPH_STATE_MAX_ENTRIES + 50)].map((_, i) => `u${i}`)));
		store.sweep();
		expect(store.size()).toBeLessThanOrEqual(MORPH_STATE_MAX_ENTRIES);
	});

	it("evicts the least recently touched first when over the ceiling", () => {
		const store = createVisualStateStore();
		store.setTarget("oldest", restingTarget(0));
		for (let i = 0; i < 5; i++) store.step(16);
		for (let i = 0; i < MORPH_STATE_MAX_ENTRIES; i++) {
			store.setTarget(`u${i}`, restingTarget(0));
			store.step(16);
		}
		store.retain(
			new Set(["oldest", ...[...Array(MORPH_STATE_MAX_ENTRIES)].map((_, i) => `u${i}`)]),
		);
		store.sweep();
		expect(store.get("oldest")).toBeNull();
	});
});

/**
 * EVERY switch must animate, not just the first.
 *
 * The bug this pins made the whole rewrite look like it had not happened: `setTarget`
 * deliberately never moves an existing element (that is what makes an interruption
 * continuous), so seeding a displacement through it did nothing for any element the store
 * already held. The first switch worked — the entry was new — and every switch afterwards
 * applied no displacement at all and teleported.
 *
 * It also explains the confusing report that interrupting repeatedly "fixed" it: an
 * interrupted element is still moving, so it took the correct branch by accident.
 */
describe("repeated switches", () => {
	const REST: VisualTarget = { x: 0, y: 0, opacity: 1, cardness: 1 };
	/** The shell's wiring, reproduced exactly. */
	function applySwitch(
		store: ReturnType<typeof createVisualStateStore>,
		id: string,
		fromY: number,
	) {
		if (store.isMoving(id)) store.setTarget(id, REST);
		else store.startFrom(id, { x: 0, y: fromY, opacity: 1, cardness: 0 }, REST);
	}
	/** Frames until the store settles, i.e. how much animation actually happened. */
	function runToRest(store: ReturnType<typeof createVisualStateStore>): number {
		let frames = 0;
		let guard = 0;
		while (store.step(16) && guard++ < 500) frames++;
		return frames;
	}

	it("animates on the SECOND and later switches, not only the first", () => {
		const store = createVisualStateStore();
		const lengths: number[] = [];
		for (let n = 1; n <= 4; n++) {
			applySwitch(store, "t", -200 - n * 50);
			lengths.push(runToRest(store));
		}
		// Every switch produced a real trajectory; before the fix these were 34, 2, 2, 2.
		for (const frames of lengths) expect(frames).toBeGreaterThan(5);
	});

	it("applies the displacement each time a settled element switches again", () => {
		const store = createVisualStateStore();
		applySwitch(store, "t", -250);
		runToRest(store);
		expect(store.isMoving("t")).toBe(false);
		applySwitch(store, "t", -300);
		expect(store.get("t")?.y).toBe(-300);
	});

	it("still continues from the live position when interrupted", () => {
		// The fix must not cost the interruption property: a MOVING element is retargeted, never
		// re-seeded, so its visual position is untouched at the moment of the switch.
		const store = createVisualStateStore();
		applySwitch(store, "t", -300);
		store.step(140);
		const mid = store.get("t")?.y as number;
		expect(mid).toBeLessThan(0);
		expect(mid).toBeGreaterThan(-300);
		applySwitch(store, "t", -400);
		expect(store.get("t")?.y).toBe(mid);
	});

	it("isMoving distinguishes settled from merely present", () => {
		// Keying on presence is what broke it: a settled entry is still retained.
		const store = createVisualStateStore();
		store.startFrom("t", { x: 0, y: -100, opacity: 1, cardness: 0 }, REST);
		expect(store.get("t")).not.toBeNull();
		expect(store.isMoving("t")).toBe(true);
		runToRest(store);
		expect(store.get("t")).not.toBeNull(); // still present…
		expect(store.isMoving("t")).toBe(false); // …but no longer moving
	});

	it("treats a fresh retarget as moving, so a rapid second switch stays continuous", () => {
		const store = createVisualStateStore();
		store.startFrom("t", { x: 0, y: -100, opacity: 1, cardness: 0 }, REST);
		runToRest(store);
		store.setTarget("t", { ...REST, y: -20 });
		expect(store.isMoving("t")).toBe(true);
	});
});
