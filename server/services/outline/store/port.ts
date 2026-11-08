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
	OutlineAskJson,
	OutlineCommitKind,
	OutlineLinkKind,
	OutlineLinkTargetKind,
	OutlinePendingDeciderJson,
	OutlinePendingKind,
	OutlinePendingRequesterJson,
	OutlinePendingStatus,
	OutlineSpaceKind,
	OutlineTaskActorRef,
	OutlineTaskJson,
} from "../model";
import type { OutlineDigestPort } from "./digest-port";
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
	/** A question put to a person (`Ask`); never set together with `taskJson`. */
	askJson: OutlineAskJson | null;
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
	askJson: OutlineAskJson | null;
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

/**
 * A change waiting for someone's confirmation (`outline_pending`, design §2.6). `opsJson` holds
 * the write path's operations (`OutlineOp`, typed where they are built: `pending.ts`).
 */
export interface OutlinePendingRow {
	id: string;
	spaceId: string;
	kind: OutlinePendingKind;
	status: OutlinePendingStatus;
	pageId: string;
	/** The lock's root (a `locked_plan`). */
	rootBlockId: string | null;
	opsJson: Array<Record<string, unknown>>;
	/** How many operations `opsJson` holds. */
	opCount: number;
	/** Each existing block's `version_seq` its proposed change was computed against, by id. */
	baseJson: Record<string, number>;
	/** For each block the change deletes: the live blocks under it and their versions then. */
	subtreeJson: Record<string, Record<string, number>>;
	/** The existing blocks the change targets: what waits for confirmation. */
	blockIdsJson: string[];
	/** The blocks the change adds: their sids and parents. */
	addsJson: Array<{ sid: string; parentId: string | null }>;
	summary: string;
	requestedByJson: OutlinePendingRequesterJson;
	/** The proposer's session (a subagent's root). */
	requesterSession: string | null;
	deciderJson: OutlinePendingDeciderJson;
	deciderUserId: string | null;
	/** Grows with every merge into the row. */
	rev: number;
	createdAt: string;
	updatedAt: string;
	decidedAt: string | null;
	decidedByJson: OutlineTaskActorRef | null;
	decisionCommitId: string | null;
	reason: string | null;
	/** When the proposer was shown the decision; null while it has not been. */
	reportedAt: string | null;
	/**
	 * When the locker acknowledged a confirmation an agent made on their behalf (their digest);
	 * null until then and on every other row.
	 */
	digestSeenAt: string | null;
}

/**
 * A pending change without its operations and deleted subtrees (up to hundreds of KiB): what
 * lists, summaries, marks and waits read. The operations are read by id (`getPending`), for the
 * reader's own changes, a diff, a confirmation.
 */
export type OutlinePendingHead = Omit<OutlinePendingRow, "opsJson" | "subtreeJson">;

/** A decision on a pending change: written only while it is open and at `expectRev`. */
export interface OutlinePendingDecision {
	id: string;
	expectRev: number;
	status: Exclude<OutlinePendingStatus, "open">;
	decidedAt: string;
	decidedBy: OutlineTaskActorRef;
	/** The `confirm` commit (set by the store from the plan's commit when written with one). */
	decisionCommitId: string | null;
	reason: string | null;
	/** Set when the proposer need not be told (it withdrew the change itself). */
	reportedAt: string | null;
}

/** What a write does to pending changes, in the same atomic section as its commit (if any). */
export interface OutlinePendingPlan {
	/**
	 * A proposal: a new row (`expectRev` null; the open-proposer unique index turns a concurrent
	 * twin into a `WriteConflictError`), or the open row read at `expectRev` with the proposal
	 * merged into it.
	 */
	put?: { row: OutlinePendingRow; expectRev: number | null };
	/** A decision (a confirmation written with its `confirm` commit). */
	decide?: OutlinePendingDecision;
	/**
	 * Lock roots whose lock this commit removes (unlocked, relocked by someone else, deleted):
	 * their open changes are withdrawn, whoever proposed them.
	 */
	withdraw?: {
		rootBlockIds: string[];
		decidedAt: string;
		decidedBy: OutlineTaskActorRef;
		reason: string;
	};
	/** Locked tasks this commit moves to another page: their open changes follow them. */
	repage?: Array<{ rootBlockId: string; pageId: string }>;
}

