import { and, count as countFn, eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import { containerInstances, narrators, terminals, userPreferences } from "../db/schema";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
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

/** Enrich raw tabs with live runtime data (narrator status, terminals, presence, containers). */
export async function enrichTabs(
	tabs: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	if (tabs.length === 0) return tabs;

	migrateTabTypes(tabs);

	const narratorIds = tabs
		.filter((t) => t.type !== "project")
		.map((t) => (t.type === "narrator" ? (t.id as string) : (t.narratorId as string)))
		.filter(Boolean);

	if (narratorIds.length > 0) {
		// Narrator status
		const rows = await db
			.select({ id: narrators.id, status: narrators.status })
			.from(narrators)
			.where(inArray(narrators.id, narratorIds));
		const statusMap = new Map(rows.map((r) => [r.id, r.status]));
		for (const tab of tabs) {
			const nId = tab.type === "narrator" ? (tab.id as string) : (tab.narratorId as string);
			if (nId && statusMap.has(nId)) {
				tab.status = statusMap.get(nId);
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
			const nId = tab.type === "narrator" ? (tab.id as string) : (tab.narratorId as string);
			if (nId && termCountMap.has(nId)) {
				tab.activeTerminalCount = termCountMap.get(nId);
			}
		}

		// Presence (from in-memory map)
		const presenceMap = getNarratorPresenceBatch(narratorIds);
		for (const tab of tabs) {
			const nId = tab.type === "narrator" ? (tab.id as string) : (tab.narratorId as string);
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
