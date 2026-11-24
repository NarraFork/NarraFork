import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import type { RecentTabStateResult } from "@shared/recent-tabs";

/**
 * The pin of a project or team tab among the sidebar's loaded rows: true or false when the row is
 * loaded, undefined when it is not (it may still be in the list, past the loaded pages). Projects
 * and teams never join folders, so "pinned" means the top-level pinned block.
 */
export function loadedSidebarPin(
	tabs: readonly Pick<RecentTab, "type" | "id" | "pinned">[] | undefined,
	type: "project" | "team",
	id: string,
): boolean | undefined {
	const tab = tabs?.find((candidate) => candidate.type === type && candidate.id === id);
	return tab ? tab.pinned === true : undefined;
}

/**
 * Whether the page's pin button shows "pinned": the loaded row when there is one (it follows the
 * sidebar at once), else the server's answer for that one tab. `known` is false while neither
 * has answered, so the button does not offer a pin it cannot judge yet.
 */
export function resolvePagePin(
	loaded: boolean | undefined,
	state: RecentTabStateResult | undefined,
): { pinned: boolean; known: boolean } {
	if (loaded !== undefined) return { pinned: loaded, known: true };
	if (state) return { pinned: state.present && state.pinned, known: true };
	return { pinned: false, known: false };
}
