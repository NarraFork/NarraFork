import type { Database } from "bun:sqlite";
import { TEAM_WORK_ITEM_FINISHED_STATES } from "@shared/project-teams";
import { DbReadError } from "../lib/db-worker/errors";
import { parseTraits, TEAM_TRAIT } from "../lib/narrator-utils";

export type DatabaseCleanupContextInput = Record<string, never>;
export interface DatabaseCleanupContextResult {
	narrators: Record<string, unknown>[];
	runningTerminalIds: string[];
	liveTeamIds: string[];
}

/** Read only metadata; payload statistics continue through the storage-scan worker. */
export function readDatabaseCleanupContext(
	database: Database,
	_input: DatabaseCleanupContextInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): DatabaseCleanupContextResult {
	const check = () => {
		if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Cleanup read cancelled");
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "Cleanup read deadline expired");
	};
	return database.transaction(() => {
		const narrators: Record<string, unknown>[] = [];
		const narratorPage = database.prepare(`SELECT id, parent_narrator_id AS parentNarratorId,
			type, variant, traits, title, status, COALESCE(message_count, 0) AS messageCount,
			created_at AS createdAt, updated_at AS updatedAt, last_message_at AS lastMessageAt,
			COALESCE(is_background, 0) AS isBackground, background_status AS backgroundStatus
			FROM narrators WHERE id > ? ORDER BY id LIMIT 256`);
		const terminalPage = database.prepare(`SELECT DISTINCT narrator_id AS narratorId
			FROM terminals WHERE status = 'running' AND narrator_id IS NOT NULL AND narrator_id > ?
			ORDER BY narrator_id LIMIT 256`);
		try {
			let after = "";
			while (true) {
				check();
				const page = narratorPage.all(after) as Record<string, unknown>[];
				narrators.push(...page);
				if (page.length < 256) break;
				after = String(page[page.length - 1].id);
			}
			const runningTerminalIds: string[] = [];
			after = "";
			while (true) {
				check();
				const page = terminalPage.all(after) as { narratorId: string }[];
				runningTerminalIds.push(...page.map((row) => row.narratorId));
				if (page.length < 256) break;
				after = page[page.length - 1].narratorId;
			}
			const coordinatorIds = narrators
				.filter((row) => parseTraits(row.traits).includes(TEAM_TRAIT))
				.map((row) => String(row.id));
			const liveTeamIds: string[] = [];
			// Same primary-key probes and EXISTS semantics as team-records, inside this snapshot.
			for (let start = 0; start < coordinatorIds.length; start += 500) {
				check();
				const batch = coordinatorIds.slice(start, start + 500);
				const liveTeams = database.prepare(`SELECT narrator_id AS teamId FROM project_teams
					WHERE narrator_id IN (${batch.map(() => "?").join(",")}) AND EXISTS (
						SELECT 1 FROM team_work_items WHERE team_id = project_teams.narrator_id
						AND (state NOT IN (${TEAM_WORK_ITEM_FINISHED_STATES.map(() => "?").join(",")})
							OR worktree_resource_id IS NOT NULL))`);
				try {
					const rows = liveTeams.all(...batch, ...TEAM_WORK_ITEM_FINISHED_STATES) as {
						teamId: string;
					}[];
					liveTeamIds.push(...rows.map((row) => row.teamId));
				} finally {
					liveTeams.finalize();
				}
			}
			check();
			return { narrators, runningTerminalIds, liveTeamIds };
		} finally {
			narratorPage.finalize();
			terminalPage.finalize();
		}
	})();
}
