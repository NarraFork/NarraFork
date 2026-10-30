/**
 * The outline store, stated without a dialect.
 *
 * Two kinds of operation live here:
 *
 *   - READS of current state, small and indexed, each with a hard row limit. The write path
 *     uses them to plan a transaction; tests use them to check what was written. Reads of
 *     history, links and the full-text index (a page as of a seq, timelines, search, backlinks)
 *     are stated in `read-port.ts` and are part of this port too; budgeted rendering and the
 *     rest of the reading logic live in their own modules above it.
 *   - `applyCommit`, the one write: it takes a fully computed {@link OutlineCommitPlan} and
 *     writes it atomically. All deciding (validation, normalization, order keys, link
 *     extraction, invariants) happens before, in `server/services/outline/write.ts`, so the
 *     SQLite implementation's synchronous section only writes rows.
 *
 * THE CONTRACT (inherited from `server/db/backend/write-port.ts`)
 * --------------------------------------------------------------
 * 1. Methods return Promises. The SQLite implementation runs its atomic section strictly
 *    synchronously; the PostgreSQL one runs an async section wrapped in `withPgRetry`.
 * 2. `applyCommit` is all-or-nothing.
 * 3. The plan names the seq it was computed for. The implementation claims it from the space's
 *    `next_seq` counter (`next_seq = seq` → `seq + 1`) as the first statement of the section;
 *    if the counter moved, another commit landed after the plan's reads, and the section
 *    rejects with {@link OutlineStaleWriteError} having written nothing. The caller re-plans.
 * 4. A uniqueness conflict crosses the boundary as `WriteConflictError`, never a driver error.
 * 5. Post-commit side effects (event-bus emission) belong to the caller, after the Promise
 *    resolves: the PostgreSQL implementation may replay its section before resolving once.
 *
 * This file imports nothing dialect-specific.
 */
import type { WritePortIdentity } from "@server/db/backend/write-port";
import type {
	OutlineActorKind,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineLinkTargetKind,
	OutlineSpaceKind,
	OutlineTaskJson,
} from "../model";
import type { OutlineReadPort } from "./read-port";

export { WriteConflictError } from "@server/db/backend/write-port";

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (plain data, field-identical across backends)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineSpaceRow {
	id: string;
	key: string;
	kind: OutlineSpaceKind;
	projectId: string | null;
	narratorId: string | null;
	ownerUserId: string | null;
	nextSeq: number;
	createdAt: string;
	/**
	 * Generation of the space's in-process answers (`outline_spaces.in_process_epoch`): moves when
	 * the background rebuild rewrites them. A commit is planned against it as against `nextSeq`.
	 */
	inProcessEpoch: number;
}

export interface OutlineBlockRow {
	id: string;
	spaceId: string;
	sid: string;
	parentId: string | null;
	pageId: string;
	orderKey: string;
	content: string;
	contentHash: string;
	alias: string | null;
	taskJson: OutlineTaskJson | null;
	authorKind: OutlineActorKind;
	authorId: string;
	versionSeq: number;
	deleted: boolean;
	/**
	 * Derived cache: the block is process (a task, under a task, or in a session space). Not part
	 * of the block's versions; kept in step by the write path (see `outline_blocks`).
	 */
	inProcess: boolean;
}

/** A block without its content and author: what planning a write needs. */
export type OutlineBlockMeta = Omit<OutlineBlockRow, "content" | "authorKind" | "authorId">;

export interface OutlineVersionRow {
	blockId: string;
	fromSeq: number;
	toSeq: number | null;
	commitId: string;
	pageId: string;
	parentId: string | null;
	orderKey: string;
	/** Null for a tombstone. */
	content: string | null;
	taskJson: OutlineTaskJson | null;
	alias: string | null;
	contentHash: string;
	changeFlags: number;
	deleted: boolean;
}

export interface OutlineLinkRow {
	id: string;
	spaceId: string;
	fromBlockId: string;
	kind: OutlineLinkKind;
	targetKind: OutlineLinkTargetKind;
	targetRef: string;
	fromSeq: number;
	toSeq: number | null;
}

