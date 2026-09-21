/** Pure normalization, serialization and partition rules for the three toolbar zones. */
import {
	isNarratorToolbarId,
	MOBILE_TOOLBAR_VISIBLE_LIMIT,
	NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	type NarratorToolbarId,
} from "@shared/narrator-toolbar";
import {
	isNarratorToolbarItemAvailable,
	NARRATOR_TOOLBAR_ITEMS,
	type NarratorToolbarHost,
	type NarratorToolbarItemDef,
	narratorToolbarItem,
} from "../components/narrator/header/narrator-toolbar-items";

export {
	MOBILE_TOOLBAR_VISIBLE_LIMIT,
	NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
	NARRATOR_TOOLBAR_DIVIDER_ID,
};

export type NarratorToolbarEntry =
	| { kind: "item"; id: NarratorToolbarId }
	| { kind: "divider" }
	| { kind: "bottom-divider" };

const defaultBottom = (id: NarratorToolbarId) => id === "path-rules" || id === "terminal";
const itemEntry = (id: NarratorToolbarId): NarratorToolbarEntry => ({ kind: "item", id });

/** Fresh installs: ordinary registry entries in the header, path rules/terminal below. */
export const DEFAULT_TOOLBAR_ENTRIES: NarratorToolbarEntry[] = [
	...NARRATOR_TOOLBAR_ITEMS.filter((def) => !defaultBottom(def.id)).map((def) => itemEntry(def.id)),
	{ kind: "divider" },
	{ kind: "bottom-divider" },
	itemEntry("path-rules"),
	itemEntry("terminal"),
];

/**
 * Keep existing ids in their saved zones; only newly introduced path rules go below.
 * Other missing registry ids retain the legacy header default (including terminal).
 * Missing/malformed layout uses fresh defaults; an actual items array is an existing
 * layout. Unknown ids and duplicates are discarded. Boundaries only advance the
 * zone, so repeated or reversed markers cannot move bottom items back into the menu.
 */
export function mergeToolbarLayout(persisted: unknown): NarratorToolbarEntry[] {
	const rawItems =
		persisted && typeof persisted === "object" && !Array.isArray(persisted)
			? (persisted as { items?: unknown }).items
			: undefined;
	if (!Array.isArray(rawItems)) return DEFAULT_TOOLBAR_ENTRIES.map((entry) => ({ ...entry }));

	const zones: NarratorToolbarId[][] = [[], [], []];
	const seen = new Set<NarratorToolbarId>();
	let zone = 0;
	for (const raw of rawItems) {
		if (!raw || typeof raw !== "object") continue;
		const record = raw as { id?: unknown; kind?: unknown };
		if (record.id === NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID || record.kind === "bottom-divider") {
			zone = 2;
			continue;
		}
		if (record.id === NARRATOR_TOOLBAR_DIVIDER_ID || record.kind === "divider") {
			zone = Math.max(zone, 1);
			continue;
		}
		if (typeof record.id !== "string" || !isNarratorToolbarId(record.id)) continue;
		if (seen.has(record.id)) continue;
		seen.add(record.id);
		zones[zone].push(record.id);
	}
	for (const def of NARRATOR_TOOLBAR_ITEMS) {
		if (!seen.has(def.id)) zones[def.id === "path-rules" ? 2 : 0].push(def.id);
	}
	return [
		...zones[0].map(itemEntry),
		{ kind: "divider" },
		...zones[1].map(itemEntry),
		{ kind: "bottom-divider" },
		...zones[2].map(itemEntry),
	];
}

/** Flat persisted ids encode both boundaries; no independent visibility flags. */
export function toPersistedToolbarLayout(entries: readonly NarratorToolbarEntry[]): {
	items: Array<{ id: string }>;
} {
	return {
		items: entries.map((entry) => ({
			id:
				entry.kind === "divider"
					? NARRATOR_TOOLBAR_DIVIDER_ID
					: entry.kind === "bottom-divider"
						? NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID
						: entry.id,
		})),
	};
}

/** Move one visible entry in the full layout, preserving unavailable entries' zones. */
export function moveToolbarEntry(
	entries: readonly NarratorToolbarEntry[],
	activeId: string,
	overId: string,
): NarratorToolbarEntry[] {
	const ids = toPersistedToolbarLayout(entries).items.map((item) => item.id);
	const from = ids.indexOf(activeId);
	let to = ids.indexOf(overId);
	const next = [...entries];
	if (from < 0 || to < 0 || from === to || entries[from].kind !== "item") return next;
	// Dropping on a section boundary enters the zone that boundary opens.
	// For `__bottom__` the zone is always AFTER the marker, so a from-below drag
	// (from > to) needs `to++` to land inside it. For `__divider__` the zone it
	// marks is the MENU (after it) when dragging down from the header, but the
	// HEADER (before it) when dragging up from menu/bottom — the empty-header
	// restore path. A plain `to++` on `__divider__` would push every from-below
	// drag into the menu and leave no way back into an empty header zone.
	if (entries[to].kind === "bottom-divider" && from > to) to++;
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

export interface ToolbarPartition {
	/** Available header entries within the cap, in saved order. */
	visible: NarratorToolbarItemDef[];
	/** Header entries beyond the cap, followed by menu entries. Never includes bottom. */
	overflow: NarratorToolbarItemDef[];
	/** Available bottom entries, independent of header capacity. */
	bottom: NarratorToolbarItemDef[];
}

/**
 * All three zones apply host capability and narrator availability filtering.
 * Filter before capping to back-fill the header. A null limit leaves it uncapped
 * for callers that measure capacity separately. Old lists without boundaries
 * remain header-only; a bottom boundary without a menu boundary has an empty menu.
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
	const zones: NarratorToolbarItemDef[][] = [[], [], []];
	const seen = new Set<NarratorToolbarId>();
	let zone = 0;
	for (const entry of entries) {
		if (entry.kind === "bottom-divider") {
			zone = 2;
			continue;
		}
		if (entry.kind === "divider") {
			zone = Math.max(zone, 1);
			continue;
		}
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const def = narratorToolbarItem(entry.id);
		if (!def || !isNarratorToolbarItemAvailable(def, hostCapabilities)) continue;
		if (entryEnabled && !entryEnabled(entry.id)) continue;
		zones[zone].push(def);
	}
	const limit = visibleLimit === null ? zones[0].length : Math.max(0, visibleLimit);
	return {
		visible: zones[0].slice(0, limit),
		overflow: [...zones[0].slice(limit), ...zones[1]],
		bottom: zones[2],
	};
}
