import { and, count as countFn, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { narrators, projectTeams, terminals, users } from "../db/schema";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { broadcastToUser, getNarratorPresenceBatch } from "../websocket/narrator-ws";
import { judgeNarratorAccessBatch, type NarratorAclRow } from "./narrator-acl";
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
					// 系统内部叙述者（ModelTrace 舱）不留在最近标签里：按钮按 id 打开，
					// 但侧栏不该因此多出一条。
					hiddenFromLists: narrators.hiddenFromLists,
					// The ACL columns, for marking team onlooker tabs below (M1).
					ownerUserId: narrators.ownerUserId,
					visibility: narrators.visibility,
					writeAudience: narrators.writeAudience,
					type: narrators.type,
					aclRootNarratorId: narrators.aclRootNarratorId,
					contextProjectId: narrators.contextProjectId,
				})
				.from(narrators)
				.where(inArray(narrators.id, narratorIds)),
			getNarratorIdsWithDraft(userId, narratorIds),
		]);
		const hiddenIds = new Set(rows.filter((r) => r.hiddenFromLists).map((r) => r.id));
		const narratorMap = new Map(rows.filter((r) => !r.hiddenFromLists).map((r) => [r.id, r]));
		for (let i = tabs.length - 1; i >= 0; i--) {
			const nId = getTabNarratorId(tabs[i] ?? {});
			if (nId && hiddenIds.has(nId)) tabs.splice(i, 1);
		}
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

		// Active background task counts (subagents + bash + transfers). Lazy import
		// matches the narrators route: the service pulls in half the agent runtime.
		try {
			const { backgroundTaskService } = await import("./background-task-service");
			const bgTaskCountMap = await backgroundTaskService.countActiveKindsByParentBatch(narratorIds);
			for (const tab of tabs) {
				const nId = getTabNarratorId(tab);
				if (nId) {
					const counts = bgTaskCountMap.get(nId);
					tab.activeBackgroundTaskCount = counts?.activeCount ?? 0;
					tab.activeBackgroundWorkCount = counts?.activeWorkCount ?? 0;
					tab.activeBackgroundServiceCount = counts?.activeServiceCount ?? 0;
				}
			}
		} catch (err) {
			// Keep existing counts (or omit unknown ones), without losing basic tab data.
			logger.warn("Failed to load background counts for recent tabs", {
				count: narratorIds.length,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// Team trees (M1): a tab of a team session the user may only read is marked, so the
		// client does not alert them that it waits for a person — only members can act on it.
		try {
			await markTeamOnlookerTabs(tabs, [...narratorMap.values()], userId);
		} catch (err) {
			logger.warn("Failed to mark team onlooker tabs", { error: String(err) });
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

	return tabs;
}

/**
 * Set `teamSession` on the tabs of team sessions (a coordinator, or a subagent whose ACL root is
 * one) and `teamOnlooker` on those the user cannot write to; clear both elsewhere. Reuses the narrator rows `enrichTabs`
 * already loaded; then one `IN` read of `project_teams`, one of the user's role, and one batch
 * judgement per team among the tabs (`judgeNarratorAccessBatch`).
 */
async function markTeamOnlookerTabs(
	tabs: Record<string, unknown>[],
	rows: NarratorAclRow[],
	userId: string,
): Promise<void> {
	for (const tab of tabs) {
		delete tab.teamOnlooker;
		delete tab.teamSession;
	}
	const teamOf = (row: NarratorAclRow) =>
		row.type === "subagent" ? row.aclRootNarratorId : row.id;
	const candidates = [...new Set(rows.map(teamOf).filter((id): id is string => !!id))];
	if (candidates.length === 0) return;
	const teams = new Set(
		(
			await db
				.select({ id: projectTeams.narratorId })
				.from(projectTeams)
				.where(inArray(projectTeams.narratorId, candidates))
		).map((row) => row.id),
	);
	if (teams.size === 0) return;
	const user = await db
		.select({ role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)
		.get();
	const principal = { userId, isAdmin: user?.role === "admin" };
	const writable = new Map<string, boolean>();
	for (const row of rows) {
		const teamId = teamOf(row);
		if (!teamId || !teams.has(teamId)) continue;
		for (const tab of tabs) if (getTabNarratorId(tab) === row.id) tab.teamSession = true;
		// A subagent's access is its root's: one judgement per team.
		let canWrite = writable.get(teamId);
		if (canWrite === undefined) {
			canWrite = (await judgeNarratorAccessBatch(row, [principal])).get(userId)?.write === true;
			writable.set(teamId, canWrite);
		}
		if (canWrite) continue;
		for (const tab of tabs) if (getTabNarratorId(tab) === row.id) tab.teamOnlooker = true;
	}
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