export interface OutlineCommitRow {
	id: string;
	spaceId: string;
	seq: number;
	kind: OutlineCommitKind;
	actorKind: OutlineActorKind;
	actorId: string;
	responsibleUserId: string | null;
	narratorId: string | null;
	messageId: string | null;
	toolCallId: string | null;
	createdAt: string;
	summary: string;
}

/**
 * One row of a page's live session log (`outline_live_updates`): a Yjs update as base64. Seq 0 of
 * an epoch, or the first row after a compaction, is a full snapshot of the session's document;
 * the rows after it are increments. Replaying an epoch's rows in seq order rebuilds the document.
 */
export interface OutlineLiveUpdateRow {
	pageBlockId: string;
	epoch: number;
	seq: number;
	updateB64: string;
	actorKind: OutlineActorKind;
	actorId: string;
	createdAt: string;
}

/**
 * One person's view state of one page (`outline_view_state`, design §7.1): folded blocks and the
 * mind map's direction. Personal and outside history: never versioned, never part of a commit.
 */
export interface OutlineViewStateRow {
	userId: string;
	pageBlockId: string;
	collapsed: string[];
	layout: "right" | "down";
	updatedAt: string;
}

/**
 * Who is doing a task (`outline_task_claims`). Held by a session (`holderNarratorId`, with a
 * lease until `expiresAt`), by a person (`holderUserId`, no lease) or by nobody (both null: the
 * claim was released; `epoch` still counts, and `lastHolder*` say who held it last).
 */
export interface OutlineTaskClaimRow {
	taskBlockId: string;
	holderNarratorId: string | null;
	holderUserId: string | null;
	/** Claim generation: grows by one whenever the task is claimed by someone new. */
	epoch: number;
	/** The task block's `version_seq` right after the claiming commit. */
	taskVersionAtClaim: number;
	claimedAt: string;
	/** End of a session's lease (ISO time); null for a person's claim and a released one. */
	expiresAt: string | null;
	/** Who held it when it was last released; null while it is held. */
	lastHolderNarratorId: string | null;
	lastHolderUserId: string | null;
}

/** The space a project, a user or a narrator owns. */
export type OutlineSpaceScope =
	| { kind: "project"; projectId: string }
	| { kind: "personal"; ownerUserId: string }
	| { kind: "session"; narratorId: string };

// ─────────────────────────────────────────────────────────────────────────────
// The write plan
// ─────────────────────────────────────────────────────────────────────────────

/** Columns a commit may change on an existing block. `versionSeq` is set by the store. */
export type OutlineBlockPatch = Partial<
	Pick<
		OutlineBlockRow,
		| "parentId"
		| "pageId"
		| "orderKey"
		| "content"
		| "contentHash"
		| "alias"
		| "taskJson"
		| "authorKind"
		| "authorId"
		| "deleted"
	>
>;

/** One claim the commit writes, taken from the row the plan read. */
export interface OutlineClaimWrite {
	row: OutlineTaskClaimRow;
	/**
	 * The claim as the plan read it (null: there was no row). The section writes only if the row
	 * still is exactly that: a session may have renewed its lease since, which changes whether
	 * the plan's takeover was allowed.
	 */
	expect: OutlineTaskClaimRow | null;
}

/** What a commit does to `outline_task_claims`; see {@link OutlineCommitPlan}. */
export interface OutlineClaimPlan {
	/** Claims taken, taken over, or (a session's own) renewed or passed within its session. */
	put: OutlineClaimWrite[];
	/**
	 * Tasks that left in progress (or were deleted): released whatever they hold now, the holder
	 * moving into `lastHolder*`.
	 */
	release: string[];
	/** Lease expiries: released only while the claim is still exactly the row read (`expect`). */
	expire: Array<{ expect: OutlineTaskClaimRow }>;
	/**
	 * Claim rows a decision of the plan rests on without writing them in `put` or `expire` (a
	 * session ending a task nobody else was holding): the commit is written only while each is
	 * still exactly as read (null: no row).
	 */
	verify: Array<{ taskBlockId: string; expect: OutlineTaskClaimRow | null }>;
}

