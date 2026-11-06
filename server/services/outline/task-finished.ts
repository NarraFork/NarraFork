/**
 * Telling a session that tasks it created were finished elsewhere (outline P2 PR 9b; PR 9 design
 * §2.7): the session that created a task (`task_json.manager`) is told when another session, or
 * a person, ticks it done or cancelled.
 *
 * WHO IS TOLD
 * -----------
 * Every commit (`outline:committed`) is read back, the versions it wrote without their content
 * (at most {@link OUTLINE_TASK_FINISHED_LIMITS.versionsPerCommit}): a task finished in it is one
 * that was to do or in progress just before it and is done or cancelled after it. Its manager is
 * told when the manager is a session (`agent`) and:
 *   - it is not the finisher's session: the session that finished it, or a subagent of it, ticked
 *     its own task (a delegated subagent's result is the notice there, design §2.6);
 *   - it exists, is not archived, and keeps its tasks in the outline;
 *   - for a person's commit, PR 5 does not tell it already (`outline-task-edits.ts` tells the
 *     session whose space holds the task, or the one doing or last doing it).
 * A person who created the task is not told here: the day's report lists it (PR 11, owner
 * decision Q3), and the task board marks it 「新完成」 until they have seen it.
 *
 * HOW
 * ---
 * One message per session told and commit, at most
 * {@link OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit} sessions (the rest are logged). The
 * commit names at most {@link OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit} tasks, shared out in
 * turn so every session told has at least one named; the rest are counted in their session's
 * message. In the session's language (its owner's); the reader's card names who finished them
 * without words of either language (a session's title, a person's username).
 * Delivered like PR 7's answers (`questions.ts`): `deliverInjection` as a system row (`sys`,
 * `outline_task_finished`), waking the session when it is idle (`wakeIfIdle`), except for a
 * person's commit, whose message waits for the session's next turn (PR 5's rule: a person tidying
 * up must not cost a request). On PostgreSQL the row is written and nothing is woken (the session
 * runtime does not run there yet), and the chosen id is not used. The row's id follows from
 * (commit, session, tasks): delivering the same commit again finds it and writes nothing. There is
 * no retry queue: a process that stops between the commit and the delivery loses the message
 * (PR 10 folds this into the runtime inbox's `team` channel, with persistence).
 *
 * Every read is indexed and bounded: the commit's versions by `(space_id, seq)`, the versions just
 * before by primary key, the commit row, the tasks' heads and claims, the sessions' roots; the
 * listener only queues the work, never blocks the commit.
 */
import { createHash } from "node:crypto";
import { eventBus } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	getOutlineTaskFinishedNote,
	getUserLanguage,
	type Locale,
	type OutlineTaskFinishedEntry,
} from "@server/lib/prompt-i18n";
import { blockTitle } from "@shared/outline";
import {
	boundOutlineTaskNoticeItem,
	OUTLINE_TASK_NOTICE_LIMITS,
	type OutlineTaskNoticeItem,
} from "@shared/outline-task-notice";
import type { SideCarBody } from "@shared/sidecar-body";
import { readDisplayNames, readNarrator } from "./access-reads";
import { isOutlineEnabled } from "./feature";
import { OUTLINE_CHANGE, type OutlineTaskJson } from "./model";
import { outlineStore } from "./store";
import type { OutlineStore } from "./store/port";
import { isFinishedTask, isOpenTask } from "./task-json";

export const OUTLINE_TASK_FINISHED_LIMITS = {
	/** Versions of one commit read back (a commit holds at most 200 operations). */
	versionsPerCommit: 200,
	/**
	 * Tasks named across one commit's messages, shared out in turn so every session told has at
	 * least one named; the rest are counted in their session's message.
	 */
	listedPerCommit: 20,
	/** Sessions one commit tells at most; the rest are logged and not told. */
	sessionsPerCommit: 20,
	/** Characters of a title or a name. */
	titleChars: OUTLINE_TASK_NOTICE_LIMITS.titleChars,
} as const;

