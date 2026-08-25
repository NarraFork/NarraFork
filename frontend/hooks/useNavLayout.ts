import type { CustomizableNavId } from "@shared/nav-layout";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { api } from "../lib/api";
import {
	DEFAULT_NAV_ENTRIES,
	mergeNavLayout,
	NAV_DIVIDER_ID,
	type NavLayoutEntry,
	toPersistedNavLayout,
} from "./nav-layout";
import { useUpdateUserPreferences, useUserPreferences } from "./useUserPreferences";

/**
 * The persisted layout is a single flat ordered list of ids. One special id —
 * the divider — marks the boundary: every id AFTER it is tucked into the
 * "More" menu, every id before it is shown in the sidebar. Visibility is
 * derived from position, never stored separately.
 *
 * The merge / serialize rules live in `./nav-layout` so they can be tested
 * without a React tree; this hook is only the query wiring around them.
 */
export { NAV_DIVIDER_ID, type NavLayoutEntry };

export interface NavLayout {
	items: NavLayoutEntry[];
}

type Preferences = Awaited<ReturnType<typeof api.getUserPreferences>>;

/**
 * Read and write the user's customizable sidebar navigation layout.
 * The layout is persisted server-side in user_preferences.nav_layout so it
 * follows the user across devices.
 */
export function useNavLayout() {
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	const queryClient = useQueryClient();

	const entries = useMemo<NavLayoutEntry[]>(
		() => (prefs ? mergeNavLayout(prefs.navLayout) : DEFAULT_NAV_ENTRIES),
		[prefs],
	);

	const dividerIndex = useMemo(
		() => entries.findIndex((entry) => entry.kind === "divider"),
		[entries],
	);

	const visibleItems = useMemo(
		() =>
			entries
				.slice(0, dividerIndex < 0 ? entries.length : dividerIndex)
				.filter((entry): entry is { kind: "item"; id: CustomizableNavId } => entry.kind === "item"),
		[entries, dividerIndex],
	);

	const saveLayout = useCallback(
		(nextEntries: NavLayoutEntry[]) => {
			const persisted = toPersistedNavLayout(nextEntries);
			const previous = queryClient.getQueryData<Preferences>(["user-preferences"]);
			// Optimistic update
			if (previous) {
				queryClient.setQueryData<Preferences>(["user-preferences"], {
					...previous,
					navLayout: persisted,
				});
			}
			updatePrefs.mutate(
				{ navLayout: persisted },
				{
					onError: () => {
						if (previous) {
							queryClient.setQueryData(["user-preferences"], previous);
						}
					},
				},
			);
		},
		[queryClient, updatePrefs],
	);

	return { entries, visibleItems, dividerIndex, saveLayout };
}
