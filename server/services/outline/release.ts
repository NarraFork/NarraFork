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
 *   | waiting: a prerequisite open; a question unanswered or a change   | kept (idle lease)       |
 *   | waiting for confirmation anywhere in its tree                     |                         |
 *   | a subagent of the session is doing a task under it (or it), or    | kept (idle lease)       |
 *   | another session is doing a task under it                          |                         |
 *   | of a project space, none of the above; the run ended `natural`,   | given back at once      |
 *   | and the task is not on a person's hour                            |                         |
 *   | of a project space, none of the above; a person's run ended       | a person's hour from    |
 *   |                                                                   | now, then the expiry job|
 *   | of a project space, none of the above; any other end (a system    | the person's hour it is |
 *   | run stopped, failed, or with work pending; or a `natural` end on  | on, unmoved; else an    |
 *   | a person's hour)                                                  | hour's lease that is    |
 *   |                                                                   | NOT a person's: the next|
 *   |                                                                   | `natural` end gives it  |
 *   |                                                                   | back at once            |
 *
 * `natural` is the runtime's word (`OutlineRunEnd`): the SYSTEM started the run (a continuation,
 * a wake, the session opened for the task), no person's message joined it, it ended by itself
 * (not stopped, not failed), nothing of the session still works in the background, nothing waits
 * to start its next run, and no person's run of the session ended within the last hour. A
 * PERSON's run is one a person started or joined: a message, Continue, Retry, the board's start
 * for an existing session, a hand-over "and start".
 *
 * THE HOUR IS THE PERSON'S. A task on the hour's lease after a person's run is not given back by
 * a system run that ends meanwhile (a wake, a notice), and that run does not move the hour
 * either: remembered here per task ({@link graceLeases}, in memory, bounded), since a run renews
 * every lease while it goes. After a restart the memory is gone: the lease in the database is
 * what the expiry job reads, and a system run that then ends by itself gives the task back.
 * Only a person's run starts such an hour: the hour's lease a system run's end puts a task on
 * (stopped, failed, work pending, a subagent's claims passed to an idle root) is a plain lease,
 * and the next system run that ends by itself gives the task back at once.
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
 * holds none); for project tasks, their ancestors by primary key level by level, the claims of
 * the session's subagents (bounded), one page-structure read per tree not kept already (at most
 * {@link OUTLINE_RELEASE_LIMITS.trees}; the rest are kept) with the claims and waits of
 * the open tasks in it (bounded), one conditional write of the leases, and for tasks given back
 * the handoff's reads and one commit per space.
 */
import { logger } from "@server/lib/logger";
import { readNarratorHandoffRows } from "./access-reads";
import {
	loadOutlineAncestors,
	OUTLINE_HANDOFF_ACTOR,
	outlineAncestorIds,
	planOutlineHandoffs,
} from "./handoff";
import { OUTLINE_TASK_GRACE_LEASE_MS, OUTLINE_TASK_IDLE_LEASE_MS } from "./model";
import { readSubtree } from "./read";
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
	type OutlineTaskSubject,
	outlineSessionsRunHere,
	type Reopening,
	renewOutlineTaskLeases,
	reopenTasks,
} from "./tasks";
import { subtreeNodes } from "./tree";

export const OUTLINE_RELEASE_LIMITS = {
	/** Claims of a session one run end reads and decides on; past it, a line is logged. */
	claims: 100,
	/** Claims of the session's subagents read to find the tasks being done for it. */
	subagentClaims: 100,
	/** Levels of ancestors read above the tasks held. */
	depth: 64,
	/**
	 * Trees looked into for other sessions' work and for questions (one page read each); the rest
	 * are kept.
	 */
	trees: 20,
	/** Open tasks of the trees whose claims and waits are read, in all; a tree past it is kept. */
	treeTasks: 500,
	/** Tasks whose hour is remembered (in memory). */
	remembered: 2000,
} as const;

