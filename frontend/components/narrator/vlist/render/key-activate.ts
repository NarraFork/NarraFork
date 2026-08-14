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
		e.preventDefault();
		e.stopPropagation();
		activate();
	};
}
