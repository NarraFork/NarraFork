/**
 * The sidebar's drag model: which rows exist, what each one is, and what a drop does.
 *
 * Built once per source update (never per pointer frame). Rendering, hit testing and the
 * persisted mutation all read the same model, so what the user sees highlighted is what
 * the server is asked to do.
 */

import {
	applyRecentTabMove,
	canJoinFolder,
	dropEmptyFolder,
	type FolderDisplay,
	groupRecentTabRows,
	isFolderTab,
	type RecentTabRow,
	recentTabKey,
	regroupFolders,
} from "../../hooks/recent-tab-folders";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import type { RecentTabMoveTarget } from "../../lib/api/settings";
import type {
	RecentTabDropRow,
	RecentTabDropSource,
	RecentTabDropTarget,
} from "./recent-tab-drop-target";

export type { FolderDisplay } from "../../hooks/recent-tab-folders";

export interface FolderView {
	display: FolderDisplay;
	/** Members rendered under the header (pinned first, then the preview window). */
	visible: RecentTab[];
	/** Members hidden by the preview limit. */
	hidden: RecentTab[];
}

export interface RecentTabDragEntry {
	key: string;
	kind: "tab" | "folder" | "member";
	pinned: boolean;
	memberPinned?: boolean;
	folderId?: string;
	tab: RecentTab;
}

export interface RecentTabDragModel {
	tabs: RecentTab[];
	rows: RecentTabRow[];
	pinnedRows: RecentTabRow[];
	unpinnedRows: RecentTabRow[];
	folderViews: Map<string, FolderView>;
	/** Every RENDERED row by key (hidden folder members are absent). */
	entries: Map<string, RecentTabDragEntry>;
}

export interface FolderViewOptions {
	/** Explicit per-folder display chosen by the user (absent = default). */
	displayOf: (folderId: string) => FolderDisplay | undefined;
	/** Preview count when the folder has none of its own. */
	defaultPreview: number;
	/** A member that must stay visible even when the preview would hide it (the open page). */
	isForcedVisible?: (tab: RecentTab) => boolean;
	/** Overrides the stored preview count (a strip being dragged previews its new count). */
	previewCountOf?: (folderId: string) => number | undefined;
}

export function folderView(
	folder: RecentTab,
	members: RecentTab[],
	options: FolderViewOptions,
): FolderView {
	const display = options.displayOf(folder.id) ?? "preview";
	if (display === "collapsed") return { display, visible: [], hidden: members };
	if (display === "expanded") return { display, visible: members, hidden: [] };
	const count = Math.max(
		0,
		options.previewCountOf?.(folder.id) ?? folder.folderPreviewCount ?? options.defaultPreview,
	);
	const visible: RecentTab[] = [];
	const hidden: RecentTab[] = [];
	members.forEach((member, index) => {
		if (index < count || options.isForcedVisible?.(member)) visible.push(member);
		else hidden.push(member);
	});
	return { display, visible, hidden };
}

export function createRecentTabDragModel(
	tabs: RecentTab[],
	options: FolderViewOptions,
): RecentTabDragModel {
	const rows = groupRecentTabRows(tabs);
	const folderViews = new Map<string, FolderView>();
	const entries = new Map<string, RecentTabDragEntry>();
	for (const row of rows) {
		const pinned = !!row.tab.pinned;
		if (row.kind === "tab") {
			entries.set(recentTabKey(row.tab), {
				key: recentTabKey(row.tab),
				kind: "tab",
				pinned,
				tab: row.tab,
			});
			continue;
		}
		const view = folderView(row.tab, row.members, options);
		folderViews.set(row.tab.id, view);
		entries.set(recentTabKey(row.tab), {
			key: recentTabKey(row.tab),
			kind: "folder",
			pinned,
			folderId: row.tab.id,
			tab: row.tab,
		});
		for (const member of view.visible) {
			entries.set(recentTabKey(member), {
				key: recentTabKey(member),
				kind: "member",
				pinned,
				memberPinned: !!member.pinned,
				folderId: row.tab.id,
				tab: member,
			});
		}
	}
	return {
		tabs,
		rows,
		pinnedRows: rows.filter((row) => row.tab.pinned),
		unpinnedRows: rows.filter((row) => !row.tab.pinned),
		folderViews,
		entries,
	};
}

/** Convert a measured element into a hit-test row, or null when it is not a model row. */
export function recentTabDragMeasuredRow(
	model: RecentTabDragModel,
	key: string,
	top: number,
	bottom: number,
): RecentTabDropRow | null {
	const entry = model.entries.get(key);
	if (!entry || bottom <= top) return null;
	return {
		key,
		top,
		bottom,
		kind: entry.kind,
		pinned: entry.pinned,
		...(entry.memberPinned !== undefined ? { memberPinned: entry.memberPinned } : {}),
		...(entry.folderId ? { folderId: entry.folderId } : {}),
		canNest: canJoinFolder(entry.tab),
	};
}

export function recentTabDragSource(
	model: RecentTabDragModel,
	key: string,
): RecentTabDropSource | null {
	const entry = model.entries.get(key);
	if (!entry) return null;
	return {
		key,
		kind: entry.kind,
		pinned: entry.kind === "member" ? false : entry.pinned,
		...(entry.folderId ? { folderId: entry.folderId } : {}),
		canNest: canJoinFolder(entry.tab),
	};
}