/**
 * Everything one commit writes, already decided. Applied in this order inside one atomic
 * section:
 *
 *   1. claim `seq` from the space counter (or reject as stale), insert `commit`;
 *   2. close the open version of every block in `closeVersionIds` (`to_seq = seq`);
 *   3. clear the alias of every patched block whose alias changes, then apply `patchBlocks`
 *      (deletions first), so an alias can move between blocks within one commit;
 *   4. insert `insertBlocks`;
 *   5. open one version per block in `versions`, copied from the block's new row;
 *   6. close `closeLinkIds`, insert `insertLinks`;
 *   7. set `in_process` of the blocks in `inProcess` (no version: it is a derived cache); with
 *      `inProcessStale`, mark the space's in-process answers as not derived
 *      (`in_process_ready` false) for the background rebuild;
 *   8. write `claims`.
 *
 * Step 1 claims `next_seq`, and `in_process_epoch` with it when the plan names one. Before it the
 * section checks that every claim row `claims` expects (`put`, `expire`, `verify`) is still as
 * read; when one is not, it writes nothing and rejects with {@link OutlineClaimsMovedError}.
 */
export interface OutlineCommitPlan {
	spaceId: string;
	/** The space's `next_seq` the plan was computed against; becomes the commit's seq. */
	seq: number;
	/**
	 * The space's `in_process_epoch` the plan's in-process answers were computed from: claimed
	 * together with `seq`, so a plan that read answers the rebuild has since rewritten is stale.
	 * Null when the plan read none (it writes none either): the epoch does not matter to it, and
	 * a rebuild running meanwhile does not send it round again.
	 */
	inProcessEpoch: number | null;
	commit: OutlineCommitRow;
	/** Existing blocks that get a new version: exactly the non-inserted blocks in `versions`. */
	closeVersionIds: string[];
	/** Changes to existing blocks, grouped by identical patch. */
	patchBlocks: Array<{ ids: string[]; patch: OutlineBlockPatch }>;
	/** New blocks, `versionSeq` = `seq`. */
	insertBlocks: OutlineBlockRow[];
	/** Every touched block once, grouped by the version's change flags. */
	versions: Array<{ ids: string[]; flags: number }>;
	closeLinkIds: string[];
	/** New link rows, `fromSeq` = `seq`, `toSeq` null. */
	insertLinks: OutlineLinkRow[];
	/** Existing blocks whose `in_process` changes (new blocks carry it in their row). */
	inProcess: Array<{ ids: string[]; value: boolean }>;
	/**
	 * Some answers this commit changes are not in `inProcess` (they did not fit the row limit):
	 * the space goes back to "not derived" until the background rebuild has run.
	 */
	inProcessStale: boolean;
	claims: OutlineClaimPlan;
}

/**
 * The space counter moved between planning and writing: another commit landed. Nothing was
 * written; plan again from fresh reads.
 */
export class OutlineStaleWriteError extends Error {
	constructor(
		readonly spaceId: string,
		readonly expectedSeq: number,
	) {
		super(`outline space ${spaceId} moved past seq ${expectedSeq} while the write was planned`);
		this.name = "OutlineStaleWriteError";
	}
}

/**
 * A claim the plan read changed before the commit was written (a session renewed its lease).
 * Nothing was written; plan again. A kind of stale write, so callers that re-plan on one re-plan
 * on this too.
 */
export class OutlineClaimsMovedError extends OutlineStaleWriteError {
	constructor(spaceId: string, expectedSeq: number) {
		super(spaceId, expectedSeq);
		this.message = `a task claim in outline space ${spaceId} changed while the write was planned`;
		this.name = "OutlineClaimsMovedError";
	}
}

/** Whether a claim row is exactly the one expected (null: no row). */
export function sameClaimRow(
	a: OutlineTaskClaimRow | null | undefined,
	b: OutlineTaskClaimRow | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return (
		a.taskBlockId === b.taskBlockId &&
		a.holderNarratorId === b.holderNarratorId &&
		a.holderUserId === b.holderUserId &&
		a.epoch === b.epoch &&
		a.taskVersionAtClaim === b.taskVersionAtClaim &&
		a.claimedAt === b.claimedAt &&
		a.expiresAt === b.expiresAt &&
		a.lastHolderNarratorId === b.lastHolderNarratorId &&
		a.lastHolderUserId === b.lastHolderUserId
	);
}

