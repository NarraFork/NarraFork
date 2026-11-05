/**
 * The details card for the row Ctrl+Up / Ctrl+Down highlights, on the collapsed rail.
 *
 * Collapsed, a row is only its icon, so while the keys move the highlight
 * (`useRecentTabKeyboardNav`) nothing says which session the switch will land on. The
 * hover card does: it follows the highlight at once, next to the rail at the row's height,
 * and goes a moment after the switch (the timing is in `recent-tab-hover.ts`).
 *
 * Only while the sidebar is collapsed, open on hover or not. Expanded, the row shows its
 * title and the card would only cover the page; the phone drawer is always expanded.
 * Nothing here opens the rail.
 */

import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import {
	type RecentTabHoverRect,
	type RecentTabHoverStore,
	railCardAnchor,
} from "./recent-tab-hover";

/** On the sidebar's content box while collapsed: "closed", or "open" on hover (NavHoverPanel). */
const PANEL_ATTR = "data-nav-hover-panel";
const NAVBAR_SELECTOR = ".mantine-AppShell-navbar";
/** The sidebar's scroll container (AuthenticatedAppLayout). */
const SCROLLER_SELECTOR = ".nf-nav-tabs";

function rowByKey(list: HTMLElement, key: string): HTMLElement | null {
	// Compared rather than put into a selector, which would need `CSS.escape` for ids.
	for (const row of list.querySelectorAll<HTMLElement>("[data-tab-sort-id]")) {
		if (row.getAttribute("data-tab-sort-id") === key) return row;
	}
	return null;
}

/**
 * The row in `list` that carries the highlight for `key`, null when the keyboard card
 * should not follow it: the sidebar is not collapsed, or the tab is in another list.
 *
 * A member of a collapsed folder has no row of its own; its folder header carries the
 * highlight then, so it anchors the card (which still shows the member).
 */
export function keyboardCardRow(
	list: HTMLElement,
	key: string,
	folderId: string | null | undefined,
): HTMLElement | null {
	if (!list.closest(`[${PANEL_ATTR}]`)) return null;
	return rowByKey(list, key) ?? (folderId ? rowByKey(list, `folder:${folderId}`) : null);
}

function folderOf(tabs: RecentTab[], key: string): string | undefined {
	return tabs.find((tab) => `${tab.type}:${tab.id}` === key)?.folderId;
}

/** Where the card for `row` anchors now, null while the row is scrolled out of sight. */
export function keyboardCardRect(row: HTMLElement): RecentTabHoverRect | null {
	const panel = row.closest(`[${PANEL_ATTR}]`);
	// Closed, the navbar clips the row to the rail's column; open on hover, it does not.
	const rail = panel?.getAttribute(PANEL_ATTR) === "closed" ? panel.closest(NAVBAR_SELECTOR) : null;
	return railCardAnchor(
		row.getBoundingClientRect(),
		rail?.getBoundingClientRect() ?? null,
		row.closest(SCROLLER_SELECTOR)?.getBoundingClientRect() ?? null,
	);
}

export function useRecentTabKeyboardCard({
	store,
	listRef,
	pendingKey,
	tabs,
}: {
	/** The list's hover-card store; null on touch, which shows no card. */
	store: RecentTabHoverStore | null;
	/** The box holding this list's rows. */
	listRef: RefObject<HTMLElement | null>;
	/** The keyboard highlight (`usePendingTabKey`). */
	pendingKey: string | null;
	tabs: RecentTab[];
}): void {
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;

	// Layout effect: the highlighted row (a folder member shown only while highlighted)
	// is in the DOM by now, and the card moves in the same frame as the highlight.
	useLayoutEffect(() => {
		if (!store) return;
		if (pendingKey === null) {
			store.release();
			return;
		}
		const list = listRef.current;
		const row = list
			? keyboardCardRow(list, pendingKey, folderOf(tabsRef.current, pendingKey))
			: null;
		if (row) store.follow(pendingKey, keyboardCardRect(row));
		else store.unfollow();
	}, [store, listRef, pendingKey]);

	// The followed row moves under the card: the highlight scrolls it into view, the user
	// scrolls the list, the rail opens or closes on hover. All cheap no-ops while the
	// keyboard follows nothing.
	useEffect(() => {
		if (!store) return;
		const reanchor = () => {
			const key = store.followedKey();
			const list = listRef.current;
			if (key === null || !list) return;
			const row = keyboardCardRow(list, key, folderOf(tabsRef.current, key));
			store.reanchor(row ? keyboardCardRect(row) : null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && store.followedKey() !== null) store.unfollow();
		};
		window.addEventListener("scroll", reanchor, true);
		window.addEventListener("resize", reanchor);
		document.addEventListener("keydown", onKeyDown);
		// The navbar outlives the collapse toggle, unlike the panel attribute it watches.
		const navbar = listRef.current?.closest(NAVBAR_SELECTOR);
		const observer =
			navbar && typeof MutationObserver !== "undefined" ? new MutationObserver(reanchor) : null;
		if (navbar && observer) {
			observer.observe(navbar, { subtree: true, attributes: true, attributeFilter: [PANEL_ATTR] });
		}
		return () => {
			window.removeEventListener("scroll", reanchor, true);
			window.removeEventListener("resize", reanchor);
			document.removeEventListener("keydown", onKeyDown);
			observer?.disconnect();
			store.unfollow();
		};
	}, [store, listRef]);
}
