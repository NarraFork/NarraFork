/**
 * Pending changes (design §2.6) and the locks they come from (§2.2): locking and unlocking a
 * task tree, confirming and rejecting what an agent proposed for a locked plan, and the reads the
 * pages, the agent tools and the task source make of them.
 *
 * Proposals are made by the write path itself (`write.ts`, LOCKED PLANS AND PENDING
 * CONFIRMATION, and `pending-hold.ts`). This module decides them:
 *
 *   - CONFIRM ({@link confirmOutlinePending}): one `confirm` commit, written as the proposer (so
 *     the blocks are the proposer's, as written), its responsible person the decider's (a person
 *     confirming, or the person of the session confirming on the locker's behalf, design §2.5).
 *     The row becomes `confirmed` in the same atomic section. Blocks someone changed since the
 *     proposal are merged three ways from the version proposed against (`agent-merge.ts`: text
 *     that does not overlap, fields one by one); structure only has to still make sense (the
 *     targets exist, no cycle). When that fails nothing is written and the change stays open:
 *     the decider rejects it, or the proposer proposes again.
 *   - REJECT ({@link rejectOutlinePending}): no commit; the proposer is told once, on its next
 *     read of the page (`reported_at`). The proposer rejecting its own change withdraws it.
 *   - WHO DECIDES: the locker, or the session the locker named to confirm on their behalf (and
 *     its subagents). A session never confirms its own change (builder decision 7: the proposer is
 *     the proposing session, as for claims): a change the delegate proposed goes to the locker.
 *   - LOCK ({@link lockOutlineTask}, {@link unlockOutlineTask}): only people lock (owner decision
 *     Q5); the routes check who may. These are the server functions plan PR 5 (`/goal`) and PR 8
 *     (plan mode) lock through on a person's behalf. Unlocking withdraws the tree's open changes
 *     in the same commit (`write.ts`).
 *
 * Every read is indexed and bounded; merges run on the text worker when large.
 */
