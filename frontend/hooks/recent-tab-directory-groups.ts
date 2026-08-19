/**
 * Directory aggregation for the sidebar's recent-tab work section.
 *
 * The flat list shows one row per tab, each repeating its working directory in the
 * subtitle. Someone running six narrators in the same repo therefore reads that path six
 * times and burns six rows on it. This module folds those tabs into one collapsible
 * directory row so the path is stated once.
 *
 * ── WHAT CAN AND CANNOT BE GROUPED ────────────────────────────────────────────
 * Only `narrator` and `subagent` tabs carry a directory: their `subtitle` IS the cwd
 * (see `addRecentTab` call sites and `buildSubagentRecentTab`). Everything else is left
 * exactly where it was, for reasons that are not stylistic:
 *
 *  - `chapter` tabs put the CHAPTER TITLE in `subtitle`, not a path. Grouping on that
 *    field would invent directories out of titles. A chapter's real directory is its
 *    worktree path, which is only reachable through a per-tab API call
 *    (`resolveTabDirectory`) — far too expensive for list rendering.
 *  - `workspace` children are an explicit user-built structure. Pulling them into a
 *    directory group would dismantle the workspace the user assembled by hand, so the
 *    header and its children stay adjacent and untouched.
 *  - `project` / `group` tabs have no directory at all.
 *
 * This module is pure so the rules above are testable without a DOM.
 */

import {
	getEffectiveNarratorDisplay,
	type StatusEntry,
	statusAccentVar,
} from "@frontend/lib/status-registry";
import type { RecentTab } from "./recent-tabs-utils";

/** A row in the rendered list: a plain tab, a workspace unit, or a directory group. */
export type RecentTabRow =
	| { kind: "tab"; tab: RecentTab }
	| {
			/**
			 * A workspace header plus its children. Kept as ONE unit: a workspace is a
			 * structure the user assembled by hand, so directory grouping must neither
			 * pull its members into groups nor let a drag split it apart.
			 */
			kind: "workspace";
			tab: RecentTab;
			children: RecentTab[];
	  }
	| {
			kind: "directory";
			/** Normalized absolute path — the group's identity and collapse key. */
			path: string;
			/** Last path segment, shown as the row's primary label. */
			label: string;
			children: RecentTab[];
	  };

/**
 * Minimum members before a directory earns its own row.
 *
 * At 1 the aggregation is a net loss: every tab gains a header line above it, doubling
 * the row count while collapsing nothing. Two is where a group first saves space.
 */
export const MIN_DIRECTORY_GROUP_SIZE = 2;

/** Tab types whose `subtitle` is a working directory. */
function hasDirectorySubtitle(tab: RecentTab): boolean {
	return tab.type === "narrator" || tab.type === "subagent";
}

/**
 * Normalize a cwd into a grouping key, or null when the tab has no usable directory.
 *
 * Backslashes are folded to `/` and trailing separators dropped, then paths must match
 * EXACTLY. Deliberately no case folding and no symlink resolution: these strings come
 * from one server field, so tabs opened in the same directory already agree
 * byte-for-byte. Treating `/a` and `/A` as one directory would be a guess about the
 * filesystem, and on a case-sensitive one it would merge two genuinely different places.
 */
export function normalizeTabDirectory(subtitle: string | undefined | null): string | null {
	if (!subtitle) return null;
	const unified = subtitle.replace(/\\/g, "/").trim();
	if (!unified) return null;
	// Keep a lone "/" intact; strip trailing separators everywhere else.
	const trimmed = unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
	return trimmed || "/";
}

/** Display label for a directory row: the last segment, falling back to the full path. */
export function directoryLabel(path: string): string {
	const segments = path.split("/").filter(Boolean);
	return segments.at(-1) ?? path;
}

/** Stable `data-tab-sort-id` for a directory row. Namespaced so it cannot collide with
 * `${type}:${id}` tab keys — no `RecentTabType` is called "dir". */
export function directoryRowId(path: string): string {
	return `dir:${path}`;
}

/**
 * Fold same-directory narrator tabs into directory rows, preserving list order.
 *
 * A group lands at the position of its FIRST member, which keeps both existing ordering
 * promises intact: recency order still reads top-down, and the `above_idle` auto-promote
 * that lifts a newly working narrator still visibly lifts its directory.
 *
 * Input must be TOP-LEVEL tabs only (no `workspaceId` children); workspace children are
 * supplied via `childrenByWorkspace` and folded into their header's unit.
 */
