import { describe, expect, test } from "bun:test";
import {
	createTabStripWheelScroller,
	maxScrollLeft,
	normalizeTabStripWheelDelta,
	resolveTabStripWheelTarget,
	type ScrollableX,
	type WheelLike,
} from "./tab-strip-wheel";

/** Emulates the DOM: scrollLeft is clamped to [0, scrollWidth - clientWidth]. */
function scroller(overrides: Partial<ScrollableX> = {}): ScrollableX {
	const base = {
		scrollWidth: 800,
		clientWidth: 300,
		...overrides,
	};
	let left = overrides.scrollLeft ?? 0;
	return {
		scrollWidth: base.scrollWidth,
		clientWidth: base.clientWidth,
		get scrollLeft() {
			return left;
		},
		set scrollLeft(next: number) {
			const max = Math.max(0, base.scrollWidth - base.clientWidth);
			left = Math.min(max, Math.max(0, next));
		},
	};
}

function wheel(overrides: Partial<WheelLike> = {}) {
	const calls = { preventDefault: 0 };
	const event: WheelLike = {
		deltaX: 0,
		deltaY: 100,
		deltaMode: 0,
		ctrlKey: false,
		metaKey: false,
		preventDefault: () => {
			calls.preventDefault += 1;
		},
		...overrides,
	};
	return { event, calls };
}

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

function harness(options?: { overrides?: Partial<ScrollableX>; reducedMotion?: boolean }) {
	const el = scroller(options?.overrides);
	const raf = createFakeRaf();
	const scrollerCtl = createTabStripWheelScroller(el, {
		raf: raf.raf,
		cancelRaf: raf.cancelRaf,
		now: () => 0,
		isReducedMotion: () => options?.reducedMotion === true,
	});
	const runFrames = (count: number) => {
		for (let frame = 1; frame <= count; frame++) raf.runFrame(frame * 16.7);
	};
	return { el, raf, scrollerCtl, runFrames };
}

describe("normalizeTabStripWheelDelta", () => {
	test("pixel-mode deltaY passes through and tracks deltaX", () => {
		expect(normalizeTabStripWheelDelta({ ...wheel().event, deltaY: 100 }, 300)).toBe(100);
		expect(normalizeTabStripWheelDelta({ ...wheel().event, deltaX: 25, deltaY: 75 }, 300)).toBe(
			100,
		);
	});

	test("line-mode deltaY is converted at 40px per line", () => {
		expect(normalizeTabStripWheelDelta({ ...wheel().event, deltaY: 3, deltaMode: 1 }, 300)).toBe(
			120,
		);
	});

	test("page-mode deltaY is scaled by clientWidth", () => {
		expect(normalizeTabStripWheelDelta({ ...wheel().event, deltaY: 1, deltaMode: 2 }, 250)).toBe(
			250,
		);
	});
});

describe("resolveTabStripWheelTarget", () => {
	const base = { maxScroll: 500, ctrlKey: false, metaKey: false, animating: false };

	test("plain vertical wheel moves the target without shift", () => {
		expect(resolveTabStripWheelTarget({ ...base, target: 0, delta: 100 })).toEqual({
			target: 100,
			consume: true,
		});
	});

	test("negative delta moves left", () => {
		expect(resolveTabStripWheelTarget({ ...base, target: 50, delta: -30 })).toEqual({
			target: 20,
			consume: true,
		});
	});

	test("the target clamps at both edges", () => {
		expect(resolveTabStripWheelTarget({ ...base, target: 480, delta: 100 })).toEqual({
			target: 500,
			consume: true,
		});
		expect(resolveTabStripWheelTarget({ ...base, target: 20, delta: -100 })).toEqual({
			target: 0,
			consume: true,
		});
	});

	test("at the edge while idle the event bubbles so ancestors can keep scrolling", () => {
		expect(resolveTabStripWheelTarget({ ...base, target: 500, delta: 100 })).toEqual({
			target: 500,
			consume: false,
		});
		expect(resolveTabStripWheelTarget({ ...base, target: 0, delta: -100 })).toEqual({
			target: 0,
			consume: false,
		});
	});

	test("at the edge while a chase is still landing the event is consumed (no mid-slide page scroll)", () => {
		expect(
			resolveTabStripWheelTarget({ ...base, target: 500, delta: 100, animating: true }),
		).toEqual({ target: 500, consume: true });
	});

	test("non-scrollable strip leaves the event alone", () => {
		expect(resolveTabStripWheelTarget({ ...base, maxScroll: 0, target: 0, delta: 100 })).toEqual({
			target: 0,
			consume: false,
		});
	});

	test("ctrl/meta wheel is left for browser zoom (trackpad pinch)", () => {
		expect(resolveTabStripWheelTarget({ ...base, target: 0, delta: 100, ctrlKey: true })).toEqual({
			target: 0,
			consume: false,
		});
		expect(resolveTabStripWheelTarget({ ...base, target: 0, delta: 100, metaKey: true })).toEqual({
			target: 0,
			consume: false,
		});
	});

	test("zero effective delta is ignored", () => {
		expect(resolveTabStripWheelTarget({ ...base, target: 0, delta: 0 })).toEqual({
			target: 0,
			consume: false,
		});
	});
});

