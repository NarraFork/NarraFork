/**
 * Activation rules for the chapter-info strip, which is BOTH a Git-panel trigger
 * and selectable text (readers copy the branch name out of it).
 *
 * Pure on purpose. The strip itself needs a router, a dock context and three
 * queries to mount, so a render test around it is expensive and fragile — while
 * these two predicates are the whole behaviour that a later "simplification" back
 * to `onClick={openGitPanel}` would silently destroy. The failure has no error
 * signal: copying the branch name would just swap the side panel and lose the
 * selection to the re-render.
 */

/** The parts of a `Selection` these rules depend on. */
export interface SelectionLike {
	isCollapsed: boolean;
	toString(): string;
}

/**
 * True when this click merely ended a drag-select, so it must NOT open the panel.
 *
 * A collapsed selection is a plain click (the caret, or nothing selected at all).
 * The text check is what makes an empty-string range — which some engines report
 * as non-collapsed after a click on whitespace — still count as a plain click.
 */
export function isTextSelectionGesture(selection: SelectionLike | null | undefined): boolean {
	if (!selection || selection.isCollapsed) return false;
	return selection.toString().length > 0;
}

/**
 * True when a key press should activate the `role="button"` strip.
 *
 * Enter and Space are the pair a real `<button>` would honour; this row is a div
 * (a UA button sets `user-select: none`, which would break copying), so the pair
 * has to be reimplemented rather than inherited.
 */
export function isActivationKey(key: string): boolean {
	return key === "Enter" || key === " ";
}
