/**
 * selection-anchor-overlay.wiring.test.ts — source-level guards for the desktop
 * selection producer of the off-screen preview strip.
 *
 * The panel renders ONE strip from three producers, so the properties that keep
 * them from interfering live in the wiring rather than in any single module. All of
 * these fail silently if broken (a strip that never shows, or one that steals the
 * swipe's slot), which is why they are asserted against the source.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PANEL = readFileSync(join(import.meta.dir, "NarratorPanel.tsx"), "utf8");

describe("selection anchor overlay wiring", () => {
	it("gates the producer through the tested pure rule", () => {
		expect(PANEL).toContain("resolveSelectionOverlayBlockId({");
		// The gate needs all three inputs; dropping one silently widens the producer
		// (e.g. omitting hasSwipeAnchor makes it fight the swipe path).
		expect(PANEL).toContain("hasSwipeAnchor: swipeAnchorOverlay != null");
		expect(PANEL).toContain("isMobileViewport");
	});

	it("reuses the shared off-screen decision instead of its own comparisons", () => {
		expect(PANEL).toContain("resolveSwipeAnchorOffScreen(");
	});

	it("ranks the selection strip LAST among the three producers", () => {
		// Swipe and compaction track live operations; the selection strip is a passive
		// wayfinding aid and must never pre-empt them.
		expect(PANEL).toContain(
			"swipeAnchorOverlay ?? compactingMarkerOverlay ?? selectionAnchorOverlay",
		);
	});

	it("dismisses the strip without clearing the selection", () => {
		// `close` is wired to clearOverlay, NOT exitSelection: losing a selection to a
		// stray tap on a wayfinding aid would be destructive.
		expect(PANEL).toMatch(/close: clearOverlay,\n\s*offScreen,/);
	});

	it("falls back to the index-based jump when the row is unmounted", () => {
		// The virtual list unmounts scrolled-away rows, so scrollIntoView alone would
		// silently do nothing; the list can still reach the row by message id.
		expect(PANEL).toMatch(/if \(live\?\.isConnected\) \{[\s\S]{0,400}?scrollToMessageTarget\(\{/);
	});

	it("re-checks on structural changes, not only on scroll", () => {
		// Rows mount / unmount as the virtual list scrolls; a scroll-only listener
		// misses the frame where the row reappears.
		expect(PANEL).toContain("new MutationObserver(scheduleCheck)");
	});
});
