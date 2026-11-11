/**
 * What a session's claims become when a run of it ends (outline P2 PR 10c-2; PR 10 design v2 §C,
 * owner decision D54): the unfinished tasks of a PROJECT space it holds, and that do not wait,
 * go back to do with a handoff under them (`handoff.ts`), for the next session opened for them.
 * Old sessions are never woken to continue a team task.
 *
 * THE RULE, PER TASK THE SESSION ITSELF HOLDS (at most {@link OUTLINE_RELEASE_LIMITS.claims})
 *
 *   | task                                                              | at the run's end        |
 *   |-------------------------------------------------------------------|-------------------------|
 *   | of the session's own space, or a personal space                   | kept (idle lease, 24 h) |
 *   | waiting: a prerequisite open, a question unanswered, a change     | kept (idle lease)       |
 *   | waiting for confirmation                                          |                         |
 *   | a subagent of the session is doing a task under it (or it)        | kept (idle lease)       |
 *   | of a project space, none of the above; the run was started by the | given back at once      |
 *   | system and ended by itself                                        |                         |
 *   | of a project space, none of the above; a person started or joined | kept for                |
 *   | the run, or it was stopped, or it failed                          | `OUTLINE_TASK_GRACE_LEASE_MS`, then given back by the expiry job |
 *
 * WHOLE TREES. Tasks the session holds that are above one another are one group, and a group is
 * kept or given back together: a task kept under a task given back could not be worked by the
 * next session, and a task given back under one kept could not be opened (a held task's steps are
 * its holder's, `task-session.ts`). A group is kept when any task of it is.
 *
 * HOW A TASK IS GIVEN BACK. Its lease is set to end now (`updateTaskClaims`, only while every
 * claim is still as read), then it is reopened the way the expiry job reopens an expired lease
 * (`reopenTasks`: one atomic system commit per space through the write path, actor
 * `outline-handoff`, the session's owner responsible; back to do, the handoff written under it,
 * the claim released, its generation kept). So no new write rule is needed, and the guards are
 * the expiry job's: a run of the session that started meanwhile and renewed its leases keeps its
 * tasks (the reopening is refused for them and skipped). A process that stops between the two
 * steps leaves an expired lease: the expiry job gives the task back, with the same handoff.
 *
 * A SUBAGENT's claims pass to its root, as before. When the root is not running, the groups they
 * join are put on the hour's lease instead of the idle one (the root is woken by the subagent's
 * result; its own run's end then decides).
 *
 * WHERE SESSIONS DO NOT RUN (PostgreSQL) nothing of this happens: no keeper runs there.
 * Anything failing here leaves the old behavior (every claim on the idle lease): see
 * `lease-keeper.ts`.
 *
 * COST, once per run end: one indexed read of the session's claims (and nothing else when it
 * holds none); for project tasks, their ancestors by primary key level by level, the wait
 * derivation of those tasks only, the claims of the session's subagents (bounded), one conditional
 * write of the leases, and for tasks given back the handoff's reads and one commit per space.
 */
import { logger } from "@server/lib/logger";
import { readNarratorHandoffRows } from "./access-reads";
import { OUTLINE_HANDOFF_ACTOR, planOutlineHandoffs } from "./handoff";
import { OUTLINE_LIMITS, OUTLINE_TASK_GRACE_LEASE_MS, OUTLINE_TASK_IDLE_LEASE_MS } from "./model";
import { outlineStore } from "./store";
import type {
	OutlineBlockMeta,
	OutlineClaimedTask,
	OutlineSpaceRow,
	OutlineStore,
} from "./store/port";
import { isOpenTask } from "./task-json";
import {
	deriveOutlineTaskWaits,
	idleOutlineTaskClaims,
	isClaimLive,
	isWaiting,
	type OutlineLeaseExpiryResult,
	outlineSessionsRunHere,
	type Reopening,
	renewOutlineTaskLeases,
	reopenTasks,
} from "./tasks";

