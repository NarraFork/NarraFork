/**
 * vlist-swipe-anchor-wiring.test.ts — source-level assertions that the touch
 * swipe ANCHOR's row is pinned into the mounted window.
 *
 * The shell is not unit-mountable (it owns a scroll container, a document
 * coordinator and a WS subscription), so the load-bearing invariants are asserted
 * against its source, exactly like vlist-editing-wiring.test.ts does for the
 * inline editor's pin.
 *
 * The regression these lock down: touch range-selection needs the FIRST swiped
 * row's `useSwipeMenu` hook to stay mounted, because its unmount cleanup clears
 * both the global anchor and the global close handler — the pair
 * `useSwipeMenu.onTouchStart` requires to treat the second swipe as a
 * range-select. With virtualization on, scrolling ~600px past the anchor unmounted
 * it and the second swipe silently opened its own menu instead of selecting the
 * range.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHELL = readFileSync(join(import.meta.dir, "PretextExactMessageList.tsx"), "utf8");
const SWIPE_STATE = readFileSync(join(import.meta.dir, "..", "scroll", "swipeState.ts"), "utf8");

describe("vlist swipe-anchor pinning", () => {
	it("pins the swipe anchor's row into the mounted window", () => {
		expect(SHELL).toContain("resolvePinnedRowIndices(visible, swipeAnchorRowIndex)");
	});

	it("merges the pins so one index is never rendered twice", () => {
		// The editor's row and the anchor's row can be the SAME index (swiping the row
		// being edited), and two children under one React key is a hard error.
		expect(SHELL).toContain("mergePinnedRowIndices(");
		expect(SHELL).toContain("resolvePinnedRowIndices(visible, editingRowIndex)");
	});

	it("subscribes to the anchor store rather than reading it once", () => {
		// The anchor is written by a touch handler in a module-level store. Without a
		// subscription the list never re-renders to pin the row, so the pin would be
		// dead code for the exact gesture it exists for.
		expect(SHELL).toContain("useSyncExternalStore(");
		expect(SHELL).toContain("subscribeGlobalSwipeAnchor");
		expect(SHELL).toContain("getGlobalSwipeAnchor");
	});

	it("scans for the anchor row only while an anchor exists", () => {
		// A read-only / desktop session must not walk the document per commit.
		expect(SHELL).toMatch(/if \(!swipeAnchorBlockId\) return null;/);
	});
});

describe("swipe anchor store", () => {
	it("notifies subscribers on change", () => {
		expect(SWIPE_STATE).toContain("subscribeGlobalSwipeAnchor");
		expect(SWIPE_STATE).toMatch(/for \(const listener of swipeAnchorListeners\) listener\(\)/);
	});

	it("short-circuits a no-op write", () => {
		// useSwipeMenu re-asserts the same anchor on every reveal-effect run; notifying
		// there would re-render the whole message list for nothing.
		expect(SWIPE_STATE).toMatch(/if \(globalSwipeAnchor === blockId\) return;/);
	});
});
