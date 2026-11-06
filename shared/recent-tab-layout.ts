/**
 * Folder layout rules for the sidebar's recent tabs.
 *
 * The flat tab list is the single source: a folder is a `type: "folder"` tab immediately
 * followed by its members (tabs whose `folderId` names it); inside a folder pinned members
 * come first. The server persists the result of these functions and the client renders
 * the same result optimistically before the server answers, so both sides import this
 * module instead of keeping a copy each.
 *
 * Exported operations named `apply*` never mutate their input: they return a new array
 * (or the input itself when nothing changed). The helpers documented as working on a
 * caller-owned array (`extractUnit`, `insertRelativeToKey`, ...) splice it in place.
 */

import type { PersistedRecentTab } from "./recent-tabs";

type LayoutTab = PersistedRecentTab;

/**
 * Where a moved tab should land. Anchors win over `position`, which wins over `toIndex`.
 *
 * `folderId`: undefined keeps membership (a member moves inside its folder, a top-level
 * tab stays top-level); null leaves the folder; a folder id joins that folder, next to
 * the anchor when the anchor is one of its members, at its end otherwise.
 */
export interface RecentTabPlacement {
	beforeKey?: string;
	afterKey?: string;
	position?: "top" | "above_idle";
	toIndex?: number;
	folderId?: string | null;
	/**
	 * A top-level unit dragged across the pin divider takes this pinned state with it. The
	 * pinned block is positional (`getPinnedSectionEndIndex`), so it lands at the pinned
	 * block's end (pinning) or the unpinned block's start (unpinning) when its anchor is in
	 * the other block. Ignored for folder members, whose pinning is per folder.
	 */
	pinned?: boolean;
}

export function recentTabKey(tab: Pick<LayoutTab, "type" | "id">): string {
	return `${tab.type}:${tab.id}`;
}

export function isFolderTab(tab: Pick<LayoutTab, "type">): boolean {
	return tab.type === "folder";
}

/** Only session tabs may live inside a folder; folders never nest. */
export function canJoinFolder(tab: Pick<LayoutTab, "type">): boolean {
	return tab.type === "narrator" || tab.type === "subagent";
}

function findKey(tabs: LayoutTab[], key: string): number {
	return tabs.findIndex((tab) => recentTabKey(tab) === key);
}

/**
 * Pull every folder's members right after its header, pinned members first (stable
 * otherwise). Returns the input array when it is already in that shape.
 *
 * `prune` gives the server's canonical form: a member whose folder is not in the list
 * goes back to the top level, and a folder with no members is removed. The client leaves
 * both alone, because its list may be a partial window (the header can be outside it),
 * and because delta replay applies a folder's upsert before its members' upserts:
 * dropping the empty folder in between would lose the anchor the members are about to
 * use. The server sends an explicit remove when a folder really disappears.
 */
export function regroupFolders<T extends LayoutTab>(
	tabs: T[],
	options: { prune?: boolean } = {},
): T[] {
	const folderIds = new Set(tabs.filter(isFolderTab).map((tab) => tab.id));
	const source = options.prune
		? tabs.map((tab) => {
				if (!tab.folderId || folderIds.has(tab.folderId)) return tab;
				const released = { ...tab };
				delete released.folderId;
				return released;
			})
		: tabs;
	if (folderIds.size === 0) return sameItems(source, tabs) ? tabs : source;

	const membersByFolder = new Map<string, T[]>();
	for (const tab of source) {
		if (!tab.folderId || !folderIds.has(tab.folderId)) continue;
		const members = membersByFolder.get(tab.folderId);
		if (members) members.push(tab);
		else membersByFolder.set(tab.folderId, [tab]);
	}
	const result: T[] = [];
	for (const tab of source) {
		if (tab.folderId && folderIds.has(tab.folderId)) continue;
		if (!isFolderTab(tab)) {
			result.push(tab);
			continue;
		}
		const members = membersByFolder.get(tab.id) ?? [];
		if (options.prune && members.length === 0) continue;
		result.push(
			tab,
			...members.filter((member) => member.pinned),
			...members.filter((member) => !member.pinned),
		);
	}
	return sameItems(result, tabs) ? tabs : result;
}