/** Ids of the claim rows a plan expects to find as read, sorted (the order rows are locked in). */
export function expectedClaimIds(plan: OutlineCommitPlan): string[] {
	const ids = [
		...plan.claims.put.map((w) => w.row.taskBlockId),
		...plan.claims.expire.map((e) => e.expect.taskBlockId),
		...plan.claims.verify.map((v) => v.taskBlockId),
	];
	return [...new Set(ids)].sort();
}

/** Whether the claim rows found (by task id) are what the plan expects. */
export function claimsAsExpected(
	plan: OutlineCommitPlan,
	found: ReadonlyMap<string, OutlineTaskClaimRow>,
): boolean {
	if (!writesAsExpected(plan.claims.put, found)) return false;
	for (const expiry of plan.claims.expire) {
		if (!sameClaimRow(found.get(expiry.expect.taskBlockId) ?? null, expiry.expect)) return false;
	}
	for (const check of plan.claims.verify) {
		if (!sameClaimRow(found.get(check.taskBlockId) ?? null, check.expect)) return false;
	}
	return true;
}

/** Whether the claim rows found (by task id) are the ones each write expects. */
export function writesAsExpected(
	writes: readonly OutlineClaimWrite[],
	found: ReadonlyMap<string, OutlineTaskClaimRow>,
): boolean {
	for (const write of writes) {
		if (!sameClaimRow(found.get(write.row.taskBlockId) ?? null, write.expect)) return false;
	}
	return true;
}

/** A task in progress that nobody holds, as the lease job finds it. */
export interface OutlineUnclaimedTask {
	blockId: string;
	spaceId: string;
	/** Its claim row (released), or null when it never had one (written before claims existed). */
	claim: OutlineTaskClaimRow | null;
}

