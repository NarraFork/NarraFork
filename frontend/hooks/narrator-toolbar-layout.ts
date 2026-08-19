/**
 * Pure layout logic for the narrator header toolbar.
 *
 * Split from the hook so the merge / partition rules can be tested without a
 * React tree or a query client. The nav equivalent keeps these inline in
 * `useNavLayout`, which is why its rules have no direct tests.
 */

import {
	isNarratorToolbarId,
	MOBILE_TOOLBAR_VISIBLE_LIMIT,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	type NarratorToolbarId,
} from "@shared/narrator-toolbar";
import {
	isNarratorToolbarItemAvailable,
	NARRATOR_TOOLBAR_ITEMS,
	type NarratorToolbarHost,
	type NarratorToolbarItemDef,
	narratorToolbarItem,
} from "../components/narrator/narrator-toolbar-items";

export { MOBILE_TOOLBAR_VISIBLE_LIMIT, NARRATOR_TOOLBAR_DIVIDER_ID };

/** One entry in the flat layout list. */
export type NarratorToolbarEntry = { kind: "item"; id: NarratorToolbarId } | { kind: "divider" };

/** Default layout for fresh installs: every id surfaced, divider at the end. */
export const DEFAULT_TOOLBAR_ENTRIES: NarratorToolbarEntry[] = [
	...NARRATOR_TOOLBAR_ITEMS.map((def): NarratorToolbarEntry => ({ kind: "item", id: def.id })),
	{ kind: "divider" },
];

/**
 * Normalize persisted data into the flat entry list:
 *  - drop unknown / stale ids (a removed feature must not resurrect)
 *  - drop duplicate ids and duplicate dividers (keep the first of each)
 *  - append registry ids missing from the persisted layout, before the divider,
 *    so a newly shipped entry is surfaced by default instead of hiding in the
 *    overflow menu where nobody would find it
 *
 * A layout with no divider at all is treated as "everything surfaced", which is
 * what an older client or a hand-written value would mean.
 */
export function mergeToolbarLayout(persisted: unknown): NarratorToolbarEntry[] {
	const rawItems =
		persisted && typeof persisted === "object" && !Array.isArray(persisted)
			? (persisted as { items?: unknown }).items
			: undefined;

	const beforeDivider: NarratorToolbarId[] = [];
	const afterDivider: NarratorToolbarId[] = [];
	let seenDivider = false;

	if (Array.isArray(rawItems)) {
		for (const raw of rawItems) {
			if (!raw || typeof raw !== "object") continue;
			const record = raw as { id?: unknown; kind?: unknown };
			if (record.id === NARRATOR_TOOLBAR_DIVIDER_ID || record.kind === "divider") {
				seenDivider = true;
				continue;
			}
			if (typeof record.id !== "string" || !isNarratorToolbarId(record.id)) continue;
			if (beforeDivider.includes(record.id) || afterDivider.includes(record.id)) continue;
			(seenDivider ? afterDivider : beforeDivider).push(record.id);
		}
	}

	// New registry ids default to surfaced.
	for (const def of NARRATOR_TOOLBAR_ITEMS) {
		if (!beforeDivider.includes(def.id) && !afterDivider.includes(def.id)) {
			beforeDivider.push(def.id);
		}
	}

	return [
		...beforeDivider.map((id): NarratorToolbarEntry => ({ kind: "item", id })),
		{ kind: "divider" },
		...afterDivider.map((id): NarratorToolbarEntry => ({ kind: "item", id })),
	];
}

/** Serialize entries to the persisted JSON shape (flat ids, divider included). */
export function toPersistedToolbarLayout(entries: readonly NarratorToolbarEntry[]): {
	items: Array<{ id: string }>;
} {
	return {
		items: entries.map((entry) =>
			entry.kind === "divider" ? { id: NARRATOR_TOOLBAR_DIVIDER_ID } : { id: entry.id },
		),
	};
}

export interface ToolbarPartition {
	/** Entries the header should render inline, in order. */
	visible: NarratorToolbarItemDef[];
	/** Entries the overflow menu should list, in order. */
	overflow: NarratorToolbarItemDef[];
}

/**
 * Split a layout into "render inline" and "list in the overflow menu", given what
 * the current host can present and how many inline slots it allows.
 *
 * Entries the host cannot present are dropped from BOTH lists rather than shown
 * as disabled: a control that can never work on this surface is noise, and the
 * id stays in the persisted layout so it reappears on a host that supports it.
 *
 * `entryEnabled` answers a different question — "does THIS narrator offer the
 * thing right now" (a chapter to diff, remote devices, spec support) — and is
 * applied to the surfaced list BEFORE the visible cap. That ordering is what
 * makes a capped host back-fill: if the first two surfaced entries are both
 * disabled and the cap is two, entries three and four still surface instead of
 * the host showing a partially (or entirely) empty row. Filtered entries are
 * excluded from both lists; they stay in the persisted layout and return when
 * the narrator regains whatever the entry needs.
 *
 * `visibleLimit` of `null` means "no cap" — the desktop header takes every
 * available entry and lets the flex row absorb the width (the title compresses
 * in a narrow dock; there is deliberately no width measurement here).
 */
export function partitionToolbar({
	entries,
	hostCapabilities,
	visibleLimit,
	entryEnabled,
}: {
	entries: readonly NarratorToolbarEntry[];
	hostCapabilities: readonly NarratorToolbarHost[];
	visibleLimit: number | null;
	entryEnabled?: (id: NarratorToolbarId) => boolean;
}): ToolbarPartition {
	const dividerIndex = entries.findIndex((entry) => entry.kind === "divider");
	const cut = dividerIndex < 0 ? entries.length : dividerIndex;

	const available = (from: number, to: number): NarratorToolbarItemDef[] => {
		const out: NarratorToolbarItemDef[] = [];
		for (const entry of entries.slice(from, to)) {
			if (entry.kind !== "item") continue;
			const def = narratorToolbarItem(entry.id);
			if (!def) continue;
			if (!isNarratorToolbarItemAvailable(def, hostCapabilities)) continue;
			if (entryEnabled && !entryEnabled(entry.id)) continue;
			out.push(def);
		}
		return out;
	};

	const surfaceable = available(0, cut);
	const tucked = available(cut, entries.length);

	if (visibleLimit === null) {
		return { visible: surfaceable, overflow: tucked };
	}

	const limit = Math.max(0, visibleLimit);
	return {
		visible: surfaceable.slice(0, limit),
		// Entries past the cap join the tucked ones, keeping layout order: the
		// overflow menu must read as a continuation of the row, not a separate list.
		overflow: [...surfaceable.slice(limit), ...tucked],
	};
}
