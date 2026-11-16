/**
 * Restoring a subtree to an earlier moment (pageless outline, H3; owner decision D58), and
 * moving one block back to where it was. Like a revert, a restore never rewrites history: it
 * is compensating commits through the ordinary planner (`writeOutline` in compensating mode),
 * so every write invariant, lock, claim and event is the write path's own.
 *
 * WHAT A RESTORE DOES (root R, seq `then`; `shared/outline-restore-api.ts` names the kinds)
 * ------------------------------------------------------------------------------------
 * It touches only what was under R then, and what is under R now that was not:
 *
 *   - `removed` (under R then, deleted while under R): brought back under its parent of then,
 *     at its order key, with its text, task, question, alias and tags of then.
 *   - `changed` (under R at both): parent, order key, text and fields put back.
 *   - `added` (under R now, not in the tree then): deleted, once nothing that stays is under it.
 *   - `moved-in` (under R now, elsewhere then): moved back to its parent and order key of then.
 *     Nothing else of it is touched, and what sits under it goes with it (blocks added since
 *     among it are kept: they never were part of R).
 *   - `moved-away` (under R then, not now; also when it was deleted after it had left): NOT
 *     pulled back, only listed by the preview; `moveOutlineBlockBack` moves one back when asked.
 *   - R itself: its text and fields are put back; where it sits is not part of its subtree.
 *
 * A block that is not under R when the restore writes is never written by it: a block another
 * person brought back elsewhere after the preview stays as they left it.
 *
 * Left alone, and said so (`OutlineRestoreSkipReason`): a block whose parent of then has moved
 * away keeps its place (its text and fields are still put back); a moved-in block whose old
 * parent is deleted stays; an added block that still holds something stays; what the write
 * path refuses, and what was to go back under a refused block; someone else's lock.
 *
 * A RESTORE NEVER DELETES WHAT IT WAS NOT TOLD TO. Deleting a block deletes everything under it,
 * so before any batch is written, every block the batch deletes is checked against the store as
 * it is (one bounded read of its live children each): it may hold only blocks the same batch
 * moves out or deletes before it. A delete that fails the check is dropped (the block is kept,
 * `holds-kept`), and so is a delete of a block above it. The commit is written only if the
 * space is still at the seq the check read (`compensating.expectNextSeq`), so the check and the
 * write see the same tree. This holds whatever happened before: a refused move, a batch split
 * in two, a call boundary.
 *
 * ONE LOGICAL OPERATION, MANY COMMITS
 * -----------------------------------
 * A preview pins the space's seq (`now`, after the live sessions of the space have written
 * what they hold) and names the restore (`restoreId`); both are in its token, sealed with the
 * person who previewed and the time (a token is good for `tokenMinutes`, for that person only).
 * The restore then walks the same comparison (`subtree-diff.ts`, the tree as it stood at
 * `now`), and for every block it meets writes what separates its row AS IT IS from its state of
 * then. That makes it idempotent by construction: a block already put back needs nothing, so a
 * restore interrupted anywhere, or confirmed twice, continues and never applies anything twice.
 * No record of the operation is kept in a table.
 *
 * Its commits carry the restore's id (`toolCallId`: `outline-restore:<id>`, an audit field
 * with no foreign key). Before writing, and again whenever another commit is found to have
 * landed, every commit after `now` that changed anything under R must be one of them; else
 * the restore stops with `OutlineRestoreConflictError` (409).
 *
 * BATCHES. Operations are gathered in walk order (parents before children; an added block
 * after what is under it) and written when a batch holds `maxBlocksPerCommit` blocks (fewer
 * after another commit made it start again), each batch one atomic commit. A batch the write
 * path finds too large (rows, or the 4,000 change marks) is split in two and tried again; an
 * operation it refuses is dropped with what depended on it, and each is reported. A call stops
 * after `maxCommitsPerCall` commits, `maxCallMs`, or `maxRowsPerCall` store rows (whichever
 * first; at least one step of the walk is always made) and answers with a cursor.
 *
 * ORDER KEYS. A block goes back to its exact order key. A sibling that sits on that key now
 * (another block of the level that is about to be re-keyed, deleted or moved on) is first set
 * aside on a key of its own, in the same commit. A key still taken places the block next to it;
 * a later pass over the subtree (at most `maxPasses`) finds the key free.
 *
 * MAIN THREAD: every step is one bounded part of a page of the walk and its reads; the loop
 * yields to the event loop between steps.
 */
