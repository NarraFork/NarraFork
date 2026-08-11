/**
 * selection-anchor-overlay.test.ts — the gate deciding whether the off-screen
 * preview strip tracks the desktop SELECTION.
 *
 * Encodes the two deliberate restrictions (single block, desktop only) plus the
 * precedence rule that keeps this producer from fighting the touch swipe anchor for
 * the one strip the panel renders.
 */

import { describe, expect, it } from "bun:test";
import { resolveSelectionOverlayBlockId } from "./selection-anchor-overlay";

const base = {
	isMobileViewport: false,
	hasSwipeAnchor: false,
};

const ids = (...values: string[]) => new Set(values);

describe("resolveSelectionOverlayBlockId", () => {
	it("tracks a single selected block on desktop", () => {
		expect(resolveSelectionOverlayBlockId({ ...base, selectedBlockIds: ids("msg-m1-0") })).toBe(
			"msg-m1-0",
		);
	});

	it("stays away when nothing is selected", () => {
		expect(resolveSelectionOverlayBlockId({ ...base, selectedBlockIds: ids() })).toBeNull();
	});

	it("stays away once several blocks are selected", () => {
		// The strip shows ONE preview; with a range selected it would have to pick an
		// arbitrary member. The selection toolbar covers that case instead.
		expect(
			resolveSelectionOverlayBlockId({ ...base, selectedBlockIds: ids("msg-m1-0", "tc-t1") }),
		).toBeNull();
		expect(
			resolveSelectionOverlayBlockId({
				...base,
				selectedBlockIds: ids("msg-m1-0", "tc-t1", "sa-t2"),
			}),
		).toBeNull();
	});

	it("stays away on a mobile viewport", () => {
		// Touch already has a producer for this exact situation (the swipe anchor).
		expect(
			resolveSelectionOverlayBlockId({
				...base,
				isMobileViewport: true,
				selectedBlockIds: ids("msg-m1-0"),
			}),
		).toBeNull();
	});

	it("yields to an active swipe anchor", () => {
		// One strip, one producer: the swipe path also owns closeSwipe, which this
		// producer must not call.
		expect(
			resolveSelectionOverlayBlockId({
				...base,
				hasSwipeAnchor: true,
				selectedBlockIds: ids("msg-m1-0"),
			}),
		).toBeNull();
	});

	it("ignores an empty-string id", () => {
		expect(resolveSelectionOverlayBlockId({ ...base, selectedBlockIds: ids("") })).toBeNull();
	});
});
