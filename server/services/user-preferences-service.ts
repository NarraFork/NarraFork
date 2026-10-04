import { and, count as countFn, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { containerInstances, narrators, terminals } from "../db/schema";
import { CONTAINER_STATUS_PRIORITY } from "../lib/constants";
import { parseSubstatus } from "../lib/narrator-utils";
import { broadcastToUser, getNarratorPresenceBatch } from "../websocket/narrator-ws";
import { getNarratorIdsWithDraft } from "./narrator-draft-service";

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

/** Enrich raw tabs with live runtime data (narrator status, terminals, presence, containers). */
export async function enrichTabs(
	tabs: Record<string, unknown>[],
	userId: string,
): Promise<Record<string, unknown>[]> {
	if (tabs.length === 0) return tabs;

	migrateTabTypes(tabs);

	const narratorIds = tabs.map(getTabNarratorId).filter((id): id is string => !!id);

	if (narratorIds.length > 0) {
		// Narrator status + current user's private draft markers
		const [rows, draftNarratorIds] = await Promise.all([
			db
				.select({
					id: narrators.id,
					status: narrators.status,
					substatus: narrators.substatus,
				})
				.from(narrators)
				.where(inArray(narrators.id, narratorIds)),
			getNarratorIdsWithDraft(userId, narratorIds),
		]);
		const narratorMap = new Map(rows.map((r) => [r.id, r]));
		for (const tab of tabs) {
			const nId = getTabNarratorId(tab);
			const row = nId ? narratorMap.get(nId) : undefined;
			if (row) {
				tab.status = row.status;
				tab.substatus = parseSubstatus(row.substatus);
				if (draftNarratorIds.has(row.id)) tab.hasDraft = true;
				else delete tab.hasDraft;
			} else {
				delete tab.substatus;
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
			.where(
				and(
					inArray(containerInstances.chapterId, chapterIds),
					isNull(containerInstances.worktreeResourceId),
				),
			);

		const containerStatusMap = new Map<string, string>();
		for (const row of containerRows) {
			if (row.chapterId === null) continue;
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
	const enriched = await enrichTabs(tabs, userId);
	broadcastToUser(userId, {
		type: "user:recent_tabs_snapshot",
		tabs: enriched,
		revision: Date.now(),
	});
	return enriched;
}

export {
	pruneUnreadableProjectTabs,
	removeTabFromAllUsers,
	syncNarratorDraftToRecentTabs,
	syncNarratorTitleToRecentTabs,
} from "./recent-tabs-service";