function sameItems<T>(left: T[], right: T[]): boolean {
	return left.length === right.length && left.every((tab, index) => tab === right[index]);
}

/**
 * The flat index range of the top-level unit containing `index`: a lone tab, or a folder
 * together with its members. Assumes the layout from `regroupFolders`.
 */
export function unitRange(tabs: LayoutTab[], index: number): { start: number; end: number } {
	const tab = tabs[index];
	if (!tab) return { start: index, end: index };
	const folderId = isFolderTab(tab) ? tab.id : tab.folderId;
	if (!folderId) return { start: index, end: index };
	const start = folderHeaderIndex(tabs, folderId);
	if (start < 0) return { start: index, end: index };
	let end = start;
	while (end + 1 < tabs.length && tabs[end + 1]?.folderId === folderId) end++;
	return { start, end };
}

/** Flat index just past the last pinned top-level unit. */
export function getPinnedSectionEndIndex(tabs: LayoutTab[]): number {
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

export function folderHeaderIndex(tabs: LayoutTab[], folderId: string): number {
	return tabs.findIndex((tab) => isFolderTab(tab) && tab.id === folderId);
}

/** Index of a folder's first non-pinned member, or just past its last member. */
export function folderUnpinnedStart(tabs: LayoutTab[], folderId: string): number {
	const header = folderHeaderIndex(tabs, folderId);
	if (header < 0) return -1;
	let index = header + 1;
	while (index < tabs.length && tabs[index].folderId === folderId && tabs[index].pinned) index++;
	return index;
}

/** Index just past a folder's last member. */
export function folderEnd(tabs: LayoutTab[], folderId: string): number {
	const header = folderHeaderIndex(tabs, folderId);
	return header < 0 ? -1 : unitRange(tabs, header).end + 1;
}

// ── Helpers on a caller-owned array ─────────────────────────────────────────

/** Take the unit at `index` out of `tabs`: a lone tab, or a folder with its members. */
export function extractUnit<T extends LayoutTab>(
	tabs: T[],
	index: number,
): { group: T[]; originalIndex: number } {
	const range = isFolderTab(tabs[index]) ? unitRange(tabs, index) : { start: index, end: index };
	return {
		group: tabs.splice(range.start, range.end - range.start + 1),
		originalIndex: range.start,
	};
}

/**
 * Place a top-level group next to `anchorKey`, reporting whether the anchor existed.
 * Anchoring to a folder member means anchoring to the whole folder: a top-level unit can
 * only land between units.
 */
export function tryInsertRelativeToKey<T extends LayoutTab>(
	tabs: T[],
	group: T[],
	anchorKey: string,
	position: "before" | "after",
): boolean {
	const anchorIndex = findKey(tabs, anchorKey);
	if (anchorIndex < 0) return false;
	const range = unitRange(tabs, anchorIndex);
	tabs.splice(position === "before" ? range.start : range.end + 1, 0, ...group);
	return true;
}

/**
 * Move-path insert: falls back to the end of the list when the anchor is gone. The user
 * asked for a position, and the bottom is a worse position but still an answer. An
 * upsert must not do this (a stale anchor would yank a revisited tab to the bottom), so
 * it uses `tryInsertRelativeToKey` and keeps the tab in place instead.
 */
export function insertRelativeToKey<T extends LayoutTab>(
	tabs: T[],
	group: T[],
	anchorKey: string,
	position: "before" | "after",
): void {
	if (!tryInsertRelativeToKey(tabs, group, anchorKey, position)) tabs.push(...group);
}

/**
 * First half of the `above_idle` promotion: a folder member moves to the head of its
 * folder's non-pinned members (pinned members keep their place). Returns the index of the
 * unit that should then move, the folder header for a member.
 */
export function promoteMemberWithinFolder(tabs: LayoutTab[], index: number): number {
	const tab = tabs[index];
	if (!tab.folderId) return index;
	const folderId = tab.folderId;
	if (!tab.pinned) {
		tabs.splice(index, 1);
		tabs.splice(folderUnpinnedStart(tabs, folderId), 0, tab);
	}
	return folderHeaderIndex(tabs, folderId);
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Move one tab, or a whole folder when `key` names a folder.
 *
 * `above_idle` needs live narrator status, which only the server has, so it is a no-op
 * here; the server runs it with `promoteMemberWithinFolder` and its own idle lookup.
 */
export function applyRecentTabMove<T extends LayoutTab>(
	tabs: T[],
	key: string,
	target: RecentTabPlacement,
): T[] {
	if (target.position === "above_idle") return tabs;
	const index = findKey(tabs, key);
	if (index < 0) return tabs;
	const source = tabs[index];
	const next = [...tabs];
	// A folder always moves as a whole unit, and a membership field on it is ignored.
	if (
		!isFolderTab(source) &&
		(target.folderId !== undefined ||
			(source.folderId && folderHeaderIndex(next, source.folderId) >= 0))
	) {
		return dropEmptyFolder(regroupFolders(moveMember(next, index, target)), source.folderId);
	}
	const { group, originalIndex } = extractUnit(next, index);
	if (target.pinned !== undefined && !!group[0].pinned !== target.pinned) {
		// Across the pin divider: the unit's head carries the zone (its members keep their
		// own in-folder pinning).
		const head = { ...group[0] };
		if (target.pinned) head.pinned = true;
		else delete head.pinned;
		group[0] = head;
	}
	if (target.beforeKey) insertRelativeToKey(next, group, target.beforeKey, "before");
	else if (target.afterKey) insertRelativeToKey(next, group, target.afterKey, "after");
	else if (target.position === "top") next.unshift(...group);
	else if (target.toIndex != null) next.splice(Math.min(target.toIndex, next.length), 0, ...group);
	else next.splice(Math.min(originalIndex, next.length), 0, ...group);
	return regroupFolders(next);
}

/**
 * Moves that involve a folder member, or a tab entering or leaving a folder.
 *
 * Crossing the folder boundary clears `pinned`: top-level pinning and in-folder pinning
 * are separate zones, and carrying one into the other would silently pin the tab
 * somewhere the user never pinned it.
 */
function moveMember<T extends LayoutTab>(
	tabs: T[],
	index: number,
	target: RecentTabPlacement,
): T[] {
	const source = tabs[index];
	const targetFolder = target.folderId === undefined ? (source.folderId ?? null) : target.folderId;
	if (targetFolder && (!canJoinFolder(source) || folderHeaderIndex(tabs, targetFolder) < 0)) {
		return tabs;
	}
	const [removed] = tabs.splice(index, 1);
	const moved = { ...removed };
	if ((moved.folderId ?? null) !== targetFolder) delete moved.pinned;
	if (targetFolder) moved.folderId = targetFolder;
	else delete moved.folderId;
	// Out of a folder into the top level's pinned block (a drag aimed above the divider).
	if (!targetFolder && target.pinned) moved.pinned = true;

	if (!targetFolder) {
		if (target.beforeKey) insertRelativeToKey(tabs, [moved], target.beforeKey, "before");
		else if (target.afterKey) insertRelativeToKey(tabs, [moved], target.afterKey, "after");
		else if (target.position === "top") tabs.unshift(moved);
		else tabs.splice(getPinnedSectionEndIndex(tabs), 0, moved);
		return tabs;
	}

	if (target.position === "top") {
		// "Move to top" inside a folder: first slot of the member's zone.
		const header = folderHeaderIndex(tabs, targetFolder);
		tabs.splice(moved.pinned ? header + 1 : folderUnpinnedStart(tabs, targetFolder), 0, moved);
		return tabs;
	}
	const anchorKey = target.beforeKey ?? target.afterKey;
	const anchorIndex = anchorKey ? findKey(tabs, anchorKey) : -1;
	const anchor = anchorIndex >= 0 ? tabs[anchorIndex] : undefined;
	if (anchor?.folderId === targetFolder) {
		// The pinned/unpinned split is kept by `regroupFolders`; a drop across it adopts the
		// anchor's zone so the row lands where it was aimed.
		if (anchor.pinned) moved.pinned = true;
		else delete moved.pinned;
		tabs.splice(target.beforeKey ? anchorIndex : anchorIndex + 1, 0, moved);
	} else if (anchor && isFolderTab(anchor) && anchor.id === targetFolder) {
		// Anchored to the folder header itself: the first non-pinned slot.
		tabs.splice(folderUnpinnedStart(tabs, targetFolder), 0, moved);
	} else {
		tabs.splice(folderEnd(tabs, targetFolder), 0, moved);
	}
	return tabs;
}

/**
 * Pin or unpin a tab. A top-level tab or folder pins to the top of the list; a folder
 * member pins to the top of its folder. Pinning appends to the pinned zone; unpinning
 * lands first among the rest.
 */
export function applyRecentTabPin<T extends LayoutTab>(
	tabs: T[],
	key: string,
	pinned: boolean,
): T[] {
	const index = findKey(tabs, key);
	if (index < 0) return tabs;
	const current = tabs[index];
	if (!!current.pinned === pinned) return tabs;
	const next = [...tabs];
	const updated = { ...current };
	if (pinned) updated.pinned = true;
	else delete updated.pinned;
	if (current.folderId && folderHeaderIndex(next, current.folderId) >= 0) {
		next.splice(index, 1);
		next.splice(folderUnpinnedStart(next, current.folderId), 0, updated);
		return regroupFolders(next);
	}
	const { group } = extractUnit(next, index);
	group[0] = updated;
	next.splice(getPinnedSectionEndIndex(next), 0, ...group);
	return regroupFolders(next);
}

/** Remove a folder but keep its members, in order and unpinned, at the folder's position. */
export function applyRecentTabFolderDissolve<T extends LayoutTab>(
	tabs: T[],
	folderId: string,
): T[] {
	const index = folderHeaderIndex(tabs, folderId);
	if (index < 0) return tabs;
	const range = unitRange(tabs, index);
	const next = [...tabs];
	const members = next.slice(range.start + 1, range.end + 1).map((member) => {
		const released = { ...member };
		delete released.folderId;
		delete released.pinned;
		return released;
	});
	next.splice(range.start, range.end - range.start + 1, ...members);
	return next;
}

/** Remove a tab; a folder takes its members with it, and a folder left empty goes too. */
export function applyRecentTabRemove<T extends LayoutTab>(tabs: T[], key: string): T[] {
	const index = findKey(tabs, key);
	if (index < 0) return tabs;
	const removed = tabs[index];
	if (!isFolderTab(removed)) {
		return dropEmptyFolder(
			tabs.filter((_, candidate) => candidate !== index),
			removed.folderId,
		);
	}
	return tabs.filter((tab) => tab !== removed && tab.folderId !== removed.id);
}

/** Remove `folderId`'s header if no member is left. */
export function dropEmptyFolder<T extends LayoutTab>(tabs: T[], folderId: string | undefined): T[] {
	if (!folderId || tabs.some((tab) => tab.folderId === folderId)) return tabs;
	return tabs.filter((tab) => !(isFolderTab(tab) && tab.id === folderId));
}

/**
 * Create a folder by dropping `sourceKey` onto `targetKey`, a top-level session tab.
 *
 * The folder takes the target's slot and pinned state, so the list does not visibly
 * jump; its members are [target, source], both unpinned. The source may come out of
 * another folder. Returns null when the drop cannot make a folder.
 */
export function applyRecentTabFolderCreate<T extends LayoutTab>(
	tabs: T[],
	targetKey: string,
	sourceKey: string,
	folder: T,
): T[] | null {
	if (targetKey === sourceKey) return null;
	const target = tabs.find((tab) => recentTabKey(tab) === targetKey);
	const source = tabs.find((tab) => recentTabKey(tab) === sourceKey);
	if (!target || !source || target.folderId) return null;
	if (!canJoinFolder(target) || !canJoinFolder(source)) return null;
	const remaining = tabs.filter((tab) => tab !== source);
	const header = { ...folder };
	if (target.pinned) header.pinned = true;
	else delete header.pinned;
	const member = (tab: T): T => {
		const next = { ...tab, folderId: folder.id };
		delete next.pinned;
		return next;
	};
	remaining.splice(remaining.indexOf(target), 1, header, member(target), member(source));
	return dropEmptyFolder(remaining, source.folderId);
}