import { AppError, NotFoundError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { titleOf } from "@shared/outline";
import { readDisplayNames } from "./access-reads";
import { type AgentReplace, mergeAgentReplaces } from "./agent-merge";
import { OutlineWriteError } from "./errors";
import { contentLinks } from "./links";
import { withOutlineLiveBarrier } from "./live-barrier";
import { OUTLINE_TEXT } from "./messages";
import {
	OUTLINE_PENDING_LIMITS,
	type OutlineTaskActorRef,
	type OutlineTaskLockJson,
	outlinePendingLabel,
} from "./model";
import { PENDING_WITHDRAW, pendingOps } from "./pending-hold";
import { outlineStore } from "./store";
import {
	type OutlineBlockMeta,
	OutlinePendingMovedError,
	type OutlinePendingRow,
	type OutlineSpaceRow,
	type OutlineStore,
} from "./store/port";
import type { OutlineTaskSubject } from "./tasks";
import {
	type OutlineCanonicalContent,
	type OutlineOp,
	type OutlineTaskPatch,
	type OutlineWriteResult,
	writeOutline,
} from "./write";

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export type OutlinePendingErrorCode =
	/** No such pending change (or one the caller may not see). */
	| "OUTLINE_PENDING_NOT_FOUND"
	/** It was decided (or withdrawn) already. */
	| "OUTLINE_PENDING_DECIDED"
	/** The caller is not who decides it. */
	| "OUTLINE_PENDING_NOT_DECIDER"
	/** The caller's own session proposed it: it goes to the locker. */
	| "OUTLINE_PENDING_OWN"
	/** Blocks changed since it was proposed and the change no longer applies. */
	| "OUTLINE_PENDING_CONFLICT"
	/** Merged into (or decided) while being confirmed: look at it again. */
	| "OUTLINE_PENDING_CHANGED";

/** A decision that could not be made; nothing was written. */
export class OutlinePendingError extends AppError {
	constructor(
		message: string,
		readonly pendingCode: OutlinePendingErrorCode,
		/** For a conflict: what no longer applies, one line each. */
		readonly details: string[] = [],
	) {
		super(
			message,
			pendingCode === "OUTLINE_PENDING_NOT_FOUND"
				? 404
				: pendingCode === "OUTLINE_PENDING_NOT_DECIDER" || pendingCode === "OUTLINE_PENDING_OWN"
					? 403
					: 409,
			pendingCode,
		);
		this.name = "OutlinePendingError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Who decides
// ─────────────────────────────────────────────────────────────────────────────

/** Who is deciding: a person, or a session (an agent confirming on the locker's behalf). */
export type OutlinePendingActor =
	| { kind: "human"; userId: string }
	| { kind: "agent"; narratorId: string; responsibleUserId: string | null };

/**
 * What the actor may do with an open change: decide it (`decider`), withdraw it (`proposer`: its
 * own session proposed it), or nothing.
 */
export type OutlinePendingRight = "decider" | "proposer" | "none";

/** The lock on a pending change's tree now (null when the tree is no longer locked). */
async function currentLock(
	store: OutlineStore,
	row: OutlinePendingRow,
): Promise<{ lock: OutlineTaskLockJson | null; root: OutlineBlockMeta | null }> {
	if (!row.rootBlockId) return { lock: null, root: null };
	const [root] = await store.getBlockMetas(row.spaceId, { ids: [row.rootBlockId] });
	const lock = root && !root.deleted ? (root.taskJson?.lock ?? null) : null;
	return { lock, root: root ?? null };
}

/** The session a narrator belongs to (a subagent's root). */
async function sessionOf(store: OutlineStore, narratorId: string): Promise<string> {
	return (await store.getNarratorRoots([narratorId])).get(narratorId)?.root ?? narratorId;
}

/**
 * The actor's right on an open change, against the lock as it is now (a delegate the locker
 * named since the proposal decides it).
 */
export async function pendingRightOf(
	row: OutlinePendingRow,
	actor: OutlinePendingActor,
	options: { store?: OutlineStore; lock?: OutlineTaskLockJson | null } = {},
): Promise<OutlinePendingRight> {
	const store = options.store ?? outlineStore;
	const lock = options.lock !== undefined ? options.lock : (await currentLock(store, row)).lock;
	if (actor.kind === "human") {
		return lock?.by.kind === "human" && lock.by.id === actor.userId ? "decider" : "none";
	}
	const session = await sessionOf(store, actor.narratorId);
	if (row.requesterSession !== null && session === row.requesterSession) return "proposer";
	if (!lock) return "none";
	if (lock.delegate && (await sessionOf(store, lock.delegate)) === session) return "decider";
	if (lock.by.kind === "agent" && (await sessionOf(store, lock.by.id)) === session)
		return "decider";
	return "none";
}

async function openRow(store: OutlineStore, pendingId: string): Promise<OutlinePendingRow> {
	const row = (await store.getPending([pendingId]))[0];
	if (!row) {
		throw new OutlinePendingError(
			OUTLINE_PENDING_TEXT.notFound(pendingId),
			"OUTLINE_PENDING_NOT_FOUND",
		);
	}
	if (row.status !== "open") {
		throw new OutlinePendingError(
			OUTLINE_PENDING_TEXT.decided(outlinePendingLabel(row.id), row.status),
			"OUTLINE_PENDING_DECIDED",
		);
	}
	return row;
}

function actorRef(actor: OutlinePendingActor): OutlineTaskActorRef {
	return actor.kind === "human"
		? { kind: "human", id: actor.userId }
		: { kind: "agent", id: actor.narratorId };
}

function emit(spaceId: string, pageIds: readonly string[]): void {
	if (pageIds.length > 0)
		eventBus.emit({ type: "outline:pending", spaceId, pageIds: [...pageIds] });
}

/** Agent- and API-facing text of decisions (English, like the rest of the outline's). */
export const OUTLINE_PENDING_TEXT = {
	notFound: (id: string) => `no pending change ${id}`,
	decided: (label: string, status: string) => `${label} is not open any more (${status})`,
	notDecider: (label: string) =>
		`${label} is not yours to decide: the person who locked the plan decides it, or the session they named to confirm on their behalf`,
	own: (label: string) =>
		`${label} was proposed by this session, so it cannot confirm it: it goes to the person who locked the plan. Reject it to withdraw it`,
	conflict: (label: string) =>
		`${label} no longer applies as proposed: blocks it changes were changed since. Nothing was written; reject it, or let its proposer propose again`,
	unlocked: (label: string) => `${label}: the plan is no longer locked`,
	changed: (label: string) =>
		`${label} changed while it was being confirmed (more was proposed into it, or it was decided); look at it again`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Confirm and reject
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineConfirmResult {
	row: OutlinePendingRow;
	/** The `confirm` commit; null when the change was all there already. */
	write: OutlineWriteResult;
}

/**
 * The stored operations, rebased onto the blocks as they are now: a block changed since the
 * proposal is merged three ways (text and fields); structural operations go as they are (the
 * write path checks the targets exist and nothing lands under itself). Throws
 * {@link OutlinePendingError} (`OUTLINE_PENDING_CONFLICT`) when a merge fails.
 */
async function rebase(
	store: OutlineStore,
	row: OutlinePendingRow,
): Promise<{ ops: OutlineOp[]; canonical: Array<OutlineCanonicalContent | undefined> }> {
	const ops = pendingOps(row).map((op) => {
		const { baseVersionSeq: _base, ...rest } = op as OutlineOp & { baseVersionSeq?: number };
		return rest as OutlineOp;
	});
	const base = row.baseJson;
	const rewritten = new Set<string>();
	for (const op of ops) {
		if ((op.op === "update" || op.op === "setTask") && "id" in op.block) rewritten.add(op.block.id);
	}
	const metas = new Map(
		(await store.getBlockMetas(row.spaceId, { ids: [...rewritten] })).map((m) => [m.id, m]),
	);
	const changed = [...rewritten].filter((id) => {
		const meta = metas.get(id);
		return meta !== undefined && base[id] !== undefined && meta.versionSeq !== base[id];
	});
	const label = outlinePendingLabel(row.id);
	const conflicts: string[] = [];
	if (changed.length > 0) {
		// The proposed text of each changed block (its version as proposed when only its fields
		// were rewritten), and its task patch.
		const baseVersions = new Map(
			(
				await store.listVersionsAtSeqs(
					changed.map((id) => ({ blockId: id, seq: base[id] as number })),
				)
			).map((v) => [v.blockId, v]),
		);
		const replaces: AgentReplace[] = [];
		for (const id of changed) {
			const update = ops.find(
				(o): o is Extract<OutlineOp, { op: "update" }> =>
					o.op === "update" && "id" in o.block && o.block.id === id,
			);
			const setTask = ops.find(
				(o): o is Extract<OutlineOp, { op: "setTask" }> =>
					o.op === "setTask" && "id" in o.block && o.block.id === id,
			);
			if (setTask?.task === null) {
				// Taking the checkbox away: only while the task is as proposed against.
				const before = baseVersions.get(id)?.taskJson ?? null;
				if (JSON.stringify(before) !== JSON.stringify(metas.get(id)?.taskJson ?? null))
					conflicts.push(`${id}: checkbox`);
				continue;
			}
			replaces.push({
				blockId: id,
				seen: base[id] as number,
				content: update?.content ?? baseVersions.get(id)?.content ?? "",
				...(update?.alias !== undefined && update.alias !== null ? { alias: update.alias } : {}),
				...(update?.tags !== undefined ? { tags: update.tags } : {}),
				...(setTask?.task ? { task: setTask.task } : {}),
			});
		}
		const merged = await mergeAgentReplaces(store, replaces);
		for (const m of merged) {
			if (!m.ok) {
				conflicts.push(`${m.blockId}: ${m.reason}${m.fields ? ` (${m.fields.join(", ")})` : ""}`);
				continue;
			}
			for (let k = 0; k < ops.length; k++) {
				const op = ops[k] as OutlineOp;
				if (!("block" in op) || !("id" in op.block) || op.block.id !== m.blockId) continue;
				if (op.op === "update") {
					const { alias: _a, tags: _t, ...rest } = op;
					ops[k] = {
						...rest,
						content: m.content,
						...(m.alias !== undefined ? { alias: m.alias } : {}),
						...(m.tags !== undefined ? { tags: m.tags } : {}),
						merged: true,
					};
				} else if (op.op === "setTask") {
					// Only the fields the proposal changed and nobody else did; none left, no change.
					ops[k] = m.task
						? { ...op, task: m.task as OutlineTaskPatch }
						: { ...op, task: {} as OutlineTaskPatch };
				}
			}
		}
	}
	if (conflicts.length > 0) {
		throw new OutlinePendingError(
			OUTLINE_PENDING_TEXT.conflict(label),
			"OUTLINE_PENDING_CONFLICT",
			conflicts,
		);
	}
	// A task patch the merge emptied changes nothing: drop it.
	const kept = ops.filter(
		(op) => !(op.op === "setTask" && op.task !== null && Object.keys(op.task).length === 0),
	);
	const canonical = kept.map((op) =>
		(op.op === "insert" || op.op === "update" || op.op === "restore") && op.content !== undefined
			? { content: op.content, links: contentLinks(op.content) }
			: undefined,
	);
	return { ops: kept, canonical };
}

/**
 * Confirm an open change: one `confirm` commit written as its proposer, the row `confirmed` with
 * it. Throws {@link OutlinePendingError}: not found, decided already, not the actor's to decide,
 * the actor's own session's change, or no longer applying (a conflict; nothing is written and it
 * stays open).
 */
export async function confirmOutlinePending(args: {
	pendingId: string;
	by: OutlinePendingActor;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineConfirmResult> {
	const store = args.store ?? outlineStore;
	const first = await openRow(store, args.pendingId);
	const label = outlinePendingLabel(first.id);
	return await withOutlineLiveBarrier(first.spaceId, async () => {
		// Behind the barrier: what people typed is committed, and nothing lands meanwhile.
		const row = await openRow(store, args.pendingId);
		const right = await pendingRightOf(row, args.by, { store });
		if (right === "proposer")
			throw new OutlinePendingError(OUTLINE_PENDING_TEXT.own(label), "OUTLINE_PENDING_OWN");
		if (right !== "decider")
			throw new OutlinePendingError(
				OUTLINE_PENDING_TEXT.notDecider(label),
				"OUTLINE_PENDING_NOT_DECIDER",
			);
		const { ops, canonical } = await rebase(store, row);
		const requester = row.requestedByJson;
		let write: OutlineWriteResult;
		try {
			write = await writeOutline(
				{
					spaceId: row.spaceId,
					ops,
					actor: { kind: requester.kind, id: requester.id },
					narratorId: requester.narratorId,
					messageId: requester.messageId,
					toolCallId: requester.toolCallId,
					responsibleUserId: args.by.kind === "human" ? args.by.userId : args.by.responsibleUserId,
					summary: OUTLINE_TEXT.confirmSummary(label, row.summary),
				},
				{
					store,
					canonical,
					confirm: { pendingId: row.id, expectRev: row.rev, decidedBy: actorRef(args.by) },
					confirmPageIds: [row.pageId],
					...(args.now ? { now: args.now } : {}),
				},
			);
		} catch (error) {
			if (error instanceof OutlinePendingMovedError) {
				throw new OutlinePendingError(
					OUTLINE_PENDING_TEXT.changed(label),
					"OUTLINE_PENDING_CHANGED",
				);
			}
			if (error instanceof OutlineWriteError) {
				throw new OutlinePendingError(
					OUTLINE_PENDING_TEXT.conflict(label),
					"OUTLINE_PENDING_CONFLICT",
					[error.message],
				);
			}
			throw error;
		}
		const decided = (await store.getPending([row.id]))[0] ?? row;
		return { row: decided, write };
	});
}

/**
 * Reject an open change (the decider, with a reason the proposer reads once), or withdraw it
 * (its proposer's session). No commit. Throws {@link OutlinePendingError}.
 */
export async function rejectOutlinePending(args: {
	pendingId: string;
	by: OutlinePendingActor;
	reason?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlinePendingRow> {
	const store = args.store ?? outlineStore;
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = await openRow(store, args.pendingId);
		const label = outlinePendingLabel(row.id);
		const right = await pendingRightOf(row, args.by, { store });
		if (right === "none")
			throw new OutlinePendingError(
				OUTLINE_PENDING_TEXT.notDecider(label),
				"OUTLINE_PENDING_NOT_DECIDER",
			);
		const now = (args.now?.() ?? new Date()).toISOString();
		const reason = args.reason?.trim().slice(0, OUTLINE_PENDING_LIMITS.maxReasonChars) || null;
		const withdrawn = right === "proposer";
		const ok = await store.decidePending({
			id: row.id,
			expectRev: row.rev,
			status: withdrawn ? "withdrawn" : "rejected",
			decidedAt: now,
			decidedBy: actorRef(args.by),
			decisionCommitId: null,
			reason: withdrawn ? (reason ?? PENDING_WITHDRAW.proposer) : reason,
			// The proposer withdrawing knows; a rejection is told to it on its next read.
			reportedAt: withdrawn ? now : null,
		});
		if (ok) {
			emit(row.spaceId, [row.pageId]);
			return (await store.getPending([row.id]))[0] ?? row;
		}
		// Merged into or decided meanwhile: look again.
	}
	throw new OutlinePendingError(
		OUTLINE_PENDING_TEXT.decided(outlinePendingLabel(args.pendingId), "changing"),
		"OUTLINE_PENDING_DECIDED",
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Locks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lock a task's tree on a person's behalf (owner decision Q5: only people lock), naming the
 * session that may confirm step changes for them (`delegate`, D25: per plan, no default). The
 * routes check that the person may write the space and the delegate; `/goal` (plan PR 5) and
 * plan mode (PR 8) call this for the person whose choice it is. Locking a task that is locked
 * already replaces the lock: the same person keeps its version (only the delegate changes),
 * someone else's lock is a new one, which withdraws the open changes of the old.
 */
export async function lockOutlineTask(args: {
	blockId: string;
	/** The person locking. */
	userId: string;
	delegate?: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineWriteResult> {
	const store = args.store ?? outlineStore;
	const block = await store.getBlock(args.blockId);
	if (!block || block.deleted) throw new NotFoundError("Outline block", args.blockId);
	if (!block.taskJson)
		throw new OutlineWriteError("only a task can be locked", "OUTLINE_INVALID_OP");
	return await writeOutline(
		{
			spaceId: block.spaceId,
			ops: [
				{
					op: "setTask",
					block: { id: block.id },
					task: {
						lock: { by: { kind: "human", id: args.userId }, delegate: args.delegate ?? null },
					},
				},
			],
			actor: { kind: "human", id: args.userId },
			responsibleUserId: args.userId,
		},
		{ store, ...(args.now ? { now: args.now } : {}) },
	);
}

/** Unlock a task's tree (the routes check who may: the locker, a space manager, an admin). */
export async function unlockOutlineTask(args: {
	blockId: string;
	userId: string;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineWriteResult> {
	const store = args.store ?? outlineStore;
	const block = await store.getBlock(args.blockId);
	if (!block || block.deleted) throw new NotFoundError("Outline block", args.blockId);
	return await writeOutline(
		{
			spaceId: block.spaceId,
			ops: [{ op: "setTask", block: { id: block.id }, task: { lock: null } }],
			actor: { kind: "human", id: args.userId },
			responsibleUserId: args.userId,
		},
		{ store, ...(args.now ? { now: args.now } : {}) },
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** Open changes of a page, and its locked tasks: what a page shows of them. */
export async function readPagePending(
	pageId: string,
	options: { store?: OutlineStore } = {},
): Promise<{ pending: OutlinePendingRow[]; locked: OutlineBlockMeta[] }> {
	const store = options.store ?? outlineStore;
	const [pending, locked] = await Promise.all([
		store.listOpenPendingByPage(pageId, OUTLINE_PENDING_LIMITS.openPerPage),
		store.listLockedBlocks(pageId, OUTLINE_PENDING_LIMITS.openPerPage),
	]);
	return { pending, locked };
}

/** Whether any block a change touches changed since it was proposed. */
export async function pendingBaseChanged(
	rows: readonly OutlinePendingRow[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	const store = options.store ?? outlineStore;
	const out = new Set<string>();
	const bySpace = new Map<string, string[]>();
	for (const row of rows) {
		const list = bySpace.get(row.spaceId) ?? [];
		list.push(...Object.keys(row.baseJson));
		bySpace.set(row.spaceId, list);
	}
	const versions = new Map<string, OutlineBlockMeta>();
	for (const [spaceId, ids] of bySpace) {
		for (const meta of await store.getBlockMetas(spaceId, { ids: [...new Set(ids)] }))
			versions.set(meta.id, meta);
	}
	for (const row of rows) {
		for (const [id, seq] of Object.entries(row.baseJson)) {
			const meta = versions.get(id);
			if (!meta || meta.deleted || meta.versionSeq !== seq) {
				out.add(row.id);
				break;
			}
		}
	}
	return out;
}

/**
 * Of the given tasks, those an open change touches (design §2.2: "等确认"): the task is a
 * block the change rewrites, moves, deletes or adds under, or its root being done waits for
 * confirmation. The task source's continuation skips them (`deriveOutlineTaskWaits`). One
 * bounded read of the open changes per space.
 */
export async function findTasksWaitingForConfirmation(
	tasks: readonly OutlineTaskSubject[],
	options: { store?: OutlineStore } = {},
): Promise<Set<string>> {
	const store = options.store ?? outlineStore;
	const out = new Set<string>();
	const bySpace = new Map<string, Set<string>>();
	for (const task of tasks) {
		const set = bySpace.get(task.spaceId) ?? new Set();
		set.add(task.id);
		bySpace.set(task.spaceId, set);
	}
	for (const [spaceId, ids] of bySpace) {
		const open = await store.listOpenPendingBySpace(spaceId, OUTLINE_PENDING_LIMITS.scanPerSpace);
		for (const row of open) for (const id of row.blockIdsJson) if (ids.has(id)) out.add(id);
	}
	return out;
}

/** People and sessions a pending change names, for showing them. */
export async function pendingNames(rows: readonly OutlinePendingRow[]): Promise<{
	users: Map<string, string>;
	narrators: Map<string, string | null>;
}> {
	const userIds = new Set<string>();
	const narratorIds = new Set<string>();
	for (const row of rows) {
		if (row.deciderJson.by.kind === "human") userIds.add(row.deciderJson.by.id);
		else narratorIds.add(row.deciderJson.by.id);
		if (row.deciderJson.delegate) narratorIds.add(row.deciderJson.delegate);
		if (row.requesterSession) narratorIds.add(row.requesterSession);
		if (row.requestedByJson.narratorId) narratorIds.add(row.requestedByJson.narratorId);
		if (row.decidedByJson?.kind === "human") userIds.add(row.decidedByJson.id);
		else if (row.decidedByJson) narratorIds.add(row.decidedByJson.id);
	}
	const names = await readDisplayNames({ userIds: [...userIds], narratorIds: [...narratorIds] });
	return { users: names.users, narrators: names.narrators };
}

/** One block of a pending change's diff: as proposed against, as proposed, and as it is now. */
export interface OutlinePendingDiffEntry {
	blockId: string;
	sid: string;
	kind: "update" | "insert" | "delete" | "move" | "task" | "restore";
	/** The block's text when proposed (null for a new block). */
	base: string | null;
	/** What the change makes it (null for a deletion). */
	proposed: string | null;
	/** The text now (null for a new block, or one deleted since). */
	now: string | null;
	/** Changed by someone since the proposal. */
	changedSince: boolean;
	/** For a task change: the fields as proposed. */
	task?: OutlineTaskPatch | null;
	/** For a move or an insert: the parent it goes under (title), null for the top level. */
	parentTitle?: string | null;
}

/**
 * A pending change block by block, at most {@link OUTLINE_PENDING_LIMITS.diffBlocks} entries and
 * {@link OUTLINE_PENDING_LIMITS.diffTextBytes} of each text. Point reads only: the blocks it
 * names, their versions as proposed against.
 */
export async function readPendingDiff(
	row: OutlinePendingRow,
	options: { store?: OutlineStore } = {},
): Promise<{ entries: OutlinePendingDiffEntry[]; truncated: boolean }> {
	const store = options.store ?? outlineStore;
	const ops = pendingOps(row);
	const limit = OUTLINE_PENDING_LIMITS.diffBlocks;
	const clip = (text: string | null | undefined): string | null => {
		if (text === null || text === undefined) return null;
		const max = OUTLINE_PENDING_LIMITS.diffTextBytes;
		if (Buffer.byteLength(text, "utf8") <= max) return text;
		return `${Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/�$/, "")}…`;
	};
	const shown = ops.slice(0, limit);
	const ids = new Set<string>();
	for (const op of shown) {
		if ("block" in op && "id" in op.block) ids.add(op.block.id);
		if ((op.op === "insert" || op.op === "move") && op.parent && "id" in op.parent)
			ids.add(op.parent.id);
	}
	const blocks = new Map((await store.getBlocks([...ids])).map((b) => [b.id, b]));
	const baseSeqs = Object.entries(row.baseJson).filter(([id]) => ids.has(id));
	const baseVersions = new Map(
		(await store.listVersionsAtSeqs(baseSeqs.map(([blockId, seq]) => ({ blockId, seq })))).map(
			(v) => [v.blockId, v],
		),
	);
	const titleOfBlock = (id: string | undefined) => {
		const b = id ? blocks.get(id) : undefined;
		return b ? titleOf(b.content).slice(0, 200) : null;
	};
	const entries: OutlinePendingDiffEntry[] = [];
	for (const op of shown) {
		if (op.op === "insert") {
			entries.push({
				blockId: op.id ?? "",
				sid: op.sid ?? "",
				kind: "insert",
				base: null,
				proposed: clip(op.content),
				now: null,
				changedSince: false,
				task: op.task ?? null,
				parentTitle: op.parent && "id" in op.parent ? titleOfBlock(op.parent.id) : null,
			});
			continue;
		}
		const id = "id" in op.block ? op.block.id : "";
		const now = blocks.get(id);
		const baseSeq = row.baseJson[id];
		const base = baseVersions.get(id);
		const changedSince =
			baseSeq !== undefined && (!now || now.deleted || now.versionSeq !== baseSeq);
		const nowText = now && !now.deleted ? now.content : null;
		const baseText = base?.content ?? nowText;
		entries.push({
			blockId: id,
			sid: now?.sid ?? "",
			kind:
				op.op === "update"
					? "update"
					: op.op === "setTask"
						? "task"
						: op.op === "delete"
							? "delete"
							: op.op === "move"
								? "move"
								: "restore",
			base: clip(baseText),
			proposed: clip(
				op.op === "update" ? (op.content ?? baseText) : op.op === "delete" ? null : baseText,
			),
			now: clip(nowText),
			changedSince,
			...(op.op === "setTask" ? { task: op.task } : {}),
			...(op.op === "move"
				? { parentTitle: op.parent && "id" in op.parent ? titleOfBlock(op.parent.id) : null }
				: {}),
		});
	}
	return { entries, truncated: ops.length > shown.length };
}

/**
 * Decisions on a session's changes it has not been shown, oldest first: shown once on its next
 * read, then marked reported. Open rows are left out (they are not decided).
 */
export async function takePendingReports(
	session: string,
	options: { store?: OutlineStore; now?: () => Date; pageId?: string } = {},
): Promise<OutlinePendingRow[]> {
	const store = options.store ?? outlineStore;
	const rows = (
		await store.listUnreportedPending(session, OUTLINE_PENDING_LIMITS.reportsPerRead * 4)
	).filter(
		(row) =>
			row.status !== "open" && (options.pageId === undefined || row.pageId === options.pageId),
	);
	const taken = rows.slice(0, OUTLINE_PENDING_LIMITS.reportsPerRead);
	if (taken.length > 0) {
		await store.markPendingReported(
			taken.map((r) => r.id),
			(options.now?.() ?? new Date()).toISOString(),
		);
	}
	return taken;
}

/** The space of a pending change, for access checks. */
export async function pendingSpace(
	row: OutlinePendingRow,
	options: { store?: OutlineStore } = {},
): Promise<OutlineSpaceRow | null> {
	return await (options.store ?? outlineStore).getSpace(row.spaceId);
}