export function groupRecentTabsByDirectory(
	topLevel: RecentTab[],
	childrenByWorkspace?: ReadonlyMap<string, RecentTab[]>,
): RecentTabRow[] {
	// First pass: count members per directory, so pass two knows whether a group forms
	// without needing to look ahead.
	const counts = new Map<string, number>();
	for (const tab of topLevel) {
		if (!hasDirectorySubtitle(tab)) continue;
		const path = normalizeTabDirectory(tab.subtitle);
		if (!path) continue;
		counts.set(path, (counts.get(path) ?? 0) + 1);
	}

	const rows: RecentTabRow[] = [];
	const groupIndexByPath = new Map<string, number>();

	for (const tab of topLevel) {
		if (tab.type === "workspace") {
			rows.push({ kind: "workspace", tab, children: childrenByWorkspace?.get(tab.id) ?? [] });
			continue;
		}
		const path = hasDirectorySubtitle(tab) ? normalizeTabDirectory(tab.subtitle) : null;
		if (!path || (counts.get(path) ?? 0) < MIN_DIRECTORY_GROUP_SIZE) {
			rows.push({ kind: "tab", tab });
			continue;
		}
		const existing = groupIndexByPath.get(path);
		if (existing === undefined) {
			groupIndexByPath.set(path, rows.length);
			rows.push({ kind: "directory", path, label: directoryLabel(path), children: [tab] });
			continue;
		}
		const row = rows[existing];
		if (row.kind === "directory") row.children.push(tab);
	}

	return rows;
}

export interface DirectoryStatusSummary {
	/** Highest-priority member display, used to tint the collapsed row's icon. */
	display: StatusEntry | null;
	/** CSS colour for {@link display}, or undefined when no member has a status. */
	accentColor: string | undefined;
	workingCount: number;
	/** Members the user needs to act on: waiting for permission, unread, or errored. */
	attentionCount: number;
}

/**
 * Summarize members so a COLLAPSED directory still reports what is happening inside it.
 *
 * Without this the aggregation would hide state: a narrator waiting on a permission
 * prompt inside a collapsed group would look identical to an idle one. The per-narrator
 * WS stream is untouched by grouping (`RecentTabsWSProvider` subscribes independently of
 * rendering), so these counts stay live while collapsed.
 *
 * Priority follows `getEffectiveNarratorDisplay` rather than a second hand-rolled
 * ranking, so a state that changes precedence there changes here too.
 */
export function aggregateDirectoryStatus(children: RecentTab[]): DirectoryStatusSummary {
	let workingCount = 0;
	let attentionCount = 0;
	let best: StatusEntry | null = null;
	let bestRank = Number.POSITIVE_INFINITY;

	for (const tab of children) {
		const status = tab.status ?? "idle";
		const substatus = tab.substatus;
		if (status === "working") workingCount++;
		if (
			status === "waiting" ||
			substatus?.includes("unread") ||
			substatus?.includes("error") ||
			substatus?.includes("retrying")
		) {
			attentionCount++;
		}
		const display = getEffectiveNarratorDisplay(status, substatus);
		const rank = statusRank(status, substatus);
		if (rank < bestRank) {
			bestRank = rank;
			best = display;
		}
	}

	return {
		display: best,
		accentColor: best ? statusAccentVar(best, 6) : undefined,
		workingCount,
		attentionCount,
	};
}

/**
 * Rank for "which member colours the collapsed row" — lower wins.
 *
 * Attention states outrank activity: a group where one narrator is blocked on the user
 * and five are working must read as blocked, because the blocked one is the only member
 * that will not progress on its own.
 */
function statusRank(status: string, substatus: string[] | undefined): number {
	if (substatus?.includes("error") || substatus?.includes("retrying")) return 0;
	if (status === "waiting") return 1;
	if (substatus?.includes("unread")) return 2;
	if (status === "working") return 3;
	if (substatus?.length) return 4;
	if (status !== "idle") return 5;
	return 6;
}

// ── Drag-and-drop translation ────────────────────────────────────────────────
//
// Directory mode renders a DERIVED order: a group's members may sit far apart in the
// server's flat order, and `moveRecentTab` only understands "key X before/after key Y"
// on that flat order. Dragging is still made to work by translating the drop into a
// permutation of the visible ROWS (this module, pure) and then into a sequence of flat
// before/after moves (`computeRecentTabOrderMoves` in useRecentTabs.ts). The sequence is
// what gets persisted, so the order survives a refresh instead of snapping back.

/** Role a sortable id plays inside its row — decides which drops are legal. */
export type DirectoryDragRole = "plain" | "wsHeader" | "wsChild" | "dirHeader" | "dirMember";

export interface DirectoryDragInfo {
	role: DirectoryDragRole;
	rowIndex: number;
}

function tabKeyOf(tab: RecentTab): string {
	return `${tab.type}:${tab.id}`;
}

/** Sortable id of a row's anchor (the id a drop onto any part of the row maps to). */
export function directoryRowSortId(row: RecentTabRow): string {
	if (row.kind === "directory") return directoryRowId(row.path);
	return tabKeyOf(row.tab);
}

/** Every tab key in a row, in visible order — the block fed to the flat-order mover. */
export function directoryRowKeyBlock(row: RecentTabRow): string[] {
	if (row.kind === "tab") return [tabKeyOf(row.tab)];
	if (row.kind === "workspace") return [tabKeyOf(row.tab), ...row.children.map(tabKeyOf)];
	return row.children.map(tabKeyOf);
}