/** The injection source of the message (`docs/INJECTION.md`). */
export const OUTLINE_TASK_FINISHED_SOURCE = "outline_task_finished";

/** What a commit's event says (`outline:committed`). */
export interface OutlineCommitEvent {
	spaceId: string;
	commitId: string;
	seq: number;
	actorKind: "human" | "agent" | "system";
	actorId: string;
}

/** One message to write: to a session, about the tasks of one commit it created. */
export interface OutlineTaskFinishedMessage {
	narratorId: string;
	messageId: string;
	locale: Locale;
	content: string;
	body: SideCarBody;
	/** The tasks it is about (block ids), named or counted. */
	taskIds: string[];
	/**
	 * Wake the session when idle. Not for a person's commit (a person tidying up must not cost a
	 * request, PR 5's rule): the row waits for the session's next turn.
	 */
	wake: boolean;
}

/** What delivering needs from the session layer: a seam tests replace. */
export interface OutlineTaskFinishedDelivery {
	/** Write the message and wake the session when idle where the runtime can. */
	deliver(message: OutlineTaskFinishedMessage): Promise<{ written: boolean; woke: boolean }>;
}

let deliverySeam: OutlineTaskFinishedDelivery | null = null;

/** Replace the delivery (tests); null restores the real one. Returns the previous. */
export function setOutlineTaskFinishedDelivery(
	next: OutlineTaskFinishedDelivery | null,
): OutlineTaskFinishedDelivery | null {
	const previous = deliverySeam;
	deliverySeam = next;
	return previous;
}

/**
 * The id of one message: derived from the commit, the session told and the tasks it names, so
 * delivering the same commit again finds the row it wrote.
 */
export function outlineTaskFinishedMessageId(
	commit: { spaceId: string; seq: number },
	narratorId: string,
	taskIds: readonly string[],
): string {
	return createHash("sha256")
		.update(
			[
				"outline-task-finished",
				commit.spaceId,
				String(commit.seq),
				narratorId,
				...[...taskIds].sort(),
			].join("\u0000"),
		)
		.digest("base64url")
		.slice(0, 21);
}

/**
 * The injection a message is written as: on PostgreSQL no chosen id and no wake (PR 7, S6); a
 * message that does not wake (a person's commit) is written for the next turn.
 */
export function outlineTaskFinishedInjection(
	message: OutlineTaskFinishedMessage,
	postgres: boolean,
) {
	return {
		...(postgres ? {} : { messageId: message.messageId }),
		content: message.content,
		body: message.body,
		source: OUTLINE_TASK_FINISHED_SOURCE,
		role: "sys" as const,
		schedule: postgres || !message.wake ? ("none" as const) : ("wakeIfIdle" as const),
		locale: message.locale,
	};
}

/**
 * The tasks each session's message names: `limit` shared out in turn, one per session per round,
 * in the order given, so every session gets at least one while there are no more sessions than
 * names. Returns how many of each session's tasks are named.
 */
export function shareOutNames(counts: readonly number[], limit: number): number[] {
	const named = counts.map(() => 0);
	let left = limit;
	for (let progress = true; left > 0 && progress; ) {
		progress = false;
		for (let i = 0; i < counts.length && left > 0; i++) {
			if ((named[i] as number) >= (counts[i] as number)) continue;
			named[i] = (named[i] as number) + 1;
			left--;
			progress = true;
		}
	}
	return named;
}

/**
 * The real delivery. SQLite: a row already under the chosen id means the commit was delivered
 * before: nothing is written again (and no wake: the first delivery woke it). PostgreSQL: the row
 * is written through the narrator store's port and nothing is woken.
 */
