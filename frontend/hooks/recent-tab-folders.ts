/**
 * Client-only folder helpers: how the sidebar groups the flat list into rows and
 * summarises hidden members. The layout rules themselves (regroup, move, pin, dissolve,
 * remove, create) live in `shared/recent-tab-layout.ts`, shared with the server.
 */

import { isFolderTab } from "@shared/recent-tab-layout";
import type { RecentTab } from "./recent-tabs-utils";

/** How a sidebar folder is shown: header only, header + first N members, or everything. */
export type FolderDisplay = "collapsed" | "preview" | "expanded";

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
