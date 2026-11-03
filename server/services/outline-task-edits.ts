/**
 * People's changes to a session's outline tasks, told to the session (outline P2 PR 5, plan §6,
 * owner Q4 B), and the board's live refresh.
 *
 * WHAT COUNTS
 * -----------
 * Every person's commit (`outline:committed`, actor `human`) is read back, its versions only
 * (at most {@link OUTLINE_TASK_EDIT_LIMITS.versionsPerCommit}), for structural task changes: a task
 * added, deleted, or no longer a task; its checkbox, assignee, prerequisites or due date; locked
 * or unlocked; moved. Text edits do not count: the current-tasks view already carries the new
 * text at the next request. So the task board's actions and the live outline editor are one path.
 * Checkboxes on a session's behavior page are rules, not tasks, and are left out (as the board
 * and the task source leave them out). A person rejecting the agent's marking a locked goal done
 * (D26b) counts too: that decision writes no commit, so it is heard on `outline:pending_rejected`.
 *
 * WHOSE SESSION
 * -------------
 * A task of a session space: that session. A task elsewhere (a project's): the session doing it,
 * or the one that did it last (its claim). Only sessions whose tasks live in the outline.
 * `/goal` skips its own commit ({@link skipOutlineTaskEditNotice}): its message tells the agent.
 *
 * HOW IT IS DELIVERED: A SYSTEM NOTICE, NEVER A PERSON'S MESSAGE
 * ---------------------------------------------------------------
 * The person who changed a task may have no access to the session (a project's writer changing a
 * task some private session holds), so the notice is never theirs: not a user message, not
 * `createdBy` them, never a run's principal. It is a system injection (`outline_task_edit`,
 * `docs/INJECTION.md`) that names who changed what, and says no more than the outline holds,
 * which the session can read anyway.
 *
 * Changes are merged per session (each person's own lines kept apart and named) for
 * {@link OUTLINE_TASK_EDIT_TIMING.quietMs} of quiet, at most {@link OUTLINE_TASK_EDIT_TIMING.maxMs}:
 *   - the session is working: the notice waits in memory and the run takes it at its next tool
 *     boundary (`drainInjectionsIntoHistory`, as background completions are taken), merged with
 *     anything still waiting; a run that ends first leaves it written as below;
 *   - idle: no wake (a person tidying up must not cost a request); the notice is written as a row
 *     the next turn reads.
 *
 * LIVE BOARD
 * ----------
 * A commit that changes tasks a session's board shows (structurally, by anyone: the session
 * itself, the session holding a project's task, a person), and a change of what waits for
 * confirmation (on its own space, or proposed by it anywhere: `outline:pending` names the
 * proposer), send that session's subscribers `outline_tasks_changed` (ids only, merged within
 * {@link OUTLINE_TASK_EDIT_TIMING.boardMs}); the board and the status bar read again. Text-only
 * commits (a task reworded, a note) do not: the board's next read shows the new words.
 *
 * Reads are bounded and indexed (a commit's versions, the versions before them by primary key,
 * the claims of the tasks, the behavior page by alias); the listeners only queue work, never
 * block the commit.
 */
import { blockTitle } from "@shared/outline";
import { OUTLINE_TASKS_CHANGED_EVENT } from "@shared/outline-task-board";
import type { SideCarBody } from "@shared/sidecar-body";
import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import {
	getOutlineTaskEditNote,
	getUserLanguage,
	type Locale,
	type OutlineTaskEdit,
	type OutlineTaskEditChange,
	type OutlineTaskEditGroup,
} from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { readDisplayNames, readNarrator } from "./outline/access-reads";
import { isOutlineEnabled } from "./outline/feature";
import { OUTLINE_BEHAVIOR_ALIAS, OUTLINE_CHANGE, type OutlineTaskJson } from "./outline/model";
import { pendingOps } from "./outline/pending-hold";
import { outlineStore } from "./outline/store";
import type { OutlineSpaceRow, OutlineVersionRow } from "./outline/store/port";
import { readTaskBackend } from "./task-source/backend";

export const OUTLINE_TASK_EDIT_TIMING = {
	/** A session's batch of changes is told after this much quiet… */
	quietMs: 1_000,
	/** …and at most this long after its first change. */
	maxMs: 4_000,
	/** Board refreshes of one session are merged within this window. */
	boardMs: 250,
	/** How long a commit `/goal` made stays skipped. */
	skipMs: 60_000,
	/** How often a notice waiting for a run's next tool boundary checks the run is still on. */
	watchMs: 2_000,
};

