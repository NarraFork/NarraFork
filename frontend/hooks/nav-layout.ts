/**
 * Pure layout logic for the customizable sidebar navigation.
 *
 * Split out of `useNavLayout` so the merge rules can be tested without a React
 * tree or a query client. They badly need it: every one of them fails SILENTLY.
 * A default that lands on the wrong side of the divider looks like a missing
 * feature, and a merge that forgets a stored position looks like "my
 * customization did not stick" — neither throws, so neither shows up in a type
 * check or by clicking around.
 */

import { type CustomizableNavId, isCustomizableNavId, NAV_DIVIDER_ID } from "@shared/nav-layout";
import { CUSTOMIZABLE_NAV_ITEMS } from "../components/nav/nav-items";

export { NAV_DIVIDER_ID };

/** One entry in the flat layout list. */
export type NavLayoutEntry = { kind: "item"; id: CustomizableNavId } | { kind: "divider" };

/**
 * Default layout for an id the reader has never positioned.
 *
 * Built from the registry rather than written out, so a new nav entry gets its
 * default from the one place that describes it (`NavItemDef.defaultTucked`)
 * instead of from a second list that would drift.
 */
export const DEFAULT_NAV_ENTRIES: NavLayoutEntry[] = [
	...CUSTOMIZABLE_NAV_ITEMS.filter((def) => !def.defaultTucked).map(
		(def): NavLayoutEntry => ({ kind: "item", id: def.id }),
	),
	{ kind: "divider" },
	...CUSTOMIZABLE_NAV_ITEMS.filter((def) => def.defaultTucked).map(
		(def): NavLayoutEntry => ({ kind: "item", id: def.id }),
	),
];

/**
 * Normalize persisted data into the flat entry list:
 * - legacy `{id, hidden}` shape → place hidden entries after the divider
 * - drop unknown/stale ids, drop duplicate dividers (keep the first)
 * - place registry ids missing from the persisted layout (new features) on the
 *   side their `defaultTucked` flag asks for
 *
 * A STORED POSITION ALWAYS WINS over the registry default. That is what makes
 * `defaultTucked` safe to change later: flipping it moves the entry for readers
 * who have never touched it and leaves everyone else's sidebar alone. Letting
 * the default win instead would silently undo a customization on upgrade, and
 * the reader would have no way to tell that from a bug.
 */
export function mergeNavLayout(persisted: unknown): NavLayoutEntry[] {
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

	// Ids the reader has never positioned — including entries added by an upgrade.
	for (const def of CUSTOMIZABLE_NAV_ITEMS) {
		if (beforeDivider.includes(def.id) || afterDivider.includes(def.id)) continue;
		(def.defaultTucked ? afterDivider : beforeDivider).push(def.id);
	}

	return [
		...beforeDivider.map((id): NavLayoutEntry => ({ kind: "item", id })),
		{ kind: "divider" },
		...afterDivider.map((id): NavLayoutEntry => ({ kind: "item", id })),
	];
}

/** Serialize entries to the persisted JSON shape (flat ids, divider marker included). */
export function toPersistedNavLayout(entries: readonly NavLayoutEntry[]): {
	items: Array<{ id: string }>;
} {
	return {
		items: entries.map((entry) =>
			entry.kind === "divider" ? { id: NAV_DIVIDER_ID } : { id: entry.id },
		),
	};
}