export const OUTLINE_RELEASE_LIMITS = {
	/** Claims of a session one run end reads and decides on. */
	claims: 100,
	/** Claims of the session's subagents read to find the tasks being done for it. */
	subagentClaims: 100,
	/** Levels of ancestors read above the tasks held. */
	depth: 64,
} as const;

/** How a run ended, as far as the release is concerned. */
export interface OutlineRunEnd {
	/**
	 * The system started the run (a continuation, the board's button, a wake) and it ended by
	 * itself: no person's message started or joined it, it was not stopped, it did not fail, and
	 * no input of a person waits to start the next one.
	 */
	natural: boolean;
	/**
	 * The session's last reply. Shown in a handoff only when exactly one task is given back and
	 * the session wrote no note under it, and only for a session the project can read.
	 */
	reply?: string | null;
}

export interface OutlineRunEndResult {
	/** Claims left on the idle lease. */
	kept: number;
	/** Claims put on the hour's lease. */
	grace: number;
	/** Tasks given back with a handoff. */
	released: number;
}

export interface OutlineRunEndOptions {
	store?: OutlineStore;
	now?: Date;
	/** Whether a run of the session is going (the keeper's count); never by default. */
	isRunning?: (narratorId: string) => boolean;
}

const end = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

/**
 * A run of `narratorId` ended: settle its claims (see the module header). Returns what became of
 * them; a session archived or deleted lets go of everything, as before (counted as released).
 */
export async function settleOutlineTaskClaimsAtRunEnd(
	narratorId: string,
	how: OutlineRunEnd,
	options: OutlineRunEndOptions = {},
): Promise<OutlineRunEndResult> {
	const store = options.store ?? outlineStore;
	const now = options.now ?? new Date();
	const session = (await store.getNarratorRoots([narratorId])).get(narratorId);
	const legacy = async (): Promise<OutlineRunEndResult> => ({
		kept: await idleOutlineTaskClaims(narratorId, { store, now }),
		grace: 0,
		released: 0,
	});
	// Ended sessions let go of everything; where sessions do not run, nothing new happens.
	if (!session || session.archived || session.sessionArchived || !outlineSessionsRunHere())
		return await legacy();
	if (session.root !== narratorId) {
		// A subagent: its claims pass to its root. Those the root then holds while it is not
		// running do not stay a day: the trees they belong to go on the hour's lease.
		const handed = (await store.listClaimedTasks(narratorId, OUTLINE_RELEASE_LIMITS.claims)).map(
			({ block }) => block.id,
		);
		const kept = await idleOutlineTaskClaims(narratorId, { store, now });
		if (handed.length === 0 || options.isRunning?.(session.root))
			return { kept, grace: 0, released: 0 };
		const settled = await settleRoot(store, session.root, "grace", now, {
			only: new Set(handed),
			...options,
		});
		return { kept: Math.max(0, kept - settled.grace), grace: settled.grace, released: 0 };
	}
	return await settleRoot(store, narratorId, how.natural ? "release" : "grace", now, {
		...options,
		reply: how.reply ?? null,
	});
}

interface Decision {
	claimed: OutlineClaimedTask[];
	spaces: Map<string, OutlineSpaceRow>;
	/** Ids of the tasks to give back (or put on the hour's lease), whole groups. */
	loose: Set<string>;
}

