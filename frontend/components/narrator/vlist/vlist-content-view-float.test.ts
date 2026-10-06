/**
 * vlist-content-view-float.test.ts — where a body's action bar lives while the
 * reader scrolls through it.
 *
 * The property that matters most is the LAST describe block: once floating, the
 * resolved position must not depend on how far the body has scrolled. That is
 * what makes the bar stand still during a scroll instead of chasing the content a
 * frame behind (the jitter this module replaced).
 */

import { describe, expect, test } from "bun:test";
import {
	resolveFloatState,
	resolveScrollToBodyTop,
	VIEW_ACTION_BAR_GAP,
	VIEW_ACTION_BAR_HEIGHT,
	VIEW_SCROLL_TO_TOP_GAP,
} from "./vlist-content-view-float";

const SCROLLER_TOP = 100;
const VIEWPORT_WIDTH = 1000;

/** A body whose head sits `above` px past the scroller's top edge. */
function geometry(opts: { above: number; height?: number; right?: number }) {
	const bodyTop = SCROLLER_TOP - opts.above;
	return {
		bodyTop,
		bodyBottom: bodyTop + (opts.height ?? 400),
		bodyRight: opts.right ?? 800,
		scrollerTop: SCROLLER_TOP,
		viewportWidth: VIEWPORT_WIDTH,
	};
}

describe("resolveFloatState — parked", () => {
	test("head visible → the bar stays an ordinary in-flow overlay", () => {
		expect(resolveFloatState(geometry({ above: -50 })).mode).toBe("parked");
	});

	test("head exactly at the scroller top is still parked", () => {
		expect(resolveFloatState(geometry({ above: 0 })).mode).toBe("parked");
	});

	test("non-finite geometry degrades to parked rather than jumping somewhere", () => {
		expect(
			resolveFloatState({
				bodyTop: Number.NaN,
				bodyBottom: 400,
				bodyRight: 800,
				scrollerTop: SCROLLER_TOP,
				viewportWidth: VIEWPORT_WIDTH,
			}).mode,
		).toBe("parked");
	});
});

describe("resolveFloatState — floating", () => {
	test("pins to the scroller's top edge, inset by the gap", () => {
		const state = resolveFloatState(geometry({ above: 120 }));
		expect(state.mode).toBe("floating");
		expect(state.top).toBe(SCROLLER_TOP + VIEW_ACTION_BAR_GAP);
	});

	test("right edge follows the body's own right edge", () => {
		const state = resolveFloatState(geometry({ above: 120, right: 800 }));
		// 1000 - 800 + 4
		expect(state.right).toBe(VIEWPORT_WIDTH - 800 + VIEW_ACTION_BAR_GAP);
	});

	test("a body reaching the viewport's right edge keeps a minimum inset", () => {
		const state = resolveFloatState(geometry({ above: 120, right: VIEWPORT_WIDTH }));
		expect(state.right).toBe(VIEW_ACTION_BAR_GAP);
	});

	test("carries the body's own height, for consumers that gate on body size", () => {
		// The touch scroll-to-top button ignores short bodies; it reads the height
		// from here rather than re-measuring.
		const state = resolveFloatState(geometry({ above: 120, height: 640 }));
		expect(state.mode).toBe("floating");
		expect(state.bodyHeight).toBe(640);
	});
});

describe("resolveFloatState — hidden", () => {
	test("hides once too little of the body is left to host the bar", () => {
		// Only 20px of a 200px body remains below the fold.
		expect(resolveFloatState(geometry({ above: 180, height: 200 })).mode).toBe("hidden");
	});

	test("still floats while exactly enough room remains", () => {
		const remaining = VIEW_ACTION_BAR_HEIGHT + VIEW_ACTION_BAR_GAP;
		const state = resolveFloatState(geometry({ above: 400 - remaining, height: 400 }));
		expect(state.mode).toBe("floating");
	});

	test("a body shorter than the bar never floats", () => {
		expect(resolveFloatState(geometry({ above: 5, height: 10 })).mode).toBe("hidden");
	});
});

/**
 * The anti-jitter property, stated directly: scrolling a floating body further
 * must not move the bar. If this ever fails, the bar is chasing the content again.
 */
describe("resolveFloatState — position is invariant under scrolling", () => {
	test("the same body at three scroll depths resolves to one position", () => {
		const positions = [200, 400, 600].map((above) => {
			const state = resolveFloatState(geometry({ above, height: 2000 }));
			expect(state.mode).toBe("floating");
			return `${state.top}:${state.right}`;
		});
		expect(new Set(positions).size).toBe(1);
	});

	test("only the horizontal bounds (a resize, not a scroll) can move it", () => {
		const narrow = resolveFloatState(geometry({ above: 200, height: 2000, right: 600 }));
		const wide = resolveFloatState(geometry({ above: 200, height: 2000, right: 900 }));
		expect(narrow.top).toBe(wide.top);
		expect(narrow.right).not.toBe(wide.right);
	});
});

describe("resolveScrollToBodyTop", () => {
	test("scrolls up by how far the head is above the fold, minus the gap", () => {
		const target = resolveScrollToBodyTop(geometry({ above: 60 }), 900);
		expect(target).toBe(900 - 60 - VIEW_SCROLL_TO_TOP_GAP);
	});

	test("clamps at the top of the history", () => {
		const target = resolveScrollToBodyTop(geometry({ above: 500 }), 20);
		expect(target).toBe(0);
	});

	test("scrolls DOWN for a body below the fold", () => {
		const target = resolveScrollToBodyTop(geometry({ above: -200 }), 500);
		expect(target).toBe(500 + 200 - VIEW_SCROLL_TO_TOP_GAP);
	});

	test("honours a custom gap", () => {
		expect(resolveScrollToBodyTop(geometry({ above: 60 }), 900, 0)).toBe(840);
	});
});
