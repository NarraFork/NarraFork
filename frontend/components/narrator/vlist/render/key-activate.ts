/**
 * key-activate.ts — Enter / Space activation for elements whose only affordance is
 * an `onClick` on a non-button box.
 *
 * The exact render layer draws its folds, trace rows and card headers as plain
 * `Group`s with a click handler: a `<button>` brings its own padding, font and focus
 * box, none of which the measure layer models, so the geometry would stop matching
 * the prediction. The accessibility that a real button would have supplied is added
 * back by hand — `role="button" tabIndex={0}` plus this handler at each call site.
 * All of that is ATTRIBUTES ONLY, so the measured height is untouched.
 *
 * Shared rather than per-file because the same three lines were being copied into
 * every module that draws a clickable row, and a copy that drifts is an affordance
 * that silently stops working for keyboard and screen-reader readers.
 *
 * Space is `preventDefault`ed because its default action on a focused element is to
 * scroll the page — which in a virtual list moves the very rows being read.
 */

import type React from "react";

export function activateOnKey(activate: () => void) {
	return (e: React.KeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
		// A keydown's target is the FOCUSED element. When that is an interactive
		// child of this row (a native `<button>` like the open-session or terminate
		// control, or a popover trigger), the child owns the activation: Enter/Space
		// must reach its own native click, not toggle the row underneath it.
		// Handling it here too would preventDefault the child's activation AND
		// double-fire the row's own action.
		if (e.target !== e.currentTarget) return;
		e.preventDefault();
		e.stopPropagation();
		activate();
	};
}

/**
 * onClick for a fold/toggle region that shares its block with the selection
 * interaction layer (VListRowInteraction / TraceRowInteraction).
 *
 * A Ctrl/Cmd+Click or Shift+Click means "select this block", not "toggle the
 * fold" — the interaction wrapper performs the selection, so the toggle must
 * swallow the event. Without this guard every multi-select click also expands
 * or collapses the card under the cursor, fighting the user on every click.
 *
 * Unconditional (matching the chunked ToolCallCard header): when the selection
 * layer is absent a modified click simply does nothing, rather than expanding
 * a card the reader was probably trying to select text from.
 */
export function swallowSelectionClick(activate: () => void) {
	return (e: React.MouseEvent) => {
		if (e.metaKey || e.ctrlKey || e.shiftKey) return;
		activate();
	};
}
