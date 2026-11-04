import { describe, expect, test } from "bun:test";
import {
	createNavHoverIntent,
	NAV_HOVER_COLLAPSE_DELAY_MS,
	NAV_HOVER_EXPAND_DELAY_MS,
	NAV_HOVER_HOLD_RECHECK_MS,
} from "./nav-hover-expand";

function fakeTimers() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { due: number; callback: () => void }>();
	return {
		timers: {
			setTimeout: (callback: () => void, ms: number) => {
				const id = nextId++;
				pending.set(id, { due: now + ms, callback });
				return id;
			},
			clearTimeout: (handle: unknown) => {
				pending.delete(handle as number);
			},
		},
		advance(ms: number) {
			const target = now + ms;
			while (true) {
				const next = [...pending].sort((a, b) => a[1].due - b[1].due)[0];
				if (!next || next[1].due > target) break;
				now = next[1].due;
				pending.delete(next[0]);
				next[1].callback();
			}
			now = target;
		},
	};
}

function setup(held = () => false) {
	const clock = fakeTimers();
	const changes: boolean[] = [];
	const intent = createNavHoverIntent({
		onChange: (expanded) => changes.push(expanded),
		isHeld: held,
		timers: clock.timers,
	});
	return { clock, changes, intent };
}

describe("collapsed sidebar hover expansion", () => {
	test("opens after resting on the rail, not when passing over it", () => {
		const { clock, changes, intent } = setup();
		intent.enter();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS - 1);
		intent.leave();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS);
		expect(changes).toEqual([]);

		intent.enter();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS);
		expect(changes).toEqual([true]);
	});

	test("closes after leaving, and coming back in time keeps it open", () => {
		const { clock, changes, intent } = setup();
		intent.enter();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS);
		intent.leave();
		clock.advance(NAV_HOVER_COLLAPSE_DELAY_MS - 1);
		intent.enter();
		clock.advance(NAV_HOVER_COLLAPSE_DELAY_MS * 2);
		expect(intent.isExpanded()).toBe(true);

		intent.leave();
		clock.advance(NAV_HOVER_COLLAPSE_DELAY_MS);
		expect(changes).toEqual([true, false]);
	});

	test("reaching the panel's own menu keeps it open; keep never opens a closed rail", () => {
		const { clock, intent } = setup();
		intent.keep();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS * 2);
		expect(intent.isExpanded()).toBe(false);

		intent.enter();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS);
		intent.leave();
		intent.keep();
		clock.advance(NAV_HOVER_COLLAPSE_DELAY_MS * 2);
		expect(intent.isExpanded()).toBe(true);
	});

	test("stays open while held (a drag, an open menu) and closes once released", () => {
		let held = true;
		const { clock, intent } = setup(() => held);
		intent.enter();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS);
		intent.leave();
		clock.advance(NAV_HOVER_COLLAPSE_DELAY_MS + NAV_HOVER_HOLD_RECHECK_MS * 3);
		expect(intent.isExpanded()).toBe(true);

		held = false;
		clock.advance(NAV_HOVER_HOLD_RECHECK_MS);
		expect(intent.isExpanded()).toBe(false);
	});

	test("reset closes at once and cancels a pending open", () => {
		const { clock, intent } = setup();
		intent.enter();
		intent.reset();
		clock.advance(NAV_HOVER_EXPAND_DELAY_MS);
		expect(intent.isExpanded()).toBe(false);
	});
});
