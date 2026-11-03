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
 *
 * WHOSE SESSION
 * -------------
 * A task of a session space: that session. A task elsewhere (a project's): the session doing it,
 * or the one that did it last (its claim). Only sessions whose tasks live in the outline.
 * `/goal` skips its own commit ({@link skipOutlineTaskEditNotice}): its message tells the agent.
 *
 * HOW IT IS DELIVERED (as `server/routes/spec.ts` does it for the Spec panel)
 * -----------------------------------------------------------------------------
 * Changes are merged per session and person for {@link OUTLINE_TASK_EDIT_TIMING.quietMs} of quiet
 * (at most {@link OUTLINE_TASK_EDIT_TIMING.maxMs}), then one note in the person's language:
 *   - the session is working: a cut-in user message at the front of its queue with a soft stop;
 *     while that message is still queued, later changes are merged into it;
 *   - idle: no wake (a person tidying up must not cost a request); the note is written as a user
 *     injection the next turn reads.
 *
 * LIVE BOARD
 * ----------
 * Any commit to a session space, an agent's commit anywhere, and a change of what waits for
 * confirmation send that session's subscribers `outline_tasks_changed` (ids only, merged within
 * {@link OUTLINE_TASK_EDIT_TIMING.boardMs}); the board reads again.
 *
 * Reads are bounded and indexed (a commit's versions, the versions before them by primary key,
 * the claims of the tasks); the listeners only queue work, never block the commit.
 */
import { blockTitle } from "@shared/outline";
import { OUTLINE_TASKS_CHANGED_EVENT } from "@shared/outline-task-board";
import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import {
	getOutlineTaskEditNote,
	getUserLanguage,
	type Locale,
	type OutlineTaskEdit,
	type OutlineTaskEditChange,
} from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { getBufferedMessages } from "./narrator-buffer";
import { isOutlineEnabled } from "./outline/feature";
import { OUTLINE_CHANGE, type OutlineTaskJson } from "./outline/model";
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
};

export const OUTLINE_TASK_EDIT_LIMITS = {
	/** Versions of one commit read back. */
	versionsPerCommit: 100,
	/** Tasks one note lists; the rest are counted. */
	editsPerNote: 20,
	/** Spaces whose kind and session are remembered. */
	spaceCache: 4096,
} as const;

/** The flags of a version that may be a structural task change; text alone is not. */
const STRUCTURAL =
	OUTLINE_CHANGE.CREATE |
	OUTLINE_CHANGE.DELETE |
	OUTLINE_CHANGE.RESTORE |
	OUTLINE_CHANGE.TASK |
	OUTLINE_CHANGE.MOVE;

