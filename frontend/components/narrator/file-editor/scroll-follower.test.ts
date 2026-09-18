import { expect, test } from "bun:test";
import {
	createScrollFollower,
	SCROLL_FOLLOW_SNAP_PX,
	SCROLL_FOLLOW_TAU_MS,
	scrollFollowStep,
} from "./scroll-follower";

test("scrollFollowStep eases exponentially and snaps at the end", () => {
	expect(scrollFollowStep(0, 100, 0)).toBe(0);
	const first = scrollFollowStep(0, 100, 1000 / 60);
	// One frame closes 1 - e^(-dt/τ) ≈ 17% of the distance with the defaults.
	expect(first).toBeCloseTo(100 * (1 - Math.exp(-1000 / 60 / SCROLL_FOLLOW_TAU_MS)), 5);
	expect(scrollFollowStep(100 - SCROLL_FOLLOW_SNAP_PX / 2, 100, 1000 / 60)).toBe(100);
	let position = 0;
	for (let i = 0; i < 500; i++) position = scrollFollowStep(position, 100, 1000 / 60);
	expect(position).toBe(100);
});

/** Minimal manual rAF: registered callbacks run when the test pumps time. */
function fakeRaf() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, (time: number) => void>();
	return {
		raf: (callback: (time: number) => void) => {
			const id = nextId++;
			pending.set(id, callback);
			return id;
		},
		cancelRaf: (id: number) => {
			pending.delete(id);
		},
		pendingCount: () => pending.size,
		pump: (ms: number) => {
			now += ms;
			const callbacks = [...pending.values()];
			pending.clear();
			for (const callback of callbacks) callback(now);
		},
	};
}

test("createScrollFollower animates to the target, then stops scheduling frames", () => {
	const { raf, cancelRaf, pendingCount, pump } = fakeRaf();
	let value = 0;
	const follower = createScrollFollower(
		() => value,
		(next) => {
			value = next;
		},
		raf,
		cancelRaf,
	);
	follower.setTarget(100);
	expect(follower.active).toBe(true);
	expect(pendingCount()).toBe(1);
	for (let i = 0; i < 500 && pendingCount() > 0; i++) pump(1000 / 60);
	expect(value).toBe(100);
	expect(follower.active).toBe(false);
	expect(pendingCount()).toBe(0);
	// Settled: pumping more time writes nothing.
	pump(1000 / 60);
	expect(value).toBe(100);
});

test("retargeting mid-flight eases from the current position, and cancel stops writes", () => {
	const { raf, cancelRaf, pendingCount, pump } = fakeRaf();
	let value = 0;
	const follower = createScrollFollower(
		() => value,
		(next) => {
			value = next;
		},
		raf,
		cancelRaf,
	);
	follower.setTarget(100);
	for (let i = 0; i < 10; i++) pump(1000 / 60);
	const midway = value;
	expect(midway).toBeGreaterThan(50);
	expect(midway).toBeLessThan(100);
	// A new target does not snap; the next step starts from the current value.
	follower.setTarget(-50);
	pump(1000 / 60);
	expect(value).toBeLessThan(midway);
	expect(value).toBeGreaterThan(-50);
	follower.cancel();
	expect(follower.active).toBe(false);
	expect(pendingCount()).toBe(0);
	const frozen = value;
	pump(1000 / 60);
	expect(value).toBe(frozen);
});
