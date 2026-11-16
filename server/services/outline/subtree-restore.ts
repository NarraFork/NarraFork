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
 *   - `removed` (under R then, deleted now): brought back under its parent of then, at its
 *     order key, with its text, task, question, alias and tags of then. A block deleted after
 *     it had moved away is brought back too: there is nowhere else it is.
 *   - `changed` (under R at both): parent, order key, text and fields put back.
 *   - `added` (under R now, not in the tree then): deleted, once nothing that stays is under it.
 *   - `moved-in` (under R now, elsewhere then): moved back to its parent and order key of then.
 *     Nothing else of it is touched, and what sits under it goes with it.
 *   - `moved-away` (under R then, elsewhere now): NOT pulled back, only counted and listed by
 *     the preview; `moveOutlineBlockBack` moves one back when asked.
 *   - R itself: its text and fields are put back; where it sits is not part of its subtree.
 *
 * Left alone, and said so (`OutlineRestoreSkipReason`): a block whose parent of then has moved
 * away keeps its place (its text and fields are still put back); a moved-in block whose old
 * parent is deleted stays; an added block that holds such a block is not deleted; what the
 * write path refuses; someone else's lock.
 *
 * ONE LOGICAL OPERATION, MANY COMMITS
 * -----------------------------------
 * A preview pins the space's seq (`now`) and names the restore (`restoreId`); both are in its
 * token, sealed. The restore then walks the same comparison (`subtree-diff.ts`, the tree as it
 * stood at `now`), and for every block it meets writes what separates its row AS IT IS from
 * its state of then. That makes it idempotent by construction: a block already put back needs
 * nothing, so a restore interrupted anywhere, or confirmed twice, continues and never applies
 * anything twice. No record of the operation is kept in a table.
 *
 * Its commits carry the restore's id (`toolCallId`: `outline-restore:<id>`, an audit field
 * with no foreign key). Before writing, and again whenever another commit is found to have
 * landed, every commit after `now` that changed anything under R must be one of them; else
 * the restore stops with `OutlineRestoreConflictError` (409). Each commit is written only if
 * the space is still at the seq its analysis read (`compensating.expectNextSeq`).
 *
 * BATCHES. Operations are gathered in walk order (parents before children; an added block
 * after what is under it) and written when a batch holds
 * `OUTLINE_RESTORE_LIMITS.maxBlocksPerCommit` blocks, each batch one atomic commit. A batch the
 * write path finds too large (rows, or the 4,000 change marks) is split in two and tried
 * again; an operation it refuses is dropped with what depended on it, and reported. A call
 * writes a bounded number of commits and answers with a cursor; calling again continues.
 *
 * ORDER KEYS. A block goes back to its exact order key. A sibling that sits on that key now
 * (another block of the level that is about to be re-keyed, deleted or moved on) is first set
 * aside on a key of its own, in the same commit. A key still taken (by a block another page of
 * the level, or another parent, deals with later) places the block next to it; the next pass
 * over the subtree finds the key free. There are at most `maxPasses` passes.
 *
 * MAIN THREAD: every step is one bounded page of the walk and its reads; the loop yields to
 * the event loop between steps.
 */
import { NotFoundError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import {
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
import type { OutlineActorKind } from "./model";
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
	]);
}