/** A task a session holds a claim on, with the task's block. */
export interface OutlineClaimedTask {
	claim: OutlineTaskClaimRow;
	block: OutlineBlockMeta;
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineStore extends WritePortIdentity, OutlineReadPort {
	/**
	 * The space of a project, user or narrator, created on first use. Concurrent callers get
	 * the same row (one per scope, enforced by a unique index). New spaces start at seq 1.
	 */
	ensureSpace(scope: OutlineSpaceScope, now: string): Promise<OutlineSpaceRow>;
	getSpace(id: string): Promise<OutlineSpaceRow | null>;
	getSpaceByKey(key: string): Promise<OutlineSpaceRow | null>;
	findSpace(scope: OutlineSpaceScope): Promise<OutlineSpaceRow | null>;

	/** Blocks of `spaceId` by id or sid, live or deleted. Ids of other spaces are not found. */
	getBlockMetas(
		spaceId: string,
		by: { ids?: readonly string[]; sids?: readonly string[] },
	): Promise<OutlineBlockMeta[]>;
	/** Which of `ids` exist as block ids in any space. */
	findExistingBlockIds(ids: readonly string[]): Promise<string[]>;
	/** Live children of the given parents (`null`: the space's pages), at most `limit` rows. */
	listChildMetas(
		spaceId: string,
		parentIds: readonly (string | null)[],
		limit: number,
	): Promise<OutlineBlockMeta[]>;
	/** Live blocks of `spaceId` holding any of `aliases`. */
	findAliasOwners(
		spaceId: string,
		aliases: readonly string[],
	): Promise<Array<{ alias: string; id: string }>>;
	/** Open links (`to_seq` NULL) of the given blocks, at most `limit` rows. */
	listOpenLinks(blockIds: readonly string[], limit: number): Promise<OutlineLinkRow[]>;

	getBlock(id: string): Promise<OutlineBlockRow | null>;
	getBlockBySid(spaceId: string, sid: string): Promise<OutlineBlockRow | null>;
	/** Live children of a parent (`null`: the space's pages) in sibling order. */
	listChildren(spaceId: string, parentId: string | null, limit: number): Promise<OutlineBlockRow[]>;
	/** Live blocks of a page, unordered; `truncated` when the page holds more than `limit`. */
	listPageBlocks(
		pageId: string,
		limit: number,
	): Promise<{ blocks: OutlineBlockRow[]; truncated: boolean }>;
	/** A block's versions, oldest first. */
	listBlockVersions(blockId: string, limit: number): Promise<OutlineVersionRow[]>;
	/** Versions recorded under a page, by `from_seq` then block id, after `afterSeq`. */
	listPageVersions(
		pageId: string,
		options: { limit: number; afterSeq?: number },
	): Promise<OutlineVersionRow[]>;
	/** Commits of a space by seq, after `afterSeq`. */
	listCommits(
		spaceId: string,
		options: { limit: number; afterSeq?: number },
	): Promise<OutlineCommitRow[]>;

	/** Write one commit atomically; see {@link OutlineCommitPlan} and the header contract. */
	applyCommit(plan: OutlineCommitPlan): Promise<void>;

	// ── tasks (`services/outline/tasks.ts`) ─────────────────────────────────────────────
	// Claims are written by `applyCommit`, and outside a commit only by a session renewing its own
	// leases (`renewTaskClaims`, `updateTaskClaims`) and handing a subagent's claims to its root
	// (`handOverTaskClaims`). Every read is one indexed statement (or one per chunk of ids) with a
	// limit.

	/** Claim rows of the given task blocks (released ones included). */
	getTaskClaims(blockIds: readonly string[]): Promise<OutlineTaskClaimRow[]>;
	/**
	 * Tasks a session holds a claim on (lease running or not), with their blocks, at most
	 * `limit`, oldest claim first.
	 */
	listClaimedTasks(narratorId: string, limit: number): Promise<OutlineClaimedTask[]>;
	/** Live open tasks (to do or in progress) of a space, unordered, at most `limit`. */
	listOpenTasks(spaceId: string, limit: number): Promise<OutlineBlockMeta[]>;
	/**
	 * Session claims whose lease ended at or before `now`, oldest first, at most `limit`, with the
	 * space of the task.
	 */
	listExpiredTaskClaims(
		now: string,
		limit: number,
	): Promise<Array<{ claim: OutlineTaskClaimRow; spaceId: string }>>;
	/**
	 * Move the lease of the claims a session holds (at most {@link OUTLINE_RENEW_LIMIT}) to
	 * `expiresAt`; returns how many. Rows are locked in task id order, as a commit locks them.
	 */
	renewTaskClaims(narratorId: string, expiresAt: string): Promise<number>;
	/**
	 * Write claim rows outside a commit (a session renewing its own lapsed lease, or taking over
	 * one within its session, without changing a block), atomically and only while every row is
	 * still exactly the one `expect` names. Returns false, having written nothing, otherwise.
	 * Rows are locked in task id order, as a commit locks them.
	 */
	updateTaskClaims(writes: readonly OutlineClaimWrite[]): Promise<boolean>;
	/**
	 * Move the claims `fromNarratorId` holds (at most {@link OUTLINE_RENEW_LIMIT}) to
	 * `toNarratorId`, with a lease until `expiresAt`: a subagent's run ended and its root takes
	 * over what it was doing. Returns how many. Rows are locked in task id order.
	 */
	handOverTaskClaims(
		fromNarratorId: string,
		toNarratorId: string,
		expiresAt: string,
	): Promise<number>;
	/**
	 * Live tasks in progress that nobody holds (no claim row, or a released one), found among at
	 * most `scan` tasks in progress by id after `after` (the in-progress index). `next` is where
	 * the following scan starts, null once the end was reached.
	 */
	listUnclaimedDoingTasks(options: {
		after: string | null;
		scan: number;
	}): Promise<{ tasks: OutlineUnclaimedTask[]; next: string | null }>;
	/**
	 * The session each narrator belongs to: a subagent's root (`acl_root_narrator_id`, the one
	 * authority on it), anyone else's own id. Narrators that do not exist are left out. One
	 * primary-key read per chunk of ids.
	 */
	getNarratorRoots(narratorIds: readonly string[]): Promise<Map<string, string>>;

	/** Of the given spaces: whether their `in_process` answers are derived, and their epoch. */
	getInProcessState(
		spaceIds: readonly string[],
	): Promise<Map<string, { ready: boolean; epoch: number }>>;
	/**
	 * Whether a commit of the space after `afterSeq` changed anything an in-process answer
	 * depends on (a version with a change flag in `flags`: creation, move, deletion, restore,
	 * task, page). Text-only commits do not count. Looks at no more than `maxCommits` commits:
	 * more than that counts as a change. Indexed, stops at the first match.
	 */
	hasChangesSince(
		spaceId: string,
		afterSeq: number,
		flags: number,
		maxCommits: number,
	): Promise<boolean>;

	// ── in-process rebuild (`services/outline/in-process.ts`) ──────────────────────────

	/**
	 * Spaces whose blocks' `in_process` has not been derived yet
	 * (`outline_spaces.in_process_ready`), by id (bytewise) after `after`, at most `limit`.
	 */
	listSpacesPendingInProcess(options: {
		after?: string | null;
		limit: number;
	}): Promise<OutlineSpaceRow[]>;
	/**
	 * Set `in_process` of live blocks of a space (only rows that differ are written), atomically
	 * and only while the space is still at `expectNextSeq` (no commit landed since the blocks were
	 * read). `ready` also marks the space as derived. When it writes a row or the mark, the
	 * space's `in_process_epoch` grows by one. Returns false, having written nothing, when the
	 * space moved.
	 */
	setInProcess(
		spaceId: string,
		expectNextSeq: number,
		values: { inProcess: readonly string[]; notInProcess: readonly string[]; ready?: boolean },
	): Promise<boolean>;

	// ── live session log (`services/outline/live/`) ─────────────────────────────────────
	// Not part of a page's history: rows are written while a page is edited live and deleted
	// once the session's text is committed. Each call is one small indexed statement or one
	// short transaction; callers bound the row counts.

	/** Append rows (at most a handful per call). */
	appendLiveUpdates(rows: readonly OutlineLiveUpdateRow[]): Promise<void>;
	/** Replace every row of an epoch with `rows`, atomically (a compaction). */
	replaceLiveUpdates(
		pageBlockId: string,
		epoch: number,
		rows: readonly OutlineLiveUpdateRow[],
	): Promise<void>;
	/** Rows of an epoch by seq, after `afterSeq`, at most `limit`. */
	listLiveUpdates(
		pageBlockId: string,
		epoch: number,
		options: { afterSeq?: number; limit: number },
	): Promise<OutlineLiveUpdateRow[]>;
	/** Delete every row of an epoch; returns how many went. */
	deleteLiveUpdates(pageBlockId: string, epoch: number): Promise<number>;
	/** Epochs that have rows, ordered by page then epoch, after `after`, at most `limit`. */
	listLiveEpochs(options: {
		after?: { pageBlockId: string; epoch: number };
		limit: number;
	}): Promise<Array<{ pageBlockId: string; epoch: number }>>;

	// ── view state (`services/outline/view-state.ts`) ───────────────────────────────────
	// One row per person and page, read and written by primary key: one small statement each.

	/** A person's view state of a page, or null when they never wrote one. */
	getViewState(userId: string, pageBlockId: string): Promise<OutlineViewStateRow | null>;
	/**
	 * Insert or replace a person's view state of a page, then keep only that page and their
	 * `keepPerUser` most recently written others (the rest are deleted in one statement bounded
	 * by that number: the person never has more than `keepPerUser + 2` rows). The page just
	 * written is never dropped, even when a clock stepped back makes it the oldest.
	 */
	putViewState(row: OutlineViewStateRow, keepPerUser: number): Promise<void>;
}

/** Claims one renewal moves at most. */
export const OUTLINE_RENEW_LIMIT = 1000;

/** Ids per `IN (…)` list, well under every engine's bound-parameter limit. */
export const OUTLINE_SQL_CHUNK = 500;

export function chunked<T>(items: readonly T[], size = OUTLINE_SQL_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