/** Sortable ids a row contributes, in visible order (dir header first, then members). */
export function directoryRowSortableIds(row: RecentTabRow): string[] {
	if (row.kind === "directory") {
		return [directoryRowId(row.path), ...row.children.map(tabKeyOf)];
	}
	return directoryRowKeyBlock(row);
}

/** Map every sortable id in the list to what it is, for collision mapping. */
export function buildDirectoryDragInfo(rows: RecentTabRow[]): Map<string, DirectoryDragInfo> {
	const info = new Map<string, DirectoryDragInfo>();
	rows.forEach((row, rowIndex) => {
		if (row.kind === "tab") {
			info.set(tabKeyOf(row.tab), { role: "plain", rowIndex });
			return;
		}
		if (row.kind === "workspace") {
			info.set(tabKeyOf(row.tab), { role: "wsHeader", rowIndex });
			for (const child of row.children) {
				info.set(tabKeyOf(child), { role: "wsChild", rowIndex });
			}
			return;
		}
		info.set(directoryRowId(row.path), { role: "dirHeader", rowIndex });
		for (const child of row.children) {
			info.set(tabKeyOf(child), { role: "dirMember", rowIndex });
		}
	});
	return info;
}

/**
 * Apply a resolved drop to the visible rows. Returns the new row order, or null when the
 * drop is not meaningful — which is a deliberate answer for these cases:
 *
 *  - a directory member dropped anywhere OUTSIDE its own group: membership comes from the
 *    cwd on the tab, not from the list position, so "moving it out" would group it right
 *    back in on the next render;
 *  - any unit dropped onto its own group;
 *  - a workspace child dragged individually: in directory mode the workspace moves as one
 *    unit (its children are not sortable here), matching the "user-built structure" rule.
 */
export function moveDirectoryRow(
	rows: RecentTabRow[],
	activeId: string,
	overId: string,
): RecentTabRow[] | null {
	const info = buildDirectoryDragInfo(rows);
	const active = info.get(activeId);
	const over = info.get(overId);
	if (!active || !over || activeId === overId) return null;

	// Reordering a directory member inside its own group.
	if (active.role === "dirMember") {
		if (over.rowIndex !== active.rowIndex) return null;
		if (over.role !== "dirMember" && over.role !== "dirHeader") return null;
		const row = rows[active.rowIndex];
		if (row.kind !== "directory") return null;
		const from = row.children.findIndex((child) => tabKeyOf(child) === activeId);
		if (from < 0) return null;
		// Dropping onto the header means "first position".
		const to =
			over.role === "dirHeader" ? 0 : row.children.findIndex((c) => tabKeyOf(c) === overId);
		if (to < 0 || from === to) return null;
		const children = [...row.children];
		const [moved] = children.splice(from, 1);
		children.splice(to, 0, moved);
		const next = [...rows];
		next[active.rowIndex] = { ...row, children };
		return next;
	}

	if (active.role === "wsChild") return null;

	// Unit moves: plain tab, workspace (header stands for the unit), directory group.
	if (active.role === "dirHeader" && over.rowIndex === active.rowIndex) return null;
	const from = active.rowIndex;
	const to = over.rowIndex;
	if (from === to) return null;
	const next = [...rows];
	const [moved] = next.splice(from, 1);
	// One index serves both directions: dragging DOWN lands after the target row
	// (the removal above already shifted it one slot left, so inserting at `to`
	// drops the unit right behind it), and dragging UP lands before it (nothing
	// shifted, so inserting at `to` puts the unit ahead of it).
	next.splice(to, 0, moved);
	return next;
}

/**
 * The collision-map half of the translation: which sortable id should a hover resolve
 * to. Kept pure so the "where would this drop land" rules are testable without dnd-kit.
 *
 * Returns the anchor id to use as `over`, or `activeId` for "no valid target" (dropping
 * onto oneself, which the drag-end handler treats as a no-op).
 */
export function resolveDirectoryDropTarget(
	rows: RecentTabRow[],
	activeId: string,
	hoveredId: string,
): string {
	const info = buildDirectoryDragInfo(rows);
	const active = info.get(activeId);
	const hovered = info.get(hoveredId);
	if (!active || !hovered) return hoveredId;

	if (active.role === "dirMember") {
		// Only same-group targets are legal; anything else snaps back.
		return hovered.rowIndex === active.rowIndex ? hoveredId : activeId;
	}
	if (active.role === "wsChild") return activeId;
	if (active.role === "dirHeader" && hovered.rowIndex === active.rowIndex) return activeId;

	// Everything else drops at unit granularity: a hover over a directory member anchors
	// to its group header (the member rows of a different group are not valid drop slots
	// for outsiders — the dragged tab cannot join that directory by position).
	if (hovered.role === "dirMember") return directoryRowId(rowPath(rows, hovered.rowIndex));
	if (hovered.role === "wsChild") {
		const row = rows[hovered.rowIndex];
		return row.kind === "workspace" ? tabKeyOf(row.tab) : hoveredId;
	}
	return hoveredId;
}

function rowPath(rows: RecentTabRow[], rowIndex: number): string {
	const row = rows[rowIndex];
	return row.kind === "directory" ? row.path : "";
}