export const OUTLINE_TASK_EDIT_LIMITS = {
	/** Versions of one commit read back. */
	versionsPerCommit: 100,
	/** Tasks one notice lists; the rest are counted. */
	editsPerNote: 20,
	/** Spaces whose kind and session are remembered. */
	spaceCache: 4096,
	/** Changes one session's waiting notice holds; the oldest go first past it. */
	queuedPerSession: 200,
} as const;

/** The flags of a version that may be a structural task change; text alone is not. */
const STRUCTURAL =
	OUTLINE_CHANGE.CREATE |
	OUTLINE_CHANGE.DELETE |
	OUTLINE_CHANGE.RESTORE |
	OUTLINE_CHANGE.TASK |
	OUTLINE_CHANGE.MOVE;

/** Who made a change: a person, or a session confirming for a goal's locker. */
type Who = { kind: "human" | "agent"; id: string };

/** One task's changes by one person, and the commits they came from. */
interface Entry {
	who: Who;
	taskId: string;
	edit: OutlineTaskEdit;
	commits: Set<string>;
}

/** A running session's waiting notice: its changes, and how many the cap let go (counted). */
interface Waiting {
	entries: Map<string, Entry>;
	dropped: number;
}

interface Batch {
	narratorId: string;
	/** By person and task, in the order first changed. */
	entries: Map<string, Entry>;
	firstAt: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const state = hotSafe("narrafork.outlineTaskEdits", () => ({
	batches: new Map<string, Batch>(),
	inflight: new Set<Promise<void>>(),
	skip: new Map<string, number>(),
	/** Notices waiting for a running session's next tool boundary, by session. */
	waiting: new Map<string, Waiting>(),
	watchers: new Map<string, ReturnType<typeof setInterval>>(),
	boardTimers: new Map<string, ReturnType<typeof setTimeout>>(),
	spaces: new Map<string, Pick<OutlineSpaceRow, "kind" | "narratorId" | "key">>(),
}));

const entryKey = (who: Who, taskId: string) => `${who.kind}:${who.id}\u0000${taskId}`;

/** Do not tell the session about this commit (`/goal`: its own message does). */
export function skipOutlineTaskEditNotice(commitId: string): void {
	const now = Date.now();
	for (const [id, until] of state.skip) if (until < now) state.skip.delete(id);
	state.skip.set(commitId, now + OUTLINE_TASK_EDIT_TIMING.skipMs);
}

async function spaceOf(
	spaceId: string,
): Promise<Pick<OutlineSpaceRow, "kind" | "narratorId" | "key"> | null> {
	const cached = state.spaces.get(spaceId);
	if (cached) return cached;
	const space = await outlineStore.getSpace(spaceId);
	if (!space) return null;
	// None of these ever change for a space.
	const entry = { kind: space.kind, narratorId: space.narratorId, key: space.key };
	state.spaces.set(spaceId, entry);
	while (state.spaces.size > OUTLINE_TASK_EDIT_LIMITS.spaceCache) {
		const oldest = state.spaces.keys().next().value;
		if (oldest === undefined) break;
		state.spaces.delete(oldest);
	}
	return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a commit
// ─────────────────────────────────────────────────────────────────────────────

function changesOf(
	before: OutlineTaskJson | null,
	after: OutlineTaskJson | null,
	version: OutlineVersionRow,
): OutlineTaskEditChange[] {
	if (!before && !after) return [];
	if (!before) return [{ kind: "added" }];
	if (!after) return [{ kind: version.deleted ? "deleted" : "unchecked" }];
	const out: OutlineTaskEditChange[] = [];
	if (before.status !== after.status)
		out.push({ kind: "status", from: before.status, to: after.status });
	if ((before.assignee ?? null) !== (after.assignee ?? null))
		out.push({ kind: "assigned", to: after.assignee ?? null });
	if (!before.lock && after.lock) out.push({ kind: "locked" });
	if (before.lock && !after.lock) out.push({ kind: "unlocked" });
	if (
		(before.due ?? null) !== (after.due ?? null) ||
		JSON.stringify(before.depends ?? []) !== JSON.stringify(after.depends ?? [])
	)
		out.push({ kind: "fields" });
	if (out.length === 0 && version.changeFlags & OUTLINE_CHANGE.MOVE) out.push({ kind: "moved" });
	return out;
}

export interface CommitTaskChanges {
	/** Sessions whose board shows a task this commit changed (structure or text). */
	refresh: Set<string>;
	/** A person's structural changes, by the session told of them (outline sessions only). */
	told: Map<string, Array<{ taskId: string; edit: OutlineTaskEdit }>>;
}

/**
 * What one commit changed of tasks: the sessions whose boards show them, and (for a person's
 * commit) the structural changes each session is told of.
 */
export async function readCommitTaskChanges(event: {
	spaceId: string;
	commitId: string;
	seq: number;
	actorKind: "human" | "agent" | "system";
	actorId: string;
}): Promise<CommitTaskChanges> {
	const out: CommitTaskChanges = { refresh: new Set(), told: new Map() };
	const space = await spaceOf(event.spaceId);
	if (!space) return out;
	const versions = await outlineStore.listCommitVersions(
		event.commitId,
		OUTLINE_TASK_EDIT_LIMITS.versionsPerCommit,
	);
	// Text alone (a task reworded, a note written) changes no task, nor does a block created
	// without a checkbox: nothing is read further.
	const candidates = versions.filter(
		(v) =>
			(v.changeFlags & STRUCTURAL) !== 0 &&
			!((v.changeFlags & OUTLINE_CHANGE.CREATE) !== 0 && v.taskJson === null),
	);
	if (candidates.length === 0) return out;
	const prior = await outlineStore.listVersionsAtSeqs(
		candidates
			.filter((v) => (v.changeFlags & OUTLINE_CHANGE.CREATE) === 0)
			.map((v) => ({ blockId: v.blockId, seq: event.seq - 1 })),
	);
	const previous = new Map(prior.map((row) => [row.blockId, row]));
	// A session's behavior page holds rules, not tasks.
	const rules = new Set(
		space.kind === "session"
			? (await outlineStore.findAliasOwners(event.spaceId, [OUTLINE_BEHAVIOR_ALIAS])).map(
					(o) => o.id,
				)
			: [],
	);
	const counted = candidates.filter((v) => !rules.has(v.pageId));
	const changed: Array<{ taskId: string; edit: OutlineTaskEdit }> = [];
	const sids = new Map(
		(await outlineStore.getBlockMetas(event.spaceId, { ids: counted.map((v) => v.blockId) })).map(
			(m) => [m.id, m.sid],
		),
	);
	for (const version of counted) {
		const prev = previous.get(version.blockId);
		const before = prev && !prev.deleted ? prev.taskJson : null;
		const after = version.deleted ? null : version.taskJson;
		const changes = changesOf(before, after, version);
		if (changes.length === 0) continue;
		const task = after ?? before;
		const content = version.content ?? prev?.content ?? "";
		changed.push({
			taskId: version.blockId,
			edit: {
				address: `${space.key}/${sids.get(version.blockId) ?? "?"}`,
				title: blockTitle(content).replace(/\s+/g, " ").trim().slice(0, 160),
				humanCreated: task?.humanCreated === true,
				locked: !!after?.lock,
				changes,
			},
		});
	}
	if (changed.length === 0) return out;

	// Whose tasks they are: a session space's own session; elsewhere, whoever holds or held them.
	const sessions = new Map<string, Set<string>>();
	if (space.kind === "session" && space.narratorId) {
		sessions.set(space.narratorId, new Set(changed.map((e) => e.taskId)));
	} else {
		const claims = await outlineStore.getTaskClaims(changed.map((e) => e.taskId));
		const holders = new Map<string, string>();
		for (const claim of claims) {
			const holder = claim.holderNarratorId ?? claim.lastHolderNarratorId;
			if (holder) holders.set(claim.taskBlockId, holder);
		}
		const roots = await outlineStore.getNarratorRoots([...new Set(holders.values())]);
		for (const [taskId, holder] of holders) {
			const root = roots.get(holder)?.root ?? holder;
			const set = sessions.get(root) ?? new Set<string>();
			set.add(taskId);
			sessions.set(root, set);
		}
	}
	for (const narratorId of sessions.keys()) out.refresh.add(narratorId);
	if (event.actorKind === "agent") {
		const root = (await outlineStore.getNarratorRoots([event.actorId])).get(event.actorId)?.root;
		if (root) out.refresh.add(root);
	}
	if (event.actorKind !== "human") return out;
	for (const [narratorId, taskIds] of sessions) {
		const edits = changed.filter((e) => taskIds.has(e.taskId));
		if (edits.length === 0) continue;
		if ((await readTaskBackend(narratorId)) !== "outline") continue;
		out.told.set(narratorId, edits);
	}
	return out;
}

/**
 * A rejected change that asked to end a locked goal (D26b): the proposing session is told who
 * rejected it and why. Other rejections are told to the proposer on its next read (PR 6).
 */
export async function readRejectedCompletion(pendingId: string): Promise<{
	narratorId: string;
	who: Who;
	taskId: string;
	edit: OutlineTaskEdit;
} | null> {
	const [row] = await outlineStore.getPending([pendingId]);
	if (!row || row.status !== "rejected" || !row.rootBlockId || !row.requesterSession) return null;
	const root = row.rootBlockId;
	let status: "done" | "cancelled" | null = null;
	for (const op of pendingOps(row)) {
		if (op.op !== "setTask" || !("id" in op.block) || op.block.id !== root) continue;
		const next = op.task?.status;
		if (next === "done" || next === "cancelled") status = next;
	}
	if (!status || !row.decidedByJson) return null;
	// A subagent's proposal is its session's: the session is told.
	const requester = row.requesterSession;
	const narratorId =
		(await outlineStore.getNarratorRoots([requester])).get(requester)?.root ?? requester;
	if ((await readTaskBackend(narratorId)) !== "outline") return null;
	const [block] = await outlineStore.getBlockMetas(row.spaceId, { ids: [root] });
	const space = await spaceOf(row.spaceId);
	if (!block || !space) return null;
	const [head] = await outlineStore.getBlockHeads([root]);
	return {
		narratorId,
		who: { kind: row.decidedByJson.kind === "human" ? "human" : "agent", id: row.decidedByJson.id },
		taskId: root,
		edit: {
			address: `${space.key}/${block.sid}`,
			title: blockTitle(head?.contentHead ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 160),
			humanCreated: block.taskJson?.humanCreated === true,
			locked: !!block.taskJson?.lock,
			changes: [{ kind: "rejected", status, reason: row.reason }],
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Batching and delivery
// ─────────────────────────────────────────────────────────────────────────────

function mergeEdit(into: OutlineTaskEdit, next: OutlineTaskEdit): OutlineTaskEdit {
	const changes = [...into.changes];
	for (const change of next.changes) {
		const at = changes.findIndex((c) => c.kind === change.kind);
		if (at >= 0 && (change.kind === "status" || change.kind === "assigned")) {
			const first = changes[at];
			// A status says where it started and where it ended; back where it started, the last
			// step is what the person did (a task done and then reopened was reopened).
			changes[at] =
				change.kind === "status" && first?.kind === "status" && first.from !== change.to
					? { kind: "status", from: first.from, to: change.to }
					: change;
		} else if (at >= 0 && change.kind === "rejected") changes[at] = change;
		else if (at < 0) changes.push(change);
	}
	return { ...next, humanCreated: into.humanCreated || next.humanCreated, changes };
}

/** Merge `entry` into `entries`, kept apart per person and task. */
function mergeInto(entries: Map<string, Entry>, entry: Entry): void {
	const key = entryKey(entry.who, entry.taskId);
	const existing = entries.get(key);
	if (existing) {
		existing.edit = mergeEdit(existing.edit, entry.edit);
		for (const commit of entry.commits) existing.commits.add(commit);
	} else entries.set(key, { ...entry, commits: new Set(entry.commits) });
}

function addToBatch(narratorId: string, entries: readonly Entry[]): void {
	let batch = state.batches.get(narratorId);
	if (!batch) {
		batch = { narratorId, entries: new Map(), firstAt: Date.now(), timer: undefined };
		state.batches.set(narratorId, batch);
	}
	for (const entry of entries) mergeInto(batch.entries, entry);
	if (batch.timer) clearTimeout(batch.timer);
	const wait = Math.max(
		0,
		Math.min(
			OUTLINE_TASK_EDIT_TIMING.quietMs,
			batch.firstAt + OUTLINE_TASK_EDIT_TIMING.maxMs - Date.now(),
		),
	);
	const current = batch;
	current.timer = setTimeout(() => {
		void flushBatch(current);
	}, wait);
}

async function flushBatch(batch: Batch): Promise<void> {
	if (state.batches.get(batch.narratorId) !== batch) return;
	state.batches.delete(batch.narratorId);
	if (batch.timer) clearTimeout(batch.timer);
	const entries = [...batch.entries.values()].filter(
		(entry) => entry.commits.size === 0 || [...entry.commits].some((id) => !state.skip.has(id)),
	);
	if (entries.length === 0) return;
	try {
		const { isLoopRunning } = await import("./narrator-session");
		if (isLoopRunning(batch.narratorId)) {
			// The run takes it at its next tool boundary (`takeOutlineTaskEditNotice`).
			const waiting = state.waiting.get(batch.narratorId) ?? { entries: new Map(), dropped: 0 };
			for (const entry of entries) mergeInto(waiting.entries, entry);
			// Past the cap the oldest go, counted: the notice says how many more there were.
			while (waiting.entries.size > OUTLINE_TASK_EDIT_LIMITS.queuedPerSession) {
				const oldest = waiting.entries.keys().next().value;
				if (oldest === undefined) break;
				waiting.entries.delete(oldest);
				waiting.dropped++;
			}
			state.waiting.set(batch.narratorId, waiting);
			watch(batch.narratorId);
			return;
		}
		await writeNotice(batch.narratorId, entries);
	} catch (error) {
		logger.warn("Failed to tell a session about task changes", {
			narratorId: batch.narratorId,
			error: String(error),
		});
	}
}

/** A run that ends before taking its waiting notice leaves it written for its next turn. */
function watch(narratorId: string): void {
	if (state.watchers.has(narratorId)) return;
	const timer = setInterval(() => {
		void (async () => {
			const waiting = state.waiting.get(narratorId);
			if (!waiting || waiting.entries.size === 0) {
				clearInterval(timer);
				state.watchers.delete(narratorId);
				return;
			}
			const { isLoopRunning } = await import("./narrator-session");
			if (isLoopRunning(narratorId)) return;
			state.waiting.delete(narratorId);
			clearInterval(timer);
			state.watchers.delete(narratorId);
			await writeNotice(narratorId, [...waiting.entries.values()], waiting.dropped).catch((error) =>
				logger.warn("Failed to write a waiting task-change notice", {
					narratorId,
					error: String(error),
				}),
			);
		})();
	}, OUTLINE_TASK_EDIT_TIMING.watchMs);
	state.watchers.set(narratorId, timer);
}

/** The notice's text and body for these changes, in `locale`, people named by their usernames. */
async function noticeOf(
	entries: readonly Entry[],
	locale: Locale,
	/** Changes the waiting cap let go: counted with those not listed. */
	dropped = 0,
): Promise<{ content: string; body: SideCarBody }> {
	const names = await readDisplayNames({
		userIds: entries.filter((e) => e.who.kind === "human").map((e) => e.who.id),
		narratorIds: entries.filter((e) => e.who.kind === "agent").map((e) => e.who.id),
	});
	const nameOf = (who: Who): string =>
		who.kind === "human"
			? (names.users.get(who.id) ?? who.id)
			: `${locale === "zh-CN" ? "会话" : "session"} ${names.narrators.get(who.id) ?? who.id}`;
	const shown = entries.slice(0, OUTLINE_TASK_EDIT_LIMITS.editsPerNote);
	const groups = new Map<string, OutlineTaskEditGroup>();
	for (const entry of shown) {
		const key = `${entry.who.kind}:${entry.who.id}`;
		const group = groups.get(key) ?? { person: nameOf(entry.who), edits: [] };
		group.edits.push(entry.edit);
		groups.set(key, group);
	}
	const content = getOutlineTaskEditNote(
		[...groups.values()],
		entries.length - shown.length + dropped,
		locale,
	);
	return { content, body: { kind: "prose", text: content } };
}

/** Write the notice as a system row the session's next turn reads (no wake). */
async function writeNotice(
	narratorId: string,
	entries: readonly Entry[],
	dropped = 0,
): Promise<void> {
	const owner = (await readNarrator(narratorId))?.ownerUserId ?? null;
	const locale = owner ? await getUserLanguage(owner).catch(() => "en" as const) : "en";
	const { content, body } = await noticeOf(entries, locale, dropped);
	const { deliverInjection } = await import("./narrator-injection");
	await deliverInjection(narratorId, {
		content,
		source: "outline_task_edit",
		body,
		schedule: "none",
		locale,
	});
}

/**
 * The notice waiting for this running session, taken (`drainInjectionsIntoHistory`, at the run's
 * tool boundary): its text and body in the run's locale, or null when nothing waits.
 */
export async function takeOutlineTaskEditNotice(
	narratorId: string,
	locale: Locale,
): Promise<{ content: string; body: SideCarBody } | null> {
	const waiting = state.waiting.get(narratorId);
	if (!waiting || waiting.entries.size === 0) return null;
	state.waiting.delete(narratorId);
	return await noticeOf([...waiting.entries.values()], locale, waiting.dropped);
}

/**
 * Tell `narratorId` now what people changed of its tasks (the board does this before it starts
 * the session, so the turn reads the notice): the commits read so far are finished first, and a
 * notice still waiting for a run that has ended is written.
 */
export async function flushOutlineTaskEdits(narratorId: string): Promise<void> {
	await Promise.allSettled([...state.inflight]);
	const batch = state.batches.get(narratorId);
	if (batch) await flushBatch(batch);
	const waiting = state.waiting.get(narratorId);
	if (waiting && waiting.entries.size > 0) {
		const { isLoopRunning } = await import("./narrator-session");
		if (!isLoopRunning(narratorId)) {
			state.waiting.delete(narratorId);
			await writeNotice(narratorId, [...waiting.entries.values()], waiting.dropped);
		}
	}
}

/** Wait for every commit being read and every batch being told (tests). */
export async function settleOutlineTaskEditsForTests(): Promise<void> {
	await Promise.allSettled([...state.inflight]);
	for (const batch of [...state.batches.values()]) await flushBatch(batch);
}

/** Forget every batch, skip and waiting notice (tests). */
export function resetOutlineTaskEditsForTests(): void {
	for (const batch of state.batches.values()) if (batch.timer) clearTimeout(batch.timer);
	for (const timer of state.boardTimers.values()) clearTimeout(timer);
	for (const timer of state.watchers.values()) clearInterval(timer);
	state.batches.clear();
	state.skip.clear();
	state.waiting.clear();
	state.watchers.clear();
	state.boardTimers.clear();
	state.spaces.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Board refresh
// ─────────────────────────────────────────────────────────────────────────────

function refreshBoard(narratorId: string): void {
	if (state.boardTimers.has(narratorId)) return;
	state.boardTimers.set(
		narratorId,
		setTimeout(() => {
			state.boardTimers.delete(narratorId);
			broadcastToNarrator(narratorId, { type: OUTLINE_TASKS_CHANGED_EVENT, narratorId });
		}, OUTLINE_TASK_EDIT_TIMING.boardMs),
	);
}

function track(work: Promise<void>): void {
	state.inflight.add(work);
	void work.finally(() => state.inflight.delete(work));
}

if (hotOnce("narrafork.outlineTaskEdits.listeners")) {
	eventBus.on("outline:committed", (event) => {
		if (!isOutlineEnabled()) return;
		track(
			readCommitTaskChanges(event)
				.then((changes) => {
					for (const narratorId of changes.refresh) refreshBoard(narratorId);
					for (const [narratorId, edits] of changes.told)
						addToBatch(
							narratorId,
							edits.map(({ taskId, edit }) => ({
								who: { kind: "human" as const, id: event.actorId },
								taskId,
								edit,
								commits: new Set([event.commitId]),
							})),
						);
				})
				.catch((error) =>
					logger.warn("Failed to read a commit's task changes", {
						spaceId: event.spaceId,
						error: String(error),
					}),
				),
		);
	});
	eventBus.on("outline:pending", (event) => {
		if (!isOutlineEnabled()) return;
		track(
			(async () => {
				const space = await spaceOf(event.spaceId);
				if (space?.kind === "session" && space.narratorId) refreshBoard(space.narratorId);
				// The session the change is about (its proposer), wherever the task lives: a held
				// change to a project task shows on the board of the session doing it.
				const about = event.narratorIds ?? [];
				if (about.length === 0) return;
				const roots = await outlineStore.getNarratorRoots(about);
				for (const id of about) refreshBoard(roots.get(id)?.root ?? id);
			})().catch(() => {}),
		);
	});
	eventBus.on("outline:pending_rejected", (event) => {
		if (!isOutlineEnabled()) return;
		track(
			readRejectedCompletion(event.pendingId)
				.then((rejected) => {
					if (!rejected) return;
					refreshBoard(rejected.narratorId);
					addToBatch(rejected.narratorId, [
						{
							who: rejected.who,
							taskId: rejected.taskId,
							edit: rejected.edit,
							commits: new Set(),
						},
					]);
				})
				.catch((error) =>
					logger.warn("Failed to read a rejected completion", {
						pendingId: event.pendingId,
						error: String(error),
					}),
				),
		);
	});
}