/** The server call a drop resolves to, plus the order to show optimistically meanwhile. */
export type RecentTabDragPlan =
	| { kind: "move"; key: string; target: RecentTabMoveTarget; finalTabs: RecentTab[] }
	| { kind: "merge"; targetKey: string; sourceKey: string; finalTabs: RecentTab[] };

/** Id of the stand-in folder shown while a merge is in flight; never sent to the server. */
export const PENDING_FOLDER_ID = "__pending__";

/** Translate a resolved target into a mutation. Null means the drop changes nothing. */
export function planRecentTabDrop(
	model: RecentTabDragModel,
	sourceKey: string,
	target: RecentTabDropTarget,
	newFolderTitle = "",
): RecentTabDragPlan | null {
	const source = model.tabs.find((tab) => recentTabKey(tab) === sourceKey);
	if (!source || target.kind === "empty") return null;
	if (target.kind === "merge") {
		if (target.key === sourceKey) return null;
		const finalTabs = applyRecentTabMerge(model.tabs, target.key, sourceKey, newFolderTitle);
		return finalTabs ? { kind: "merge", targetKey: target.key, sourceKey, finalTabs } : null;
	}

	let moveTarget: RecentTabMoveTarget;
	switch (target.kind) {
		case "into-folder":
			if (source.folderId === target.folderId) return null;
			moveTarget = { folderId: target.folderId };
			break;
		case "member-before":
			moveTarget = { beforeKey: target.key, folderId: target.folderId };
			break;
		case "member-after":
			moveTarget = { afterKey: target.key, folderId: target.folderId };
			break;
		case "before":
			moveTarget = { beforeKey: target.key, ...(isFolderTab(source) ? {} : { folderId: null }) };
			break;
		case "after":
			moveTarget = { afterKey: target.key, ...(isFolderTab(source) ? {} : { folderId: null }) };
			break;
	}
	// Only send `folderId: null` for a tab that actually leaves a folder; a top-level move
	// stays the plain before/after primitive.
	if (moveTarget.folderId === null && !source.folderId) delete moveTarget.folderId;
	const finalTabs = applyRecentTabMove(model.tabs, sourceKey, moveTarget);
	if (finalTabs === model.tabs || sameOrder(finalTabs, model.tabs)) return null;
	return { kind: "move", key: sourceKey, target: moveTarget, finalTabs };
}

/**
 * What the list looks like right after a merge, before the server answers: a stand-in
 * folder at the target's slot holding [target, source]. Mirrors `createRecentTabFolder`.
 * The server's delta replaces the stand-in with the real folder when it lands.
 */
function applyRecentTabMerge(
	tabs: RecentTab[],
	targetKey: string,
	sourceKey: string,
	title: string,
): RecentTab[] | null {
	const target = tabs.find((tab) => recentTabKey(tab) === targetKey);
	const source = tabs.find((tab) => recentTabKey(tab) === sourceKey);
	if (!target || !source || target.folderId) return null;
	const remaining = tabs.filter((tab) => tab !== source);
	const index = remaining.indexOf(target);
	const folder: RecentTab = {
		type: "folder",
		id: PENDING_FOLDER_ID,
		title,
		lastVisitedAt: Date.now(),
		...(target.pinned ? { pinned: true } : {}),
	};
	const member = (tab: RecentTab): RecentTab => ({
		...tab,
		folderId: PENDING_FOLDER_ID,
		pinned: undefined,
	});
	remaining.splice(index, 1, folder, member(target), member(source));
	return dropEmptyFolder(remaining, source.folderId);
}

function sameOrder(left: RecentTab[], right: RecentTab[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(tab, index) =>
				recentTabKey(tab) === recentTabKey(right[index]) &&
				tab.folderId === right[index].folderId &&
				!!tab.pinned === !!right[index].pinned,
		)
	);
}

/**
 * While a submission is in flight, show the optimistic order but keep the latest
 * WS-delivered content (status, title) for each tab.
 */
export function projectRecentTabDragOrder(
	latest: RecentTab[],
	optimistic: RecentTab[] | null,
): RecentTab[] {
	if (!optimistic) return latest;
	const latestByKey = new Map(latest.map((tab) => [recentTabKey(tab), tab]));
	const projected: RecentTab[] = [];
	for (const tab of optimistic) {
		// The stand-in folder of an in-flight merge exists only locally.
		if (isFolderTab(tab) && tab.id === PENDING_FOLDER_ID) {
			projected.push(tab);
			continue;
		}
		const current = latestByKey.get(recentTabKey(tab));
		if (!current) continue;
		latestByKey.delete(recentTabKey(tab));
		projected.push(
			current.folderId === tab.folderId && !!current.pinned === !!tab.pinned
				? current
				: { ...current, folderId: tab.folderId, pinned: tab.pinned },
		);
	}
	// Tabs that appeared mid-flight are appended, then pulled under their folder headers.
	projected.push(...latestByKey.values());
	return regroupFolders(projected);
}