/** How a run ended, as far as the release is concerned. */
export interface OutlineRunEnd {
	/** See the module header: only such an end gives tasks back at once. */
	natural: boolean;
	/** A person started or joined the run: its end starts the hour afresh. */
	person?: boolean;
	/** The session's last reply (a handoff may quote it under `forTaskId`). */
	reply?: string | null;
	/** The task the run was started for (the session opened for it): where the reply belongs. */
	forTaskId?: string | null;
	/**
	 * The run ended inside the hour of the session's last person run: when that hour ends (ms).
	 * Tasks not on an hour of their own go on it (and it is remembered for them), not a new one.
	 */
	personHourUntil?: number | null;
}

export interface OutlineRunEndResult {
	/** Claims left on the idle lease. */
	kept: number;
	/** Claims on the hour's lease. */
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

/**
 * The hour each task is on (see the module header), by task: whose it is, at which claim
 * generation, and when it ends (ms). In memory; the oldest entry goes when it is full.
 */
const graceLeases = new Map<string, { root: string; epoch: number; until: number }>();

function rememberGrace(taskId: string, entry: { root: string; epoch: number; until: number }) {
	graceLeases.delete(taskId);
	graceLeases.set(taskId, entry);
	while (graceLeases.size > OUTLINE_RELEASE_LIMITS.remembered) {
		const oldest = graceLeases.keys().next().value;
		if (oldest === undefined) break;
		graceLeases.delete(oldest);
	}
}

/** The end (ms) of the hour a claim is on, when it is on one that has not ended. */
function graceOf(task: OutlineClaimedTask, root: string, nowMs: number): number | null {
	const entry = graceLeases.get(task.block.id);
	if (!entry) return null;
	if (entry.root !== root || entry.epoch !== task.claim.epoch || entry.until <= nowMs) {
		graceLeases.delete(task.block.id);
		return null;
	}
	return entry.until;
}

/** Whether a task is on a person's hour that has not ended (the turn-end note asks). */
export function outlineTaskOnPersonHour(taskId: string, nowMs = Date.now()): boolean {
	const entry = graceLeases.get(taskId);
	return entry !== undefined && entry.until > nowMs;
}

/** Forget every remembered hour (tests: what a restart does). */
export function resetOutlineGraceLeasesForTests(): void {
	graceLeases.clear();
}

const end = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

/**
 * A run of `narratorId` ended: settle its claims (see the module header). Returns what became of
 * them; a session archived or deleted lets go of everything, as before.
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
		const settled = await settleRoot(store, session.root, "hold", now, {
			only: new Set(handed),
			...options,
		});
		return { kept: Math.max(0, kept - settled.grace), grace: settled.grace, released: 0 };
	}
	return await settleRoot(
		store,
		narratorId,
		how.natural ? "release" : how.person ? "hour" : "hold",
		now,
		{
			...options,
			reply: how.reply ?? null,
			forTaskId: how.forTaskId ?? null,
			personHourUntil: how.person ? null : (how.personHourUntil ?? null),
		},
	);
}

interface Decision {
	claimed: OutlineClaimedTask[];
	spaces: Map<string, OutlineSpaceRow>;
	/** Ids of the tasks not kept (given back, or put on the hour's lease), whole groups. */
	loose: Set<string>;
	/** The group (its topmost held task) of each team task. */
	groupOf: Map<string, string>;
}

