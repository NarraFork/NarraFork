/**
 * Team events (outline P2 PR 10a, design v2 §D): what a commit of someone else means for a
 * session, told to that session as one system row, and whether the row wakes it.
 *
 * THE EVENTS (all read from one commit, `outline:committed`)
 * ---------------------------------------------------------
 *   1. ASSIGNED TO IT: a task's assignee became `@agent:<a session's id or handle>`
 *      (`assignee.ts`), on a task that is open; created with it counts. Told to that session.
 *      A task nobody is assigned (the pool) tells nobody: idle sessions are never woken to pick
 *      work up (owner decision D54).
 *   2. A PREREQUISITE ENDED: a task P went from open to done or cancelled. Every open task D that
 *      depends on P (`depends::`, found through the link index, any space) is told to who does D:
 *      the session holding it (lease running), else the session whose space holds it, else the
 *      session it is assigned to. D in a project space with nobody on it tells nobody.
 *   3. A TASK IT CREATED ENDED (PR 9b, `task-finished.ts`): told to the manager's session.
 *
 * Never told: the session that made the commit (or whose subagent did); a session that does not
 * exist, is archived, or keeps its tasks in Dynamic Spec; and a person's change that PR 5's notice
 * (`outline-task-edits.ts`) already tells that session of. At most
 * {@link OUTLINE_TEAM_EVENT_LIMITS.sessionsPerCommit} sessions per commit; the tasks named are
 * bounded and the rest counted.
 *
 * ONE ROW PER COMMIT AND SESSION
 * ------------------------------
 * A session that a commit concerns in several ways gets one row, source {@link OUTLINE_TEAM_SOURCE},
 * id derived from (space, seq, session). A commit that concerns it only by ending tasks it created
 * is told exactly as PR 9b told it (source `outline_task_finished`, 9b's id and text), so rows
 * written before this module existed are still found, and never told twice. Which of the two a
 * commit is for a session depends on what is read when it is read (who does a dependent task
 * now), so a delivery looks for a row under either id and writes none when it finds one
 * (`alsoIds`): one row per commit and session, whatever the commit reads as later. A dependence
 * written after the commit is not read into it (a task that came to depend on an ended task
 * later was never waiting for that commit). A session is told of a task only in a space it may
 * read.
 *
 * NO MAILBOX; DIRECT WRITE, AND A RE-PUSH AFTER A START
 * ---------------------------------------------------
 * The row is written when the commit is heard (`deliverInjection`, `sys`, no `createdBy`): from
 * then on it is in the session's history. What a direct write can lose is a commit whose row was
 * not written yet when the process stopped. So a start pushes the recent commits again
 * ({@link repushRecentOutlineTeamEvents}): spaces committed to in the last
 * {@link OUTLINE_TEAM_EVENT_LIMITS.repushWindowMs} (the `last_commit_at` index), at most
 * {@link OUTLINE_TEAM_EVENT_LIMITS.repushSpaces} of them and the newest
 * {@link OUTLINE_TEAM_EVENT_LIMITS.repushCommitsPerSpace} commits of each. The ids are derived,
 * so a row written before is found and not written again; when it is still the last row of its
 * session (nothing happened there since), the wake the stop may have cut off is tried once more.
 * Not on PostgreSQL: its rows have no chosen id to find them by, so nothing is pushed again.
 *
 * WHEN A ROW WAKES ITS SESSION
 * ----------------------------
 * A person's commit never wakes (PR 5's rule: a person tidying up must not cost a request; the
 * board's 「转交并开始」 starts the session itself). An agent's commit wakes the session when:
 *   - the event is one to act on now: assigned; a prerequisite ended and the task no longer waits
 *     for anything; a created task ended;
 *   - the session is idle and not in plan mode (the session layer checks again), and its last run
 *     was not stopped by its person or by an error (they speak next);
 *   - its wake limit has room (`team-wake.ts`: 6 a minute); else the row is written and one wake
 *     follows when there is room, if the row is still unread then;
 *   - it is not the writer's second hand-over of that task within ten minutes (a first
 *     hand-over wakes, a hand-back included; two sessions passing a task to and fro after that
 *     record it, and do not keep each other running).
 * A running session is not woken: it reads the row at its next tool boundary. On PostgreSQL the
 * row is written and nothing is woken (the session runtime does not run there; as PR 7 and 9b).
 *
 * LOAD: the listener only queues. A space's commits are read one at a time, in order, and at most
 * {@link OUTLINE_TEAM_EVENT_LIMITS.spacesAtOnce} spaces at once. Per commit: its versions without
 * content (≤200), the versions before by primary key, the commit and its writer; only when a
 * task ended, one read of the link index per ended task (≤20 tasks × ≤50 links); only when an
 * agent was assigned, that session by primary key or handle index. A commit that changed no
 * task reads its versions and nothing else.
 */
