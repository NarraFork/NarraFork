/**
 * Client mirror of the server's folder layout rules (`server/services/recent-tabs-service.ts`).
 *
 * The flat tab list is the single source: a folder is a `type: "folder"` tab immediately
 * followed by its members (tabs whose `folderId` names it); inside a folder pinned members
 * come first. Optimistic updates and WS delta replay both run through these functions, so
 * they must land on exactly the order the server persists — the delta reducer test in
 * `tests/server/services/recent-tabs-service.test.ts` replays real server deltas through
 * them to hold that.
 *
 * One deliberate difference from the server: `regroupFolders` keeps an EMPTY folder.
 * Delta replay applies a folder's upsert before its members' upserts, so dropping it in
 * between would lose the anchor the members are about to use (the server sends an
 * explicit remove when a folder really disappears). The optimistic operations below drop
 * a folder they emptied themselves, as the server does.
 */

import type { RecentTabMoveTarget } from "../lib/api/settings";
import type { RecentTab } from "./recent-tabs-utils";

export function recentTabKey(tab: Pick<RecentTab, "type" | "id">): string {
	return `${tab.type}:${tab.id}`;
}

export function isFolderTab(tab: Pick<RecentTab, "type">): boolean {
	return tab.type === "folder";
}

/** Only session tabs may live inside a folder (mirrors the server's `canJoinFolder`). */
export function canJoinFolder(tab: Pick<RecentTab, "type">): boolean {
	return tab.type === "narrator" || tab.type === "subagent";
}

/**
 * Pull every folder's members right after its header, pinned members first. Members whose
 * folder is not in the list (outside the loaded window, or mid-replay) stay where they are.
 */
export function regroupFolders(tabs: RecentTab[]): RecentTab[] {
	const folderIds = new Set(tabs.filter(isFolderTab).map((tab) => tab.id));
	if (folderIds.size === 0) return tabs;
	const membersByFolder = new Map<string, RecentTab[]>();
	for (const tab of tabs) {
		if (!tab.folderId || !folderIds.has(tab.folderId)) continue;
		const members = membersByFolder.get(tab.folderId);
		if (members) members.push(tab);
		else membersByFolder.set(tab.folderId, [tab]);
	}
	const result: RecentTab[] = [];
	for (const tab of tabs) {
		if (tab.folderId && folderIds.has(tab.folderId)) continue;
		result.push(tab);
		if (!isFolderTab(tab)) continue;
		const members = membersByFolder.get(tab.id) ?? [];
		result.push(
			...members.filter((member) => member.pinned),
			...members.filter((member) => !member.pinned),
		);
	}
	return result.length === tabs.length && result.every((tab, index) => tab === tabs[index])
		? tabs
		: result;
}

/** Flat index range of the top-level unit containing `index` (a lone tab, or a folder + members). */
export function unitRange(tabs: RecentTab[], index: number): { start: number; end: number } {
	const tab = tabs[index];
	if (!tab) return { start: index, end: index };
	const folderId = isFolderTab(tab) ? tab.id : tab.folderId;
	if (!folderId) return { start: index, end: index };
	const start = tabs.findIndex((candidate) => isFolderTab(candidate) && candidate.id === folderId);
	if (start < 0) return { start: index, end: index };
	let end = start;
	while (end + 1 < tabs.length && tabs[end + 1]?.folderId === folderId) end++;
	return { start, end };
}

/** Flat index just past the last pinned top-level unit. */
export function getPinnedSectionEndIndex(tabs: RecentTab[]): number {
	let index = 0;
	while (index < tabs.length) {
		const tab = tabs[index];
		if (tab.folderId) {
			index++;
			continue;
		}
		if (!tab.pinned) break;
		index = unitRange(tabs, index).end + 1;
	}
	return index;
}

function folderHeaderIndex(tabs: RecentTab[], folderId: string): number {
	return tabs.findIndex((tab) => isFolderTab(tab) && tab.id === folderId);
}

/** Index of a folder's first non-pinned member (or just past its last member). */
function folderUnpinnedStart(tabs: RecentTab[], folderId: string): number {
	const header = folderHeaderIndex(tabs, folderId);
	if (header < 0) return -1;
	let index = header + 1;
	while (index < tabs.length && tabs[index].folderId === folderId && tabs[index].pinned) index++;
	return index;
}

function folderEnd(tabs: RecentTab[], folderId: string): number {
	const header = folderHeaderIndex(tabs, folderId);
	return header < 0 ? -1 : unitRange(tabs, header).end + 1;
}

