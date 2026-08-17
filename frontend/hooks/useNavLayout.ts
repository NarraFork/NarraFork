import { type CustomizableNavId, isCustomizableNavId, NAV_DIVIDER_ID } from "@shared/nav-layout";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { CUSTOMIZABLE_NAV_ITEMS } from "../components/nav/nav-items";
import type { api } from "../lib/api";
import { useUpdateUserPreferences, useUserPreferences } from "./useUserPreferences";

/**
 * The persisted layout is a single flat ordered list of ids. One special id —
 * the divider — marks the boundary: every id AFTER it is tucked into the
 * "More" menu, every id before it is shown in the sidebar. Visibility is
 * derived from position, never stored separately.
 */
export { NAV_DIVIDER_ID };

/** One entry in the flat layout list. */
export type NavLayoutEntry = { kind: "item"; id: CustomizableNavId } | { kind: "divider" };

export interface NavLayout {
	items: NavLayoutEntry[];
}

type Preferences = Awaited<ReturnType<typeof api.getUserPreferences>>;

const DEFAULT_ENTRIES: NavLayoutEntry[] = [
	...CUSTOMIZABLE_NAV_ITEMS.map((def): NavLayoutEntry => ({ kind: "item", id: def.id })),
	{ kind: "divider" },
];

/**
 * Normalize persisted data into the flat entry list:
 * - legacy `{id, hidden}` shape → place hidden entries after the divider
 * - drop unknown/stale ids, drop duplicate dividers (keep the first)
 * - append new registry ids missing from the persisted layout (new features),
 *   inserted just before the divider so they are visible by default
 */
function mergeWithDefaults(persisted: unknown): NavLayoutEntry[] {
	const rawItems =
		persisted && typeof persisted === "object" && !Array.isArray(persisted)
			? (persisted as { items?: unknown }).items
			: undefined;

	const beforeDivider: CustomizableNavId[] = [];
	const afterDivider: CustomizableNavId[] = [];
	let seenDivider = false;

	if (Array.isArray(rawItems)) {
		for (const raw of rawItems) {
			if (!raw || typeof raw !== "object") continue;
			const record = raw as { id?: unknown; kind?: unknown; hidden?: unknown };
			if (record.id === NAV_DIVIDER_ID || record.kind === "divider") {
				if (!seenDivider) seenDivider = true;
				continue;
			}
			if (typeof record.id !== "string" || !isCustomizableNavId(record.id)) continue;
			if (beforeDivider.includes(record.id) || afterDivider.includes(record.id)) continue;
			// Legacy shape: explicit hidden flag wins; otherwise position relative to divider.
			const hidden = record.hidden === true || (record.hidden == null && seenDivider);
			(hidden ? afterDivider : beforeDivider).push(record.id);
		}
	}

	// New registry ids (new navigation entries) default to visible.
	for (const def of CUSTOMIZABLE_NAV_ITEMS) {
		if (!beforeDivider.includes(def.id) && !afterDivider.includes(def.id)) {
			beforeDivider.push(def.id);
		}
	}

	return [
		...beforeDivider.map((id): NavLayoutEntry => ({ kind: "item", id })),
		{ kind: "divider" },
		...afterDivider.map((id): NavLayoutEntry => ({ kind: "item", id })),
	];
}

/** Serialize entries to the persisted JSON shape (flat ids, divider marker included). */
function toPersisted(entries: NavLayoutEntry[]): { items: Array<{ id: string }> } {
	return {
		items: entries.map((entry) =>
			entry.kind === "divider" ? { id: NAV_DIVIDER_ID } : { id: entry.id },
		),
	};
}

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
		() => (prefs ? mergeWithDefaults(prefs.navLayout) : DEFAULT_ENTRIES),
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
			const persisted = toPersisted(nextEntries);
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