const realDelivery: OutlineTaskFinishedDelivery = {
	async deliver(message) {
		const [{ getNarratorMessageRefsPort }, { deliverInjection }] = await Promise.all([
			import("../narrator-refs/store"),
			import("../narrator-injection"),
		]);
		const postgres = !!getNarratorMessageRefsPort();
		if (!postgres) {
			const [{ db }, { narratorMessages }, { and, eq }] = await Promise.all([
				import("@server/db"),
				import("@server/db/schema"),
				import("drizzle-orm"),
			]);
			const existing = db
				.select({ id: narratorMessages.id })
				.from(narratorMessages)
				.where(
					and(
						eq(narratorMessages.id, message.messageId),
						eq(narratorMessages.narratorId, message.narratorId),
					),
				)
				.get();
			if (existing) return { written: true, woke: false };
		}
		const result = await deliverInjection(
			message.narratorId,
			outlineTaskFinishedInjection(message, postgres),
		);
		return { written: result.messageId !== null, woke: result.started };
	},
};

/** A task finished in the commit, with what is needed to name it. */
interface Finished {
	blockId: string;
	manager: string;
	status: "done" | "cancelled";
	from: "todo" | "doing";
	humanCreated: boolean;
}

/** The tasks a commit finished whose manager is a session, by block id (as the versions are read). */
async function finishedInCommit(store: OutlineStore, event: OutlineCommitEvent) {
	const versions = await store.listCommitRangeChanges(
		event.spaceId,
		event.seq - 1,
		event.seq,
		OUTLINE_TASK_FINISHED_LIMITS.versionsPerCommit,
	);
	// Only versions whose task changed, finished after it, of a task a session created.
	const candidates = versions.filter(
		(v) =>
			v.seq === event.seq &&
			(v.changeFlags & OUTLINE_CHANGE.TASK) !== 0 &&
			(v.changeFlags & OUTLINE_CHANGE.CREATE) === 0 &&
			!v.deleted &&
			isFinishedTask(v.taskJson) &&
			v.taskJson?.manager?.kind === "agent",
	);
	if (candidates.length === 0) return [];
	const before = new Map(
		(
			await store.listVersionMetasAt(
				candidates.map((v) => ({ blockId: v.blockId, seq: event.seq - 1 })),
			)
		).map((v) => [v.blockId, v]),
	);
	const out: Finished[] = [];
	for (const v of candidates) {
		const prior = before.get(v.blockId);
		if (!prior || prior.deleted || !isOpenTask(prior.taskJson)) continue;
		const task = v.taskJson as OutlineTaskJson;
		out.push({
			blockId: v.blockId,
			manager: task.manager?.id as string,
			status: task.status as "done" | "cancelled",
			from: (prior.taskJson as OutlineTaskJson).status as "todo" | "doing",
			humanCreated: task.humanCreated === true,
		});
	}
	return out;
}

/**
 * The sessions PR 5 tells of a person's commit for these tasks (`readCommitTaskChanges`): the
 * session whose space holds them, else whoever holds or last held each one (by root).
 */
async function toldByPeopleEdits(
	store: OutlineStore,
	space: { kind: string; narratorId: string | null },
	taskIds: readonly string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (space.kind === "session" && space.narratorId) {
		for (const id of taskIds) out.set(id, space.narratorId);
		return out;
	}
	const holders = new Map<string, string>();
	for (const claim of await store.getTaskClaims(taskIds)) {
		const holder = claim.holderNarratorId ?? claim.lastHolderNarratorId;
		if (holder) holders.set(claim.taskBlockId, holder);
	}
	const roots = await store.getNarratorRoots([...new Set(holders.values())]);
	for (const [id, holder] of holders) out.set(id, roots.get(holder)?.root ?? holder);
	return out;
}

