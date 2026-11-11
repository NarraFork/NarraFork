/**
 * Handing a task to a session on the board (outline P2 PR 10a, design §E.1): who it may be handed
 * to (「转交给会话…」), and starting that session on it (「转交并开始」).
 *
 * WHO: root sessions of the task's project that keep their tasks in the outline, are not
 * archived, that the person may read, and that could do the task (`canSessionWorkIn`); named
 * sessions first, then the most recently active, at most
 * {@link OUTLINE_TRANSFER_LIMITS.sessions}. The hand-over itself is the person's commit
 * (`person-tasks.ts`): `@agent:<session id>`, and a task in progress back to to-do in the same
 * commit, so whoever was doing it stops and the new executor claims it afresh (the next claim
 * generation; a result the previous one still hands in is told as late).
 *
 * AND START: a person's explicit start, so it is the one case where a person's commit leads to a
 * turn (owner rule: 「…并开始」). Decided before anything is claimed
 * (`outlineTaskStartBlocker`, as a plugin's start is): the session must be idle, not in plan
 * mode, and its continuation mode must continue on this task (`off` starts once, as `/goal` and
 * "Add and start" do). Then the task is started for the session by the system (the write path
 * claims it; actor {@link OUTLINE_TASK_START_ACTOR}), and the session is started on it
 * (`startSpecContinuationIfPossible`, naming the task). A start that declines after all gives the
 * claim back (to-do), so no task is left in progress on a session that does not run.
 */
import { getUserLanguage, getUserReplyInLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import type {
	OutlineBoardNotStarted,
	OutlineBoardTransferSession,
} from "@shared/outline-task-board";
import type { OutlinePrincipal } from "./access";
import { readNarrator, readProjectTransferSessions } from "./access-reads";
import { canSessionWorkIn } from "./assignee";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "./errors";
import { OUTLINE_TEXT } from "./messages";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import { isPersonWork } from "./task-json";
import { flushOutlineTeamEvents } from "./team-events";
import { writeOutline } from "./write";

export const OUTLINE_TRANSFER_LIMITS = {
	/** Sessions the board offers. */
	sessions: 50,
} as const;

/** The system actor of a start made for a session (as continuation's promotion). */
const OUTLINE_TASK_START_ACTOR = "outline-task-start";

/**
 * The project whose sessions a task of `space` may be handed to: the project space's project, or
 * the project of the session whose space it is.
 */
export async function transferProjectOf(space: OutlineSpaceRow): Promise<string | null> {
	if (space.kind === "project") return space.projectId;
	if (space.kind === "session" && space.narratorId) {
		const { resolveNarratorProjectId } = await import("../narrator-project");
		const narrator = await readNarrator(space.narratorId);
		return narrator ? ((await resolveNarratorProjectId(narrator)) ?? null) : null;
	}
	return null;
}

/** The sessions a task of `space` may be handed to by `principal` (see the module header). */
export async function listTransferSessions(
	principal: OutlinePrincipal,
	space: OutlineSpaceRow,
): Promise<{ sessions: OutlineBoardTransferSession[]; truncated: boolean }> {
	const projectId = await transferProjectOf(space);
	if (!projectId) return { sessions: [], truncated: false };
	const limit = OUTLINE_TRANSFER_LIMITS.sessions;
	const rows = await readProjectTransferSessions(principal, projectId, limit + 1);
	const sessions: OutlineBoardTransferSession[] = [];
	for (const row of rows.slice(0, limit)) {
		// The session whose space holds the task has it already ("back to the session").
		if (space.kind === "session" && space.narratorId === row.id) continue;
		if (!(await canSessionWorkIn(row.id, space))) continue;
		sessions.push({
			narratorId: row.id,
			title: row.title,
			...(row.handle ? { handle: row.handle } : {}),
		});
	}
	return { sessions, truncated: rows.length > limit };
}

function refused(error: unknown): boolean {
	return (
		error instanceof OutlineTaskClaimedError ||
		error instanceof OutlineConflictError ||
		error instanceof OutlineWriteError ||
		error instanceof OutlineBusyError
	);
}

/**
 * Start session `narratorId` on task `blockId`, which was just handed to it (「转交并开始」). The
 * caller has checked that `userId` may write the session: the turn runs on their behalf.
 */
export async function startSessionOnTransferredTask(args: {
	narratorId: string;
	userId: string;
	blockId: string;
	store?: OutlineStore;
}): Promise<{ started: boolean; notStarted?: OutlineBoardNotStarted }> {
	const store = args.store ?? outlineStore;
	const block = await store.getBlock(args.blockId);
	const space = block ? await store.getSpace(block.spaceId) : null;
	if (!block || block.deleted || !block.taskJson || !space)
		return { started: false, notStarted: "not_started" };
	// The row that tells the session of the hand-over is written before its turn reads history.
	await flushOutlineTeamEvents(space.id);
	const session = await import("../narrator-session");
	// Decided before anything is claimed.
	const blocker = await session.outlineTaskStartBlocker(
		args.narratorId,
		{ blockId: block.id, status: block.taskJson.status },
		{ explicit: true, personWork: isPersonWork(block.taskJson, args.narratorId) },
	);
	if (blocker) return { started: false, notStarted: blocker };
	const address = `${space.key}/${block.sid}`;
	const system = {
		spaceId: space.id,
		actor: { kind: "system" as const, id: OUTLINE_TASK_START_ACTOR },
		responsibleUserId: args.userId,
		narratorId: args.narratorId,
	};
	if (block.taskJson.status !== "doing") {
		try {
			const claimed = await writeOutline(
				{
					...system,
					ops: [
						{
							op: "setTask",
							block: { id: block.id },
							task: { status: "doing" },
							baseVersionSeq: block.versionSeq,
						},
					],
					summary: OUTLINE_TEXT.startedForSession(address, args.narratorId),
				},
				{ store },
			);
			if (!claimed.commit) return { started: false, notStarted: "not_started" };
		} catch (error) {
			// Taken or changed meanwhile: the hand-over stands, the start does not happen.
			if (refused(error)) return { started: false, notStarted: "not_started" };
			throw error;
		}
	}
	const [locale, reply] = await Promise.all([
		getUserLanguage(args.userId),
		getUserReplyInLanguage(args.userId),
	]);
	const { started } = await session
		.startSpecContinuationIfPossible(args.narratorId, locale, reply, args.userId, {
			preferTaskId: block.id,
		})
		.catch((error: unknown) => {
			logger.warn("Could not start a session on a task handed to it", {
				narratorId: args.narratorId,
				blockId: block.id,
				error: String(error),
			});
			return { started: false };
		});
	if (started) return { started: true };
	// The start declined after all: the claim made for it is given back.
	await writeOutline(
		{
			...system,
			ops: [{ op: "setTask", block: { id: block.id }, task: { status: "todo" } }],
			summary: `gave ${address} back: session ${args.narratorId} did not start`,
		},
		{ store },
	).catch((error: unknown) =>
		logger.warn("Could not give back a task a start claimed", {
			narratorId: args.narratorId,
			blockId: block.id,
			error: String(error),
		}),
	);
	return { started: false, notStarted: "not_started" };
}