import { NotFoundError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import {
	OUTLINE_DIFF_LIMITS,
	OUTLINE_RESTORE_LIMITS,
	type OutlineMoveBackResponse,
	type OutlineRestoreAction,
	type OutlineRestoreEntry,
	type OutlineRestorePreviewResponse,
	type OutlineRestoreResponse,
	type OutlineRestoreSkip,
	type OutlineRestoreSkipReason,
} from "@shared/outline-restore-api";
import { OutlineBusyError, OutlineWriteError } from "./errors";
import { withOutlineLiveBarrier } from "./live-barrier";
import { OUTLINE_TEXT } from "./messages";
import { OUTLINE_LIMITS, type OutlineActorKind } from "./model";
import {
	OutlineRestoreConflictError,
	OutlineRestoreParentGoneError,
	OutlineRestoreRootError,
	OutlineRestoreTokenError,
	openOutlineValue,
	sealOutlineValue,
} from "./restore-errors";
import { taskInput, taskPatch } from "./revert";
import { yieldToEventLoop } from "./session-scope";
import { outlineStore } from "./store";
import {
	type OutlineBlockMeta,
	type OutlineSpaceRow,
	OutlineStaleWriteError,
	type OutlineStore,
} from "./store/port";
import type { OutlineVersionHead } from "./store/read-port";
import {
	assertOutlineHistoryAt,
	clampDiffLimit,
	contentFieldsDiffer,
	type DiffItem,
	type DiffLateCost,
	type DiffStep,
	type DiffWalkState,
	decodeDiffWalkState,
	diffEntry,
	diffHasRoom,
	encodeDiffWalkState,
	newDiffWalkState,
	SubtreeDiffWalk,
} from "./subtree-diff";
import { withOutlineHistory } from "./subtree-errors";
import { sameTaskJson } from "./task-json";
import { type OutlineOp, type OutlineWriteResult, writeOutline } from "./write";

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

interface RestoreToken {
	spaceId: string;
	rootId: string | null;
	thenSeq: number;
	/** The seq the preview was of. */
	pin: number;
	restoreId: string;
	/** Who previewed: only they may confirm or page it. */
	userId: string;
	/** When the preview was made (ms since the epoch). */
	issuedAt: number;
}

const isSeq = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function sealToken(token: RestoreToken): string {
	return sealOutlineValue("token", [
		token.spaceId,
		token.rootId ?? "",
		token.thenSeq,
		token.pin,
		token.restoreId,
		token.userId,
		token.issuedAt,
	]);
}

function openToken(
	sealed: string,
	space: OutlineSpaceRow,
	userId: string,
	now: Date,
): RestoreToken {
	const value = openOutlineValue("token", sealed, "token");
	if (!Array.isArray(value) || value.length !== 7) throw new OutlineRestoreTokenError("token");
	const [spaceId, rootId, thenSeq, pin, restoreId, owner, issuedAt] = value as unknown[];
	if (
		spaceId !== space.id ||
		typeof rootId !== "string" ||
		!isSeq(thenSeq) ||
		!isSeq(pin) ||
		typeof restoreId !== "string" ||
		typeof owner !== "string" ||
		!isSeq(issuedAt)
	)
		throw new OutlineRestoreTokenError("token");
	if (owner !== userId) throw new OutlineRestoreTokenError("token", "person");
	if (now.getTime() - issuedAt > OUTLINE_RESTORE_LIMITS.tokenMinutes * 60_000)
		throw new OutlineRestoreTokenError("token", "expired");
	return {
		spaceId: space.id,
		rootId: rootId === "" ? null : rootId,
		thenSeq,
		pin,
		restoreId,
		userId: owner,
		issuedAt,
	};
}

/** What a restore's commits carry in `toolCallId`. */
export function outlineRestoreMarker(restoreId: string): string {
	return `outline-restore:${restoreId}`;
}

const liveNow = (meta: OutlineBlockMeta | undefined): meta is OutlineBlockMeta =>
	meta !== undefined && !meta.deleted;

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

const CARRY_ROWS = OUTLINE_DIFF_LIMITS.carryCount + 1;

/**
 * What restoring the subtree of `rootId` (null: the whole space) to the seq `then` would do,
 * a page at a time, without writing anything: the change list with what happens to each block,
 * the blocks that have moved away (action `none`), and the token the restore is confirmed with.
 * The first page (no `token`) waits for the live sessions of the space to write what they hold
 * (as a restore does), pins the space's last commit and names the restore; further pages pass
 * its `token` and the `cursor`, and are of the same moment. A page reads at most
 * `OUTLINE_DIFF_LIMITS.maxStoreRows` store rows. Throws H2's history errors,
 * `OutlineRestoreRootError`, and `OutlineRestoreTokenError` for a token of someone else or one
 * that has expired.
 */
export async function previewOutlineRestore(input: {
	space: OutlineSpaceRow;
	rootId: string | null;
	thenSeq: number;
	/** The person previewing: the token is theirs. */
	userId: string;
	token?: string | null;
	cursor?: string | null;
	limit?: number;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineRestorePreviewResponse> {
	const store = input.store ?? outlineStore;
	const now = input.now ?? (() => new Date());
	if (input.token) {
		const token = openToken(input.token, input.space, input.userId, now());
		if (token.rootId !== input.rootId || token.thenSeq !== input.thenSeq)
			throw new OutlineRestoreTokenError("token");
		let state = newDiffWalkState();
		if (input.cursor) {
			const value = openOutlineValue("preview", input.cursor, "cursor");
			if (!Array.isArray(value) || value.length !== 2 || value[0] !== token.restoreId)
				throw new OutlineRestoreTokenError("cursor");
			state = decodeDiffWalkState(value[1], token.pin);
		}
		return await previewPage(store, input.space, token, state, input.limit, 0);
	}
	if (input.cursor) throw new OutlineRestoreTokenError("cursor");
	// Behind the live barrier: what the live sessions hold is written first, so the preview is
	// of what everyone sees, and a confirm does not find those edits as a conflict.
	return await withOutlineLiveBarrier(input.space.id, async () => {
		const space = await store.getSpace(input.space.id);
		if (!space) throw new NotFoundError("Outline space", input.space.id);
		const token: RestoreToken = {
			spaceId: space.id,
			rootId: input.rootId,
			thenSeq: input.thenSeq,
			pin: space.nextSeq - 1,
			restoreId: generateId(),
			userId: input.userId,
			issuedAt: now().getTime(),
		};
		return await previewPage(store, space, token, newDiffWalkState(), input.limit, 1);
	});
}

async function previewPage(
	store: OutlineStore,
	space: OutlineSpaceRow,
	token: RestoreToken,
	state: DiffWalkState,
	wanted: number | undefined,
	/** Rows already read for this page. */
	spent: number,
): Promise<OutlineRestorePreviewResponse> {
	await assertOutlineHistoryAt(store, space, token.thenSeq);
	const limit = clampDiffLimit(wanted);
	const entries: OutlineRestoreEntry[] = [];
	const skipped: OutlineRestoreSkip[] = [];
	const response = (nextCursor: string | null): OutlineRestorePreviewResponse => ({
		spaceId: space.id,
		rootId: token.rootId,
		thenSeq: token.thenSeq,
		nowSeq: token.pin,
		token: sealToken(token),
		restoreId: token.restoreId,
		entries,
		skipped,
		nextCursor,
	});
	if (token.pin <= token.thenSeq) return response(null);
	const { rootId, thenSeq, pin } = token;
	const walk = new SubtreeDiffWalk(
		{ store, space, rootId, thenSeq, to: pin, mode: "compare" },
		state,
	);
	walk.rows = spent + 1;
	const max = OUTLINE_DIFF_LIMITS.maxStoreRows;
	// What this function reads for an item after the walk, at most.
	const late: DiffLateCost = {
		max: 1 + CARRY_ROWS,
		cost: (item, frameKind) =>
			item.kind === "moved-in"
				? 1 + CARRY_ROWS
				: item.kind === "moved-away"
					? 1
					: frameKind === "added" && !item.own && item.before !== null && item.inThen
						? 2
						: 0,
	};
	return await withOutlineHistory(async () => {
		while (!walk.finished && diffHasRoom(entries.length, limit)) {
			// A finished added frame reads its block (2 rows) before it is listed.
			if (max - walk.rows < 2) break;
			const step = await walk.step(max - walk.rows, late);
			if (!step) break;
			if (step.type === "close") {
				if (step.kind !== "added" || step.parentId === null) continue;
				const head = (
					await store.listVersionHeadsAt([step.parentId], pin, OUTLINE_DIFF_LIMITS.excerptChars)
				)[0];
				const meta = (await store.getBlockMetas(space.id, { ids: [step.parentId] }))[0];
				walk.rows += 2;
				if (!head || !meta) continue;
				const entry = diffEntry({
					id: meta.id,
					meta,
					before: null,
					at: null,
					now: head,
					own: false,
					inThen: false,
					inNow: true,
					deletedSince: false,
					kind: "added",
					fields: [],
					tagsMayDiffer: false,
					self: true,
					below: true,
					descend: "added",
				}) as OutlineRestoreEntry;
				if (step.kept) {
					entries.push({ ...entry, action: "delete", skip: "holds-kept" });
					skipped.push({ blockId: meta.id, sid: meta.sid, reason: "holds-kept" });
				} else entries.push({ ...entry, action: step.maybe ? "delete-unless-holds" : "delete" });
				continue;
			}
			if (step.type === "root") {
				const entry = step.item ? diffEntry(step.item) : null;
				if (entry) entries.push({ ...entry, action: "put-back" });
				continue;
			}
			// Whether the parent of then of a block that moved (in, or away), or of a block of the
			// subtree sitting under an added one, is live now.
			const strays = step.items.filter(
				(item) => step.kind === "added" && !item.own && item.before !== null && item.inThen,
			);
			const parents = [
				...step.items.filter((item) => item.kind === "moved-in" || item.kind === "moved-away"),
				...strays,
			]
				.map((item) => item.before?.parentId ?? null)
				.filter((id): id is string => id !== null);
			const parentMetas = new Map(
				(parents.length > 0
					? await store.getBlockMetas(space.id, { ids: [...new Set(parents)] })
					: []
				).map((meta) => [meta.id, meta]),
			);
			walk.rows += parentMetas.size;
			const parentLive = (item: DiffItem) =>
				item.before?.parentId == null || liveNow(parentMetas.get(item.before.parentId));

			// A block of the subtree under an added block goes back where it belonged when that
			// block is there: under the root now (or the root). Its parent moved away: it stays,
			// and so does the added block. Its parent is deleted: not known before the restore.
			if (strays.length > 0) {
				const there = new Set<string>();
				const ask = strays
					.map((item) => item.before?.parentId ?? null)
					.filter(
						(id): id is string => id !== null && id !== rootId && liveNow(parentMetas.get(id)),
					);
				if (rootId === null) for (const id of ask) there.add(id);
				else if (ask.length > 0) {
					const rows = await store.listUnderRootAt(
						space.id,
						rootId,
						ask.map((blockId) => ({ blockId, asOf: pin })),
						OUTLINE_LIMITS.maxDepth,
					);
					walk.rows += rows.length;
					for (const row of rows) if (row.under) there.add(row.blockId);
				}
				for (const item of strays) {
					const parentId = item.before?.parentId ?? null;
					const live = parentId === null || liveNow(parentMetas.get(parentId));
					if (parentId === rootId || (parentId !== null && there.has(parentId)) || !live)
						walk.maybe(step.frameIndex);
					else walk.keep(step.frameIndex);
				}
			}

			for (const item of step.items) {
				const entry = diffEntry(item);
				if (!entry) continue;
				let action: OutlineRestoreAction;
				let skip: OutlineRestoreSkipReason | undefined;
				let canMoveBack: boolean | undefined;
				let carried: { carries: number; carriesMore: boolean } | undefined;
				if (item.kind === "added") {
					// One with something under it is listed when its frame is finished.
					if (item.descend === "added") continue;
					action = "delete";
				} else if (item.kind === "moved-in") {
					action = "move-out";
					if (!parentLive(item)) {
						skip = "parent-gone";
						walk.keep(step.frameIndex);
					} else walk.maybe(step.frameIndex);
					const under = await store.listSubtreeAt(space.id, item.id, {
						asOf: pin,
						limit: CARRY_ROWS,
					});
					walk.rows += under.rows.length;
					carried = {
						carries: Math.min(under.rows.length, OUTLINE_DIFF_LIMITS.carryCount),
						carriesMore: under.rows.length > OUTLINE_DIFF_LIMITS.carryCount || under.truncated,
					};
				} else if (item.kind === "moved-away") {
					action = "none";
					canMoveBack = parentLive(item);
				} else if (item.kind === "removed") {
					action = "restore";
					if (step.kind === "away") skip = "parent-moved-away";
				} else {
					action = "put-back";
					if (step.kind === "away" && item.fields.some((f) => f === "parent" || f === "order"))
						skip = "parent-moved-away";
				}
				entries.push({
					...entry,
					action,
					...(skip ? { skip } : {}),
					...(canMoveBack !== undefined ? { canMoveBack } : {}),
					...(carried ?? {}),
				});
			}
		}
		return response(
			walk.finished
				? null
				: sealOutlineValue("preview", [token.restoreId, encodeDiffWalkState(walk.state, pin)]),
		);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Restore
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineRestoreWriter {
	actor: { kind: OutlineActorKind; id: string };
	/** The person accountable for the restore (the session's user for an agent). */
	responsibleUserId: string | null;
	narratorId?: string | null;
	messageId?: string | null;
	/** Whether the actor may take away someone else's lock (as for a revert). */
	unlockAuthority?: () => Promise<boolean>;
}

/** Whose a restore's token must be: the person accountable, else the actor. */
function personOf(writer: OutlineRestoreWriter): string {
	return writer.responsibleUserId ?? writer.actor.id;
}

export interface OutlineRestoreOptions {
	store?: OutlineStore;
	now?: () => Date;
	/** Tighter limits, for tests. */
	limits?: Partial<{
		maxBlocksPerCommit: number;
		maxCommitsPerCall: number;
		maxCallMs: number;
		maxPasses: number;
		maxRowsPerCall: number;
	}>;
	/** Called after each commit of the restore (tests interrupt a restore here). */
	afterCommit?: (commit: { id: string; seq: number }) => void | Promise<void>;
}

/** One operation of a batch, with what is needed to drop it safely. */
export interface RestoreBatchEntry {
	op: OutlineOp;
	blockId: string;
	/** The block this one is placed under: dropped with it when that one is refused. */
	dependsOn: string | null;
	/** Added blocks whose deletion would take this block along if its own move were dropped. */
	guards: string[];
	/** Setting a sibling aside: its adjustments say nothing. */
	park?: true;
	/** The deletion of an added block whose level was walked. */
	close?: true;
}

/** The analysis must start again from the last commit: another commit landed. */
class RestoreRestart extends Error {}
/** The call's clock ran out inside a split batch: the rest is left to the next call. */
class RestoreOutOfTime extends Error {}

const STALE_RESTARTS = 5;
const REFUSALS_PER_BATCH = 64;
const PARK_DIGITS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key right after `orderKey` that no sibling can be expected to hold. */
function parkKey(orderKey: string): string {
	let suffix = "";
	for (let i = 0; i < 12; i++)
		suffix += PARK_DIGITS[Math.floor(Math.random() * PARK_DIGITS.length)] as string;
	return orderKey + suffix;
}

/**
 * The last cursor each restore handed out, so a confirm without one continues where the last
 * call stopped instead of walking the finished part again. Only a shortcut: a restore is
 * idempotent, and with nothing here (another process, a restart) it starts over.
 */
const lastCursors = new Map<string, string>();
const LAST_CURSORS = 256;

function rememberCursor(restoreId: string, cursor: string | null): void {
	lastCursors.delete(restoreId);
	if (cursor === null) return;
	if (lastCursors.size >= LAST_CURSORS) {
		const oldest = lastCursors.keys().next().value;
		if (oldest !== undefined) lastCursors.delete(oldest);
	}
	lastCursors.set(restoreId, cursor);
}

/**
 * What dropping a refused block's operations takes along: every operation of the block, the
 * operations of blocks placed under a dropped one (`dependsOn`, transitively: they are
 * `dropped` too), and the deletions of the added blocks a dropped move was to take a block out
 * of (`unsafe`: they still hold it). Returns the operations left, in order.
 */
export function dropRefused(
	entries: readonly RestoreBatchEntry[],
	blockId: string,
): { left: RestoreBatchEntry[]; dropped: Set<string>; unsafe: Set<string> } {
	const dropped = new Set<string>([blockId]);
	const unsafe = new Set<string>();
	let left = [...entries];
	for (let changed = true; changed; ) {
		changed = false;
		const next: RestoreBatchEntry[] = [];
		for (const entry of left) {
			const gone =
				dropped.has(entry.blockId) ||
				(entry.dependsOn !== null && dropped.has(entry.dependsOn)) ||
				(entry.close === true && unsafe.has(entry.blockId));
			if (!gone) {
				next.push(entry);
				continue;
			}
			changed = true;
			if (!dropped.has(entry.blockId) && !entry.close) dropped.add(entry.blockId);
			for (const guard of entry.guards) unsafe.add(guard);
		}
		left = next;
	}
	return { left, dropped, unsafe };
}

class SubtreeRestorer {
	readonly commits: Array<{ id: string; seq: number }> = [];
	readonly skipped = new Map<string, { sid: string; reason: OutlineRestoreSkipReason }>();
	changed = 0;
	readonly movedAway = new Set<string>();
	pending: { id: string; label: string } | undefined;

	private walk: SubtreeDiffWalk;
	/** Rows read by walks finished in this call, and by this restorer outside a walk. */
	private rowsBefore = 0;
	/** Where the walk stood after the last commit: where a restart, and the next call, begin. */
	private start: DiffWalkState;
	private batch: RestoreBatchEntry[] = [];
	private readonly batchBlocks = new Set<string>();
	/** Effects of the batch not written yet, over the rows as read. */
	private readonly overlay = new Map<string, Partial<OutlineBlockMeta>>();
	/** Added blocks that must not be deleted: something under them could not leave. */
	private readonly keptIds = new Set<string>();
	/** Blocks whose operations were held for confirmation: not tried again. */
	private readonly held = new Set<string>();
	private readonly limits: Required<NonNullable<OutlineRestoreOptions["limits"]>>;
	/** Blocks a batch holds before it is written: smaller after another commit made it restart. */
	private batchLimit: number;
	private restarts = 0;
	private steps = 0;
	private readonly startedAt = Date.now();

	constructor(
		private readonly store: OutlineStore,
		private space: OutlineSpaceRow,
		private readonly token: RestoreToken,
		private readonly writer: OutlineRestoreWriter,
		private readonly options: OutlineRestoreOptions,
		state: DiffWalkState,
		/** Passes done before this one; blocks left for another pass; whether this pass wrote. */
		private pass: number,
		private deferred: number,
		private progressed: boolean,
		/** Every commit up to this seq is known to leave the subtree to this restore. */
		private verified: number,
		private readonly summary: string,
	) {
		this.limits = { ...OUTLINE_RESTORE_LIMITS, ...options.limits };
		this.batchLimit = this.limits.maxBlocksPerCommit;
		this.start = state;
		this.walk = this.newWalk(state);
	}

	/** Store rows this call has read. */
	get rows(): number {
		return this.rowsBefore + this.walk.rows;
	}

	private newWalk(state: DiffWalkState): SubtreeDiffWalk {
		if (this.walk) this.rowsBefore += this.walk.rows;
		const pin = this.token.pin;
		const copy = decodeDiffWalkState(encodeDiffWalkState(state, pin), pin);
		return new SubtreeDiffWalk(
			{
				store: this.store,
				space: this.space,
				rootId: this.token.rootId,
				thenSeq: this.token.thenSeq,
				to: pin,
				mode: "restore",
			},
			copy,
		);
	}

	cursor(): string {
		return sealOutlineValue("restore", [
			this.token.restoreId,
			this.pass,
			this.deferred,
			this.progressed ? 1 : 0,
			this.verified,
			encodeDiffWalkState(this.start, this.token.pin),
		]);
	}

	private get outOfTime(): boolean {
		return Date.now() - this.startedAt > this.limits.maxCallMs;
	}

	// ── conflicts ────────────────────────────────────────────────────────────

	/**
	 * Every commit after `verified` that changed anything under the root must be this restore's
	 * own. Reads the root's change marks (or, for the whole space, every commit) a bounded page
	 * at a time.
	 */
	async verify(): Promise<void> {
		const space = await this.store.getSpace(this.space.id);
		if (!space) throw new NotFoundError("Outline space", this.space.id);
		this.space = space;
		this.rowsBefore += 1;
		const latest = space.nextSeq - 1;
		const marker = outlineRestoreMarker(this.token.restoreId);
		const check = async (seqs: number[]) => {
			if (seqs.length === 0) return;
			const commits = await this.store.getCommitsBySeqs(space.id, seqs);
			this.rowsBefore += commits.length;
			const foreign = commits
				.filter((commit) => commit.kind !== "revert" || commit.toolCallId !== marker)
				.map((commit) => commit.seq)
				.sort((a, b) => a - b)[0];
			if (foreign !== undefined) {
				throw new OutlineRestoreConflictError({
					restoreId: this.token.restoreId,
					previewSeq: this.token.pin,
					conflictSeq: foreign,
				});
			}
		};
		const rootId = this.token.rootId;
		const page = 200;
		if (rootId === null) {
			for (let from = this.verified + 1; from <= latest; from += page) {
				const seqs: number[] = [];
				for (let seq = from; seq < from + page && seq <= latest; seq++) seqs.push(seq);
				await check(seqs);
				await yieldToEventLoop();
			}
		} else {
			for (let before: number | null = null; ; ) {
				const below = await this.store.listSubtreeChangeSeqs(space.id, rootId, {
					before,
					after: this.verified,
					limit: page,
				});
				this.rowsBefore += below.length;
				await check(below);
				if (below.length < page) break;
				before = below.at(-1) as number;
				await yieldToEventLoop();
			}
			for (let before: number | null = null; ; ) {
				const own = await this.store.listBlockHistory(rootId, { before, limit: page });
				this.rowsBefore += own.length;
				await check(own.map((row) => row.fromSeq).filter((seq) => seq > this.verified));
				const last = own.at(-1);
				if (own.length < page || !last || last.fromSeq <= this.verified) break;
				before = last.fromSeq;
			}
		}
		this.verified = latest;
	}

	// ── the loop ─────────────────────────────────────────────────────────────

	/** What `handle` reads for an item after the walk, at most. */
	private readonly late: DiffLateCost = {
		max: 1 + OUTLINE_LIMITS.maxTagsPerBlock,
		cost: (item) => (item.own ? 1 + (item.tagsMayDiffer ? OUTLINE_LIMITS.maxTagsPerBlock : 0) : 1),
	};

	/** Work until the subtree is restored or this call's budget is spent; true when done. */
	async run(): Promise<boolean> {
		await this.verify();
		for (;;) {
			try {
				if (this.walk.finished) {
					await this.flush();
					if (this.deferred > 0 && this.progressed && this.pass + 1 < this.limits.maxPasses) {
						this.pass++;
						// What the last pass could not do yet is tried again: forget that it was said.
						for (const [id, skip] of this.skipped) {
							if (skip.reason !== "parent-moved-away" && skip.reason !== "lock-kept")
								this.skipped.delete(id);
						}
						this.deferred = 0;
						this.progressed = false;
						this.keptIds.clear();
						this.start = newDiffWalkState();
						this.walk = this.newWalk(this.start);
						continue;
					}
					return true;
				}
				// The budgets of a call; one step at least is always made, so every call moves on.
				if (
					this.steps > 0 &&
					(this.commits.length >= this.limits.maxCommitsPerCall ||
						this.outOfTime ||
						this.rows >= this.limits.maxRowsPerCall)
				) {
					await this.flush();
					return false;
				}
				const budget = Math.max(
					this.limits.maxRowsPerCall - this.rows,
					this.steps === 0 ? OUTLINE_DIFF_LIMITS.maxStoreRows : 0,
				);
				const step = await this.walk.step(budget, this.late);
				if (!step) {
					await this.flush();
					return false;
				}
				this.steps++;
				await this.handle(step);
				if (this.batchBlocks.size >= this.batchLimit) await this.flush();
			} catch (error) {
				if (error instanceof RestoreOutOfTime) return false;
				if (!(error instanceof RestoreRestart)) throw error;
				// Another commit landed: it must not have touched the subtree; then start again
				// from the last commit of this restore, against the rows as they are, in smaller
				// batches (a shorter time between reading and writing).
				if (++this.restarts > STALE_RESTARTS)
					throw new OutlineBusyError(this.space.id, STALE_RESTARTS);
				this.batchLimit = Math.max(1, Math.floor(this.batchLimit / 4));
				this.batch = [];
				this.batchBlocks.clear();
				this.overlay.clear();
				await this.verify();
				this.walk = this.newWalk(this.start);
			}
			await yieldToEventLoop();
		}
	}

	// ── analysis ─────────────────────────────────────────────────────────────

	private cur(meta: OutlineBlockMeta): OutlineBlockMeta {
		const patch = this.overlay.get(meta.id);
		return patch ? { ...meta, ...patch } : meta;
	}

	private patch(id: string, patch: Partial<OutlineBlockMeta>): void {
		this.overlay.set(id, { ...this.overlay.get(id), ...patch });
	}

	private add(entry: RestoreBatchEntry): void {
		this.batch.push(entry);
		this.batchBlocks.add(entry.blockId);
	}

	private skip(meta: { id: string; sid: string }, reason: OutlineRestoreSkipReason): void {
		if (!this.skipped.has(meta.id)) this.skipped.set(meta.id, { sid: meta.sid, reason });
	}

	private async metas(ids: readonly string[]): Promise<OutlineBlockMeta[]> {
		if (ids.length === 0) return [];
		const rows = await this.store.getBlockMetas(this.space.id, { ids: [...new Set(ids)] });
		this.rowsBefore += rows.length;
		return rows;
	}

	private async handle(step: DiffStep): Promise<void> {
		if (step.type === "root") {
			if (step.item) await this.own([step.item], null, false, true);
			return;
		}
		if (step.type === "close") {
			if (step.kind !== "added" || step.parentId === null) return;
			const meta = (await this.metas([step.parentId]))[0];
			if (!meta || this.cur(meta).deleted) return;
			if (step.kept || this.keptIds.has(meta.id)) {
				this.deferred++;
				this.skip(meta, "holds-kept");
				return;
			}
			this.add({
				op: { op: "delete", block: { id: meta.id } },
				blockId: meta.id,
				dependsOn: null,
				guards: [],
				close: true,
			});
			this.patch(meta.id, { deleted: true });
			return;
		}

		const { items, parentId, kind, frameIndex } = step;
		const guards = this.walk.addedAbove(frameIndex);
		const mine = items.filter((item) => item.own);
		const arrived = items.filter((item) => !item.own);
		for (const item of mine) if (item.kind === "moved-away") this.movedAway.add(item.id);

		// Leaves added since go first: they free the order keys they took.
		for (const item of arrived) {
			if (item.before !== null || item.descend !== null || this.cur(item.meta).deleted) continue;
			this.add({
				op: { op: "delete", block: { id: item.id } },
				blockId: item.id,
				dependsOn: null,
				guards: [],
			});
			this.patch(item.id, { deleted: true });
		}

		// The order keys the blocks of this page go back to under this parent, and the siblings
		// sitting on them now: set aside first.
		const placing =
			kind === "then"
				? mine.filter((item) => (item.at === null && item.kind === "removed") || item.inNow)
				: [];
		const wanted = new Map<string, string>();
		for (const item of placing) {
			const now = this.cur(item.meta);
			const key = (item.before as OutlineVersionHead).orderKey;
			if (!now.deleted && now.parentId !== parentId && item.at === null) continue;
			if (now.deleted || now.parentId !== parentId || now.orderKey !== key)
				wanted.set(key, item.id);
		}
		if (wanted.size > 0) {
			for (const item of items) {
				const now = this.cur(item.meta);
				if (now.deleted || now.parentId !== parentId) continue;
				const wanter = wanted.get(now.orderKey);
				if (wanter === undefined || wanter === item.id || this.held.has(item.id)) continue;
				const orderKey = parkKey(now.orderKey);
				this.add({
					op: {
						op: "move",
						block: { id: item.id },
						parent: parentId === null ? null : { id: parentId },
						position: { orderKey },
					},
					blockId: item.id,
					dependsOn: null,
					guards: [],
					park: true,
				});
				this.patch(item.id, { orderKey });
			}
		}

		// Blocks that moved in go back out.
		const movedIn = arrived.filter((item) => item.before !== null && !item.inThen);
		const outside = movedIn
			.map((item) => item.before?.parentId ?? null)
			.filter((id): id is string => id !== null);
		const outsideMetas = new Map(
			(await this.metas(outside)).map((meta) => [meta.id, this.cur(meta)]),
		);
		for (const item of movedIn) {
			const before = item.before as OutlineVersionHead;
			const now = this.cur(item.meta);
			if (now.deleted || this.held.has(item.id)) continue;
			if (now.parentId === before.parentId && now.orderKey === before.orderKey) continue;
			if (before.parentId !== null && !liveNow(outsideMetas.get(before.parentId))) {
				this.skip(item.meta, "parent-gone");
				this.walk.keep(frameIndex);
				continue;
			}
			this.add({
				op: {
					op: "move",
					block: { id: item.id },
					parent: before.parentId === null ? null : { id: before.parentId },
					position: { orderKey: before.orderKey },
				},
				blockId: item.id,
				dependsOn: before.parentId,
				guards,
			});
			this.patch(item.id, { parentId: before.parentId, orderKey: before.orderKey });
		}

		// A block of the subtree that sits under a block added since must leave it before that
		// one can go: it is placed where it belonged (by the frame of its parent of then, maybe
		// later in this pass); until it has left, the added block stays.
		if (kind === "added") {
			for (const item of arrived) {
				if (item.before === null || !item.inThen) continue;
				const now = this.cur(item.meta);
				if (!now.deleted && now.parentId === parentId) this.walk.keep(frameIndex);
			}
		}

		await this.own(mine, parentId, kind === "away", false);
	}

	/**
	 * Put the subtree's own blocks of one page back: under `parentId` at their order keys of
	 * then (not for the root, nor under a parent that is away), with their text and fields.
	 * Only blocks under the root: one under it at `now` (as the walk read it), or one removed
	 * since that is still deleted, or that this restore already brought back under its parent.
	 */
	private async own(
		items: DiffItem[],
		parentId: string | null,
		away: boolean,
		isRoot: boolean,
	): Promise<void> {
		const work = items.filter((item) => {
			if (item.before === null || this.held.has(item.id)) return false;
			if (item.inNow) return true;
			if (item.at !== null || item.kind !== "removed") return false;
			// Removed: still deleted, or brought back under its parent (by this restore: anyone
			// else's commit there is a conflict). Brought back anywhere else: not ours to touch.
			const now = this.cur(item.meta);
			return now.deleted || (!away && now.parentId === parentId);
		});
		if (work.length === 0) return;
		const needText = work.filter((item) => {
			const now = this.cur(item.meta);
			return now.deleted || now.contentHash !== (item.before as OutlineVersionHead).contentHash;
		});
		const texts = new Map<string, string>();
		if (needText.length > 0) {
			const rows = await this.store.listVersionContents(
				needText.map((item) => ({
					blockId: item.id,
					fromSeq: (item.before as OutlineVersionHead).fromSeq,
				})),
			);
			this.rowsBefore += rows.length;
			for (const row of rows) texts.set(row.blockId, row.content ?? "");
		}
		// Tags now: only of live blocks whose tags may differ (the walk read their tags of then).
		const tagged = work
			.filter((item) => item.tagsMayDiffer && !this.cur(item.meta).deleted)
			.map((item) => item.id);
		const tagsNow = new Map<string, string[]>(tagged.map((id) => [id, []]));
		if (tagged.length > 0) {
			const links = await this.store.listLinksAt(
				tagged,
				null,
				["tag"],
				tagged.length * OUTLINE_LIMITS.maxTagsPerBlock,
			);
			this.rowsBefore += links.length;
			for (const link of links) tagsNow.get(link.fromBlockId)?.push(link.targetRef);
			for (const list of tagsNow.values()) list.sort();
		}

		// Aliases that change hands are let go first.
		for (const item of work) {
			const before = item.before as OutlineVersionHead;
			const now = this.cur(item.meta);
			if (!now.deleted && now.alias !== null && now.alias !== before.alias) {
				this.add({
					op: { op: "update", block: { id: item.id }, alias: null },
					blockId: item.id,
					dependsOn: null,
					guards: [],
				});
				this.patch(item.id, { alias: null });
			}
		}

		for (const item of work) {
			const before = item.before as OutlineVersionHead;
			const now = this.cur(item.meta);
			const block = { id: item.id };
			// Only a placement depends on the parent: text and fields are put back whatever happens
			// to it.
			const push = (op: OutlineOp) =>
				this.add({
					op,
					blockId: item.id,
					dependsOn: op.op === "restore" || op.op === "move" ? parentId : null,
					guards: [],
				});
			const parent = parentId === null ? null : { id: parentId };
			if (now.deleted) {
				if (isRoot) continue;
				if (away) {
					this.skip(item.meta, "parent-moved-away");
					continue;
				}
				push({
					op: "restore",
					block,
					parent,
					position: { orderKey: before.orderKey },
					content: texts.get(item.id) ?? "",
					alias: before.alias,
					task: before.taskJson ? taskInput(before.taskJson) : null,
					ask: before.askJson,
					tags: item.thenTags ?? [],
				});
				this.patch(item.id, { deleted: false, parentId, orderKey: before.orderKey });
				continue;
			}
			if (!isRoot && (now.parentId !== before.parentId || now.orderKey !== before.orderKey)) {
				if (away) this.skip(item.meta, "parent-moved-away");
				else {
					push({ op: "move", block, parent, position: { orderKey: before.orderKey } });
					this.patch(item.id, { parentId, orderKey: before.orderKey });
				}
			}
			// Text and fields can only differ for a block with a version of its own since then
			// (or one this restore brought back).
			if (!item.self && item.inNow) continue;
			const differ = contentFieldsDiffer(before, now);
			if (differ.includes("text")) push({ op: "update", block, content: texts.get(item.id) ?? "" });
			if (before.alias !== null && before.alias !== now.alias)
				push({ op: "update", block, alias: before.alias });
			if (
				item.thenTags !== undefined &&
				tagsNow.has(item.id) &&
				item.thenTags.join("\n") !== (tagsNow.get(item.id) ?? []).join("\n")
			)
				push({ op: "update", block, tags: item.thenTags });
			if (!sameTaskJson(before.taskJson, now.taskJson)) {
				push({
					op: "setTask",
					block,
					task: before.taskJson ? taskPatch(before.taskJson, now.taskJson) : null,
				});
			}
			if (differ.includes("question")) push({ op: "update", block, ask: before.askJson });
		}
	}

	// ── writing ──────────────────────────────────────────────────────────────

	private async flush(): Promise<void> {
		const entries = this.batch;
		this.batch = [];
		this.batchBlocks.clear();
		this.overlay.clear();
		// Out of time inside a split batch (`RestoreOutOfTime`): `start` stays where it stood
		// before this batch, and the next call finds what is already written done.
		await this.write(entries);
		this.start = this.walk.snapshot();
	}

	/** Report and keep the added blocks a dropped move or delete would take along. */
	private keepAll(ids: Iterable<string>): void {
		const set = new Set(ids);
		for (const id of set) this.keptIds.add(id);
		this.walk.keepIds(set);
	}

	/** Drop a refused block's operations, and what cannot be written without them. */
	private async drop(entries: RestoreBatchEntry[], blockId: string): Promise<RestoreBatchEntry[]> {
		const { left, dropped, unsafe } = dropRefused(entries, blockId);
		this.keepAll(unsafe);
		// What depended on the refused block is reported too: nothing is left undone unsaid.
		const dependents = [...dropped].filter((id) => id !== blockId);
		for (const meta of await this.metas(dependents)) this.skip(meta, "parent-refused");
		for (const meta of await this.metas([...unsafe].filter((id) => !this.skipped.has(id))))
			this.skip(meta, "holds-kept");
		this.deferred += dropped.size + unsafe.size;
		return left;
	}

	/**
	 * The guard of every delete in a batch (see the header): a block deleted by the batch may hold
	 * only blocks the batch moves out or deletes before deleting it. Its live children as they
	 * are now are read, at most one more than the batch removes before it, so the read is
	 * bounded by the batch. A delete that fails is dropped (the block is kept, `holds-kept`),
	 * which may make a delete above it fail in turn. Deletes of blocks known to be kept are
	 * dropped first.
	 */
	private async guardDeletes(entries: RestoreBatchEntry[]): Promise<RestoreBatchEntry[]> {
		let list = entries.filter(
			(entry) => !(entry.op.op === "delete" && this.keptIds.has(entry.blockId)),
		);
		const deletes = list.filter((entry) => entry.op.op === "delete");
		if (deletes.length === 0) return list;
		const children = new Map<string, string[]>();
		for (const [index, entry] of list.entries()) {
			if (entry.op.op !== "delete") continue;
			const removals = list
				.slice(0, index)
				.filter((other) => other.op.op === "delete" || other.op.op === "move").length;
			const { rows } = await this.store.listLevel(this.space.id, entry.blockId, {
				asOf: null,
				limit: removals + 1,
			});
			this.rowsBefore += rows.length;
			children.set(
				entry.blockId,
				rows.map((row) => row.id),
			);
		}
		const failed = new Set<string>();
		for (let changed = true; changed; ) {
			changed = false;
			for (const [index, entry] of list.entries()) {
				if (entry.op.op !== "delete" || failed.has(entry.blockId)) continue;
				const earlier = list.slice(0, index);
				const removed = new Set<string>();
				let added = false;
				for (const other of earlier) {
					const op = other.op;
					if (op.op === "delete" && !failed.has(other.blockId)) removed.add(other.blockId);
					else if (op.op === "move" || op.op === "restore") {
						const target = op.parent && "id" in op.parent ? op.parent.id : null;
						if (target === entry.blockId) added = true;
						else if (op.op === "move") removed.add(other.blockId);
					}
				}
				const holds = (children.get(entry.blockId) ?? []).some((child) => !removed.has(child));
				if (holds || added) {
					failed.add(entry.blockId);
					changed = true;
				}
			}
		}
		if (failed.size === 0) return list;
		list = list.filter((entry) => !(entry.op.op === "delete" && failed.has(entry.blockId)));
		this.keepAll(failed);
		for (const meta of await this.metas([...failed])) this.skip(meta, "holds-kept");
		this.deferred += failed.size;
		return list;
	}

	private async write(all: RestoreBatchEntry[]): Promise<void> {
		let entries = all;
		for (let refusals = 0; entries.length > 0; ) {
			entries = await this.guardDeletes(entries);
			if (entries.length === 0) return;
			let written: OutlineWriteResult;
			try {
				written = await writeOutline(
					{
						spaceId: this.space.id,
						ops: entries.map((entry) => entry.op),
						actor: this.writer.actor,
						responsibleUserId: this.writer.responsibleUserId,
						narratorId: this.writer.narratorId ?? null,
						messageId: this.writer.messageId ?? null,
						toolCallId: outlineRestoreMarker(this.token.restoreId),
						summary: this.summary,
						...(this.writer.unlockAuthority
							? { unlockAuthority: this.writer.unlockAuthority }
							: {}),
					},
					{
						store: this.store,
						now: this.options.now,
						compensating: { expectNextSeq: this.verified + 1 },
					},
				);
			} catch (error) {
				if (error instanceof OutlineStaleWriteError) throw new RestoreRestart();
				if (!(error instanceof OutlineWriteError)) throw error;
				const blocks = [...new Set(entries.map((entry) => entry.blockId))];
				const tooLarge =
					error.code === "OUTLINE_TOO_MANY_ROWS" || error.code === "OUTLINE_TOO_MANY_OPS";
				// A batch too large is split, never taken for a refusal of the op that crossed the
				// line.
				const refused = tooLarge || error.opIndex === null ? undefined : entries[error.opIndex];
				if (refused && ++refusals <= REFUSALS_PER_BATCH) {
					const meta = (await this.metas([refused.blockId]))[0];
					if (meta) {
						const lock = error.code === "OUTLINE_LOCK_DENIED" || error.code === "OUTLINE_LOCK_HELD";
						this.skip(meta, lock ? "lock-kept" : "refused");
					}
					entries = await this.drop(entries, refused.blockId);
					continue;
				}
				if (!tooLarge) throw error;
				// Too large for one commit (rows, or change marks): two halves, in order.
				if (blocks.length <= 1) {
					const meta = (await this.metas(blocks))[0];
					if (meta) this.skip(meta, "refused");
					this.deferred++;
					return;
				}
				const first = new Set(blocks.slice(0, Math.ceil(blocks.length / 2)));
				let cut = entries.length;
				for (let i = 0; i < entries.length; i++) {
					if (!first.has((entries[i] as RestoreBatchEntry).blockId)) {
						cut = i;
						break;
					}
				}
				await this.write(entries.slice(0, Math.max(1, cut)));
				// The call's clock is checked between halves too (once something was written).
				if (this.commits.length > 0 && this.outOfTime) throw new RestoreOutOfTime();
				await this.write(entries.slice(Math.max(1, cut)));
				return;
			}
			await this.settle(entries, written);
			return;
		}
	}

	private async settle(entries: RestoreBatchEntry[], written: OutlineWriteResult): Promise<void> {
		const noted = new Map<string, OutlineRestoreSkipReason>();
		written.results.forEach((result, i) => {
			const entry = entries[i] as RestoreBatchEntry;
			if (result.pending) this.held.add(entry.blockId);
			if (entry.park) return;
			for (const adjustment of result.adjustments ?? []) {
				if (adjustment.kind === "lock-kept") noted.set(entry.blockId, "lock-kept");
				else if (adjustment.kind === "order-key-moved" || adjustment.kind === "alias-dropped") {
					if (!noted.has(entry.blockId)) noted.set(entry.blockId, "place-taken");
					this.deferred++;
				}
			}
		});
		if (noted.size > 0) {
			for (const meta of await this.metas([...noted.keys()]))
				this.skip(meta, noted.get(meta.id) as OutlineRestoreSkipReason);
		}
		if (written.pending) this.pending = { id: written.pending.id, label: written.pending.label };
		if (!written.commit) return;
		this.commits.push(written.commit);
		this.verified = written.commit.seq;
		this.progressed = true;
		this.changed += new Set(entries.map((entry) => entry.blockId)).size;
		await this.options.afterCommit?.(written.commit);
	}
}

/**
 * Restore the subtree a preview's `token` names to its seq, as compensating commits. One call
 * writes a bounded number of them and answers `done: false` with a cursor when more is left;
 * calling again with the same token continues (the cursor only saves walking again what is
 * done; without one, the call continues from the last cursor this process handed out), and a
 * call after the restore is complete writes nothing. Throws `OutlineRestoreConflictError` when
 * anything under the subtree changed after the preview other than by this restore,
 * `OutlineRestoreTokenError` for a token or cursor that is not this server's, someone else's,
 * or expired, H2's history errors, and `OutlineBusyError` when the space keeps changing.
 */
export async function restoreOutlineSubtree(
	input: OutlineRestoreWriter & {
		space: OutlineSpaceRow;
		token: string;
		cursor?: string | null;
	},
	options: OutlineRestoreOptions = {},
): Promise<OutlineRestoreResponse> {
	const store = options.store ?? outlineStore;
	const token = openToken(
		input.token,
		input.space,
		personOf(input),
		(options.now ?? (() => new Date()))(),
	);
	let state = newDiffWalkState();
	let pass = 0;
	let deferred = 0;
	let progressed = false;
	let verified = token.pin;
	const sealed = input.cursor ?? lastCursors.get(token.restoreId) ?? null;
	if (sealed) {
		const value = openOutlineValue("restore", sealed, "cursor");
		if (!Array.isArray(value) || value.length !== 6 || value[0] !== token.restoreId)
			throw new OutlineRestoreTokenError("cursor");
		const [, p, d, g, v, frames] = value as unknown[];
		if (!isSeq(p) || !isSeq(d) || !isSeq(v) || v < token.pin)
			throw new OutlineRestoreTokenError("cursor");
		pass = p;
		deferred = d;
		progressed = g === 1;
		verified = v;
		state = decodeDiffWalkState(frames, token.pin);
	}
	return await withOutlineLiveBarrier(input.space.id, async () => {
		const space = await store.getSpace(input.space.id);
		if (!space) throw new NotFoundError("Outline space", input.space.id);
		await assertOutlineHistoryAt(store, space, token.thenSeq);
		let address: string | null = null;
		if (token.rootId !== null) {
			const root = (await store.getBlockMetas(space.id, { ids: [token.rootId] }))[0];
			if (!liveNow(root))
				throw new OutlineRestoreRootError({ blockId: token.rootId, seq: space.nextSeq - 1 });
			address = `${space.key}/${root.sid}`;
		}
		const restorer = new SubtreeRestorer(
			store,
			space,
			token,
			input,
			options,
			state,
			pass,
			deferred,
			progressed,
			Math.min(verified, space.nextSeq - 1),
			OUTLINE_TEXT.restoreSummary(token.thenSeq, address),
		);
		const done = token.pin <= token.thenSeq ? true : await withOutlineHistory(() => restorer.run());
		const cursor = done ? null : restorer.cursor();
		rememberCursor(token.restoreId, cursor);
		const skipped = [...restorer.skipped].map(([blockId, skip]) => ({ blockId, ...skip }));
		return {
			spaceId: space.id,
			restoreId: token.restoreId,
			done,
			cursor,
			commits: restorer.commits,
			changed: restorer.changed,
			skipped: skipped.slice(0, OUTLINE_RESTORE_LIMITS.maxSkipped),
			skippedTruncated: skipped.length > OUTLINE_RESTORE_LIMITS.maxSkipped,
			movedAway: restorer.movedAway.size,
			...(restorer.pending ? { pending: restorer.pending } : {}),
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Move one block back
// ─────────────────────────────────────────────────────────────────────────────

const MOVE_BACK_ATTEMPTS = 5;

/**
 * Move one block back under the parent, and to the order key, it had at the seq `then`: what
 * the "move back" of a block a restore listed as moved away does. A block deleted since is
 * brought back there as it was when it was deleted. Nothing else of the block changes, and
 * what is under it comes with it. One compensating commit; none when it already is there.
 * Throws `OutlineRestoreRootError` when the block was not in the tree then,
 * `OutlineRestoreParentGoneError` when its parent of then is deleted now, the write path's
 * `OUTLINE_CYCLE` when that parent sits under the block now, and H2's history errors.
 */
export async function moveOutlineBlockBack(
	input: OutlineRestoreWriter & { space: OutlineSpaceRow; blockId: string; thenSeq: number },
	options: Pick<OutlineRestoreOptions, "store" | "now"> = {},
): Promise<OutlineMoveBackResponse> {
	const store = options.store ?? outlineStore;
	const { blockId, thenSeq } = input;
	return await withOutlineLiveBarrier(input.space.id, async () => {
		for (let attempt = 0; attempt < MOVE_BACK_ATTEMPTS; attempt++) {
			const space = await store.getSpace(input.space.id);
			if (!space) throw new NotFoundError("Outline space", input.space.id);
			await assertOutlineHistoryAt(store, space, thenSeq);
			const meta = (await store.getBlockMetas(space.id, { ids: [blockId] }))[0];
			const before = (await store.listVersionHeadsAt([blockId], thenSeq, 0))[0];
			if (!meta || !before || before.deleted)
				throw new OutlineRestoreRootError({ blockId, seq: thenSeq });
			const base = { spaceId: space.id, blockId };
			if (!meta.deleted && meta.parentId === before.parentId && meta.orderKey === before.orderKey)
				return { ...base, commit: null, restored: false, orderKeyMoved: false };
			if (before.parentId !== null) {
				const parent = (await store.getBlockMetas(space.id, { ids: [before.parentId] }))[0];
				if (!liveNow(parent)) throw new OutlineRestoreParentGoneError(blockId, before.parentId);
			}
			const parent = before.parentId === null ? null : { id: before.parentId };
			const position = { orderKey: before.orderKey };
			const op: OutlineOp = meta.deleted
				? { op: "restore", block: { id: blockId }, parent, position }
				: { op: "move", block: { id: blockId }, parent, position };
			let written: OutlineWriteResult;
			try {
				written = await writeOutline(
					{
						spaceId: space.id,
						ops: [op],
						actor: input.actor,
						responsibleUserId: input.responsibleUserId,
						narratorId: input.narratorId ?? null,
						messageId: input.messageId ?? null,
						summary: OUTLINE_TEXT.moveBackSummary(thenSeq, `${space.key}/${meta.sid}`),
						...(input.unlockAuthority ? { unlockAuthority: input.unlockAuthority } : {}),
					},
					{ store, now: options.now, compensating: { expectNextSeq: space.nextSeq } },
				);
			} catch (error) {
				if (error instanceof OutlineStaleWriteError) continue;
				throw error;
			}
			return {
				...base,
				commit: written.commit,
				restored: meta.deleted && written.commit !== null,
				orderKeyMoved: (written.results[0]?.adjustments ?? []).some(
					(adjustment) => adjustment.kind === "order-key-moved",
				),
			};
		}
		throw new OutlineBusyError(input.space.id, MOVE_BACK_ATTEMPTS);
	});
}
