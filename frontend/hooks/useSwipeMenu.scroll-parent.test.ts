/**
 * useSwipeMenu.scroll-parent.test.ts — the scrollable-ancestor walk behind the
 * off-screen swipe-anchor overlay.
 *
 * When a swiped row scrolls out of view, `useSwipeMenu` pins a translucent preview
 * strip to the edge of the SCROLL AREA (SwipeAnchorOverlay). To decide "out of
 * view" it needs the row's scroll container, which it finds by walking up from the
 * row until an ancestor overflows.
 *
 * ⚠️ Scope: this walk is NOT what broke the overlay in the virtual list (that was
 * the row being unmounted — see useSwipeMenu.offscreen-overlay.test.ts). Both
 * lists lay content out inside their wrappers' own height, so a height-only walk
 * reached the real scroller in both paths.
 *
 * These tests exist because the height-only form fails SILENTLY when it does
 * break: any ancestor that overflows while being unscrollable (`overflow: hidden`,
 * a clipped decorative canvas) captures the walk, and visibility is then measured
 * against a box the target can never leave — so no strip ever appears and nothing
 * reports an error. They pin the stricter contract: an element qualifies only if it
 * can actually scroll (`overflow-y: auto | scroll | overlay`).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { findVerticalScrollParent } from "./scroll-parent";

beforeAll(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	// linkedom computes no layout, so the tests set the three geometry inputs the
	// walk reads (scrollHeight / clientHeight / overflow-y) explicitly.
	(globalThis as { window?: unknown }).window = window;
	(globalThis as { document?: unknown }).document = window.document;
	(globalThis as { getComputedStyle?: unknown }).getComputedStyle = (el: {
		__overflowY?: string;
	}) => ({ overflowY: el.__overflowY ?? "visible" });
});

interface FakeBox {
	__overflowY?: string;
	scrollHeight: number;
	clientHeight: number;
	parentElement: FakeBox | null;
}

/** Build a leaf→root chain; entries are listed innermost-first. */
function chain(
	...boxes: { scrollHeight: number; clientHeight: number; overflowY?: string }[]
): FakeBox {
	let parent: FakeBox | null = null;
	for (let i = boxes.length - 1; i >= 0; i--) {
		const spec = boxes[i];
		const node: FakeBox = {
			scrollHeight: spec.scrollHeight,
			clientHeight: spec.clientHeight,
			parentElement: parent,
		};
		if (spec.overflowY) node.__overflowY = spec.overflowY;
		parent = node;
	}
	return parent as FakeBox;
}

const walk = (leaf: FakeBox | null) =>
	findVerticalScrollParent(leaf as unknown as HTMLElement | null) as unknown as FakeBox | null;

describe("findVerticalScrollParent", () => {
	it("returns null when nothing overflows", () => {
		const leaf = chain(
			{ scrollHeight: 100, clientHeight: 100 },
			{ scrollHeight: 200, clientHeight: 200, overflowY: "auto" },
		);
		expect(walk(leaf)).toBeNull();
	});

	it("finds a genuine scroller (the chunked list's shape)", () => {
		const scroller = chain(
			{ scrollHeight: 50, clientHeight: 50 },
			{ scrollHeight: 4000, clientHeight: 600, overflowY: "auto" },
		).parentElement;
		const leaf = chain(
			{ scrollHeight: 50, clientHeight: 50 },
			{ scrollHeight: 4000, clientHeight: 600, overflowY: "auto" },
		);
		expect(walk(leaf)).toBe(leaf.parentElement);
		expect(scroller).not.toBeNull();
	});

	it("SKIPS an overflowing but unscrollable box and keeps walking", () => {
		// The silent-failure shape this guards against: a clipped wrapper
		// (overflow:hidden) taller than its own box would capture the walk, and
		// visibility would then be measured against a box nothing can leave.
		const leaf = chain(
			{ scrollHeight: 50, clientHeight: 50 },
			{ scrollHeight: 9000, clientHeight: 9000, overflowY: "hidden" },
			{ scrollHeight: 9000, clientHeight: 600, overflowY: "auto" },
		);
		const canvas = leaf.parentElement;
		const scroller = canvas?.parentElement ?? null;
		expect(walk(leaf)).toBe(scroller);
		expect(walk(leaf)).not.toBe(canvas);
	});

	it("accepts scroll and overlay, not just auto", () => {
		for (const overflowY of ["scroll", "overlay"]) {
			const leaf = chain(
				{ scrollHeight: 50, clientHeight: 50 },
				{ scrollHeight: 4000, clientHeight: 600, overflowY },
			);
			expect(walk(leaf)).toBe(leaf.parentElement);
		}
	});

	it("ignores a zero-height ancestor (unmounted / display:none subtree)", () => {
		// A collapsed box reports scrollHeight > 0 with clientHeight 0, which would
		// otherwise look like an overflowing scroller.
		const leaf = chain(
			{ scrollHeight: 50, clientHeight: 50 },
			{ scrollHeight: 4000, clientHeight: 0, overflowY: "auto" },
			{ scrollHeight: 4000, clientHeight: 600, overflowY: "auto" },
		);
		expect(walk(leaf)).toBe(leaf.parentElement?.parentElement ?? null);
	});

	it("tolerates a detached leaf", () => {
		expect(walk(null)).toBeNull();
		expect(walk(chain({ scrollHeight: 10, clientHeight: 10 }))).toBeNull();
	});
});
