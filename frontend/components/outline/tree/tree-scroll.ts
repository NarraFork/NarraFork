/**
 * Where the reader was in the connected outline, kept across leaving it (readability F): coming
 * back from a focused page, the tree is where they left it.
 *
 * What is open is already kept (`tree-open-state.ts`); the scroll position is kept as an ANCHOR,
 * not as pixels: the first row at the top of the view and how far it is from the top. The tree
 * loads its rows as its nodes open again, so the anchor's row may arrive late: the restore waits
 * for it (bounded), and gives way the moment the reader scrolls themselves.
 *
 * Per browser tab (`sessionStorage`), per host and tree root. Without storage nothing is kept.
 */

export interface TreeAnchor {
	/** The row's node key (`data-tree-node`). */
	key: string;
	/** The row's top, from the top of what scrolls, in CSS pixels. */
	offset: number;
}

const STORAGE_PREFIX = "narrafork_outline_tree_scroll:";
/** How long a restore waits for its row. */
export const TREE_SCROLL_WAIT_MS = 5000;

export function parseTreeAnchor(text: string | null): TreeAnchor | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as { key?: unknown; offset?: unknown };
		if (
			typeof value?.key === "string" &&
			value.key.length > 0 &&
			value.key.length <= 160 &&
			typeof value.offset === "number" &&
			Number.isFinite(value.offset)
		) {
			return { key: value.key, offset: Math.round(value.offset) };
		}
	} catch {
		// Not an anchor.
	}
	return null;
}

export function readTreeAnchor(name: string): TreeAnchor | null {
	try {
		return parseTreeAnchor(sessionStorage.getItem(STORAGE_PREFIX + name));
	} catch {
		return null;
	}
}

export function writeTreeAnchor(name: string, anchor: TreeAnchor | null): void {
	try {
		if (anchor) sessionStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(anchor));
		else sessionStorage.removeItem(STORAGE_PREFIX + name);
	} catch {
		// A convenience: without storage the tree opens at its top.
	}
}

/** What scrolls the tree: its nearest scrolling ancestor, else the page. */
export function scrollParentOf(element: HTMLElement): HTMLElement {
	for (let at = element.parentElement; at; at = at.parentElement) {
		const overflow = getComputedStyle(at).overflowY;
		if ((overflow === "auto" || overflow === "scroll") && at.scrollHeight > at.clientHeight) {
			return at;
		}
	}
	return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function viewTop(scroller: HTMLElement): number {
	return scroller === document.scrollingElement || scroller === document.documentElement
		? 0
		: scroller.getBoundingClientRect().top;
}

/**
 * The anchor of the tree as it is scrolled now: the first row whose bottom is below the top of
 * the view. Null when the tree is not on screen, or not scrolled at all (nothing to keep).
 */
export function captureTreeAnchor(tree: HTMLElement): TreeAnchor | null {
	if (tree.offsetParent === null) return null;
	const scroller = scrollParentOf(tree);
	if (scroller.scrollTop <= 0) return null;
	const top = viewTop(scroller);
	for (const row of tree.querySelectorAll<HTMLElement>("[data-tree-node]")) {
		const box = row.getBoundingClientRect();
		if (box.height > 0 && box.bottom > top) {
			return { key: row.dataset.treeNode ?? "", offset: Math.round(box.top - top) };
		}
	}
	return null;
}

/** Scroll so the anchor's row is where it was; false while the row is not there (yet). */
export function restoreTreeAnchor(tree: HTMLElement, anchor: TreeAnchor): boolean {
	const row = [...tree.querySelectorAll<HTMLElement>("[data-tree-node]")].find(
		(candidate) => candidate.dataset.treeNode === anchor.key,
	);
	if (!row || row.getBoundingClientRect().height === 0) return false;
	const scroller = scrollParentOf(tree);
	const delta = row.getBoundingClientRect().top - viewTop(scroller) - anchor.offset;
	if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
	return true;
}
