/**
 * useSwipeMenu.overlay-wiring.test.ts — source-level guards for the off-screen
 * swipe-anchor overlay.
 *
 * The overlay is a two-part contract that spans two files, and each half fails
 * SILENTLY without the other:
 *
 *   1. `useSwipeMenu` reports `SwipeAnchorInfo` when the swiped row leaves the
 *      scroll area — but only while the row's node is still connected;
 *   2. the virtual list PINS the anchor's row into its mounted window, so an
 *      ordinary scroll no longer destroys that node.
 *
 * Before (2), scrolling past the swiped row in the virtual list unmounted it, the
 * `!isConnected` branch closed the swipe, and the strip could never appear. Neither
 * half throws when the link breaks, so the coupling is asserted here rather than
 * left to a manual check.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK = readFileSync(join(import.meta.dir, "useSwipeMenu.ts"), "utf8");
const SHELL = readFileSync(
	join(import.meta.dir, "..", "components", "narrator", "vlist", "PretextExactMessageList.tsx"),
	"utf8",
);

describe("off-screen anchor overlay wiring", () => {
	it("uses the overflow-aware scroll parent for menu geometry too", () => {
		const positionStart = HOOK.indexOf("const getSwipeMenuPosition");
		const positionEnd = HOOK.indexOf("\n\treturn {", positionStart);
		const positionSource = HOOK.slice(positionStart, positionEnd);
		expect(positionSource).toContain("findVerticalScrollParent(");
		expect(positionSource).not.toContain("scrollHeight > el.clientHeight");
	});

	it("reports the overlay through the global anchor-info channel", () => {
		// The panel renders SwipeAnchorOverlay from whatever this pushes.
		expect(HOOK).toContain("getGlobalOnSwipeAnchorInfo()?.({");
		expect(HOOK).toContain("previewText:");
		expect(HOOK).toContain("offScreen: dir");
	});

	it("decides off-screen through the shared, tested helper", () => {
		// Inline rect comparisons in the rAF loop are untestable without a layout
		// engine, which is how the boundary behaviour drifted unnoticed before.
		expect(HOOK).toContain("resolveSwipeAnchorOffScreen(rect,");
	});

	it("resolves the scroll area through the overflow-aware walk", () => {
		expect(HOOK).toContain("findVerticalScrollParent(");
		// The height-only walk must not come back: it captures on any clipped
		// ancestor and then measures against a box the row can never leave.
		expect(HOOK).not.toMatch(/scrollHeight <= \w+\.clientHeight/);
	});

	it("still dismisses when the row is genuinely gone", () => {
		// A strip pointing at a row that no longer exists is worse than none.
		expect(HOOK).toMatch(/if \(!box\?\.isConnected\) \{/);
	});

	it("depends on the vlist pinning the anchor row (the other half)", () => {
		// Without this pin the `!isConnected` branch above fires on ordinary
		// scrolling and the overlay is unreachable in the virtual list.
		expect(SHELL).toContain("resolvePinnedRowIndices(visible, swipeAnchorRowIndex)");
	});
});