/** Read the session's claims and decide which are kept and which are not (the header's table). */
async function decide(
	store: OutlineStore,
	root: string,
	now: Date,
	only: ReadonlySet<string> | undefined,
): Promise<Decision | null> {
	const read = await store.listClaimedTasks(root, OUTLINE_RELEASE_LIMITS.claims + 1);
	if (read.length > OUTLINE_RELEASE_LIMITS.claims)
		logger.info("Outline run end: more claims than one run end decides on; the rest keep theirs", {
			narratorId: root,
			decided: OUTLINE_RELEASE_LIMITS.claims,
		});
	const claimed = read
		.slice(0, OUTLINE_RELEASE_LIMITS.claims)
		.filter(({ claim }) => claim.holderNarratorId === root);
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
	const groupOf = new Map<string, string>();
	if (team.length === 0) return { claimed, spaces, loose: new Set(), groupOf };

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
	await loadOutlineAncestors(store, known, OUTLINE_RELEASE_LIMITS.depth);

	// Groups: team tasks above one another (the topmost held task above each names its group).
	const teamIds = new Set(team.map(({ block }) => block.id));
	for (const { block } of team) {
		const held = outlineAncestorIds(known, block.id).filter((id) => teamIds.has(id));
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
		for (const id of [claim.taskBlockId, ...outlineAncestorIds(known, claim.taskBlockId)]) {
			const group = groupOf.get(id);
			if (group) keptGroups.add(group);
		}
	const touched = only
		? new Set(
				team.filter(({ block }) => only.has(block.id)).map(({ block }) => groupOf.get(block.id)),
			)
		: null;
	const candidates = [...new Set(groupOf.values())].filter(
		(group) => !keptGroups.has(group) && (!touched || touched.has(group)),
	);
	for (const group of await treesInWork(store, root, candidates, teamIds, nowIso))
		keptGroups.add(group);
	const loose = new Set<string>();
	for (const { block } of team) {
		const group = groupOf.get(block.id) as string;
		if (keptGroups.has(group)) continue;
		if (touched && !touched.has(group)) continue;
		loose.add(block.id);
	}
	return { claimed, spaces, loose, groupOf };
}

/**
 * Of the trees (by their topmost held task), those something else keeps: another session is
 * doing a task in it, or a question or a change waiting for confirmation is open anywhere in it
 * (the session waits for people there, even when the nearest task above is not one it holds).
 * One page-structure read per tree, at most {@link OUTLINE_RELEASE_LIMITS.trees}; the claims and
 * the waits of at most {@link OUTLINE_RELEASE_LIMITS.treeTasks} open tasks not held by the
 * session. What is not known is kept: a tree past {@link OUTLINE_RELEASE_LIMITS.trees}, one that
 * cannot be read or is on a page read truncated, and one whose open tasks did not all fit in
 * {@link OUTLINE_RELEASE_LIMITS.treeTasks}.
 */
async function treesInWork(
	store: OutlineStore,
	root: string,
	groups: readonly string[],
	heldIds: ReadonlySet<string>,
	nowIso: string,
): Promise<Set<string>> {
	const out = new Set<string>();
	const groupOfTask = new Map<string, string>();
	const subjects: OutlineTaskSubject[] = [];
	for (const group of groups.slice(OUTLINE_RELEASE_LIMITS.trees)) out.add(group);
	for (const group of groups.slice(0, OUTLINE_RELEASE_LIMITS.trees)) {
		const subtree = await readSubtree(group, { store }).catch(() => null);
		if (!subtree || subtree.state.truncated) {
			out.add(group);
			continue;
		}
		for (const node of subtreeNodes(subtree.root).slice(1)) {
			if (!node.task || !isOpenTask(node.task) || heldIds.has(node.id)) continue;
			if (subjects.length >= OUTLINE_RELEASE_LIMITS.treeTasks) {
				out.add(group);
				break;
			}
			groupOfTask.set(node.id, group);
			subjects.push({ id: node.id, spaceId: subtree.state.space.id, taskJson: node.task });
		}
	}
	if (subjects.length === 0) return out;
	const claims = (await store.getTaskClaims(subjects.map((s) => s.id))).filter(
		(claim) => claim.holderNarratorId !== null && isClaimLive(claim, nowIso),
	);
	if (claims.length > 0) {
		const holders = await store.getNarratorRoots([
			...new Set(claims.map((claim) => claim.holderNarratorId as string)),
		]);
		for (const claim of claims) {
			const holder = claim.holderNarratorId as string;
			if ((holders.get(holder)?.root ?? holder) !== root)
				out.add(groupOfTask.get(claim.taskBlockId) as string);
		}
	}
	const waits = await deriveOutlineTaskWaits(subjects, { store });
	for (const subject of subjects) {
		const wait = waits.get(subject.id);
		if (wait?.people || wait?.confirmation) out.add(groupOfTask.get(subject.id) as string);
	}
	return out;
}

async function settleRoot(
	store: OutlineStore,
	root: string,
	/** `release`: give back at once; `hour`: a new hour; `hold`: the hour it is on, or a new one. */
	mode: "release" | "hour" | "hold",
	now: Date,
	options: OutlineRunEndOptions & {
		only?: ReadonlySet<string>;
		reply?: string | null;
		forTaskId?: string | null;
		personHourUntil?: number | null;
	},
): Promise<OutlineRunEndResult> {
	const idle = end(now, OUTLINE_TASK_IDLE_LEASE_MS);
	const nowMs = now.getTime();
	const none: OutlineRunEndResult = { kept: 0, grace: 0, released: 0 };
	// The leases of the tasks not kept are written only while their claims are as read; a claim
	// that moved meanwhile (a commit released one, a run renewed) makes it decide again, once.
	for (let attempt = 0; attempt < 2; attempt++) {
		const decision = await decide(store, root, now, options.only);
		if (!decision) return none;
		const { claimed, spaces, loose, groupOf } = decision;
		// First everything on the idle lease, in one statement, as before this rule existed: what
		// follows only shortens the leases of the tasks not kept, and may fail without harm.
		const all = options.only ? 0 : await store.renewTaskClaims(root, idle);
		if (loose.size === 0) return { ...none, kept: all };
		const looseTasks = claimed.filter(({ block }) => loose.has(block.id));
		// The hour a tree is on (the latest of its tasks'), when it is on one.
		const hourOfGroup = new Map<string, number>();
		for (const task of looseTasks) {
			const until = graceOf(task, root, nowMs);
			const group = groupOf.get(task.block.id) as string;
			if (until !== null) hourOfGroup.set(group, Math.max(until, hourOfGroup.get(group) ?? 0));
		}
		const onHour = (task: OutlineClaimedTask) =>
			hourOfGroup.get(groupOf.get(task.block.id) as string) ?? null;
		// Given back at once: only at a natural end, and never a tree on a person's hour.
		const going = mode === "release" ? looseTasks.filter((task) => onHour(task) === null) : [];
		const goingIds = new Set(going.map(({ block }) => block.id));
		const held = looseTasks.filter(({ block }) => !goingIds.has(block.id));
		const plans =
			going.length > 0
				? await planOutlineHandoffs(
						store,
						going.map(({ claim, block }) => ({
							claim,
							space: spaces.get(block.spaceId) as OutlineSpaceRow,
						})),
						{
							reason: "unfinished",
							at: now,
							reply: options.reply ?? null,
							replyTaskId: options.forTaskId ?? null,
						},
					).catch(() => new Map() as Awaited<ReturnType<typeof planOutlineHandoffs>>)
				: null;
		// A run of the session started meanwhile: the tasks are its own again.
		if (options.isRunning?.(root)) return { ...none, kept: all };
		const fresh = nowMs + OUTLINE_TASK_GRACE_LEASE_MS;
		const personHour =
			options.personHourUntil != null && options.personHourUntil > nowMs
				? options.personHourUntil
				: null;
		const untilOf = (task: OutlineClaimedTask): number =>
			goingIds.has(task.block.id)
				? nowMs
				: mode === "hour"
					? fresh
					: (onHour(task) ?? personHour ?? fresh);
		const written = await store.updateTaskClaims(
			looseTasks.map((task) => ({
				row: { ...task.claim, expiresAt: new Date(untilOf(task)).toISOString() },
				expect: options.only ? task.claim : { ...task.claim, expiresAt: idle },
			})),
		);
		if (!written) continue;
		// Only a person's run starts a person's hour (or a run that ends inside one puts tasks on
		// it). An hour's lease a system run put the task on otherwise (it stopped, failed, or had
		// work pending) is not remembered: the next run that ends by itself gives the task back at
		// once. A task already on a person's hour keeps its entry.
		for (const task of held)
			if (mode === "hour" || (personHour !== null && onHour(task) === null))
				rememberGrace(task.block.id, { root, epoch: task.claim.epoch, until: untilOf(task) });
		for (const task of going) graceLeases.delete(task.block.id);
		const kept = Math.max(0, all - looseTasks.length);
		if (going.length === 0) return { kept, grace: held.length, released: 0 };
		if (options.isRunning?.(root)) {
			// It started between the check and the write: its leases run again.
			await renewOutlineTaskLeases(root, { store, now });
			return { ...none, kept: all };
		}
		const result = await giveBack(store, root, going, plans ?? new Map(), now);
		return { kept, grace: held.length, released: result.reopened };
	}
	return none;
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
