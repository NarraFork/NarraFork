/**
 * useSwipeMenu.offscreen-overlay.test.ts — the off-screen anchor overlay decision.
 *
 * When a swiped row scrolls out of the scroll area, `useSwipeMenu` reports a
 * `SwipeAnchorInfo` so the panel can pin a translucent preview strip to the top or
 * bottom edge (SwipeAnchorOverlay). This file pins the DECISION that drives it,
 * which is where the virtual-list path diverged.
 *
 * The vlist-specific failure was NOT geometry: it was the row being UNMOUNTED. The
 * canvas mounts only the rows near the viewport, so scrolling ~600px past the
 * swiped row destroyed its node — and the `!isConnected` branch treats a missing
 * node as "give up": it clears the overlay and closes the swipe outright. The
 * overlay therefore never had a chance to appear, no matter how the visible bounds
 * were computed.
 *
 * The row is now pinned into the mounted window (vlist-swipe-anchor.ts), so these
 * tests encode the two halves that must both hold for the strip to show:
 *   1. a CONNECTED row that left the scroll area reports a direction, and
 *   2. a DISCONNECTED row still dismisses (an unpinned / genuinely gone row must
 *      not leave a stale strip pointing at nothing).
 */

import { describe, expect, it } from "bun:test";
import { resolveSwipeAnchorOffScreen } from "./scroll-parent";

const VISIBLE = { top: 100, bottom: 700 };

describe("resolveSwipeAnchorOffScreen", () => {
	it("reports nothing while the row is inside the scroll area", () => {
		expect(resolveSwipeAnchorOffScreen({ top: 200, bottom: 300 }, VISIBLE)).toBeNull();
	});

	it("reports nothing while the row is only partially visible", () => {
		// Straddling the edge still shows content, so the strip would be redundant.
		expect(resolveSwipeAnchorOffScreen({ top: 50, bottom: 150 }, VISIBLE)).toBeNull();
		expect(resolveSwipeAnchorOffScreen({ top: 650, bottom: 800 }, VISIBLE)).toBeNull();
	});

	it("reports 'top' once the row has scrolled entirely above the area", () => {
		expect(resolveSwipeAnchorOffScreen({ top: 10, bottom: 90 }, VISIBLE)).toBe("top");
	});

	it("reports 'bottom' once the row is entirely below the area", () => {
		expect(resolveSwipeAnchorOffScreen({ top: 750, bottom: 900 }, VISIBLE)).toBe("bottom");
	});

	it("treats a row flush against the boundary as still visible", () => {
		// A zero-height sliver exactly at the edge is a boundary case; showing a strip
		// for a row the reader can still see would flicker on every scroll frame.
		expect(resolveSwipeAnchorOffScreen({ top: 100, bottom: 100 }, VISIBLE)).toBeNull();
		expect(resolveSwipeAnchorOffScreen({ top: 700, bottom: 700 }, VISIBLE)).toBeNull();
	});
});
