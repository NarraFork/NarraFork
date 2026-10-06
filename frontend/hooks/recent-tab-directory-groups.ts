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

function tabKeyOf(tab: RecentTab): string {
	return `${tab.type}:${tab.id}`;
}

/** Every tab key in a row, in visible order — the block fed to the flat-order mover. */
export function directoryRowKeyBlock(row: RecentTabRow): string[] {
	if (row.kind === "tab") return [tabKeyOf(row.tab)];
	if (row.kind === "workspace") return [tabKeyOf(row.tab), ...row.children.map(tabKeyOf)];
	return row.children.map(tabKeyOf);
}
