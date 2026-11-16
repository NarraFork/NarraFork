/**
 * A tree is ONE tab stop (the WAI tree pattern, roving tabindex): of everything focusable in
 * it, only the row the reader was last on is reached by Tab (its title, or a "more" control,
 * `data-tree-nav`); the arrow keys move between rows (`onTreeKeyDown`). The rest of a row's
 * controls (its arrow, its preview line, its counts, its quick control) are for the pointer and
 * for the keys the title answers (Alt+Enter: everything inside, → / ←: open / close).
 *
 * Rows come and go as the list is windowed and levels load, so the stops are put right after
 * every change of the tree's DOM (a MutationObserver on the tree itself: nothing listens on the
 * window or the document). What the tree shows that is not a row (the question form) keeps its
 * own tab stops: it is marked `data-tree-keep`.
 */
import { useEffect } from "react";

const NAV = "[data-tree-nav]";
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/** Put the tree's tab stops right: `current` (or the first row) is the one stop. */
export function applyTreeTabStops(
	tree: HTMLElement,
	current: HTMLElement | null,
): HTMLElement | null {
	const navs = [...tree.querySelectorAll<HTMLElement>(NAV)];
	const stop =
		current && tree.contains(current) && current.matches(NAV) ? current : (navs[0] ?? null);
	for (const element of tree.querySelectorAll<HTMLElement>(FOCUSABLE)) {
		if (element.closest("[data-tree-keep]")) continue;
		const want = element === stop ? "0" : "-1";
		if (element.getAttribute("tabindex") !== want) element.setAttribute("tabindex", want);
	}
	return stop;
}

/** Keep `tree` one tab stop (see the header). */
export function useTreeTabStops(tree: { readonly current: HTMLElement | null }): void {
	useEffect(() => {
		const root = tree.current;
		if (!root) return;
		let current: HTMLElement | null = null;
		let queued = false;
		const apply = () => {
			queued = false;
			current = applyTreeTabStops(root, current);
		};
		const queue = () => {
			if (queued) return;
			queued = true;
			queueMicrotask(apply);
		};
		const onFocus = (event: FocusEvent) => {
			const nav = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(NAV);
			if (nav && root.contains(nav) && nav !== current) {
				current = nav;
				queue();
			}
		};
		const watch = new MutationObserver(queue);
		watch.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["tabindex"],
		});
		root.addEventListener("focusin", onFocus);
		apply();
		return () => {
			watch.disconnect();
			root.removeEventListener("focusin", onFocus);
		};
	}, [tree]);
}