interface Batch {
	narratorId: string;
	userId: string;
	/** By task id, in the order first changed; each with the commits it came from. */
	edits: Map<string, { edit: OutlineTaskEdit; commits: Set<string> }>;
	firstAt: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const state = hotSafe("narrafork.outlineTaskEdits", () => ({
	batches: new Map<string, Batch>(),
	inflight: new Set<Promise<void>>(),
	skip: new Map<string, number>(),
	/** The still-queued cut-in message per session, and the edits it holds. */
	cutIns: new Map<string, string>(),
	cutInEdits: new Map<string, OutlineTaskEdit[]>(),
	boardTimers: new Map<string, ReturnType<typeof setTimeout>>(),
	spaces: new Map<string, Pick<OutlineSpaceRow, "kind" | "narratorId" | "key">>(),
}));

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

/** The structural task changes of one person's commit, by the session each is told to. */
export async function readTaskEditsOfCommit(event: {
	spaceId: string;
	commitId: string;
	seq: number;
}): Promise<Map<string, Array<{ taskId: string; edit: OutlineTaskEdit }>>> {
	const out = new Map<string, Array<{ taskId: string; edit: OutlineTaskEdit }>>();
	const space = await spaceOf(event.spaceId);
	if (!space) return out;
	const versions = (
		await outlineStore.listCommitVersions(
			event.commitId,
			OUTLINE_TASK_EDIT_LIMITS.versionsPerCommit,
		)
	).filter((v) => (v.changeFlags & STRUCTURAL) !== 0);
	if (versions.length === 0) return out;
	const prior = await outlineStore.listVersionsAtSeqs(
		versions
			.filter((v) => (v.changeFlags & OUTLINE_CHANGE.CREATE) === 0)
			.map((v) => ({ blockId: v.blockId, seq: event.seq - 1 })),
	);
	const previous = new Map(prior.map((row) => [row.blockId, row]));
	const key = space.key;
	const sids = new Map(
		(await outlineStore.getBlockMetas(event.spaceId, { ids: versions.map((v) => v.blockId) })).map(
			(m) => [m.id, m.sid],
		),
	);
	const edits: Array<{ taskId: string; edit: OutlineTaskEdit }> = [];
	for (const version of versions) {
		const prev = previous.get(version.blockId);
		const before = prev && !prev.deleted ? prev.taskJson : null;
		const after = version.deleted ? null : version.taskJson;
		const changes = changesOf(before, after, version);
		if (changes.length === 0) continue;
		const task = after ?? before;
		const content = version.content ?? prev?.content ?? "";
		edits.push({
			taskId: version.blockId,
			edit: {
				address: `${key}/${sids.get(version.blockId) ?? "?"}`,
				title: blockTitle(content).replace(/\s+/g, " ").trim().slice(0, 160),
				humanCreated: task?.humanCreated === true,
				locked: !!after?.lock,
				changes,
			},
		});
	}
	if (edits.length === 0) return out;

	const sessions = new Map<string, string[]>();
	if (space.kind === "session" && space.narratorId) {
		sessions.set(
			space.narratorId,
			edits.map((e) => e.taskId),
		);
	} else {
		// Elsewhere: the session doing each task, or the one that did it last.
		const claims = await outlineStore.getTaskClaims(edits.map((e) => e.taskId));
		const holders = new Map<string, string>();
		for (const claim of claims) {
			const holder = claim.holderNarratorId ?? claim.lastHolderNarratorId;
			if (holder) holders.set(claim.taskBlockId, holder);
		}
		const roots = await outlineStore.getNarratorRoots([...new Set(holders.values())]);
		for (const [taskId, holder] of holders) {
			const root = roots.get(holder)?.root ?? holder;
			sessions.set(root, [...(sessions.get(root) ?? []), taskId]);
		}
	}
	for (const [narratorId, taskIds] of sessions) {
		if ((await readTaskBackend(narratorId)) !== "outline") continue;
		const wanted = new Set(taskIds);
		out.set(
			narratorId,
			edits.filter((e) => wanted.has(e.taskId)),
		);
	}
	return out;
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
		} else if (at < 0) changes.push(change);
	}
	return { ...next, humanCreated: into.humanCreated || next.humanCreated, changes };
}

function addToBatch(
	narratorId: string,
	userId: string,
	commitId: string,
	edits: Array<{ taskId: string; edit: OutlineTaskEdit }>,
): void {
	const key = `${narratorId}\u0000${userId}`;
	let batch = state.batches.get(key);
	if (!batch) {
		batch = { narratorId, userId, edits: new Map(), firstAt: Date.now(), timer: undefined };
		state.batches.set(key, batch);
	}
	for (const { taskId, edit } of edits) {
		const existing = batch.edits.get(taskId);
		if (existing) {
			existing.edit = mergeEdit(existing.edit, edit);
			existing.commits.add(commitId);
		} else batch.edits.set(taskId, { edit, commits: new Set([commitId]) });
	}
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
		void flushBatch(key, current);
	}, wait);
}

async function flushBatch(key: string, batch: Batch): Promise<void> {
	if (state.batches.get(key) !== batch) return;
	state.batches.delete(key);
	if (batch.timer) clearTimeout(batch.timer);
	const edits = [...batch.edits.values()]
		.filter(({ commits }) => [...commits].some((id) => !state.skip.has(id)))
		.map(({ edit }) => edit);
	if (edits.length === 0) return;
	try {
		await deliverTaskEdits(batch.narratorId, batch.userId, edits);
	} catch (error) {
		logger.warn("Failed to tell a session about task changes", {
			narratorId: batch.narratorId,
			error: String(error),
		});
	}
}