import { createHash } from "node:crypto";
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	getOutlineTeamEventsNote,
	type Locale,
	type OutlineTeamAssignedEntry,
	type OutlineTeamUnblockedEntry,
} from "@server/lib/prompt-i18n";
import { blockTitle, isAlias } from "@shared/outline";
import {
	boundOutlineTaskNoticeItem,
	type OutlineTaskNoticeItem,
} from "@shared/outline-task-notice";
import { readNarratorWakeFacts } from "./access-reads";
import { noteOutlineAssignedTasks } from "./assigned";
import { agentAssigneeName, resolveAgentAssignee } from "./assignee";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_CHANGE, type OutlineTaskJson } from "./model";
import { canSessionReadSpace, yieldToEventLoop } from "./session-scope";
import { outlineStore } from "./store";
import type { OutlineBlockMeta, OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineLinkTargetRef } from "./store/read-port";
import {
	clip,
	type OutlineCommitEvent,
	type OutlineCommitTaskRead,
	type OutlineCommitWriter,
	type OutlineTaskFinishedMessage,
	type OutlineTaskFinishedPart,
	outlineSessionLocale,
	outlineTaskFinishedDeliverySeam,
	outlineTaskFinishedInjection,
	outlineTaskFinishedMessage,
	outlineTaskFinishedMessageId,
	readOutlineCommitTasks,
	readOutlineCommitWriter,
	readOutlineTaskFinishedParts,
	shareOutNames,
	toldByPeopleEdits,
} from "./task-finished";
import { hasHumanAssignee, isFinishedTask, isOpenTask } from "./task-json";
import { deriveOutlineTaskWaits, isClaimLive, isWaiting } from "./tasks";
import { wakeForTeam } from "./team-wake";

/** The injection source of a row that tells more than tasks the session created (`docs/INJECTION.md`). */
export const OUTLINE_TEAM_SOURCE = "outline_team";

export const OUTLINE_TEAM_EVENT_LIMITS = {
	/** Sessions one commit tells at most (all events together); the rest are logged. */
	sessionsPerCommit: 20,
	/** Assigned and unblocked tasks named across one commit's rows; the rest are counted. */
	listedPerCommit: 20,
	/** Ended tasks of one commit whose dependents are looked up. */
	endedPerCommit: 20,
	/** Tasks depending on one ended task that are read. */
	dependentsPerTask: 50,
	/** Distinct `agent:` names one commit resolves. */
	assigneesPerCommit: 20,
	/** Spaces whose commits are read at the same time. */
	spacesAtOnce: 4,
	/** Commits one space may have waiting to be read; past it they are dropped and logged. */
	queuedPerSpace: 500,
	/** A session's second hand-over of the same task within this long wakes nobody. */
	handBackQuietMs: 10 * 60_000,
	/** Tasks whose last hand-over is remembered (memory only). */
	handOversRemembered: 2000,
	/** After a start: how far back commits are pushed again. */
	repushWindowMs: 15 * 60_000,
	/** After a start: spaces pushed again at most. */
	repushSpaces: 200,
	/** After a start: the newest commits of a space pushed again at most. */
	repushCommitsPerSpace: 50,
} as const;

/** One row to write: {@link OutlineTaskFinishedMessage} with its source and what it assigned. */
export type OutlineTeamMessage = OutlineTaskFinishedMessage;