function clip(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	const max = OUTLINE_TASK_FINISHED_LIMITS.titleChars;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The messages one commit makes: for each session that created tasks the commit finished (and is
 * told, see the module header), its tasks named (within the commit's limit) and counted. Reads
 * only; nothing is written.
 */
export async function readOutlineTaskFinishedMessages(
	event: OutlineCommitEvent,
	options: { store?: OutlineStore } = {},
): Promise<OutlineTaskFinishedMessage[]> {
	const store = options.store ?? outlineStore;
	const finished = await finishedInCommit(store, event);
	if (finished.length === 0) return [];
	const [space, [commit]] = await Promise.all([
		store.getSpace(event.spaceId),
		store.getCommitsBySeqs(event.spaceId, [event.seq]),
	]);
	if (!space || !commit) return [];
	// Who finished them: the commit's session (an agent's own, a system commit's), or a person.
	const finisher =
		commit.narratorId ?? (commit.actorKind === "agent" ? commit.actorId : null) ?? null;
	const sessions = await store.getNarratorRoots([
		...new Set([...finished.map((f) => f.manager), ...(finisher ? [finisher] : [])]),
	]);
	const finisherRoot = finisher ? (sessions.get(finisher)?.root ?? finisher) : null;
	const told =
		commit.actorKind === "human"
			? await toldByPeopleEdits(
					store,
					space,
					finished.map((f) => f.blockId),
				)
			: new Map<string, string>();
	const byManager = new Map<string, Finished[]>();
	const backends = new Map<string, boolean>();
	const { readTaskBackend } = await import("../task-source/backend");
	let dropped = 0;
	for (const task of finished) {
		// The manager may be a subagent of the session (it wrote the task): its session is told.
		const session = sessions.get(task.manager);
		if (!session || session.sessionArchived) continue;
		const root = session.root;
		// Its own session (or a subagent of it) finished it: nothing to tell.
		if (finisherRoot !== null && root === finisherRoot) continue;
		// A person's change PR 5 already tells this session of.
		if (told.get(task.blockId) === root) continue;
		// As many sessions as one commit tells are found: another is not even read.
		if (!byManager.has(root) && byManager.size >= OUTLINE_TASK_FINISHED_LIMITS.sessionsPerCommit) {
			dropped++;
			continue;
		}
		if (!backends.has(root)) {
			// One session that cannot be read does not keep the others from being told.
			const outline = await readTaskBackend(root)
				.then((backend) => backend === "outline")
				.catch((error) => {
					logger.warn("Could not read a session told of finished tasks", {
						narratorId: root,
						error: String(error),
					});
					return false;
				});
			backends.set(root, outline);
		}
		if (!backends.get(root)) continue;
		const list = byManager.get(root);
		if (list) list.push(task);
		else byManager.set(root, [task]);
	}
	if (dropped > 0)
		logger.warn("A commit finished tasks of more sessions than it tells", {
			spaceId: event.spaceId,
			seq: event.seq,
			told: byManager.size,
			tasksNotTold: dropped,
		});
	if (byManager.size === 0) return [];

	const all = [...byManager.values()].flat();
	const [metas, heads] = await Promise.all([
		store.getBlockMetas(event.spaceId, { ids: all.map((t) => t.blockId) }),
		store.getBlockHeads(all.map((t) => t.blockId)),
	]);
	const sids = new Map(metas.map((m) => [m.id, m.sid]));
	const titles = new Map(heads.map((h) => [h.id, clip(blockTitle(h.contentHead))]));
	const names = await readDisplayNames(
		commit.actorKind === "human"
			? { userIds: [commit.actorId] }
			: { narratorIds: finisherRoot ? [finisherRoot] : [] },
	).catch(() => null);

	const sessionsTold = [...byManager];
	const named = shareOutNames(
		sessionsTold.map(([, tasks]) => tasks.length),
		OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit,
	);
	// Who finished them, as the reader's card names them (a name, in no language) and as the
	// model's text does (in the session's language).
	const sessionName = finisherRoot
		? clip(names?.narrators.get(finisherRoot) ?? finisherRoot)
		: null;
	const person = commit.actorKind === "human";
	const neutralBy = person ? (names?.users.get(commit.actorId) ?? commit.actorId) : sessionName;
	const out: OutlineTaskFinishedMessage[] = [];
	for (const [index, [root, tasks]] of sessionsTold.entries()) {
		const owner = await readNarrator(root)
			.then((row) => row?.ownerUserId ?? null)
			.catch(() => null);
		const locale: Locale = owner ? await getUserLanguage(owner).catch(() => "en" as const) : "en";
		const by =
			person && neutralBy
				? neutralBy
				: sessionName
					? locale === "zh-CN"
						? `会话「${sessionName}」`
						: `session "${sessionName}"`
					: locale === "zh-CN"
						? "系统"
						: "the system";
		const shown = tasks.slice(0, named[index] ?? 0);
		const more = tasks.length - shown.length;
		const entries: OutlineTaskFinishedEntry[] = shown.map((task) => ({
			address: `${space.key}/${sids.get(task.blockId) ?? "?"}`,
			title: titles.get(task.blockId) || (sids.get(task.blockId) ?? "?"),
			status: task.status,
			humanCreated: task.humanCreated,
		}));
		const items = shown.flatMap((task, index): OutlineTaskNoticeItem[] => {
			const entry = entries[index] as OutlineTaskFinishedEntry;
			const item = boundOutlineTaskNoticeItem({
				address: entry.address,
				title: entry.title,
				...(neutralBy ? { by: neutralBy } : {}),
				...(task.humanCreated ? { humanCreated: true } : {}),
				changes: [{ kind: "status", from: task.from, to: task.status }],
			});
			return item ? [item] : [];
		});
		const taskIds = tasks.map((task) => task.blockId);
		out.push({
			narratorId: root,
			messageId: outlineTaskFinishedMessageId(event, root, taskIds),
			locale,
			content: getOutlineTaskFinishedNote({ by, entries, more }, locale),
			body: {
				kind: "outlineTasks",
				variant: "finished",
				items,
				...(more > 0 ? { more } : {}),
			},
			taskIds,
			// A message that names nothing never wakes; a person's commit never does (PR 5's rule).
			wake: !person && items.length > 0,
		});
	}
	return out;
}

/**
 * Tell the sessions a commit finished tasks of (see the module header). Errors are logged per
 * session: one that fails does not keep the others from being told.
 */
export async function deliverOutlineTaskFinished(
	event: OutlineCommitEvent,
	options: { store?: OutlineStore } = {},
): Promise<{ told: string[]; woke: number }> {
	if (!isOutlineEnabled()) return { told: [], woke: 0 };
	const delivery = deliverySeam ?? realDelivery;
	const told: string[] = [];
	let woke = 0;
	for (const message of await readOutlineTaskFinishedMessages(event, options)) {
		try {
			const result = await delivery.deliver(message);
			if (!result.written) continue;
			told.push(message.narratorId);
			if (result.woke) woke++;
		} catch (error) {
			logger.warn("Failed to tell a session its tasks were finished", {
				narratorId: message.narratorId,
				spaceId: event.spaceId,
				seq: event.seq,
				error: String(error),
			});
		}
	}
	return { told, woke };
}

const inflight = hotSafe("narrafork.outlineTaskFinished.inflight", () => new Set<Promise<void>>());

/** Wait for every commit being read and told (tests). */
export async function settleOutlineTaskFinishedForTests(): Promise<void> {
	await Promise.allSettled([...inflight]);
}

/** Listen for commits (once per process; the server starts it with the outline jobs). */
export function startOutlineTaskFinishedNotices(): void {
	if (!hotOnce("narrafork.outlineTaskFinished.listener")) return;
	eventBus.on("outline:committed", (event) => {
		if (!isOutlineEnabled()) return;
		const work = deliverOutlineTaskFinished(event)
			.then(() => {})
			.catch((error) =>
				logger.warn("Failed to read a commit's finished tasks", {
					spaceId: event.spaceId,
					seq: event.seq,
					error: String(error),
				}),
			);
		inflight.add(work);
		void work.finally(() => inflight.delete(work));
	});
}
