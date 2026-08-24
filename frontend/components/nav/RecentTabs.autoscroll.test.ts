/**
 * Horizontal scoping of the recent-tab list's drag auto-scroll.
 *
 * dnd-kit decides the VERTICAL scroll direction from the activation rect's `top`/`bottom`
 * alone, so a pointer that has left the sidebar sideways still drives the tab list as
 * long as its height falls in the container's threshold band. That is not a cosmetic
 * issue: dragging a tab onto the narrator / workspace surface is a DIFFERENT operation
 * (drop to open a panel) than reordering, and a list scrolling under that drag keeps
 * moving the drop target away.
 *
 * The missing horizontal test therefore lives in `autoScrollAllowedForPointer`, and it is
 * a pure function so this asymmetry is asserted rather than eyeballed in a live drag.
 */

import { describe, expect, it } from "bun:test";
import { autoScrollAllowedForPointer } from "./RecentTabs";

const NAVBAR = { left: 0, right: 260 };

describe("autoScrollAllowedForPointer", () => {
	it("allows scrolling while the pointer is inside the sidebar column", () => {
		expect(autoScrollAllowedForPointer(0, NAVBAR)).toBe(true);
		expect(autoScrollAllowedForPointer(130, NAVBAR)).toBe(true);
		expect(autoScrollAllowedForPointer(260, NAVBAR)).toBe(true);
	});

	it("blocks scrolling once the pointer is over the area to the right", () => {
		// The regression this exists for: the pointer is on the narrator / workspace
		// surface, so the drag is no longer about ordering.
		expect(autoScrollAllowedForPointer(261, NAVBAR)).toBe(false);
		expect(autoScrollAllowedForPointer(900, NAVBAR)).toBe(false);
	});

	it("blocks scrolling to the left of the column too", () => {
		// Not symmetric in practice (nothing is left of the navbar in the default
		// layout), but the gate is a containment test, not a right-edge test — an
		// RTL layout or an offset container puts the outside on the other side.
		expect(autoScrollAllowedForPointer(-1, NAVBAR)).toBe(false);
	});

	it("allows scrolling when the pointer position is unknown", () => {
		// Keyboard drags and the frames before the first pointer move have no
		// coordinates. Treating that as "outside" would disable auto-scroll outright
		// instead of scoping it, which is a bigger regression than the bug being fixed.
		expect(autoScrollAllowedForPointer(null, NAVBAR)).toBe(true);
	});
});