/** The id of a session's `outline_team` row of one commit: one per (space, seq, session). */
export function outlineTeamMessageId(
	commit: { spaceId: string; seq: number },
	narratorId: string,
): string {
	return createHash("sha256")
		.update(["outline-team", commit.spaceId, String(commit.seq), narratorId].join("\u0000"))
		.digest("base64url")
		.slice(0, 21);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a commit's events
// ─────────────────────────────────────────────────────────────────────────────

interface Assigned {
	blockId: string;
	humanCreated: boolean;
	/**
	 * The writer already handed this same task over within the quiet time: the task is being
	 * passed to and fro. Recorded, but not a reason to wake (two sessions must not keep each
	 * other running). A session's FIRST hand-over of a task wakes as usual, a hand-back included:
	 * "I cannot do this" is worth a turn.
	 */
	back: boolean;
}

/**
 * Who handed each task away lately, in memory: what {@link Assigned.back} is read from. The last
 * few hand-overs of a task, by commit; times are the commits' own, so reading a commit again (a
 * retry, the re-push) says the same.
 */
type HandOver = { by: string; at: number; commitId: string };
const handedAway = hotSafe(
	"narrafork.outlineTeamEvents.handedAway",
	() => new Map<string, HandOver[]>(),
);
const HAND_OVERS_PER_TASK = 4;

/** Forget who handed what away (tests). */
export function resetOutlineTeamHandOversForTests(): void {
	handedAway.clear();
}

function noteHandedAway(taskId: string, by: string, at: number, commitId: string): void {
	const known = handedAway.get(taskId) ?? [];
	if (known.some((h) => h.commitId === commitId)) return;
	handedAway.delete(taskId);
	handedAway.set(taskId, [...known, { by, at, commitId }].slice(-HAND_OVERS_PER_TASK));
	while (handedAway.size > OUTLINE_TEAM_EVENT_LIMITS.handOversRemembered) {
		const [oldest] = handedAway.keys();
		if (oldest === undefined) break;
		handedAway.delete(oldest);
	}
}

/** Whether session `root` handed the task over (in another commit) within the quiet time before `at`. */
function handedAwayBy(taskId: string, root: string, at: number, commitId: string): boolean {
	return (handedAway.get(taskId) ?? []).some(
		(h) =>
			h.by === root &&
			h.commitId !== commitId &&
			at >= h.at &&
			at - h.at < OUTLINE_TEAM_EVENT_LIMITS.handBackQuietMs,
	);
}

interface Unblocked {
	/** The dependent task (the session's). */
	task: OutlineBlockMeta;
	/** The prerequisite that ended. */
	prerequisite: { blockId: string; status: "done" | "cancelled" };
	stillWaiting: boolean;
}

interface SessionEvents {
	assigned: Assigned[];
	unblocked: Unblocked[];
}

/** Sessions that may be told, checked once each: exists, not archived, tasks in the outline. */
class Recipients {
	private readonly verdicts = new Map<string, boolean>();
	constructor(private readonly store: OutlineStore) {}

	async tellable(root: string): Promise<boolean> {
		const known = this.verdicts.get(root);
		if (known !== undefined) return known;
		let verdict = false;
		try {
			const session = (await this.store.getNarratorRoots([root])).get(root);
			if (session && session.root === root && !session.archived && !session.sessionArchived) {
				const { readTaskBackend } = await import("../task-source/backend");
				verdict = (await readTaskBackend(root)) === "outline";
			}
		} catch (error) {
			// One session that cannot be read does not keep the others from being told.
			logger.warn("Could not read a session a team event concerns", {
				narratorId: root,
				error: String(error),
			});
		}
		this.verdicts.set(root, verdict);
		return verdict;
	}
}

/** The tasks a commit assigned to sessions by name, by session (root). */
async function assignedInCommit(
	store: OutlineStore,
	read: OutlineCommitTaskRead,
	writer: OutlineCommitWriter,
	recipients: Recipients,
): Promise<Map<string, Assigned[]>> {
	const out = new Map<string, Assigned[]>();
	const candidates: Array<{ blockId: string; assignee: string; humanCreated: boolean }> = [];
	for (const v of read.changed) {
		const task = v.taskJson;
		if (!task || !isOpenTask(task) || agentAssigneeName(task.assignee) === null) continue;
		if ((v.changeFlags & OUTLINE_CHANGE.CREATE) === 0) {
			const prior = read.before.get(v.blockId);
			// The same assignee before the commit: nothing was assigned in it.
			if (!prior) continue;
			if (!prior.deleted && prior.taskJson?.assignee === task.assignee) continue;
		}
		candidates.push({
			blockId: v.blockId,
			assignee: task.assignee as string,
			humanCreated: task.humanCreated === true,
		});
	}
	if (candidates.length === 0) return out;
	const names = [...new Set(candidates.map((c) => c.assignee))];
	if (names.length > OUTLINE_TEAM_EVENT_LIMITS.assigneesPerCommit)
		logger.warn("A commit assigned tasks to more names than are resolved", {
			spaceId: writer.space.id,
			seq: writer.commit.seq,
			names: names.length,
		});
	const sessions = new Map<string, string>();
	for (const name of names.slice(0, OUTLINE_TEAM_EVENT_LIMITS.assigneesPerCommit)) {
		const session = await resolveAgentAssignee(name, { store });
		if (session && !session.archived) sessions.set(name, session.narratorId);
	}
	if (sessions.size === 0) return out;
	const told = writer.person
		? await toldByPeopleEdits(
				store,
				writer.space,
				candidates.map((c) => c.blockId),
			)
		: new Map<string, string>();
	const at = Date.parse(writer.commit.createdAt);
	for (const candidate of candidates) {
		const root = sessions.get(candidate.assignee);
		if (root === undefined) continue;
		// The writer's second hand-over of this task within minutes: no wake (see `Assigned`).
		const back =
			writer.writerRoot !== null &&
			handedAwayBy(candidate.blockId, writer.writerRoot, at, writer.commit.id);
		if (writer.writerRoot !== null && writer.writerRoot !== root)
			noteHandedAway(candidate.blockId, writer.writerRoot, at, writer.commit.id);
		// Its own session (or a subagent of it) assigned it: nothing to tell.
		if (writer.writerRoot !== null && root === writer.writerRoot) continue;
		// A person's change PR 5 already tells this session of.
		if (told.get(candidate.blockId) === root) continue;
		if (!(await recipients.tellable(root))) continue;
		// A session that may not read the space could not do the task, and is told nothing of it.
		if (!(await canSessionReadSpace(root, writer.space).catch(() => false))) continue;
		const list = out.get(root);
		const entry = { blockId: candidate.blockId, humanCreated: candidate.humanCreated, back };
		if (list) list.push(entry);
		else out.set(root, [entry]);
	}
	return out;
}

/**
 * The open tasks that depend on tasks the commit ended, by the session doing them (root). A
 * prerequisite is found as `deriveOutlineTaskWaits` resolves one: written as `key/sid`,
 * `key/alias`, or the bare alias in its own space.
 */
async function unblockedInCommit(
	store: OutlineStore,
	read: OutlineCommitTaskRead,
	writer: OutlineCommitWriter,
	recipients: Recipients,
	now: string,
): Promise<Map<string, Unblocked[]>> {
	const out = new Map<string, Unblocked[]>();
	const ended = read.changed.filter((v) => {
		if ((v.changeFlags & OUTLINE_CHANGE.CREATE) !== 0 || !isFinishedTask(v.taskJson)) return false;
		const prior = read.before.get(v.blockId);
		return !!prior && !prior.deleted && isOpenTask(prior.taskJson);
	});
	if (ended.length === 0) return out;
	const { space } = writer;
	if (ended.length > OUTLINE_TEAM_EVENT_LIMITS.endedPerCommit)
		logger.warn("A commit ended more tasks than are checked for dependents", {
			spaceId: space.id,
			seq: writer.commit.seq,
			ended: ended.length,
		});
	const looked = ended.slice(0, OUTLINE_TEAM_EVENT_LIMITS.endedPerCommit);
	const metas = new Map(
		(await store.getBlockMetas(space.id, { ids: looked.map((v) => v.blockId) })).map((m) => [
			m.id,
			m,
		]),
	);
	// Whether a link was written after the commit: by seq in the commit's own space, by its
	// commit's time in another (one commit read by `(space, seq)`, memoized).
	const linkCommits = new Map<string, Promise<boolean>>();
	const writtenAfter = (link: { spaceId: string; fromSeq: number }): Promise<boolean> => {
		if (link.spaceId === space.id) return Promise.resolve(link.fromSeq > writer.commit.seq);
		const key = `${link.spaceId}\u0000${link.fromSeq}`;
		let verdict = linkCommits.get(key);
		if (!verdict) {
			verdict = store
				.getCommitsBySeqs(link.spaceId, [link.fromSeq])
				.then(([commit]) => !!commit && commit.createdAt > writer.commit.createdAt);
			linkCommits.set(key, verdict);
		}
		return verdict;
	};
	// (dependent, prerequisite) pairs, the dependents read once.
	const pairs: Array<{ from: string; prerequisite: string; status: "done" | "cancelled" }> = [];
	for (const v of looked) {
		const meta = metas.get(v.blockId);
		if (!meta) continue;
		const targets: OutlineLinkTargetRef[] = [
			{ targetKind: "block", targetRef: `${space.key}/${meta.sid}` },
		];
		if (meta.alias && isAlias(meta.alias)) {
			targets.push({ targetKind: "block", targetRef: `${space.key}/${meta.alias}` });
			targets.push({ targetKind: "text", targetRef: meta.alias, spaceId: space.id });
		}
		const links = await store.listLinksTo(
			targets,
			null,
			OUTLINE_TEAM_EVENT_LIMITS.dependentsPerTask,
			{ kinds: ["depends"] },
		);
		for (const link of links) {
			if (link.fromBlockId === v.blockId) continue;
			// A dependence written after this commit did not wait for it: a task that came to
			// depend on an ended task later is not "unblocked" by the old commit (the re-push).
			if (await writtenAfter(link)) continue;
			pairs.push({
				from: link.fromBlockId,
				prerequisite: v.blockId,
				status: (v.taskJson as OutlineTaskJson).status as "done" | "cancelled",
			});
		}
	}
	if (pairs.length === 0) return out;
	const dependents = new Map(
		(await store.getBlockMetasByIds([...new Set(pairs.map((p) => p.from))]))
			.filter((m) => !m.deleted && isOpenTask(m.taskJson))
			.map((m) => [m.id, m]),
	);
	if (dependents.size === 0) return out;
	const claims = new Map(
		(await store.getTaskClaims([...dependents.keys()])).map((c) => [c.taskBlockId, c]),
	);
	const holderRoots = await store.getNarratorRoots([
		...new Set(
			[...claims.values()].flatMap((c) => (c.holderNarratorId ? [c.holderNarratorId] : [])),
		),
	]);
	const spaces = new Map<string, OutlineSpaceRow | null>([[space.id, space]]);
	const spaceOf = async (id: string) => {
		if (!spaces.has(id)) spaces.set(id, await store.getSpace(id));
		return spaces.get(id) ?? null;
	};
	const assignees = new Map<string, string | null>();
	/**
	 * Who does a dependent task (see the module header), and only a session that may read the
	 * task's space: a row names the task by its title, and a session that cannot read it could
	 * not do it either (the rule the assigned event applies).
	 */
	const doerOf = async (task: OutlineBlockMeta): Promise<string | null> => {
		const root = await namedDoerOf(task);
		if (root === null) return null;
		const taskSpace = await spaceOf(task.spaceId);
		if (!taskSpace) return null;
		return (await canSessionReadSpace(root, taskSpace).catch(() => false)) ? root : null;
	};
	const namedDoerOf = async (task: OutlineBlockMeta): Promise<string | null> => {
		const claim = claims.get(task.id);
		if (claim && isClaimLive(claim, now)) {
			// A person doing it is not told here.
			if (claim.holderNarratorId === null) return null;
			return holderRoots.get(claim.holderNarratorId)?.root ?? claim.holderNarratorId;
		}
		if (hasHumanAssignee(task.taskJson)) return null;
		const taskSpace = await spaceOf(task.spaceId);
		if (taskSpace?.kind === "session" && taskSpace.narratorId) return taskSpace.narratorId;
		const assignee = task.taskJson?.assignee ?? null;
		if (agentAssigneeName(assignee) === null) return null;
		if (!assignees.has(assignee as string)) {
			const session = await resolveAgentAssignee(assignee, { store });
			assignees.set(assignee as string, session && !session.archived ? session.narratorId : null);
		}
		return assignees.get(assignee as string) ?? null;
	};
	const told = writer.person
		? await toldByPeopleEdits(
				store,
				space,
				looked.map((v) => v.blockId),
			)
		: new Map<string, string>();
	const found: Array<{ root: string; pair: (typeof pairs)[number]; task: OutlineBlockMeta }> = [];
	const seen = new Set<string>();
	for (const pair of pairs) {
		const task = dependents.get(pair.from);
		if (!task || seen.has(`${pair.from}\u0000${pair.prerequisite}`)) continue;
		seen.add(`${pair.from}\u0000${pair.prerequisite}`);
		const root = await doerOf(task);
		if (root === null) continue;
		if (writer.writerRoot !== null && root === writer.writerRoot) continue;
		// A person's change to the prerequisite that PR 5 already tells this session of.
		if (told.get(pair.prerequisite) === root) continue;
		if (!(await recipients.tellable(root))) continue;
		found.push({ root, pair, task });
	}
	if (found.length === 0) return out;
	// Whether each still waits for something else: derived now, for these tasks only.
	const waits = await deriveOutlineTaskWaits(
		[...new Map(found.map((f) => [f.task.id, f.task])).values()].map((t) => ({
			id: t.id,
			spaceId: t.spaceId,
			taskJson: t.taskJson,
		})),
		{ store },
	);
	// The link index gives them in no order a reader would know: by space, page and sibling order.
	const place = (t: OutlineBlockMeta) =>
		`${t.spaceId}\u0000${t.pageId}\u0000${t.orderKey}\u0000${t.id}`;
	found.sort((a, b) =>
		place(a.task) < place(b.task) ? -1 : place(a.task) > place(b.task) ? 1 : 0,
	);
	for (const { root, pair, task } of found) {
		const entry: Unblocked = {
			task,
			prerequisite: { blockId: pair.prerequisite, status: pair.status },
			stillWaiting: isWaiting(waits.get(task.id)),
		};
		const list = out.get(root);
		if (list) list.push(entry);
		else out.set(root, [entry]);
	}
	return out;
}

/**
 * The rows one commit makes, one per session it concerns (see the module header). Reads the
 * store and writes nothing to it; the one thing it keeps is in memory: who handed which task over
 * in this commit (`handedAway`, by commit id, so reading a commit again changes nothing).
 */
export async function readOutlineTeamMessages(
	event: OutlineCommitEvent,
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<OutlineTeamMessage[]> {
	const store = options.store ?? outlineStore;
	const read = await readOutlineCommitTasks(store, event);
	// A commit that changed no task concerns nobody: nothing else is read.
	if (read.changed.length === 0) return [];
	const interesting = read.changed.some(
		(v) => isFinishedTask(v.taskJson) || agentAssigneeName(v.taskJson?.assignee) !== null,
	);
	if (!interesting) return [];
	const writer = await readOutlineCommitWriter(store, event);
	if (!writer) return [];
	const now = (options.now ?? new Date()).toISOString();
	const recipients = new Recipients(store);
	const finished = await readOutlineTaskFinishedParts(event, { store, read, writer });
	const assigned = await assignedInCommit(store, read, writer, recipients);
	const unblocked = await unblockedInCommit(store, read, writer, recipients, now);

	// The sessions told, those of finished tasks first (9b's order and limit), then the others.
	const finishedBy = new Map(finished.map((part) => [part.narratorId, part]));
	const order = [...new Set([...finishedBy.keys(), ...assigned.keys(), ...unblocked.keys()])];
	const toldSessions = order.slice(0, OUTLINE_TEAM_EVENT_LIMITS.sessionsPerCommit);
	if (order.length > toldSessions.length)
		logger.warn("A commit concerns more sessions than it tells", {
			spaceId: event.spaceId,
			seq: event.seq,
			told: toldSessions.length,
			notTold: order.length - toldSessions.length,
		});
	const events = new Map<string, SessionEvents>(
		toldSessions.map((root) => [
			root,
			{ assigned: assigned.get(root) ?? [], unblocked: unblocked.get(root) ?? [] },
		]),
	);
	// Names shared out in turn, as 9b shares its own: every session told has one named.
	const withEvents = toldSessions.filter((root) => {
		const e = events.get(root) as SessionEvents;
		return e.assigned.length + e.unblocked.length > 0;
	});
	const named = new Map(
		shareOutNames(
			withEvents.map((root) => {
				const e = events.get(root) as SessionEvents;
				return e.assigned.length + e.unblocked.length;
			}),
			OUTLINE_TEAM_EVENT_LIMITS.listedPerCommit,
		).map((n, index) => [withEvents[index] as string, n]),
	);

	// Titles and addresses of what is named: heads only, and each space's key.
	const titled = new Set<string>();
	for (const root of withEvents) {
		const e = events.get(root) as SessionEvents;
		let left = named.get(root) ?? 0;
		for (const a of e.assigned.slice(0, left)) titled.add(a.blockId);
		left -= Math.min(left, e.assigned.length);
		for (const u of e.unblocked.slice(0, left)) {
			titled.add(u.task.id);
			titled.add(u.prerequisite.blockId);
		}
	}
	const [heads, ownMetas] =
		titled.size > 0
			? await Promise.all([store.getBlockHeads([...titled]), store.getBlockMetasByIds([...titled])])
			: [[], []];
	const titles = new Map(heads.map((h) => [h.id, clip(blockTitle(h.contentHead))]));
	const metaOf = new Map(ownMetas.map((m) => [m.id, m]));
	const keys = new Map<string, string>([[writer.space.id, writer.space.key]]);
	for (const meta of ownMetas) {
		if (keys.has(meta.spaceId)) continue;
		const space = await store.getSpace(meta.spaceId);
		if (space) keys.set(meta.spaceId, space.key);
	}
	const addressOf = (blockId: string): string => {
		const meta = metaOf.get(blockId);
		return meta ? `${keys.get(meta.spaceId) ?? "?"}/${meta.sid}` : "?";
	};
	const titleOf = (blockId: string): string =>
		titles.get(blockId) || (metaOf.get(blockId)?.sid ?? "?");

	const out: OutlineTeamMessage[] = [];
	for (const root of toldSessions) {
		const part: OutlineTaskFinishedPart | undefined = finishedBy.get(root);
		const e = events.get(root) as SessionEvents;
		if (e.assigned.length + e.unblocked.length === 0) {
			// Only tasks it created ended: told as 9b tells it.
			if (part)
				out.push({
					...outlineTaskFinishedMessage(event, part, writer),
					// Read at another time the commit may have concerned it in more ways.
					alsoIds: [outlineTeamMessageId(event, root)],
				});
			continue;
		}
		const locale: Locale = part?.locale ?? (await outlineSessionLocale(root));
		let left = named.get(root) ?? 0;
		const shownAssigned = e.assigned.slice(0, left);
		left -= shownAssigned.length;
		const shownUnblocked = e.unblocked.slice(0, left);
		const more =
			e.assigned.length -
			shownAssigned.length +
			(e.unblocked.length - shownUnblocked.length) +
			(part?.more ?? 0);
		// The prerequisite's title only where the session may read its space (the task is the
		// session's own; what it waits on may be anywhere).
		const prerequisiteReadable = await canSessionReadSpace(root, writer.space).catch(() => false);
		const assignedEntries: OutlineTeamAssignedEntry[] = shownAssigned.map((a) => ({
			address: addressOf(a.blockId),
			title: titleOf(a.blockId),
			humanCreated: a.humanCreated,
		}));
		const unblockedEntries: OutlineTeamUnblockedEntry[] = shownUnblocked.map((u) => ({
			address: addressOf(u.task.id),
			title: titleOf(u.task.id),
			prerequisite: {
				address: addressOf(u.prerequisite.blockId),
				title: prerequisiteReadable ? titleOf(u.prerequisite.blockId) : "",
				status: u.prerequisite.status,
			},
			stillWaiting: u.stillWaiting,
		}));
		const by = writer.neutralBy ? { by: writer.neutralBy } : {};
		const items = [
			...assignedEntries.map((entry) =>
				boundOutlineTaskNoticeItem({
					address: entry.address,
					title: entry.title,
					...by,
					...(entry.humanCreated ? { humanCreated: true } : {}),
					changes: [{ kind: "assignedHere" }],
				}),
			),
			...unblockedEntries.map((entry) =>
				boundOutlineTaskNoticeItem({
					address: entry.address,
					title: entry.title,
					...by,
					...(entry.stillWaiting ? { waiting: true } : {}),
					changes: [
						{
							kind: "unblocked",
							by: entry.prerequisite.status,
							...(entry.stillWaiting ? { still: true } : {}),
						},
					],
				}),
			),
			...(part?.items ?? []).map((item) =>
				boundOutlineTaskNoticeItem({
					...item,
					changes: [...(item.changes ?? []), { kind: "created" }],
				}),
			),
		].filter((item): item is OutlineTaskNoticeItem => item !== null);
		const taskIds = [
			...new Set([
				...e.assigned.map((a) => a.blockId),
				...e.unblocked.map((u) => u.task.id),
				...(part?.taskIds ?? []),
			]),
		];
		// A person's commit never wakes. An agent's wakes for what can be acted on now.
		const wake =
			!writer.person &&
			(shownAssigned.some((a) => !a.back) ||
				shownUnblocked.some((u) => !u.stillWaiting) ||
				(part?.wake ?? false));
		out.push({
			narratorId: root,
			messageId: outlineTeamMessageId(event, root),
			locale,
			content: getOutlineTeamEventsNote(
				{
					by: writer.words(locale),
					assigned: assignedEntries,
					unblocked: unblockedEntries,
					finished: part?.entries ?? [],
					more,
				},
				locale,
			),
			body: { kind: "outlineTasks", variant: "team", items, ...(more > 0 ? { more } : {}) },
			taskIds,
			wake,
			source: OUTLINE_TEAM_SOURCE,
			...(e.assigned.length > 0 ? { assigned: e.assigned.map((a) => a.blockId) } : {}),
			// Read at another time it may have been only the tasks it created ending (9b's row).
			...(part ? { alsoIds: [outlineTaskFinishedMessageId(event, root, part.taskIds)] } : {}),
		});
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery
// ─────────────────────────────────────────────────────────────────────────────

/** How the session's last run stopped keeps a team event from waking it: its person speaks next. */
function stoppedByPersonOrError(reason: string | null): boolean {
	return reason === "user_interrupt" || reason === "error";
}

/**
 * Whether a team event may wake the session at all, before the wake limit: not in plan mode, and
 * its last run not stopped by its person or an error. Whether it is idle is the session layer's
 * to say, under its start lock (it checks plan mode again there): a session that is running is
 * not started, and reads the row at its next tool boundary.
 */
export async function outlineTeamWakeAllowed(narratorId: string): Promise<boolean> {
	const facts = await readNarratorWakeFacts(narratorId).catch(() => null);
	if (!facts) return false;
	return !facts.planMode && !stoppedByPersonOrError(facts.lastStopReason);
}

/** Whether row `messageId` is the last row of the session's history (SQLite). */
async function isLastRow(narratorId: string, messageId: string): Promise<boolean> {
	const [{ db }, { narratorMessageRefs }, { desc, eq }] = await Promise.all([
		import("@server/db"),
		import("@server/db/schema"),
		import("drizzle-orm"),
	]);
	const last = db
		.select({ messageId: narratorMessageRefs.messageId })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1)
		.get();
	return last?.messageId === messageId;
}

/**
 * The wake of a row already written, for when the wake limit has room again: only while the row
 * is still the session's last (nothing read it since) and the session may still be woken.
 */
async function wakeIfStillUnread(message: OutlineTeamMessage): Promise<boolean> {
	if (!(await isLastRow(message.narratorId, message.messageId))) return false;
	if (!(await outlineTeamWakeAllowed(message.narratorId))) return false;
	const { wakeIdleAfterDelivery } = await import("../narrator-injection");
	return await wakeIdleAfterDelivery(message.narratorId, message.locale);
}

/**
 * Write one row and wake its session where the rules allow (see the module header).
 *   - SQLite: a row already under the id means the commit was delivered before: nothing is
 *     written. With `repush` (after a start) the wake that may have been cut off is tried again,
 *     while the row is still the session's last.
 *   - PostgreSQL: written through the narrator store's port, no chosen id, nothing woken.
 * `deferred`: the wake limit had no room, and one wake follows when it has.
 */
export async function deliverOutlineTeamMessage(
	message: OutlineTeamMessage,
	options: { repush?: boolean } = {},
): Promise<{ written: boolean; woke: boolean; deferred: boolean }> {
	const seam = outlineTaskFinishedDeliverySeam();
	if (seam) return { ...(await seam.deliver(message)), deferred: false };
	const [{ getNarratorMessageRefsPort }, { deliverInjection }] = await Promise.all([
		import("../narrator-refs/store"),
		import("../narrator-injection"),
	]);
	const postgres = !!getNarratorMessageRefsPort();
	if (message.assigned?.length) {
		noteOutlineAssignedTasks(message.narratorId, message.assigned);
		// Its current-tasks view lists them: read again.
		void import("../task-source/outline-views")
			.then(({ invalidateOutlineTasksView }) => invalidateOutlineTasksView(message.narratorId))
			.catch(() => {});
	}
	if (postgres) {
		const result = await deliverInjection(
			message.narratorId,
			outlineTaskFinishedInjection(message, true),
		);
		return { written: result.messageId !== null, woke: false, deferred: false };
	}
	const [{ db }, { narratorMessages }, { and, eq, inArray }] = await Promise.all([
		import("@server/db"),
		import("@server/db/schema"),
		import("drizzle-orm"),
	]);
	// A row of this session for this commit, under the id it has now or the one it would have had
	// read at another time (see `alsoIds`): delivered before, never written twice.
	const existing = db
		.select({ id: narratorMessages.id })
		.from(narratorMessages)
		.where(
			and(
				inArray(narratorMessages.id, [message.messageId, ...(message.alsoIds ?? [])]),
				eq(narratorMessages.narratorId, message.narratorId),
			),
		)
		.limit(1)
		.get();
	if (existing) {
		if (!options.repush || !message.wake) return { written: true, woke: false, deferred: false };
		// After a start: the first delivery may have stopped between the write and the wake.
		const row = { ...message, messageId: existing.id };
		const again = await wakeForTeam(message.narratorId, () => wakeIfStillUnread(row));
		return { written: true, ...again };
	}
	// Written first, without a wake: the wake is decided on its own, and may come later.
	const result = await deliverInjection(
		message.narratorId,
		outlineTaskFinishedInjection({ ...message, wake: false }, false),
	);
	if (result.messageId === null) return { written: false, woke: false, deferred: false };
	if (!message.wake || !(await outlineTeamWakeAllowed(message.narratorId)))
		return { written: true, woke: false, deferred: false };
	const { wakeIdleAfterDelivery } = await import("../narrator-injection");
	const woken = await wakeForTeam(
		message.narratorId,
		// Now: the row was just written.
		() => wakeIdleAfterDelivery(message.narratorId, message.locale),
		// Later, when the limit has room: only while the row is still unread.
		() => wakeIfStillUnread(message),
	);
	return { written: true, ...woken };
}

/**
 * Tell the sessions a commit concerns (see the module header). Errors are logged per session:
 * one that fails does not keep the others from being told.
 */
export async function deliverOutlineTeamEvents(
	event: OutlineCommitEvent,
	options: { store?: OutlineStore; repush?: boolean; now?: Date } = {},
): Promise<{ told: string[]; woke: number; deferred: number }> {
	if (!isOutlineEnabled()) return { told: [], woke: 0, deferred: 0 };
	const told: string[] = [];
	let woke = 0;
	let deferred = 0;
	for (const message of await readOutlineTeamMessages(event, options)) {
		try {
			const result = await deliverOutlineTeamMessage(message, { repush: options.repush });
			if (!result.written) continue;
			told.push(message.narratorId);
			if (result.woke) woke++;
			if (result.deferred) deferred++;
		} catch (error) {
			logger.warn("Failed to tell a session of a team event", {
				narratorId: message.narratorId,
				spaceId: event.spaceId,
				seq: event.seq,
				error: String(error),
			});
		}
	}
	return { told, woke, deferred };
}

// ─────────────────────────────────────────────────────────────────────────────
// The listener: a queue per space, a few spaces at once
// ─────────────────────────────────────────────────────────────────────────────

const queue = hotSafe("narrafork.outlineTeamEvents.queue", () => ({
	/** The last piece of work queued for each space: the next waits for it. */
	tails: new Map<string, Promise<void>>(),
	/** Commits waiting or being read, per space. */
	waiting: new Map<string, number>(),
	running: 0,
	slots: [] as Array<() => void>,
	inflight: new Set<Promise<void>>(),
}));

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (queue.running >= OUTLINE_TEAM_EVENT_LIMITS.spacesAtOnce)
		await new Promise<void>((resolve) => queue.slots.push(resolve));
	queue.running++;
	try {
		return await fn();
	} finally {
		queue.running--;
		queue.slots.shift()?.();
	}
}

/**
 * Queue work of one space behind the work queued for it before, a few spaces at once. Returns
 * false when the space has too much waiting already (the work is dropped; the caller logs).
 */
function enqueue(spaceId: string, fn: () => Promise<unknown>): boolean {
	const waiting = queue.waiting.get(spaceId) ?? 0;
	if (waiting >= OUTLINE_TEAM_EVENT_LIMITS.queuedPerSpace) return false;
	queue.waiting.set(spaceId, waiting + 1);
	const before = queue.tails.get(spaceId) ?? Promise.resolve();
	const work = before
		.then(() => withSlot(fn))
		.then(
			() => {},
			(error) =>
				logger.warn("Failed to read a commit's team events", { spaceId, error: String(error) }),
		)
		.finally(() => {
			const left = (queue.waiting.get(spaceId) ?? 1) - 1;
			if (left <= 0) queue.waiting.delete(spaceId);
			else queue.waiting.set(spaceId, left);
			if (queue.tails.get(spaceId) === work) queue.tails.delete(spaceId);
			queue.inflight.delete(work);
		});
	queue.tails.set(spaceId, work);
	queue.inflight.add(work);
	return true;
}

/** Wait for every commit queued so far to be read and told (tests, and a start that follows). */
export async function settleOutlineTeamEventsForTests(): Promise<void> {
	while (queue.inflight.size > 0) await Promise.allSettled([...queue.inflight]);
}

/**
 * Wait until the commits of `spaceId` queued so far have been told: a caller about to start a
 * session (the board's 「转交并开始」) lets the row of its own commit be written first, so the turn
 * reads it.
 */
export async function flushOutlineTeamEvents(spaceId: string): Promise<void> {
	await queue.tails.get(spaceId)?.catch(() => {});
}

/** Queue one commit's team events. */
export function queueOutlineTeamEvents(
	event: OutlineCommitEvent,
	options: { repush?: boolean } = {},
): void {
	const queued = enqueue(event.spaceId, () => deliverOutlineTeamEvents(event, options));
	if (!queued)
		logger.warn("Too many commits of a space wait for their team events; one is skipped", {
			spaceId: event.spaceId,
			seq: event.seq,
		});
}

/** Listen for commits (once per process; the server starts it with the outline jobs). */
export function startOutlineTeamEvents(): void {
	if (!hotOnce("narrafork.outlineTaskFinished.listener")) return;
	eventBus.on("outline:committed", (event) => {
		if (!isOutlineEnabled()) return;
		queueOutlineTeamEvents(event);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// After a start: push the recent commits again
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push the commits of the last {@link OUTLINE_TEAM_EVENT_LIMITS.repushWindowMs} again (see the
 * module header): what a process that stopped between a commit and its rows left untold. Bounded
 * and indexed: spaces by `last_commit_at`, a page at a time; of each the newest commits by seq.
 * Runs in the background, a commit at a time through the listener's queue, yielding between
 * spaces. Returns how many commits were queued.
 */
export async function repushRecentOutlineTeamEvents(
	options: { store?: OutlineStore; now?: Date } = {},
): Promise<{ spaces: number; commits: number }> {
	if (!isOutlineEnabled()) return { spaces: 0, commits: 0 };
	// PostgreSQL writes its rows without a chosen id, so a row written before cannot be found
	// again: pushing a commit twice would tell it twice. Nothing is pushed again there (a commit
	// whose row a stop cut off stays untold, as before this module; nothing is woken there anyway).
	const { getNarratorMessageRefsPort } = await import("../narrator-refs/store");
	if (getNarratorMessageRefsPort()) return { spaces: 0, commits: 0 };
	const store = options.store ?? outlineStore;
	const limits = OUTLINE_TEAM_EVENT_LIMITS;
	const since = new Date(
		(options.now ?? new Date()).getTime() - limits.repushWindowMs,
	).toISOString();
	let after: { lastCommitAt: string; id: string } | null = null;
	let spaces = 0;
	let commits = 0;
	while (spaces < limits.repushSpaces) {
		const page = await store.listSpacesCommittedSince(since, {
			after,
			limit: Math.min(50, limits.repushSpaces - spaces),
		});
		if (page.length === 0) break;
		for (const space of page) {
			spaces++;
			after = { lastCommitAt: space.lastCommitAt, id: space.id };
			// The newest commits: those after `next_seq - 1 - limit`.
			const rows = await store.listCommits(space.id, {
				limit: limits.repushCommitsPerSpace,
				afterSeq: Math.max(0, space.nextSeq - 1 - limits.repushCommitsPerSpace),
			});
			for (const commit of rows) {
				if (commit.createdAt < since) continue;
				queueOutlineTeamEvents(
					{
						spaceId: space.id,
						commitId: commit.id,
						seq: commit.seq,
						actorKind: commit.actorKind,
						actorId: commit.actorId,
					},
					{ repush: true },
				);
				commits++;
			}
			await yieldToEventLoop();
		}
		if (page.length < 50) break;
	}
	return { spaces, commits };
}
