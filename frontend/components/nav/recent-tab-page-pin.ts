import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";

/**
 * Whether a project or team is pinned in the sidebar, from the loaded recent tabs. Projects and
 * teams never join folders, so "pinned" means the top-level pinned block.
 */
export function isPinnedInSidebar(
	tabs: readonly Pick<RecentTab, "type" | "id" | "pinned">[] | undefined,
	type: "project" | "team",
	id: string,
): boolean {
	return !!tabs?.some((tab) => tab.type === type && tab.id === id && tab.pinned === true);
}