/** Read the session's claims and decide which are kept and which are not (the header's table). */
async function decide(
	store: OutlineStore,
	root: string,
	now: Date,
	only: ReadonlySet<string> | undefined,
): Promise<Decision | null> {
	const claimed = (await store.listClaimedTasks(root, OUTLINE_RELEASE_LIMITS.claims)).filter(
		({ claim }) => claim.holderNarratorId === root,
	);
	if (claimed.length === 0) return null;
	const spaces = new Map<string, OutlineSpaceRow>();
	for (const spaceId of new Set(claimed.map(({ block }) => block.spaceId))) {
		const space = await store.getSpace(spaceId);
		if (space) spaces.set(spaceId, space);
	}
	const team = claimed.filter(
		({ block }) =>
			spaces.get(block.spaceId)?.kind === "project" && !block.deleted && isOpenTask(block.taskJson),
	);
	if (team.length === 0) return { claimed, spaces, loose: new Set() };

	// The blocks above the team tasks (and above what the session's subagents are doing), by
	// primary key, level by level.
	const nowIso = now.toISOString();
	const delegated = (
		await store.listSessionTaskClaims(root, OUTLINE_RELEASE_LIMITS.subagentClaims, {
			subagentsOnly: true,
		})
	).filter(({ claim }) => claim.holderNarratorId !== root && isClaimLive(claim, nowIso));
	const known = new Map<string, OutlineBlockMeta>(team.map(({ block }) => [block.id, block]));
	const delegatedIds = delegated
		.map(({ claim }) => claim.taskBlockId)
		.filter((id) => !known.has(id));
	if (delegatedIds.length > 0)
		for (const meta of await store.getBlockMetasByIds(delegatedIds)) known.set(meta.id, meta);
	for (let depth = 0; depth < OUTLINE_RELEASE_LIMITS.depth; depth++) {
		const missing = new Set<string>();
		for (const block of known.values())
			if (block.parentId !== null && !known.has(block.parentId)) missing.add(block.parentId);
		if (missing.size === 0) break;
		const found = await store.getBlockMetasByIds([...missing]);
		if (found.length === 0) break;
		for (const meta of found) known.set(meta.id, meta);
	}
	/** The block and everything above it, nearest first. */
	const chain = (id: string): string[] => {
		const out: string[] = [];
		let current = known.get(id);
		while (current && out.length <= OUTLINE_LIMITS.maxDepth) {
			out.push(current.id);
			current = current.parentId === null ? undefined : known.get(current.parentId);
		}
		return out;
	};

	// Groups: team tasks above one another (the topmost held task above each names its group).
	const teamIds = new Set(team.map(({ block }) => block.id));
	const groupOf = new Map<string, string>();
	for (const { block } of team) {
		const held = chain(block.id).filter((id) => teamIds.has(id));
		groupOf.set(block.id, held[held.length - 1] ?? block.id);
	}
	const keptGroups = new Set<string>();
	const waits = await deriveOutlineTaskWaits(
		team.map(({ block }) => ({ id: block.id, spaceId: block.spaceId, taskJson: block.taskJson })),
		{ store },
	);
	for (const { block } of team)
		if (isWaiting(waits.get(block.id))) keptGroups.add(groupOf.get(block.id) as string);
	// A subagent of the session is doing a task at or under a held one: that tree is in work.
	for (const { claim } of delegated)
		for (const id of chain(claim.taskBlockId)) {
			const group = groupOf.get(id);
			if (group) keptGroups.add(group);
		}
	const touched = only
		? new Set(
				team.filter(({ block }) => only.has(block.id)).map(({ block }) => groupOf.get(block.id)),
			)
		: null;
	const loose = new Set<string>();
	for (const { block } of team) {
		const group = groupOf.get(block.id) as string;
		if (keptGroups.has(group)) continue;
		if (touched && !touched.has(group)) continue;
		loose.add(block.id);
	}
	return { claimed, spaces, loose };
}