/** How a sidebar folder is shown: header only, header + first N members, or everything. */
export type FolderDisplay = "collapsed" | "preview" | "expanded";

function anchorOf(
	target: RecentTabMoveTarget,
): { key: string; position: "before" | "after" } | null {
	if ("beforeKey" in target) return { key: target.beforeKey, position: "before" };
	if ("afterKey" in target) return { key: target.afterKey, position: "after" };
	return null;
}

/**
 * Move one tab (or a whole folder when `key` names a folder) the way the server's
 * `moveRecentTab` does. Returns a new array; the input is not mutated.
 */
export function applyRecentTabMove(
	tabs: RecentTab[],
	key: string,
	target: RecentTabMoveTarget,
): RecentTab[] {
	const index = tabs.findIndex((tab) => recentTabKey(tab) === key);
	if (index === -1) return tabs;
	const source = tabs[index];
	const next = [...tabs];
	// `above_idle` needs live narrator status, which only the server has; replaying its
	// result arrives as a delta. Locally it is a no-op.
	if ("position" in target && target.position === "above_idle") return tabs;
	if (
		!isFolderTab(source) &&
		(target.folderId !== undefined ||
			(source.folderId && folderHeaderIndex(next, source.folderId) >= 0))
	) {
		return dropEmptyFolder(regroupFolders(moveMember(next, index, target)), source.folderId);
	}

	const range = isFolderTab(source) ? unitRange(next, index) : { start: index, end: index };
	const group = next.splice(range.start, range.end - range.start + 1);
	insertUnit(next, group, target, range.start);
	return regroupFolders(next);
}

/** Top-level placement: an anchor inside a folder resolves to the folder's boundary. */
function insertUnit(
	tabs: RecentTab[],
	group: RecentTab[],
	target: RecentTabMoveTarget,
	originalIndex: number,
): void {
	const anchor = anchorOf(target);
	if (anchor) {
		const anchorIndex = tabs.findIndex((tab) => recentTabKey(tab) === anchor.key);
		if (anchorIndex < 0) {
			// Mirrors the server's move: a vanished anchor appends.
			tabs.push(...group);
			return;
		}
		const range = unitRange(tabs, anchorIndex);
		tabs.splice(anchor.position === "before" ? range.start : range.end + 1, 0, ...group);
	} else if ("toIndex" in target) {
		tabs.splice(Math.min(target.toIndex, tabs.length), 0, ...group);
	} else if ("position" in target && target.position === "top") {
		tabs.unshift(...group);
	} else {
		tabs.splice(Math.min(originalIndex, tabs.length), 0, ...group);
	}
}

/** Mirrors the server's `moveMember`: moves that enter, leave or stay inside a folder. */
function moveMember(tabs: RecentTab[], index: number, target: RecentTabMoveTarget): RecentTab[] {
	const source = tabs[index];
	const targetFolder = target.folderId === undefined ? (source.folderId ?? null) : target.folderId;
	if (targetFolder && (!canJoinFolder(source) || folderHeaderIndex(tabs, targetFolder) < 0)) {
		return tabs;
	}
	const [removed] = tabs.splice(index, 1);
	const moved: RecentTab = { ...removed };
	if ((moved.folderId ?? null) !== targetFolder) delete moved.pinned;
	if (targetFolder) moved.folderId = targetFolder;
	else delete moved.folderId;

	if (!targetFolder) {
		const anchor = anchorOf(target);
		if (anchor || "toIndex" in target) insertUnit(tabs, [moved], target, index);
		else if ("position" in target && target.position === "top") tabs.unshift(moved);
		else tabs.splice(getPinnedSectionEndIndex(tabs), 0, moved);
		return tabs;
	}

	if ("position" in target && target.position === "top") {
		const header = folderHeaderIndex(tabs, targetFolder);
		tabs.splice(moved.pinned ? header + 1 : folderUnpinnedStart(tabs, targetFolder), 0, moved);
		return tabs;
	}
	const anchor = anchorOf(target);
	const anchorIndex = anchor ? tabs.findIndex((tab) => recentTabKey(tab) === anchor.key) : -1;
	const anchorTab = anchorIndex >= 0 ? tabs[anchorIndex] : undefined;
	if (anchor && anchorTab?.folderId === targetFolder) {
		if (anchorTab.pinned) moved.pinned = true;
		else delete moved.pinned;
		tabs.splice(anchor.position === "before" ? anchorIndex : anchorIndex + 1, 0, moved);
	} else if (anchorTab && isFolderTab(anchorTab) && anchorTab.id === targetFolder) {
		tabs.splice(folderUnpinnedStart(tabs, targetFolder), 0, moved);
	} else {
		tabs.splice(folderEnd(tabs, targetFolder), 0, moved);
	}
	return tabs;
}