describe("createTabStripWheelScroller", () => {
	test("a plain wheel notch glides to the target instead of jumping", () => {
		const { el, raf, scrollerCtl, runFrames } = harness();
		const { event, calls } = wheel({ deltaY: 100 });
		expect(scrollerCtl.handleWheel(event)).toBe(true);
		expect(calls.preventDefault).toBe(1);
		// Nothing is written synchronously — the chase is scheduled.
		expect(el.scrollLeft).toBe(0);
		expect(raf.pendingCount).toBe(1);
		runFrames(60);
		expect(el.scrollLeft).toBe(100);
		expect(raf.pendingCount).toBe(0);
	});

	test("rapid notches accumulate into one chase (no per-notch restart)", () => {
		const { el, raf, scrollerCtl, runFrames } = harness();
		scrollerCtl.handleWheel(wheel({ deltaY: 100 }).event);
		scrollerCtl.handleWheel(wheel({ deltaY: 100 }).event);
		scrollerCtl.handleWheel(wheel({ deltaY: 100 }).event);
		// Three input events, one animation loop.
		expect(raf.pendingCount).toBe(1);
		runFrames(60);
		expect(el.scrollLeft).toBe(300);
	});

	test("shift+wheel keeps working (same mapping, not disabled)", () => {
		const { el, scrollerCtl, runFrames } = harness();
		const { event, calls } = wheel({ deltaY: 40 });
		Object.assign(event, { shiftKey: true });
		expect(scrollerCtl.handleWheel(event)).toBe(true);
		expect(calls.preventDefault).toBe(1);
		runFrames(60);
		expect(el.scrollLeft).toBe(40);
	});

	test("mid-chase input keeps accumulating onto the moving target", () => {
		const { el, scrollerCtl, runFrames } = harness();
		scrollerCtl.handleWheel(wheel({ deltaY: 200 }).event);
		runFrames(2);
		const mid = el.scrollLeft;
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(200);
		scrollerCtl.handleWheel(wheel({ deltaY: 100 }).event);
		runFrames(60);
		expect(el.scrollLeft).toBe(300);
	});

	test("reduced motion lands instantly (no animation loop)", () => {
		const { el, raf, scrollerCtl } = harness({ reducedMotion: true });
		const { event, calls } = wheel({ deltaY: 100 });
		expect(scrollerCtl.handleWheel(event)).toBe(true);
		expect(calls.preventDefault).toBe(1);
		expect(el.scrollLeft).toBe(100);
		expect(raf.pendingCount).toBe(0);
	});

	test("at the right edge while idle the event bubbles", () => {
		const { el, scrollerCtl } = harness({ overrides: { scrollLeft: 500 } });
		const { event, calls } = wheel({ deltaY: 100 });
		expect(scrollerCtl.handleWheel(event)).toBe(false);
		expect(el.scrollLeft).toBe(500);
		expect(calls.preventDefault).toBe(0);
	});

	test("at the left edge while idle the event bubbles", () => {
		const { el, scrollerCtl } = harness({ overrides: { scrollLeft: 0 } });
		const { event, calls } = wheel({ deltaY: -100 });
		expect(scrollerCtl.handleWheel(event)).toBe(false);
		expect(el.scrollLeft).toBe(0);
		expect(calls.preventDefault).toBe(0);
	});

	test("overshooting the edge clamps and then bubbles once idle", () => {
		const { el, scrollerCtl, runFrames } = harness();
		const first = wheel({ deltaY: 10_000 });
		expect(scrollerCtl.handleWheel(first.event)).toBe(true);
		runFrames(60);
		expect(el.scrollLeft).toBe(500); // clamped to maxScrollLeft
		// Landed at the edge: further right-wheeling bubbles to the panel.
		const second = wheel({ deltaY: 100 });
		expect(scrollerCtl.handleWheel(second.event)).toBe(false);
		expect(second.calls.preventDefault).toBe(0);
	});

	test("ctrl+wheel is left for browser zoom (trackpad pinch)", () => {
		const { el, raf, scrollerCtl } = harness();
		const { event, calls } = wheel({ deltaY: 100, ctrlKey: true });
		expect(scrollerCtl.handleWheel(event)).toBe(false);
		expect(el.scrollLeft).toBe(0);
		expect(calls.preventDefault).toBe(0);
		expect(raf.pendingCount).toBe(0);
	});

	test("a non-scrollable strip never consumes the wheel", () => {
		const { el, scrollerCtl } = harness({ overrides: { scrollWidth: 300, clientWidth: 300 } });
		const { event, calls } = wheel({ deltaY: 100 });
		expect(scrollerCtl.handleWheel(event)).toBe(false);
		expect(el.scrollLeft).toBe(0);
		expect(calls.preventDefault).toBe(0);
	});

	test("destroy stops the chase without further writes", () => {
		const { el, scrollerCtl, runFrames } = harness();
		scrollerCtl.handleWheel(wheel({ deltaY: 100 }).event);
		runFrames(2);
		const mid = el.scrollLeft;
		scrollerCtl.destroy();
		runFrames(10);
		expect(el.scrollLeft).toBe(mid);
	});
});

describe("maxScrollLeft", () => {
	test("is width difference and never negative", () => {
		expect(maxScrollLeft(scroller())).toBe(500);
		expect(maxScrollLeft(scroller({ scrollWidth: 200, clientWidth: 300 }))).toBe(0);
	});
});