async function settleRoot(
	store: OutlineStore,
	root: string,
	mode: "release" | "grace",
	now: Date,
	options: OutlineRunEndOptions & { only?: ReadonlySet<string>; reply?: string | null },
): Promise<OutlineRunEndResult> {
	const idle = end(now, OUTLINE_TASK_IDLE_LEASE_MS);
	const nowIso = now.toISOString();
	const none: OutlineRunEndResult = { kept: 0, grace: 0, released: 0 };
	// The leases of the tasks not kept are written only while their claims are as read; a claim
	// that moved meanwhile (a commit released one, a run renewed) makes it decide again, once.
	for (let attempt = 0; attempt < 2; attempt++) {
		const decision = await decide(store, root, now, options.only);
		if (!decision) return none;
		const { claimed, spaces, loose } = decision;
		// First everything on the idle lease, in one statement, as before this rule existed: what
		// follows only shortens the leases of the tasks not kept, and may fail without harm.
		const all = options.only ? 0 : await store.renewTaskClaims(root, idle);
		if (loose.size === 0) return { ...none, kept: all };
		const going = claimed.filter(({ block }) => loose.has(block.id));
		const releasing = mode === "release";
		const plans = releasing
			? await planOutlineHandoffs(
					store,
					going.map(({ claim, block }) => ({
						claim,
						space: spaces.get(block.spaceId) as OutlineSpaceRow,
					})),
					{
						reason: "unfinished",
						at: now,
						// The reply speaks of the task only when there is one to speak of.
						reply: looseTops(going) === 1 ? (options.reply ?? null) : null,
					},
				).catch(() => new Map() as Awaited<ReturnType<typeof planOutlineHandoffs>>)
			: null;
		// A run of the session started meanwhile: the tasks are its own again.
		if (options.isRunning?.(root)) return { ...none, kept: all };
		const until = releasing ? nowIso : end(now, OUTLINE_TASK_GRACE_LEASE_MS);
		const written = await store.updateTaskClaims(
			going.map(({ claim }) => ({
				row: { ...claim, expiresAt: until },
				expect: options.only ? claim : { ...claim, expiresAt: idle },
			})),
		);
		if (!written) continue;
		const kept = Math.max(0, all - going.length);
		if (!releasing) return { kept, grace: going.length, released: 0 };
		if (options.isRunning?.(root)) {
			// It started between the check and the write: its leases run again.
			await renewOutlineTaskLeases(root, { store, now });
			return { ...none, kept: all };
		}
		const result = await giveBack(store, root, going, plans ?? new Map(), now);
		return { kept, grace: 0, released: result.reopened };
	}
	return none;
}

/** How many of the tasks given back are not directly under another one given back. */
function looseTops(going: readonly OutlineClaimedTask[]): number {
	const ids = new Set(going.map(({ block }) => block.id));
	// Deeper nesting counts both; the reply is then left out, which is the careful side.
	return going.filter(({ block }) => block.parentId === null || !ids.has(block.parentId)).length;
}

async function giveBack(
	store: OutlineStore,
	root: string,
	going: readonly OutlineClaimedTask[],
	plans: Awaited<ReturnType<typeof planOutlineHandoffs>>,
	now: Date,
): Promise<OutlineLeaseExpiryResult> {
	const session = (await readNarratorHandoffRows([root]).catch(() => null))?.get(root) ?? null;
	const items = going.map(({ claim, block }): Reopening => {
		const plan = plans.get(block.id);
		return {
			taskBlockId: block.id,
			spaceId: block.spaceId,
			note: "",
			// No plan (the task could not be read): reopened bare, never with an empty block.
			ops: plan?.ops ?? [],
			clearAssignee:
				plan?.clearAssignee ?? block.taskJson?.assignee === `agent:${claim.holderNarratorId}`,
		};
	});
	const result = await reopenTasks(store, items, now, {
		actor: OUTLINE_HANDOFF_ACTOR,
		responsibleUserId: session?.ownerUserId ?? null,
		summary: (n) =>
			`session ${root} did not finish: ${n === 1 ? "1 task" : `${n} tasks`} back to do with a handoff`,
	});
	const noted = [...plans.values()].filter((plan) => plan.ops.length > 0 && plan.noted).length;
	const handoffs = [...plans.values()].filter((plan) => plan.ops.length > 0).length;
	// How often the model wrote its own notes before ending (design §G.5: measured, not assumed).
	logger.info("Outline tasks given back at a run's end", {
		narratorId: root,
		...result,
		handoffs,
		handoffsWithSessionNotes: noted,
	});
	return result;
}