/** Mirrors the server's `pinRecentTab`. */
export function applyRecentTabPin(tabs: RecentTab[], key: string, pinned: boolean): RecentTab[] {
	const index = tabs.findIndex((tab) => recentTabKey(tab) === key);
	if (index === -1) return tabs;
	const current = tabs[index];
	if (!!current.pinned === pinned) return tabs;
	const next = [...tabs];
	if (current.folderId && folderHeaderIndex(next, current.folderId) >= 0) {
		const folderId = current.folderId;
		next.splice(index, 1);
		const member: RecentTab = { ...current, pinned: pinned || undefined };
		next.splice(folderUnpinnedStart(next, folderId), 0, member);
		return regroupFolders(next);
	}
	const range = isFolderTab(current) ? unitRange(next, index) : { start: index, end: index };
	const group = next.splice(range.start, range.end - range.start + 1);
	group[0] = { ...group[0], pinned: pinned || undefined };
	next.splice(getPinnedSectionEndIndex(next), 0, ...group);
	return regroupFolders(next);
}

/** Mirrors the server's `dissolveRecentTabFolder`. */
export function applyRecentTabFolderDissolve(tabs: RecentTab[], folderId: string): RecentTab[] {
	const index = folderHeaderIndex(tabs, folderId);
	if (index < 0) return tabs;
	const range = unitRange(tabs, index);
	const next = [...tabs];
	const members = next.slice(range.start + 1, range.end + 1).map((member) => {
		const released: RecentTab = { ...member };
		delete released.folderId;
		delete released.pinned;
		return released;
	});
	next.splice(range.start, range.end - range.start + 1, ...members);
	return next;
}

/** Remove a tab; a folder takes its members with it (the server's `removeRecentTab`). */
export function applyRecentTabRemove(tabs: RecentTab[], key: string): RecentTab[] {
	const index = tabs.findIndex((tab) => recentTabKey(tab) === key);
	if (index < 0) return tabs;
	const removed = tabs[index];
	if (!isFolderTab(removed)) {
		const next = tabs.filter((_, candidate) => candidate !== index);
		return dropEmptyFolder(next, removed.folderId);
	}
	return tabs.filter((tab) => tab !== removed && tab.folderId !== removed.id);
}

/** Remove `folderId`'s header if no member is left (mirrors the server's empty-folder rule). */
export function dropEmptyFolder(tabs: RecentTab[], folderId: string | undefined): RecentTab[] {
	if (!folderId || tabs.some((tab) => tab.folderId === folderId)) return tabs;
	return tabs.filter((tab) => !(isFolderTab(tab) && tab.id === folderId));
}

// ── Rendering units ──────────────────────────────────────────────────────────

export type RecentTabRow =
	| { kind: "tab"; tab: RecentTab }
	| { kind: "folder"; tab: RecentTab; members: RecentTab[] };

/** Group the flat list into top-level rows. Orphan members render as plain tabs. */
export function groupRecentTabRows(tabs: RecentTab[]): RecentTabRow[] {
	const folderIds = new Set(tabs.filter(isFolderTab).map((tab) => tab.id));
	const membersByFolder = new Map<string, RecentTab[]>();
	for (const tab of tabs) {
		if (!tab.folderId || !folderIds.has(tab.folderId)) continue;
		const members = membersByFolder.get(tab.folderId);
		if (members) members.push(tab);
		else membersByFolder.set(tab.folderId, [tab]);
	}
	const rows: RecentTabRow[] = [];
	for (const tab of tabs) {
		if (tab.folderId && folderIds.has(tab.folderId)) continue;
		if (isFolderTab(tab))
			rows.push({ kind: "folder", tab, members: membersByFolder.get(tab.id) ?? [] });
		else rows.push({ kind: "tab", tab });
	}
	return rows;
}

/** Status summary shown for members a collapsed (or preview-limited) folder hides. */
export interface FolderStatusSummary {
	working: number;
	waiting: number;
	unread: number;
	error: number;
}

export function summarizeFolderMembers(members: RecentTab[]): FolderStatusSummary {
	const summary: FolderStatusSummary = { working: 0, waiting: 0, unread: 0, error: 0 };
	for (const member of members) {
		if (member.status === "working") summary.working++;
		else if (member.status === "waiting") summary.waiting++;
		if (member.substatus?.includes("error")) summary.error++;
		else if (member.substatus?.includes("unread")) summary.unread++;
	}
	return summary;
}
