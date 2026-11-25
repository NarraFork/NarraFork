/**
 * Which row a sidebar row menu (right-click, or a left swipe on touch) belongs to.
 *
 * The menu keeps only the row's `type:id` and reads the tab from the current list on each
 * render. Runtime patches replace tab objects in the cache instead of mutating them, so a tab
 * captured when the menu opened would never show what arrives while it is open (a project's
 * details read by its own touch details, `refreshProjectTabDetails`). A row that leaves the list
 * closes the menu.
 */
import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

export interface RecentTabMenuTarget {
	x: number;
	y: number;
	/** The row's `type:id`. */
	key: string;
}

export function recentTabMenuKey(tab: Pick<RecentTab, "type" | "id">): string {
	return `${tab.type}:${tab.id}`;
}

/** The open menu, its row as the list has it now, and the setter (null closes). */
export function useRecentTabMenuTarget(
	tabs: readonly RecentTab[],
): readonly [
	RecentTabMenuTarget | null,
	RecentTab | undefined,
	Dispatch<SetStateAction<RecentTabMenuTarget | null>>,
] {
	const [menu, setMenu] = useState<RecentTabMenuTarget | null>(null);
	const tab = menu ? tabs.find((candidate) => recentTabMenuKey(candidate) === menu.key) : undefined;
	useEffect(() => {
		if (menu && !tab) setMenu(null);
	}, [menu, tab]);
	return [menu, tab, setMenu] as const;
}