async function deliverTaskEdits(
	narratorId: string,
	userId: string,
	edits: OutlineTaskEdit[],
): Promise<void> {
	const locale = await getUserLanguage(userId);
	const { isLoopRunning } = await import("./narrator-session");
	if (isLoopRunning(narratorId)) {
		// Still queued: the new changes join the message already waiting at the front.
		const tracked = state.cutIns.get(narratorId);
		const queued =
			tracked !== undefined && getBufferedMessages(narratorId).some((m) => m.id === tracked);
		const all = [...(queued ? (state.cutInEdits.get(narratorId) ?? []) : []), ...edits];
		const { cutInUserMessage } = await import("./spec-edit-interject");
		if (await cutInUserMessage(narratorId, noteText(all, locale), userId, state.cutIns)) {
			state.cutInEdits.set(narratorId, all);
			return;
		}
	}
	state.cutInEdits.delete(narratorId);
	const text = noteText(edits, locale);
	const { deliverInjection } = await import("./narrator-injection");
	await deliverInjection(narratorId, {
		content: text,
		source: "outline_task_edit",
		body: { kind: "prose", text },
		role: "user",
		schedule: "none",
		locale,
		createdBy: userId,
	});
}

function noteText(edits: readonly OutlineTaskEdit[], locale: Locale): string {
	const shown = edits.slice(0, OUTLINE_TASK_EDIT_LIMITS.editsPerNote);
	return getOutlineTaskEditNote(shown, edits.length - shown.length, locale);
}

/**
 * Tell `narratorId` now what people changed of its tasks (the board does this before it starts
 * the session, so the turn reads the note): the commits read so far are finished first.
 */
export async function flushOutlineTaskEdits(narratorId: string): Promise<void> {
	await Promise.allSettled([...state.inflight]);
	for (const [key, batch] of [...state.batches]) {
		if (batch.narratorId === narratorId) await flushBatch(key, batch);
	}
}

/** Wait for every commit being read and every batch being told (tests). */
export async function settleOutlineTaskEditsForTests(): Promise<void> {
	await Promise.allSettled([...state.inflight]);
	for (const [key, batch] of [...state.batches]) await flushBatch(key, batch);
}

/** Forget every batch, skip and cut-in (tests). */
export function resetOutlineTaskEditsForTests(): void {
	for (const batch of state.batches.values()) if (batch.timer) clearTimeout(batch.timer);
	for (const timer of state.boardTimers.values()) clearTimeout(timer);
	state.batches.clear();
	state.skip.clear();
	state.cutIns.clear();
	state.cutInEdits.clear();
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

async function refreshBoardsOf(event: {
	spaceId: string;
	actorKind?: string;
	actorId?: string;
}): Promise<void> {
	const space = await spaceOf(event.spaceId);
	if (space?.kind === "session" && space.narratorId) refreshBoard(space.narratorId);
	if (event.actorKind === "agent" && event.actorId) {
		const root = (await outlineStore.getNarratorRoots([event.actorId])).get(event.actorId)?.root;
		if (root && root !== space?.narratorId) refreshBoard(root);
	}
}

function track(work: Promise<void>): void {
	state.inflight.add(work);
	void work.finally(() => state.inflight.delete(work));
}

if (hotOnce("narrafork.outlineTaskEdits.listeners")) {
	eventBus.on("outline:committed", (event) => {
		if (!isOutlineEnabled()) return;
		track(
			refreshBoardsOf(event).catch((error) =>
				logger.debug("Outline board refresh failed", { error: String(error) }),
			),
		);
		if (event.actorKind !== "human") return;
		track(
			readTaskEditsOfCommit(event)
				.then((bySession) => {
					for (const [narratorId, edits] of bySession)
						addToBatch(narratorId, event.actorId, event.commitId, edits);
				})
				.catch((error) =>
					logger.warn("Failed to read a person's task changes", {
						spaceId: event.spaceId,
						error: String(error),
					}),
				),
		);
	});
	eventBus.on("outline:pending", (event) => {
		if (!isOutlineEnabled()) return;
		track(refreshBoardsOf(event).catch(() => {}));
	});
}