/** The pending rows a plan expects to find as read (`put` merged into, `decide`), by id. */
export function expectedPendingRevs(pending: OutlinePendingPlan | undefined): Map<string, number> {
	const out = new Map<string, number>();
	if (pending?.put && pending.put.expectRev !== null)
		out.set(pending.put.row.id, pending.put.expectRev);
	if (pending?.decide) out.set(pending.decide.id, pending.decide.expectRev);
	return out;
}

/** Whether the pending rows found (by id) are open at the revisions the plan expects. */
export function pendingAsExpected(
	pending: OutlinePendingPlan | undefined,
	found: ReadonlyMap<string, { status: string; rev: number }>,
): boolean {
	for (const [id, rev] of expectedPendingRevs(pending)) {
		const row = found.get(id);
		if (!row || row.status !== "open" || row.rev !== rev) return false;
	}
	return true;
}

/** The creation version of a block: the seq and commit of its first version. */
export interface OutlineFirstVersion {
	blockId: string;
	fromSeq: number;
	commitId: string;
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
		| "askJson"
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
 *   8. write `claims`;
 *   9. write `pending`: withdraw, repage, then decide (its `decisionCommitId` is the commit's
 *      id), then put (insert, or update the row merged into).
 *  10. write `questions` (insert, or update all but the asker, creation and, unless
 *      `setDelivered`, delivery).
 *
 * Step 1 claims `next_seq`, and `in_process_epoch` with it when the plan names one. Before it the
 * section checks that every claim row `claims` expects (`put`, `expire`, `verify`) is still as
 * read; when one is not, it writes nothing and rejects with {@link OutlineClaimsMovedError}. Then
 * that every pending row `pending` expects is open at the revision read; when one is not, it
 * writes nothing and rejects with {@link OutlinePendingMovedError}. (PostgreSQL locks the claim
 * rows, then the pending rows, then the space row, in that order.)
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
	/**
	 * Pending changes written with the commit (step 9): a proposal held back from it, the
	 * decision a confirmation makes, the changes an unlock withdraws.
	 */
	pending?: OutlinePendingPlan;
	/** Question rows of the blocks whose question this commit asks, changes or ends (step 10). */
	questions?: OutlineQuestionWrite[];
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

/**
 * A pending row the plan read changed before the write (another proposal merged into it, or it
 * was decided). Nothing was written; plan again. A kind of stale write.
 */
export class OutlinePendingMovedError extends OutlineStaleWriteError {
	constructor(spaceId: string, expectedSeq: number) {
		super(spaceId, expectedSeq);
		this.message = `a pending change in outline space ${spaceId} changed while the write was planned`;
		this.name = "OutlinePendingMovedError";
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

/**
 * Ids of the claim rows a commit locks before the space row (PostgreSQL), sorted: those it
 * expects to find as read and those it releases without checking (a person ending someone else's
 * task), so a commit never takes a claim row after the space row and never waits in a cycle
 * with a writer that took them in the other order.
 */
export function lockedClaimIds(plan: OutlineCommitPlan): string[] {
	return [...new Set([...expectedClaimIds(plan), ...plan.claims.release])].sort();
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

/** The session a narrator belongs to (`getNarratorRoots`). */
export interface OutlineNarratorSession {
	/** A subagent's root; anyone else's own id. */
	root: string;
	/** The narrator itself is archived. */
	archived: boolean;
	/** The session it belongs to is archived (for a session, the same as `archived`). */
	sessionArchived: boolean;
}

/** What `getNarratorRoots` reads of a narrator. */
export interface NarratorStateRow {
	id: string;
	type: string;
	root: string | null;
	status: string;
}

/**
 * Sessions of the narrators read (`rows`), reading the roots not among them with `readRoots`
 * (primary keys): the store-independent half of `getNarratorRoots`.
 */
export async function narratorSessions(
	rows: readonly NarratorStateRow[],
	readRoots: (ids: string[]) => NarratorStateRow[] | Promise<NarratorStateRow[]>,
): Promise<Map<string, OutlineNarratorSession>> {
	const known = new Map(rows.map((r) => [r.id, r]));
	const rootOf = (r: NarratorStateRow) => (r.type === "subagent" && r.root ? r.root : r.id);
	const missing = [...new Set(rows.map(rootOf))].filter((id) => !known.has(id));
	if (missing.length > 0) for (const r of await readRoots(missing)) known.set(r.id, r);
	const out = new Map<string, OutlineNarratorSession>();
	for (const r of rows) {
		const root = rootOf(r);
		const archived = r.status === "archived";
		out.set(r.id, {
			root,
			archived,
			sessionArchived: root === r.id ? archived : known.get(root)?.status === "archived",
		});
	}
	return out;
}

/**
 * Routing and delivery of a question (`outline_questions`), derived from its block's `ask_json` by
 * the write path; see the table.
 */
export interface OutlineQuestionRow {
	blockId: string;
	spaceId: string;
	state: "open" | "answered" | "withdrawn";
	proceed: boolean;
	toUserId: string | null;
	askerNarratorId: string | null;
	askerUserId: string | null;
	askerToolCallId: string | null;
	createdAt: string;
	answeredAt: string | null;
	answerCommitId: string | null;
	deliveredAt: string | null;
}

/**
 * A question row a commit writes: inserted whole when new; an existing row keeps its asker and
 * creation and takes the rest, and its `deliveredAt` only with `setDelivered` (the answer is new:
 * not told yet, or told already), so a delivery marked meanwhile is not undone.
 */
export interface OutlineQuestionWrite {
	row: OutlineQuestionRow;
	setDelivered: boolean;
}

/** A task a session holds a claim on, with the task's block. */
export interface OutlineClaimedTask {
	claim: OutlineTaskClaimRow;
	block: OutlineBlockMeta;
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

export interface OutlineStore extends WritePortIdentity, OutlineReadPort, OutlineDigestPort {
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
	/**
	 * The last `limit` live children of a parent, last first (sibling order read backwards on the
	 * children index): a bounded scan whose rows do not depend on the plan.
	 */
	listLastChildMetas(spaceId: string, parentId: string, limit: number): Promise<OutlineBlockMeta[]>;
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
	/**
	 * Live open tasks (to do or in progress) of a space, unordered, at most `limit`, leaving out
	 * the blocks of `excludePageIds` before the limit applies (a session's behavior page: its
	 * checkboxes are rules, and must not use up the scan).
	 */
	listOpenTasks(
		spaceId: string,
		limit: number,
		options?: { excludePageIds?: readonly string[] },
	): Promise<OutlineBlockMeta[]>;
	/**
	 * Live finished tasks (done or cancelled) of a space, latest change first: by `version_seq`
	 * descending, then id descending, strictly after `before` in that order when given, at most
	 * `limit`. Served by the finished-task index, `before` included in its seek (a row-value
	 * comparison on `(version_seq, id)`), so a later page reads no more than a first one. Ids
	 * compare in the column's own order, which differs between the backends: a cursor is only
	 * meaningful to the backend that made it (the task board's finished lists).
	 */
	listFinishedTasks(
		spaceId: string,
		options: { before?: { versionSeq: number; id: string } | null; limit: number },
	): Promise<OutlineBlockMeta[]>;
	/**
	 * Live open tasks of several spaces at once (the task boards), each space's `excludePageIds`
	 * left out before its limits: of each space, its active open tasks (in progress, or to do and
	 * locked: the active-task index) and its open tasks (the open-task index), at most `limit` of
	 * each, unordered, every task once. So a space with more open tasks than `limit` still yields
	 * the ones in progress (up to `limit`), and more than `limit` rows tell that it has more. One
	 * statement per chunk of spaces (two bounded seeks per space), then the rows.
	 */
	listOpenTasksOfSpaces(
		parts: ReadonlyArray<{ spaceId: string; excludePageIds?: readonly string[] }>,
		limit: number,
	): Promise<OutlineBlockMeta[]>;
	/**
	 * Live finished tasks of several spaces at once, at most `limit` of each, latest change first
	 * within a space, in the order `listFinishedTasks` gives (the finished-task index, a bounded
	 * seek per space), then the rows.
	 */
	listFinishedTasksOfSpaces(
		spaceIds: readonly string[],
		limit: number,
	): Promise<OutlineBlockMeta[]>;
	/** Blocks by id in any space, live or deleted, without content (primary key, chunked). */
	getBlockMetasByIds(ids: readonly string[]): Promise<OutlineBlockMeta[]>;
	/** Live blocks holding `alias` in any of the spaces (the alias index, chunked). */
	findAliasOwnersInSpaces(
		spaceIds: readonly string[],
		alias: string,
	): Promise<Array<{ spaceId: string; id: string }>>;
	/**
	 * Session claims whose lease ended at or before `now`, oldest first, at most `limit`, with the
	 * space of the task.
	 */
	listExpiredTaskClaims(
		now: string,
		limit: number,
	): Promise<Array<{ claim: OutlineTaskClaimRow; spaceId: string }>>;
	/**
	 * Claims held by a session or by one of its subagents (`acl_root_narrator_id` is the session),
	 * whatever their lease, oldest claim first, at most `limit`, with the space of the task: what
	 * archiving or deleting the session releases. Two indexed reads (the session's own claims,
	 * its subagents' through the narrators' root index), each with the limit. With
	 * `subagentsOnly`, only the second: the tasks the session's subagents hold (the current-tasks
	 * view's "delegated" section, outline P2 PR 9b).
	 */
	listSessionTaskClaims(
		narratorId: string,
		limit: number,
		options?: { subagentsOnly?: boolean },
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
	 * authority on it), anyone else's own id; and whether it or that session is archived.
	 * Narrators that do not exist are left out. Primary-key reads: one per chunk of ids, and one
	 * per chunk of roots not among them.
	 */
	getNarratorRoots(narratorIds: readonly string[]): Promise<Map<string, OutlineNarratorSession>>;
	/**
	 * Distinct sessions holding claims, by id after `after`, at most `limit` (the holder index,
	 * read in order): the lease job's sweep for claims of sessions that ended while nobody was
	 * listening. `next` is where the following sweep starts, null once the end was reached.
	 */
	listTaskClaimHolders(options: {
		after: string | null;
		limit: number;
	}): Promise<{ holders: string[]; next: string | null }>;

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

	// ── pending changes (`services/outline/pending.ts`) ─────────────────────────────────
	// Written with a commit (`applyCommit`, the plan's `pending`), alone with the space counter as
	// a guard (`applyPending`), or decided alone (`decidePending`). Every read is indexed and
	// bounded.

	/** Pending rows by id, whole. */
	getPending(ids: readonly string[]): Promise<OutlinePendingRow[]>;
	/** Open pending changes of a page (heads), oldest first, at most `limit`. */
	listOpenPendingByPage(pageId: string, limit: number): Promise<OutlinePendingHead[]>;
	/** Open pending changes of a space (heads), oldest first, at most `limit`. */
	listOpenPendingBySpace(spaceId: string, limit: number): Promise<OutlinePendingHead[]>;
	/**
	 * Open pending changes a person decides as their locker (`decider_user_id`; heads), oldest
	 * first, at most `limit`: their inbox.
	 */
	listOpenPendingForDecider(userId: string, limit: number): Promise<OutlinePendingHead[]>;
	/** Open pending changes (heads) on any of the given lock roots (the open-root index), at most `limit`. */
	listOpenPendingByRoots(rootIds: readonly string[], limit: number): Promise<OutlinePendingHead[]>;
	/** How many open pending changes a page has, counting at most `limit`. */
	countOpenPendingByPage(pageId: string, limit: number): Promise<number>;
	/** The open row a session has on a lock root, if any, whole. */
	findOpenPending(requesterSession: string, rootBlockId: string): Promise<OutlinePendingRow | null>;
	/**
	 * Decisions on a session's changes on a page it has not been told of (heads), oldest first,
	 * at most `limit` (the unreported index: open rows and other pages are not read).
	 */
	listUnreportedPending(
		requesterSession: string,
		pageId: string,
		limit: number,
	): Promise<OutlinePendingHead[]>;
	/** Mark decided rows as shown to their proposer. */
	markPendingReported(ids: readonly string[], at: string): Promise<void>;
	/**
	 * Write a plan's pending changes without a commit (a proposal with nothing written directly):
	 * atomically, and only while the space's counter is still `seq` (no commit landed since the
	 * plan's reads; the space row is held so none lands meanwhile) and every row it expects is as
	 * read. Rejects like `applyCommit`: {@link OutlineStaleWriteError},
	 * {@link OutlinePendingMovedError}, `WriteConflictError`.
	 */
	applyPending(plan: { spaceId: string; seq: number; pending: OutlinePendingPlan }): Promise<void>;
	/** Write a decision alone (a rejection); false, writing nothing, when the row moved. */
	decidePending(decision: OutlinePendingDecision): Promise<boolean>;
	/**
	 * The first version of each block (its creation: seq and commit), one primary-key probe
	 * each. Blocks with no versions are left out.
	 */
	getFirstVersions(blockIds: readonly string[]): Promise<OutlineFirstVersion[]>;
	/** Live locked blocks of a page (the partial lock index), at most `limit`. */
	listLockedBlocks(pageId: string, limit: number): Promise<OutlineBlockMeta[]>;
	/**
	 * Confirmations an agent made on a locker's behalf that the locker has not acknowledged
	 * (heads; the digest index), oldest first, at most `limit`.
	 */
	listUnseenDelegateConfirmations(userId: string, limit: number): Promise<OutlinePendingHead[]>;
	/** Mark such confirmations of the locker as seen; returns how many were marked. */
	markDelegateConfirmationsSeen(
		userId: string,
		ids: readonly string[],
		at: string,
	): Promise<number>;

	// ── questions (`services/outline/questions.ts`) ─────────────────────────────────────
	// Written by `applyCommit` (the plan's `questions`); outside a commit only `delivered_at`
	// (`markQuestionsDelivered`). Every read is one indexed statement with a limit.

	/** Question rows of the given blocks. */
	getQuestions(blockIds: readonly string[]): Promise<OutlineQuestionRow[]>;
	/**
	 * The first `chars` characters of the given blocks' content, by id (live or deleted): what a
	 * list shows of them, without reading whole bodies.
	 */
	getContentHeads(blockIds: readonly string[], chars: number): Promise<Map<string, string>>;
	/**
	 * Open questions of each of the given spaces, oldest first, at most `limitPerSpace` of each:
	 * one read for many spaces (a project board derives the waits of every session on its page).
	 */
	listOpenQuestionsBySpaces(
		spaceIds: readonly string[],
		limitPerSpace: number,
	): Promise<OutlineQuestionRow[]>;
	/** Open questions put to a person, oldest first, at most `limit`. */
	listOpenQuestionsForUser(userId: string, limit: number): Promise<OutlineQuestionRow[]>;
	/** Open questions a session asked, oldest first, at most `limit`. */
	listOpenQuestionsByAsker(narratorId: string, limit: number): Promise<OutlineQuestionRow[]>;
	/** Answered questions whose asker was not told yet, oldest answer first, at most `limit`. */
	listUndeliveredAnswers(limit: number): Promise<OutlineQuestionRow[]>;
	/**
	 * Mark answers as delivered; only rows still answered and undelivered are marked (a revert
	 * reopening one meanwhile wins). Returns how many were marked.
	 */
	markQuestionsDelivered(blockIds: readonly string[], at: string): Promise<number>;

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

	// ── tasks a person saw finished (`outline_task_seen`, outline P2 PR 9b, the board's 「新完成」) ──

	/** The person's rows of the given tasks: the version each was seen finished at (primary key). */
	getTaskSeen(userId: string, taskBlockIds: readonly string[]): Promise<OutlineTaskSeenRow[]>;
	/**
	 * Record that the person saw these tasks finished at these versions (a row already there keeps
	 * the higher version), then delete the person's rows seen before `pruneBefore` (by the
	 * `(user_id, seen_at)` index). One transaction.
	 */
	putTaskSeen(
		userId: string,
		rows: readonly OutlineTaskSeenRow[],
		at: string,
		pruneBefore: string,
	): Promise<void>;
}

/** A task a person saw finished, and the version they saw (`outline_task_seen`). */
export interface OutlineTaskSeenRow {
	taskBlockId: string;
	seenSeq: number;
}

/** Claims one renewal moves at most. */
export const OUTLINE_RENEW_LIMIT = 1000;

/** Ids per `IN (…)` list, well under every engine's bound-parameter limit. */
export const OUTLINE_SQL_CHUNK = 500;

/** Spaces one compound statement reads, one bounded member each (`listOpenTasksOfSpaces`). */
export const OUTLINE_BATCH_SPACES = 50;

/** `rows` in the order of `ids` (a read by key returns them in no particular order). */
export function inIdOrder<T extends { id: string }>(
	ids: readonly string[],
	rows: readonly T[],
): T[] {
	const at = new Map(ids.map((id, index) => [id, index]));
	return [...rows].sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
}

export function chunked<T>(items: readonly T[], size = OUTLINE_SQL_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Claims read by several queries, as one list: oldest claim first (then by task id), each task
 * once, at most `limit`.
 */
export function oldestClaimsFirst<T extends { claim: OutlineTaskClaimRow }>(
	rows: readonly T[],
	limit: number,
): T[] {
	const byTask = new Map(rows.map((row) => [row.claim.taskBlockId, row]));
	return [...byTask.values()]
		.sort((a, b) =>
			a.claim.claimedAt !== b.claim.claimedAt
				? a.claim.claimedAt < b.claim.claimedAt
					? -1
					: 1
				: a.claim.taskBlockId < b.claim.taskBlockId
					? -1
					: 1,
		)
		.slice(0, limit);
}
