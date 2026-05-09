import { and, count as countFn, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { containerInstances, narrators, terminals, userPreferences } from "../db/schema";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { parseDraftTrait } from "../lib/narrator-utils";
import { broadcastToUser, getNarratorPresenceBatch } from "../websocket/narrator-ws";

// ── Tab helpers ────────────────────────────────────────────────────────────

/** Migrate legacy tab types (e.g. "session" → "narrator"). */
export function migrateTabTypes(tabs: Record<string, unknown>[]): void {
	for (const t of tabs) {
		// biome-ignore lint/suspicious/noExplicitAny: legacy data migration
		if ((t as any).type === "session") {
			// biome-ignore lint/suspicious/noExplicitAny: legacy data migration
			(t as any).type = "narrator";
		}
	}
}

/** Resolve the narrator ID represented by a recent-tab entry. */
export function getTabNarratorId(tab: Record<string, unknown>): string | undefined {
	if (tab.type === "narrator" || tab.type === "subagent") {
		return typeof tab.id === "string" ? tab.id : undefined;
	}
	if (tab.type === "chapter") {
		return typeof tab.narratorId === "string" ? tab.narratorId : undefined;
	}
	return undefined;
}

function tabRepresentsNarrator(tab: Record<string, unknown>, narratorId: string): boolean {
	return getTabNarratorId(tab) === narratorId;
}

function tabKey(tab: Record<string, unknown>): string {
	return `${String(tab.type)}:${String(tab.id)}`;
}

/**
 * Enforce workspace grouping invariant: workspace header is immediately followed
 * by all its children. Operates in-place.
 */
function regroupWorkspaces(tabs: Record<string, unknown>[]): void {
	const childrenByWs = new Map<string, Record<string, unknown>[]>();
	for (const tab of tabs) {
		const wsId = typeof tab.workspaceId === "string" ? tab.workspaceId : undefined;
		if (!wsId) continue;
		const arr = childrenByWs.get(wsId);
		if (arr) arr.push(tab);
		else childrenByWs.set(wsId, [tab]);
	}
	if (childrenByWs.size === 0) return;

	let i = 0;
	while (i < tabs.length) {
		if (tabs[i].workspaceId) tabs.splice(i, 1);
		else i++;
	}

	const headerIds = new Set<string>();
	for (let j = 0; j < tabs.length; j++) {
		if (tabs[j].type !== "workspace") continue;
		const wsId = tabs[j].id as string;
		headerIds.add(wsId);
		const children = childrenByWs.get(wsId);
		if (!children?.length) continue;
		tabs.splice(j + 1, 0, ...children);
		j += children.length;
	}

	for (const [wsId, children] of childrenByWs) {
		if (headerIds.has(wsId)) continue;
		for (const child of children) delete child.workspaceId;
		tabs.push(...children);
	}
}

function getPinnedSectionEndIndex(tabs: Record<string, unknown>[]): number {
	let idx = 0;
	while (idx < tabs.length) {
		const tab = tabs[idx];
		if (tab.workspaceId) {
			idx++;
			continue;
		}
		if (!tab.pinned) break;
		idx++;
		if (tab.type === "workspace") {
			while (idx < tabs.length && tabs[idx]?.workspaceId === tab.id) idx++;
		}
	}
	return idx;
}

function promoteTopLevelTabRespectingPins(tabs: Record<string, unknown>[], idx: number): boolean {
	const tab = tabs[idx];
	if (!tab || tab.workspaceId || tab.pinned) return false;
	const before = tabs.map(tabKey).join("|");
	let movedGroup: Record<string, unknown>[];
	if (tab.type === "workspace") {
		let end = idx + 1;
		while (end < tabs.length && tabs[end]?.workspaceId === tab.id) end++;
		movedGroup = tabs.splice(idx, end - idx);
	} else {
		movedGroup = tabs.splice(idx, 1);
	}
	tabs.splice(getPinnedSectionEndIndex(tabs), 0, ...movedGroup);
	return tabs.map(tabKey).join("|") !== before;
}

function promoteDraftTab(tabs: Record<string, unknown>[], narratorId: string): boolean {
	const idx = tabs.findIndex((tab) => tabRepresentsNarrator(tab, narratorId));
	if (idx < 0) return false;
	const tab = tabs[idx];
	if (typeof tab.workspaceId === "string") {
		const headerIdx = tabs.findIndex(
			(candidate) => candidate.type === "workspace" && candidate.id === tab.workspaceId,
		);
		if (headerIdx >= 0) return promoteTopLevelTabRespectingPins(tabs, headerIdx);
	}
	return promoteTopLevelTabRespectingPins(tabs, idx);
}

/** Enrich raw tabs with live runtime data (narrator status, terminals, presence, containers). */
export async function enrichTabs(
	tabs: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	if (tabs.length === 0) return tabs;

	migrateTabTypes(tabs);

	const narratorIds = tabs.map(getTabNarratorId).filter((id): id is string => !!id);

	if (narratorIds.length > 0) {
		// Narrator status + draft marker
		const rows = await db
			.select({ id: narrators.id, status: narrators.status, traits: narrators.traits })
			.from(narrators)
			.where(inArray(narrators.id, narratorIds));
		const narratorMap = new Map(rows.map((r) => [r.id, r]));
		for (const tab of tabs) {
			const nId = getTabNarratorId(tab);
			const row = nId ? narratorMap.get(nId) : undefined;
			if (row) {
				tab.status = row.status;
				if (parseDraftTrait(row.traits)) tab.hasDraft = true;
				else delete tab.hasDraft;
			} else {
				delete tab.hasDraft;
			}
		}

		// Active terminal counts
		const termRows = await db
			.select({
				narratorId: terminals.narratorId,
				count: countFn(),
			})
			.from(terminals)
			.where(and(inArray(terminals.narratorId, narratorIds), eq(terminals.status, "running")))
			.groupBy(terminals.narratorId);
		const termCountMap = new Map(termRows.map((r) => [r.narratorId, r.count]));
		for (const tab of tabs) {
			const nId = getTabNarratorId(tab);
			if (nId && termCountMap.has(nId)) {
				tab.activeTerminalCount = termCountMap.get(nId);
			}
		}

		// Presence (from in-memory map)
		const presenceMap = getNarratorPresenceBatch(narratorIds);
		for (const tab of tabs) {
			const nId = getTabNarratorId(tab);
			if (nId) {
				const viewers = presenceMap.get(nId);
				if (viewers && viewers.length > 0) {
					tab.viewers = viewers;
				}
			}
		}
	}

	// Container status for chapter tabs
	const chapterIds = tabs.filter((t) => t.type === "chapter").map((t) => t.id as string);
	if (chapterIds.length > 0) {
		const containerRows = await db
			.select({
				chapterId: containerInstances.chapterId,
				status: containerInstances.status,
			})
			.from(containerInstances)
			.where(inArray(containerInstances.chapterId, chapterIds));

		const containerStatusMap = new Map<string, string>();
		for (const row of containerRows) {
			const existing = containerStatusMap.get(row.chapterId);
			if (
				!existing ||
				(CONTAINER_STATUS_PRIORITY[row.status] ?? 0) > (CONTAINER_STATUS_PRIORITY[existing] ?? 0)
			) {
				containerStatusMap.set(row.chapterId, row.status);
			}
		}
		for (const tab of tabs) {
			if (tab.type === "chapter" && containerStatusMap.has(tab.id as string)) {
				tab.containerStatus = containerStatusMap.get(tab.id as string);
			}
		}
	}

	return tabs;
}

/** Enrich tabs and broadcast a snapshot to all of the user's WS connections. */
export async function broadcastTabsSnapshot(
	userId: string,
	tabs: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	const enriched = await enrichTabs(tabs);
	broadcastToUser(userId, {
		type: "user:recent_tabs_snapshot",
		tabs: enriched,
		revision: Date.now(),
	});
	return enriched;
}

/**
 * Refresh every user's recent-tabs snapshot for a narrator draft state change.
 * When a draft first appears, promote the affected top-level tab (or workspace
 * header) to the top of the unpinned section. Repeated non-empty draft updates
 * intentionally do not reorder the list, avoiding sidebar jitter while typing.
 */
export async function syncNarratorDraftToRecentTabs(
	narratorId: string,
	opts: { promote: boolean },
): Promise<void> {
	const rows = db
		.select({ userId: userPreferences.userId, recentTabs: userPreferences.recentTabs })
		.from(userPreferences)
		.all();
	const now = new Date().toISOString();

	for (const row of rows) {
		let tabs: Record<string, unknown>[];
		try {
			tabs = JSON.parse(row.recentTabs);
		} catch {
			continue;
		}
		if (!Array.isArray(tabs)) continue;
		migrateTabTypes(tabs);
		if (!tabs.some((tab) => tabRepresentsNarrator(tab, narratorId))) continue;

		let changed = false;
		if (opts.promote) {
			const before = JSON.stringify(tabs);
			promoteDraftTab(tabs, narratorId);
			regroupWorkspaces(tabs);
			changed = JSON.stringify(tabs) !== before;
		}
		if (changed) {
			sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
				JSON.stringify(tabs),
				now,
				row.userId,
			]);
		}
		await broadcastTabsSnapshot(row.userId, tabs);
	}
}

// ── Tab removal ────────────────────────────────────────────────────────────

/**
 * Remove a tab (chapter, narrator, or project) from every user's recent_tabs and broadcast updated snapshots.
 * Called when the corresponding entity is deleted so ghost tabs don't linger.
 */
export async function removeTabFromAllUsers(
	tabType: "chapter" | "narrator" | "project",
	tabId: string,
): Promise<void> {
	const rows = db
		.select({ userId: userPreferences.userId, recentTabs: userPreferences.recentTabs })
		.from(userPreferences)
		.all();

	const now = new Date().toISOString();

	for (const row of rows) {
		let tabs: Record<string, unknown>[];
		try {
			tabs = JSON.parse(row.recentTabs);
		} catch {
			continue;
		}
		if (!Array.isArray(tabs)) continue;

		const filtered = tabs.filter(
			(t: Record<string, unknown>) => !(t.type === tabType && t.id === tabId),
		);
		if (filtered.length === tabs.length) continue; // nothing removed

		sqlite.run(`UPDATE user_preferences SET recent_tabs = ?, updated_at = ? WHERE user_id = ?`, [
			JSON.stringify(filtered),
			now,
			row.userId,
		]);
		broadcastTabsSnapshot(row.userId, filtered);
	}
}
