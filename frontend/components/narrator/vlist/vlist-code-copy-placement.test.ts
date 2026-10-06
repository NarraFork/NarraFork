/**
 * vlist-code-copy-placement.test.ts — where a fenced panel's copy button may go,
 * given that the row's hover action bar owns the body's top-right corner.
 *
 * The bug behind this: the row bar (source / wrap / copy / fullscreen) parks at
 * the body's top-right corner with `zIndex: 2`, deliberately above block-level
 * chrome at `zIndex: 1`. A code block leading the body therefore had its own copy
 * button completely covered — the panel looked like it had none.
 *
 * The rule is pure geometry, so it is tested here directly rather than only
 * through the renderer (`render/RenderMarkdown.codecopy.test.tsx` covers the
 * wiring). Both of the interesting boundaries are asserted exactly, because both
 * off-by-ones are user-visible: shifting a panel that already clears the bar moves
 * its button for no reason, and NOT shifting one that overlaps reintroduces the
 * original bug.
 */

import { describe, expect, it } from "bun:test";
import {
	resolveCodeCopyPlacement,
	VIEW_ACTION_BAR_GAP,
	VIEW_ACTION_BUTTON_SIZE,
} from "./vlist-content-view-float";

/** Height that comfortably separates the two corners (a multi-line panel). */
const TALL = 200;

describe("resolveCodeCopyPlacement — clearing the row action bar", () => {
	it("keeps the top corner for a panel that starts below the bar's button", () => {
		// One markdown text line (17px) already clears it.
		expect(resolveCodeCopyPlacement(VIEW_ACTION_BUTTON_SIZE, TALL)).toBe("top-right");
		expect(resolveCodeCopyPlacement(40, TALL)).toBe("top-right");
	});

	it("drops to the bottom corner for a tall panel that leads the body", () => {
		expect(resolveCodeCopyPlacement(0, TALL)).toBe("bottom-right");
	});

	it("pins the top boundary exactly at the bar button's lower edge", () => {
		// One pixel higher still overlaps; at the edge itself there is no overlap.
		expect(resolveCodeCopyPlacement(VIEW_ACTION_BUTTON_SIZE - 1, TALL)).toBe("bottom-right");
		expect(resolveCodeCopyPlacement(VIEW_ACTION_BUTTON_SIZE, TALL)).toBe("top-right");
	});

	it("hides the button when the panel cannot hold the two corners apart", () => {
		// Both buttons plus their insets need 2 × (gap + size); anything shorter
		// would put the panel's own button back under the bar's.
		const minimum = 2 * (VIEW_ACTION_BAR_GAP + VIEW_ACTION_BUTTON_SIZE);
		expect(resolveCodeCopyPlacement(0, minimum - 1)).toBe("hidden");
		expect(resolveCodeCopyPlacement(0, minimum)).toBe("bottom-right");
	});

	it("counts the panel's own offset toward the clearance it needs", () => {
		// A short panel pushed partly clear of the bar needs less of its own height:
		// what matters is where its BOTTOM edge lands, not the height alone.
		const minimum = 2 * (VIEW_ACTION_BAR_GAP + VIEW_ACTION_BUTTON_SIZE);
		expect(resolveCodeCopyPlacement(0, minimum - 8)).toBe("hidden");
		expect(resolveCodeCopyPlacement(8, minimum - 8)).toBe("bottom-right");
	});

	it("falls back to the conventional corner on non-finite geometry", () => {
		// A measure gap must never silently delete the button.
		expect(resolveCodeCopyPlacement(Number.NaN, TALL)).toBe("top-right");
		expect(resolveCodeCopyPlacement(0, Number.POSITIVE_INFINITY)).toBe("top-right");
	});
});
