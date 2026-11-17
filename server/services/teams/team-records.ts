/**
 * The team rows a coordinator narrator's deletion has to deal with.
 *
 * Kept apart from `team-service.ts` so `narrator-service.ts` can call it without importing the
 * team service (which imports the narrator service): only `db` and the schema here.
 *
 * Rule (docs/PROJECT_TEAMS-PLAN.md §二.1): a coordinator whose team still has live work cannot
 * be deleted — the work items are the only record of the worktrees and branches they made, and
 * cleanup deletes only what a record names. "Live" is any item not finished yet, or finished but
 * still holding a recorded worktree (it has to be cleaned or handed out first).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { TEAM_WORK_ITEM_FINISHED_STATES } from "@shared/project-teams";
import { and, eq, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import { db } from "../../db";
import { projectTeams, teamWorkItems } from "../../db/schema";
import { AppError } from "../../lib/errors";

type Executor = Pick<typeof db, "select" | "delete">;

/**
 * Who is changing a coordinator's status right now, for the team's archive/unarchive event.
 * `narrator:status_changed` carries no actor, and its listener runs synchronously inside the
 * call that changed the status, so the person is handed over through the async context: the
 * team routes wrap their narrator calls, and the narrator HTTP routes wrap every request in
 * their caller. Outside any such context (Agent control, recovery jobs) the change is the
 * system's. A run started by a request inherits its person, which matches how a run acts for
 * the person who started it.
 */
const teamStatusActor = new AsyncLocalStorage<string>();

export function runAsTeamStatusActor<T>(userId: string | null | undefined, fn: () => T): T {
	return userId ? teamStatusActor.run(userId, fn) : fn();
}

export function currentTeamStatusActor(): string | null {
	return teamStatusActor.getStore() ?? null;
}

const liveItem = () =>
	or(
		notInArray(teamWorkItems.state, [...TEAM_WORK_ITEM_FINISHED_STATES]),
		isNotNull(teamWorkItems.worktreeResourceId),
	);

/**
 * The coordinators whose teams have live work, i.e. those `narratorService.remove` refuses.
 * Database cleanup keeps them (reported as blocked) instead of aborting on the refusal. One
 * DISTINCT over the work items (team id leads its index); optionally narrowed to some narrators.
 */
export function listTeamsWithLiveWork(narratorIds?: string[]): Set<string> {
	if (narratorIds && narratorIds.length === 0) return new Set();
	const rows = db
		.selectDistinct({ teamId: teamWorkItems.teamId })
		.from(teamWorkItems)
		.where(and(liveItem(), narratorIds ? inArray(teamWorkItems.teamId, narratorIds) : undefined))
		.all();
	return new Set(rows.map((row) => row.teamId));
}

function liveWorkItemOf(executor: Executor, teamId: string): { id: string } | undefined {
	return executor
		.select({ id: teamWorkItems.id })
		.from(teamWorkItems)
		.where(and(eq(teamWorkItems.teamId, teamId), liveItem()))
		.limit(1)
		.get();
}

export function teamHasLiveWorkError(teamId: string): AppError {
	return new AppError(
		"This session is a team coordinator with live work items. Clean up or hand out the team's work items before deleting it.",
		409,
		"TEAM_HAS_LIVE_WORK",
		undefined,
		{ teamId },
	);
}

/** Throw unless the narrator is no coordinator, or its team has no live work. */
export function assertTeamRemovable(narratorId: string, executor: Executor = db): void {
	const team = executor
		.select({ id: projectTeams.narratorId })
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, narratorId))
		.limit(1)
		.get();
	if (team && liveWorkItemOf(executor, narratorId)) throw teamHasLiveWorkError(narratorId);
}

/**
 * Inside the narrator's deletion transaction: re-check, then delete the team row (its finished
 * work items and events cascade). Synchronous so the check and the delete see the same rows.
 */
export function deleteTeamOfNarratorInTransaction(tx: Executor, narratorId: string): void {
	assertTeamRemovable(narratorId, tx);
	tx.delete(projectTeams).where(eq(projectTeams.narratorId, narratorId)).run();
}

/**
 * Whether a project still has teams. Project deletion refuses while it does: the team rows
 * restrict the project delete, and they are the record of the team's worktrees.
 */
export function projectHasTeams(projectId: string, executor: Executor = db): boolean {
	return Boolean(
		executor
			.select({ id: projectTeams.narratorId })
			.from(projectTeams)
			.where(eq(projectTeams.projectId, projectId))
			.limit(1)
			.get(),
	);
}