function openToken(sealed: string, space: OutlineSpaceRow): RestoreToken {
	const value = openOutlineValue("token", sealed, "token");
	if (!Array.isArray(value) || value.length !== 5) throw new OutlineRestoreTokenError("token");
	const [spaceId, rootId, thenSeq, pin, restoreId] = value as unknown[];
	if (
		spaceId !== space.id ||
		typeof rootId !== "string" ||
		!isSeq(thenSeq) ||
		!isSeq(pin) ||
		pin >= space.nextSeq ||
		typeof restoreId !== "string"
	)
		throw new OutlineRestoreTokenError("token");
	return { spaceId: space.id, rootId: rootId === "" ? null : rootId, thenSeq, pin, restoreId };
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

/**
 * What restoring the subtree of `rootId` (null: the whole space) to the seq `then` would do,
 * a page at a time, without writing anything: the change list with what happens to each block,
 * the blocks that have moved away (action `none`), and the token the restore is confirmed with.
 * The first page (no `token`) pins the space's last commit and names the restore; further
 * pages pass its `token` and the `cursor`, and are of the same moment. Costs what a page of the
 * comparison costs. Throws H2's history errors and `OutlineRestoreRootError`.
 */
export async function previewOutlineRestore(input: {
	space: OutlineSpaceRow;
	rootId: string | null;
	thenSeq: number;
	token?: string | null;
	cursor?: string | null;
	limit?: number;
	store?: OutlineStore;
}): Promise<OutlineRestorePreviewResponse> {
	const store = input.store ?? outlineStore;
	const { space } = input;
	let token: RestoreToken;
	let state = newDiffWalkState();
	if (input.token) {
		token = openToken(input.token, space);
		if (token.rootId !== input.rootId || token.thenSeq !== input.thenSeq)
			throw new OutlineRestoreTokenError("token");
		if (input.cursor) {
			const value = openOutlineValue("preview", input.cursor, "cursor");
			if (!Array.isArray(value) || value.length !== 2 || value[0] !== token.restoreId)
				throw new OutlineRestoreTokenError("cursor");
			state = decodeDiffWalkState(value[1]);
		}
	} else {
		if (input.cursor) throw new OutlineRestoreTokenError("cursor");
		token = {
			spaceId: space.id,
			rootId: input.rootId,
			thenSeq: input.thenSeq,
			pin: space.nextSeq - 1,
			restoreId: generateId(),
		};
	}
	await assertOutlineHistoryAt(store, space, token.thenSeq);
	const limit = clampDiffLimit(input.limit);
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
	const walk = new SubtreeDiffWalk(
		{ store, space, rootId: token.rootId, thenSeq: token.thenSeq, to: token.pin, mode: "compare" },
		state,
	);
	return await withOutlineHistory(async () => {
		while (!walk.finished && diffHasRoom(walk, entries.length, limit)) {
			const step = await walk.step();
			if (step.type === "close") {
				if (step.kind === "added" && step.kept && step.parentId !== null) {
					const meta = (await store.getBlockMetas(space.id, { ids: [step.parentId] }))[0];
					if (meta) skipped.push({ blockId: meta.id, sid: meta.sid, reason: "holds-kept" });
				}
				continue;
			}
			if (step.type === "root") {
				const entry = step.item ? diffEntry(step.item) : null;
				if (entry) entries.push({ ...entry, action: "put-back" });
				continue;
			}
			// Whether the parent of then of a block that moved (in, or away) is live now.
			const parents = step.items
				.filter((item) => item.kind === "moved-in" || item.kind === "moved-away")
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
			for (const item of step.items) {
				const entry = diffEntry(item);
				if (!entry) continue;
				let action: OutlineRestoreAction;
				let skip: OutlineRestoreSkipReason | undefined;
				let canMoveBack: boolean | undefined;
				if (item.kind === "added") action = "delete";
				else if (item.kind === "moved-in") {
					action = "move-out";
					if (!parentLive(item)) {
						skip = "parent-gone";
						walk.keep(step.frameIndex);
					}
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
				});
			}
		}
		return response(
			walk.finished
				? null
				: sealOutlineValue("preview", [token.restoreId, encodeDiffWalkState(walk.state)]),
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

export interface OutlineRestoreOptions {
	store?: OutlineStore;
	now?: () => Date;
	/** Tighter limits, for tests. */
	limits?: Partial<{
		maxBlocksPerCommit: number;
		maxCommitsPerCall: number;
		maxCallMs: number;
		maxPasses: number;
	}>;
	/** Called after each commit of the restore (tests interrupt a restore here). */
	afterCommit?: (commit: { id: string; seq: number }) => void | Promise<void>;
}

/** One operation of a batch, with what is needed to drop it safely. */
interface BatchEntry {
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

class SubtreeRestorer {
	readonly commits: Array<{ id: string; seq: number }> = [];
	readonly skipped = new Map<string, { sid: string; reason: OutlineRestoreSkipReason }>();
	changed = 0;
	readonly movedAway = new Set<string>();
	pending: { id: string; label: string } | undefined;

	private walk: SubtreeDiffWalk;
	/** Where the walk stood after the last commit: where a restart, and the next call, begin. */
	private start: DiffWalkState;
	private batch: BatchEntry[] = [];
	private readonly batchBlocks = new Set<string>();
	/** Effects of the batch not written yet, over the rows as read. */
	private readonly overlay = new Map<string, Partial<OutlineBlockMeta>>();
	/** Added blocks that must not be deleted: a block under them could not be moved out. */
	private readonly keptIds = new Set<string>();
	/** Blocks whose operations were held for confirmation: not tried again. */
	private readonly held = new Set<string>();
	private readonly limits: Required<NonNullable<OutlineRestoreOptions["limits"]>>;
	private restarts = 0;
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
		this.start = state;
		this.walk = this.newWalk(state);
	}

	private newWalk(state: DiffWalkState): SubtreeDiffWalk {
		const copy = decodeDiffWalkState(encodeDiffWalkState(state));
		return new SubtreeDiffWalk(
			{
				store: this.store,
				space: this.space,
				rootId: this.token.rootId,
				thenSeq: this.token.thenSeq,
				to: this.token.pin,
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
			encodeDiffWalkState(this.start),
		]);
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
		const latest = space.nextSeq - 1;
		const marker = outlineRestoreMarker(this.token.restoreId);
		const check = async (seqs: number[]) => {
			if (seqs.length === 0) return;
			const commits = await this.store.getCommitsBySeqs(space.id, seqs);
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
				await check(below);
				if (below.length < page) break;
				before = below.at(-1) as number;
				await yieldToEventLoop();
			}
			for (let before: number | null = null; ; ) {
				const own = await this.store.listBlockHistory(rootId, { before, limit: page });
				await check(own.map((row) => row.fromSeq).filter((seq) => seq > this.verified));
				const last = own.at(-1);
				if (own.length < page || !last || last.fromSeq <= this.verified) break;
				before = last.fromSeq;
			}
		}
		this.verified = latest;
	}

	// ── the loop ─────────────────────────────────────────────────────────────

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
						this.start = newDiffWalkState();
						this.walk = this.newWalk(this.start);
						continue;
					}
					return true;
				}
				if (
					this.commits.length >= this.limits.maxCommitsPerCall ||
					Date.now() - this.startedAt > this.limits.maxCallMs
				) {
					await this.flush();
					return false;
				}
				await this.handle(await this.walk.step());
				if (this.batchBlocks.size >= this.limits.maxBlocksPerCommit) await this.flush();
			} catch (error) {
				if (!(error instanceof RestoreRestart)) throw error;
				// Another commit landed: it must not have touched the subtree; then start again
				// from the last commit of this restore, against the rows as they are.
				if (++this.restarts > STALE_RESTARTS)
					throw new OutlineBusyError(this.space.id, STALE_RESTARTS);
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

	private add(entry: BatchEntry): void {
		this.batch.push(entry);
		this.batchBlocks.add(entry.blockId);
	}

	private skip(meta: { id: string; sid: string }, reason: OutlineRestoreSkipReason): void {
		if (!this.skipped.has(meta.id)) this.skipped.set(meta.id, { sid: meta.sid, reason });
	}

	private async handle(step: DiffStep): Promise<void> {
		if (step.type === "root") {
			if (step.item) await this.own([step.item], null, false, true);
			return;
		}
		if (step.type === "close") {
			if (step.kind !== "added" || step.parentId === null) return;
			const meta = (await this.store.getBlockMetas(this.space.id, { ids: [step.parentId] }))[0];
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
		const placing = kind === "then" ? mine.filter((item) => item.at === null || item.inNow) : [];
		const wanted = new Map<string, string>();
		for (const item of placing) {
			const now = this.cur(item.meta);
			const key = (item.before as OutlineVersionHead).orderKey;
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
		const outside = [...new Set(movedIn.map((item) => item.before?.parentId ?? null))].filter(
			(id): id is string => id !== null,
		);
		const outsideMetas = new Map(
			(outside.length > 0
				? await this.store.getBlockMetas(this.space.id, { ids: outside })
				: []
			).map((meta) => [meta.id, this.cur(meta)]),
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
	 */
	private async own(
		items: DiffItem[],
		parentId: string | null,
		away: boolean,
		isRoot: boolean,
	): Promise<void> {
		const work = items.filter(
			(item) => item.before !== null && (item.at === null || item.inNow) && !this.held.has(item.id),
		);
		if (work.length === 0) return;
		const needText = work.filter((item) => {
			const now = this.cur(item.meta);
			return now.deleted || now.contentHash !== (item.before as OutlineVersionHead).contentHash;
		});
		const texts = new Map(
			(needText.length > 0
				? await this.store.listVersionContents(
						needText.map((item) => ({
							blockId: item.id,
							fromSeq: (item.before as OutlineVersionHead).fromSeq,
						})),
					)
				: []
			).map((row) => [row.blockId, row.content ?? ""]),
		);
		const tagged = work.filter((item) => item.thenTags !== undefined).map((item) => item.id);
		const tagsNow = new Map<string, string[]>(tagged.map((id) => [id, []]));
		if (tagged.length > 0) {
			for (const link of await this.store.listLinksAt(tagged, null, ["tag"], tagged.length * 32))
				tagsNow.get(link.fromBlockId)?.push(link.targetRef);
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
			// Text and fields can only differ for a block with a version of its own since then.
			if (!item.self) continue;
			const differ = contentFieldsDiffer(before, now);
			if (differ.includes("text")) push({ op: "update", block, content: texts.get(item.id) ?? "" });
			if (before.alias !== null && before.alias !== now.alias)
				push({ op: "update", block, alias: before.alias });
			if (
				item.thenTags !== undefined &&
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
		await this.write(entries);
		this.start = this.walk.snapshot();
	}

	/** Drop a refused block's operations, and what cannot be written without them. */
	private drop(entries: BatchEntry[], blockId: string): BatchEntry[] {
		const dropped = new Set<string>([blockId]);
		const unsafe = new Set<string>();
		let left = entries;
		for (let changed = true; changed; ) {
			changed = false;
			const next: BatchEntry[] = [];
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
				for (const guard of entry.guards) {
					unsafe.add(guard);
					this.keptIds.add(guard);
				}
			}
			left = next;
		}
		this.deferred += dropped.size;
		return left;
	}

	private async write(all: BatchEntry[]): Promise<void> {
		let entries = all;
		for (let refusals = 0; entries.length > 0; ) {
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
				const refused = error.opIndex === null ? undefined : entries[error.opIndex];
				if (refused && ++refusals <= REFUSALS_PER_BATCH) {
					const meta = (
						await this.store.getBlockMetas(this.space.id, { ids: [refused.blockId] })
					)[0];
					if (meta) {
						const lock = error.code === "OUTLINE_LOCK_DENIED" || error.code === "OUTLINE_LOCK_HELD";
						this.skip(meta, lock ? "lock-kept" : "refused");
					}
					entries = this.drop(entries, refused.blockId);
					continue;
				}
				if (error.code !== "OUTLINE_TOO_MANY_ROWS" && error.code !== "OUTLINE_TOO_MANY_OPS")
					throw error;
				// Too large for one commit (rows, or change marks): two halves, in order.
				if (blocks.length <= 1) {
					const meta = (await this.store.getBlockMetas(this.space.id, { ids: blocks }))[0];
					if (meta) this.skip(meta, "refused");
					this.deferred++;
					return;
				}
				const first = new Set(blocks.slice(0, Math.ceil(blocks.length / 2)));
				let cut = entries.length;
				for (let i = 0; i < entries.length; i++) {
					if (!first.has((entries[i] as BatchEntry).blockId)) {
						cut = i;
						break;
					}
				}
				await this.write(entries.slice(0, Math.max(1, cut)));
				await this.write(entries.slice(Math.max(1, cut)));
				return;
			}
			await this.settle(entries, written);
			return;
		}
	}

	private async settle(entries: BatchEntry[], written: OutlineWriteResult): Promise<void> {
		const noted = new Map<string, OutlineRestoreSkipReason>();
		written.results.forEach((result, i) => {
			const entry = entries[i] as BatchEntry;
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
			for (const meta of await this.store.getBlockMetas(this.space.id, { ids: [...noted.keys()] }))
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
 * done), and a call after the restore is complete writes nothing. Throws
 * `OutlineRestoreConflictError` when anything under the subtree changed after the preview
 * other than by this restore, `OutlineRestoreTokenError` for a token or cursor that is not this
 * server's, H2's history errors, and `OutlineBusyError` when the space keeps changing.
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
	const token = openToken(input.token, input.space);
	let state = newDiffWalkState();
	let pass = 0;
	let deferred = 0;
	let progressed = false;
	let verified = token.pin;
	if (input.cursor) {
		const value = openOutlineValue("restore", input.cursor, "cursor");
		if (!Array.isArray(value) || value.length !== 6 || value[0] !== token.restoreId)
			throw new OutlineRestoreTokenError("cursor");
		const [, p, d, g, v, frames] = value as unknown[];
		if (!isSeq(p) || !isSeq(d) || !isSeq(v) || v < token.pin)
			throw new OutlineRestoreTokenError("cursor");
		pass = p;
		deferred = d;
		progressed = g === 1;
		verified = v;
		state = decodeDiffWalkState(frames);
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
		const skipped = [...restorer.skipped].map(([blockId, skip]) => ({ blockId, ...skip }));
		return {
			spaceId: space.id,
			restoreId: token.restoreId,
			done,
			cursor: done ? null : restorer.cursor(),
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
