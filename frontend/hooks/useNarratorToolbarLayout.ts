/**
 * Read and write the user's customizable narrator-header toolbar layout.
 *
 * Persisted server-side in `user_preferences.narrator_toolbar_layout`, so the
 * layout follows the user across devices. Deliberately ONE layout shared by
 * desktop and mobile: the order expresses "which tools I reach for most", which
 * is a property of the person, not the screen. Each host then decides how many of
 * them fit (see `partitionToolbar`).
 */

import type {
	NarratorToolbarHost,
	NarratorToolbarId,
} from "@frontend/components/narrator/header/narrator-toolbar-items";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { api } from "../lib/api";
import {
	DEFAULT_TOOLBAR_ENTRIES,
	mergeToolbarLayout,
	type NarratorToolbarEntry,
	partitionToolbar,
	toPersistedToolbarLayout,
} from "./narrator-toolbar-layout";
import { useUpdateUserPreferences, useUserPreferences } from "./useUserPreferences";

type Preferences = Awaited<ReturnType<typeof api.getUserPreferences>>;

export function useNarratorToolbarLayout({
	hostCapabilities,
	visibleLimit,
	entryEnabled,
}: {
	hostCapabilities: readonly NarratorToolbarHost[];
	/**
	 * `null` = no cap: `visible` holds every surfaced entry. The narrator header
	 * passes `null` and applies its own MEASURED capacity afterwards
	 * (title-first arithmetic in `header-title-width.ts`), which needs the uncapped count as its
	 * input.
	 */
	visibleLimit: number | null;
	/**
	 * Per-narrator availability ("does this narrator have the thing"). Applied
	 * before the visible cap so a capped host back-fills past disabled entries.
	 * Omitted = every entry the host can present is offered.
	 */
	entryEnabled?: (id: NarratorToolbarId) => boolean;
}) {
	const { data: prefs } = useUserPreferences();
	const updatePrefs = useUpdateUserPreferences();
	const queryClient = useQueryClient();

	const entries = useMemo<NarratorToolbarEntry[]>(
		() =>
			prefs
				? mergeToolbarLayout((prefs as { narratorToolbarLayout?: unknown }).narratorToolbarLayout)
				: DEFAULT_TOOLBAR_ENTRIES,
		[prefs],
	);

	// Capability list is rebuilt by callers on every render; key the memo on its
	// contents so a stable host does not invalidate the partition each pass.
	const capabilityKey = hostCapabilities.join(",");
	const partition = useMemo(
		() =>
			partitionToolbar({
				entries,
				hostCapabilities: capabilityKey ? (capabilityKey.split(",") as NarratorToolbarHost[]) : [],
				visibleLimit,
				entryEnabled,
			}),
		[entries, capabilityKey, visibleLimit, entryEnabled],
	);

	const saveLayout = useCallback(
		(nextEntries: readonly NarratorToolbarEntry[]) => {
			const persisted = toPersistedToolbarLayout(nextEntries);
			const previous = queryClient.getQueryData<Preferences>(["user-preferences"]);
			// Optimistic update: dragging a row must feel immediate, and the drag
			// source is the same list this feeds.
			if (previous) {
				queryClient.setQueryData<Preferences>(["user-preferences"], {
					...previous,
					narratorToolbarLayout: persisted,
				} as Preferences);
			}
			updatePrefs.mutate(
				{ narratorToolbarLayout: persisted },
				{
					onError: () => {
						if (previous) queryClient.setQueryData(["user-preferences"], previous);
					},
				},
			);
		},
		[queryClient, updatePrefs],
	);

	// `overflow` excludes bottom controls; consumers needing combined badges can
	// explicitly aggregate both lists without rendering bottom entries twice.
	return { entries, ...partition, saveLayout };
}
