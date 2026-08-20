import { describe, expect, it } from "bun:test";
import {
	isActivationKey,
	isTextSelectionGesture,
	type SelectionLike,
} from "./chapter-bar-git-trigger";

/** A `Selection` stub carrying only what the rules read. */
function selection(text: string, isCollapsed = text.length === 0): SelectionLike {
	return { isCollapsed, toString: () => text };
}

describe("chapter-bar Git trigger — text selection guard", () => {
	// The reason the strip is a div with role="button" at all: readers copy the
	// branch name out of it. A drag-select ends with a click on the same element, so
	// without this guard every copy attempt also swaps the side panel and loses the
	// selection to the re-render.
	it("treats a completed drag-select as a copy gesture, not a click", () => {
		expect(isTextSelectionGesture(selection("chapter/very-long-branch-Bo_bRv", false))).toBe(true);
	});

	it("treats a plain click as activation", () => {
		// Collapsed = caret only, which is what a click without dragging leaves.
		expect(isTextSelectionGesture(selection("", true))).toBe(false);
	});

	// Some engines report a non-collapsed range with empty text after a click on
	// whitespace. Reading `isCollapsed` alone would make the strip unclickable there.
	it("still activates when a non-collapsed range holds no text", () => {
		expect(isTextSelectionGesture(selection("", false))).toBe(false);
	});

	// `window.getSelection()` is nullable, and a null result must not disable the
	// trigger — that would make the panel unopenable rather than merely unguarded.
	it("activates when the document reports no selection at all", () => {
		expect(isTextSelectionGesture(null)).toBe(false);
		expect(isTextSelectionGesture(undefined)).toBe(false);
	});

	// A selection made ELSEWHERE on the page is indistinguishable here, and the
	// trade-off is deliberate: a stray selection costing one extra click is better
	// than a copy gesture that silently swaps panels.
	it("suppresses activation for any page selection, not just this row's", () => {
		expect(isTextSelectionGesture(selection("text selected in the conversation", false))).toBe(
			true,
		);
	});
});

describe("chapter-bar Git trigger — keyboard activation", () => {
	// The div has to reimplement what a real <button> gives for free; the UA button
	// style sets `user-select: none`, which is why it cannot be one.
	it("activates on the same keys a button would", () => {
		expect(isActivationKey("Enter")).toBe(true);
		expect(isActivationKey(" ")).toBe(true);
	});

	it("ignores keys that must keep their normal meaning", () => {
		for (const key of ["Tab", "Escape", "ArrowDown", "a", "Spacebar"]) {
			expect(isActivationKey(key)).toBe(false);
		}
	});
});
