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
import { and, eq, exists, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { projectTeams, teamWorkItems } from "../../db/schema";
import { AppError } from "../../lib/errors";

type Executor = Pick<typeof db, "select" | "delete">;

/** Who changed a coordinator's status: a person (user id) or an agent (its narrator id). */
export type TeamStatusActor = { kind: "person" | "agent"; id: string };

interface ActorFrame {
	actor: TeamStatusActor;
	/** Cleared when the wrapped call settles: later work started inside it sees no actor. */
	open: boolean;
}

/**
 * Who is changing a coordinator's status right now, for the team's archive/unarchive event.
 * `narrator:status_changed` carries no actor, and its listener runs synchronously inside the
 * call that changed the status, so the actor is handed over through the async context — only
 * around the status-changing calls themselves (team routes, the narrator archive / unarchive /
 * auto-unarchive sites, Agent control), never around a whole request.
 *
 * The frame is closed as soon as the wrapped call settles. Anything the call scheduled that
 * runs later (a timer, a run, a wake-up, a later turn) still sees the frame through the async
 * context, but closed, so it reads as "no actor" and is recorded as the system's instead of
 * being attributed to whoever happened to trigger the earlier call.
 */
const teamStatusActor = new AsyncLocalStorage<ActorFrame>();

export async function runAsTeamStatusActor<T>(
	actor: TeamStatusActor | null | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	if (!actor?.id) return fn();
	const frame: ActorFrame = { actor, open: true };
	try {
		return await teamStatusActor.run(frame, fn);
	} finally {
		frame.open = false;
	}
}

/** The person behind a request, or no actor for a request without one. */
export function personActor(userId: string | null | undefined): TeamStatusActor | null {
	return userId ? { kind: "person", id: userId } : null;
}

export function currentTeamStatusActor(): TeamStatusActor | null {
	const frame = teamStatusActor.getStore();
	return frame?.open ? frame.actor : null;
}

const liveItem = () =>
	or(
		notInArray(teamWorkItems.state, [...TEAM_WORK_ITEM_FINISHED_STATES]),
		isNotNull(teamWorkItems.worktreeResourceId),
	);

const LIVE_TEAM_BATCH = 500;

/**
 * Which of these coordinator candidates have teams with live work, i.e. the ones
 * `narratorService.remove` refuses. Database cleanup keeps them (reported as blocked) instead of
 * aborting on the refusal. Looked up per candidate id in batches of 500: each statement is a
 * primary-key probe per id plus an EXISTS that stops at the first live item, so the work and
 * the result are bounded by the batch whatever `team_work_items` holds.
 */
export function listTeamsWithLiveWork(candidateIds: readonly string[]): Set<string> {
	const live = new Set<string>();
	const unique = [...new Set(candidateIds)];
	for (let start = 0; start < unique.length; start += LIVE_TEAM_BATCH) {
		const batch = unique.slice(start, start + LIVE_TEAM_BATCH);
		const rows = db
			.select({ id: projectTeams.narratorId })
			.from(projectTeams)
			.where(
				and(
					inArray(projectTeams.narratorId, batch),
					exists(
						db
							.select({ one: sql`1` })
							.from(teamWorkItems)
							.where(and(eq(teamWorkItems.teamId, projectTeams.narratorId), liveItem())),
					),
				),
			)
			.all();
		for (const row of rows) live.add(row.id);
	}
	return live;
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
