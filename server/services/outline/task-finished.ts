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
 * One message per session told and commit, naming at most
 * {@link OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit} tasks across the commit (the rest are
 * counted in the message of the session they belong to), in the session's language (its owner's).
 * Delivered like PR 7's answers (`questions.ts`): `deliverInjection` as a system row (`sys`,
 * `outline_task_finished`), waking the session when it is idle (`wakeIfIdle`); on PostgreSQL the
 * row is written and nothing is woken (the session runtime does not run there yet), and the chosen
 * id is not used. The row's id follows from (commit, session, tasks): delivering the same commit
 * again finds it and writes nothing. There is no retry queue: a process that stops between the
 * commit and the delivery loses the message (PR 10 folds this into the runtime inbox's `team`
 * channel, with persistence).
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
	/** Tasks named across one commit's messages; the rest are counted. */
	listedPerCommit: 20,
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

/** The injection a message is written as: on PostgreSQL no chosen id and no wake (PR 7, S6). */
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
		schedule: postgres ? ("none" as const) : ("wakeIfIdle" as const),
		locale: message.locale,
	};
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
	for (const task of finished) {
		// The manager may be a subagent of the session (it wrote the task): its session is told.
		const session = sessions.get(task.manager);
		if (!session || session.sessionArchived) continue;
		const root = session.root;
		// Its own session (or a subagent of it) finished it: nothing to tell.
		if (finisherRoot !== null && root === finisherRoot) continue;
		// A person's change PR 5 already tells this session of.
		if (told.get(task.blockId) === root) continue;
		if (!backends.has(root)) backends.set(root, (await readTaskBackend(root)) === "outline");
		if (!backends.get(root)) continue;
		byManager.set(root, [...(byManager.get(root) ?? []), task]);
	}
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

	let listed = 0;
	const out: OutlineTaskFinishedMessage[] = [];
	for (const [root, tasks] of byManager) {
		const owner = (await readNarrator(root))?.ownerUserId ?? null;
		const locale: Locale = owner ? await getUserLanguage(owner).catch(() => "en" as const) : "en";
		const by =
			commit.actorKind === "human"
				? (names?.users.get(commit.actorId) ?? commit.actorId)
				: finisherRoot
					? locale === "zh-CN"
						? `会话「${clip(names?.narrators.get(finisherRoot) ?? finisherRoot)}」`
						: `session "${clip(names?.narrators.get(finisherRoot) ?? finisherRoot)}"`
					: locale === "zh-CN"
						? "系统"
						: "the system";
		const room = Math.max(0, OUTLINE_TASK_FINISHED_LIMITS.listedPerCommit - listed);
		const shown = tasks.slice(0, room);
		listed += shown.length;
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
				by,
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
