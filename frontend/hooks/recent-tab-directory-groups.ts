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

	for (const index of groupIndexByPath.values()) {
		const row = rows[index];
		if (row.kind === "directory") row.children = sortDirectoryMembers(row.children);
	}

	return rows;
}

/**
 * Order a group's members: hand-arranged ones keep the position the user gave them,
 * everything else stays in the incoming (recency) order.
 *
 * ── WHY UNORDERED MEMBERS SORT FIRST ──────────────────────────────────────────
 * The obvious reading of "no explicit position" is "put it last", but that is wrong
 * here: a member without `dirSortOrder` is one the user has never dragged, and the
 * common way to become one is to be BRAND NEW — a narrator opened a moment ago.
 * Sorting those to the bottom would bury the newest session under older hand-placed
 * rows, contradicting the recency promise the rest of the list makes, and it would look
 * like the new narrator failed to appear.
 *
 * The cost is that a member dragged to the top of its group is displaced by the next
 * new arrival. That is the better failure: recency is a standing guarantee, while a
 * single hand-placed position is cheap to redo, and the hand-placed members keep their
 * order relative to EACH OTHER either way.
 *
 * The sort is stable (`Array.prototype.sort` is), so equal keys preserve recency order.
 */
function sortDirectoryMembers(children: RecentTab[]): RecentTab[] {
	if (!children.some((child) => child.dirSortOrder !== undefined)) return children;
	return [...children].sort((left, right) => {
		const leftOrder = left.dirSortOrder;
		const rightOrder = right.dirSortOrder;
		if (leftOrder === undefined && rightOrder === undefined) return 0;
		if (leftOrder === undefined) return -1;
		if (rightOrder === undefined) return 1;
		return leftOrder - rightOrder;
	});
}

/**
 * Optimistic counterpart of the dir-order endpoint: stamp `dirSortOrder` locally.
 *
 * The flat order is deliberately left alone — that is what the server does too, so
 * the optimistic state and the authoritative state describe the same change.
 */
export function applyDirectoryMemberOrder(tabs: RecentTab[], keys: string[]): RecentTab[] {
	const positionByKey = new Map(keys.map((key, index) => [key, index]));
	return tabs.map((tab) => {
		const position = positionByKey.get(`${tab.type}:${tab.id}`);
		if (position === undefined || tab.dirSortOrder === position) return tab;
		return { ...tab, dirSortOrder: position };
	});
}

/**
 * Have the two lists converged — same rows in the same order, AND the same
 * hand-arranged positions inside directory groups?
 *
 * `dirSortOrder` is part of the comparison because a reorder INSIDE a group changes
 * only that column: the flat sequence is identical before and after. Comparing
 * identities alone declared the optimistic state "already converged" on the first
 * frame after the drop, so the sidebar dropped its mask, repainted from the cache's
 * stale order, and the row visibly sprang back before jumping again when the PATCH
 * landed — which undoes the whole point of hand-ordering.
 */
export function sameRecentTabOrder(left: RecentTab[], right: RecentTab[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const a = left[i];
		const b = right[i];
		if (!a || !b) return false;
		if (a.type !== b.type || a.id !== b.id) return false;
		// `?? null` so "never hand-ordered" compares equal across both shapes
		// (absent vs. explicit null) instead of masking forever.
		if ((a.dirSortOrder ?? null) !== (b.dirSortOrder ?? null)) return false;
	}
	return true;
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

/**
 * Sortable ids a row contributes, in visible order (dir header first, then members).
 *
 * Members are registered ONLY when they are actually measurable. dnd-kit derives drop
 * positions from each registered id's rect, so registering an id with no usable rect
 * corrupts the whole list's collision math, not just that row:
 *
 *  - a COLLAPSED group does not render its members at all, so they have no DOM node;
 *  - while the group HEADER is dragged its members are squashed to `height: 0`, which
 *    turns them into a stack of coincident zero-height rects that the pointer "hits"
 *    arbitrarily — the drop indicator jitters between them.
 *
 * The header is always registered: it is the one id in a directory row that exists in
 * every state, which is why {@link resolveDirectoryDropTarget} anchors to it rather
 * than to a member.
 */
export function directoryRowSortableIds(
	row: RecentTabRow,
	options: { collapsed?: boolean; dragging?: boolean } = {},
): string[] {
	if (row.kind === "directory") {
		const headerId = directoryRowId(row.path);
		if (options.collapsed || options.dragging) return [headerId];
		return [headerId, ...row.children.map(tabKeyOf)];
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
	/**
	 * Which way the pointer travelled. Required because {@link resolveDirectoryDropTarget}
	 * collapses every hover over a directory group down to its HEADER id, which throws
	 * away where inside the group the pointer actually was. A group occupies several rows,
	 * so releasing over its lower half must land the unit AFTER the group — with only a
	 * row index to go on, that is indistinguishable from landing before it.
	 */
	direction: "up" | "down",
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
	// Removing the unit shifts every row after it one slot left, so a target that sat
	// below the origin is now at `to - 1`.
	const shifted = to > from ? to - 1 : to;
	// `direction` — not the sign of `to - from` — decides the side. They agree for a
	// single-row target, but a multi-row directory group anchors to its header no matter
	// where inside it the pointer was, and the header's row index alone would always
	// resolve to "before the group".
	next.splice(direction === "down" ? shifted + 1 : shifted, 0, moved);
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
