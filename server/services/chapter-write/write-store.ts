/**
 * The chapter graph's write capability, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * The chapter write paths used to open `db.transaction((tx) => …)` (the fork/merge
 * edge upserts in `chapter-edge-service.ts`, the split's continuation rewrite in
 * `chapter-split.ts`) or issue bare single statements (the chapter row insert in
 * `chapter-fork.ts`, the merge-outcome updates in `chapter-merge.ts`) directly against
 * the main handle. The check-then-insert edge upserts hard-code bun:sqlite: the
 * transaction is synchronous, and the race it closes — `chapter_edges` has no UNIQUE
 * constraint on (source, target, type), so two concurrent forks of one parent could
 * both observe "no edge" and both insert — is closed by SQLite's single writer, not
 * by anything a second backend reproduces for free.
 *
 * So the facts are written here instead, in domain terms only: what goes in, what
 * comes out, and which failures are guaranteed to leave nothing behind. This file
 * imports nothing dialect-specific — no driver, no `server/db`, no schema. The one
 * allowed dependency is `lib/errors`: `NotFoundError`/`ValidationError` are the domain
 * vocabulary the guarded operations already reject with, and both implementations must
 * produce the same instances so existing callers cannot tell which backend answered.
 *
 * THE CONTRACT EVERY OPERATION INHERITS (from `server/db/backend/write-port.ts`)
 * ------------------------------------------------------------------------------
 * 1. Methods return PROMISES. The SQLite implementation runs its atomic section
 *    STRICTLY SYNCHRONOUSLY inside the call (bun:sqlite commits when the transaction
 *    callback returns — an `await` inside is silent data loss, see
 *    `server/db/transaction-atomicity-contract.test.ts`); the Promise is a wrapper
 *    around an already-committed result. The PostgreSQL implementation runs a
 *    genuinely async section with `withPgRetry` around the WHOLE section as the
 *    retry unit.
 * 2. ATOMICITY IS PART OF THE CONTRACT. Each operation is all-or-nothing: it either
 *    returns with every write committed, or rejects having written nothing.
 * 3. CONFLICTS CROSS AS VOCABULARY. A uniqueness conflict arrives at the caller as
 *    `WriteConflictError` (with the constraint name when the backend reported one),
 *    never as a driver error.
 * 4. POST-COMMIT SIDE EFFECTS STAY OUT. Git operations, event-bus emissions, worktree
 *    teardown and narrator forks belong to the services AFTER the returned Promise
 *    resolves — the exactly-once boundary, because the PostgreSQL implementation may
 *    replay the whole section before resolving once. Every id below is therefore
 *    supplied by the caller, so a replay writes the same rows instead of minting new
 *    identities.
 *
 * THE EDGE UPSERT RACE, PER BACKEND
 * ---------------------------------
 * `upsertForkEdge` / `upsertMergeEdge` are check-then-insert by design (the table has
 * no unique constraint to lean on; adding one is a schema decision, not a write-path
 * one). The SQLite implementation serializes the check and the write inside one
 * strictly synchronous transaction — no interleaving point exists. The PostgreSQL
 * implementation takes the SOURCE chapter's row lock (`SELECT … FOR UPDATE`) before
 * the check, so two concurrent upserts sharing a source serialize on that row while
 * upserts of different sources proceed in parallel. Both answer the same question:
 * "one edge per (source, target, type), updated in place when it already exists".
 *
 * WHAT IT IS NOT
 * --------------
 * Not a DAO over the `chapters` table. Reads stay with the services and the read
 * adapter batch; merge-session bookkeeping (`chapter-batch-merge.ts`) is a set of
 * single statements carrying no atomicity requirement beyond one UPDATE each and is
 * deliberately not here. Only the atomic sections and the chapter-row writes the
 * fork/split/merge flows must be able to land on either backend live here.
 */

import { NotFoundError, ValidationError } from "@server/lib/errors";

/** A uniqueness conflict surfaced by a write port — re-exported so the services name
 *  one vocabulary type whether the backend was SQLite or PostgreSQL. */
export { WriteConflictError } from "@server/db/backend/write-port";

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (plain data, field-identical across backends)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `chapters` row, projected to plain data.
 *
 * Field-for-field the shape both backends' `.returning()` produces: the SQLite
 * implementation returns the Drizzle row itself, the PostgreSQL one the same columns
 * decoded by its own driver. JSON columns (`forkPoint`, `containerConfig`) arrive
 * PARSED on both sides — the PG schema's `jsonText` codec exists precisely to keep
 * that application-level equivalence — so they are typed `unknown` here and the
 * service keeps its own narrower view of them.
 */
export interface ChapterRow {
	id: string;
	projectId: string;
	title: string;
	description: string | null;
	status: string;
	role: string;
	branch: string;
	worktreePath: string | null;
	baseBranch: string;
	parentChapterId: string | null;
	forkPoint: unknown;
	mergedIntoChapterId: string | null;
	mergeCommitSha: string | null;
	mergeStrategy: string | null;
	preMergeTargetSha: string | null;
	mergeSnapshotCommitSha: string | null;
	preMergeTargetSnapshotSha: string | null;
	mergedSourceSnapshotSha: string | null;
	containerConfig: unknown;
	explorationGroupId: string | null;
	isRoot: number | null;
	headCommitSha: string | null;
	startCommitSha: string | null;
	commitCount: number | null;
	snapshotCommitSha: string | null;
	snapshotShadowKey: string | null;
	dormantSnapshotCommitSha: string | null;
	parkedSnapshotCommitSha: string | null;
	parkedSnapshotBaseTree: string | null;
	color: string | null;
	groupLabel: string | null;
	pinned: number | null;
	anchorCommitSha: string | null;
	axisOffset: number | null;
	crossOffset: number | null;
	graphX: number | null;
	graphY: number | null;
	panelExpanded: number | null;
	panelWidth: number | null;
	panelHeight: number | null;
	dockLayoutJson: string | null;
	detachedPanelsJson: string | null;
	reviewSourceChapterId: string | null;
	reviewStatus: string | null;
	lastAccessedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** A `chapter_edges` row, projected to plain data. `metadata` arrives parsed. */
export interface ChapterEdgeRow {
	id: string;
	projectId: string;
	sourceId: string;
	targetId: string;
	type: string;
	metadata: unknown;
	createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operation inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chapter row insert, exactly as the fork and split flows compose it. Every field
 * that has no database default is required; the optional ones are the columns the two
 * flows set only on some paths. Ids and timestamps are caller-supplied so a
 * whole-section replay (PostgreSQL retry) writes the same row, never a new identity.
 */
export interface InsertChapterWrite {
	id: string;
	projectId: string;
	title: string;
	description: string | null;
	status: string;
	role: string;
	branch: string;
	worktreePath: string | null;
	baseBranch: string;
	parentChapterId: string | null;
	forkPoint: unknown;
	startCommitSha: string | null;
	headCommitSha?: string | null;
	commitCount?: number | null;
	snapshotCommitSha?: string | null;
	snapshotShadowKey?: string | null;
	anchorCommitSha?: string | null;
	axisOffset?: number | null;
	crossOffset?: number | null;
	graphX?: number | null;
	graphY?: number | null;
	lastAccessedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

/** The metadata a fork edge carries. Field-for-field what `chapter-edge-service`
 *  has always written; stored as JSON text. */
export interface ForkEdgeMetadata {
	commitSha: string;
	worktreeSource: string;
	inheritMode: string;
	narratorMessageUuid?: string;
	narratorMessageId?: string;
}

/** The metadata a merge edge carries. */
export interface MergeEdgeMetadata {
	mergeCommitSha?: string;
	/** Set instead of `mergeCommitSha` when the merge happened in snapshot space. */
	mergeSnapshotCommitSha?: string;
	strategy: string;
	status?: "pending" | "completed";
}

export interface UpsertForkEdgeWrite {
	/** Pre-generated by the caller (whole-section replay safety); used only when no
	 *  edge exists yet. */
	id: string;
	projectId: string;
	sourceId: string;
	targetId: string;
	metadata: ForkEdgeMetadata;
	now: string;
}

export interface UpsertMergeEdgeWrite {
	id: string;
	projectId: string;
	sourceId: string;
	targetId: string;
	metadata: MergeEdgeMetadata;
	now: string;
}

/**
 * A commit-producing merge's outcome on the SOURCE chapter row. Snapshot-merge
 * coordinates are cleared in the same statement: a real git commit means any
 * snapshot coordinate on the row belongs to an earlier commit-free merge that has
 * since been undone (see `chapter-merge.ts`).
 */
export interface RecordChapterMergeWrite {
	sourceChapterId: string;
	targetChapterId: string;
	strategy: string;
	mergeCommitSha: string | null;
	preMergeTargetSha: string | null;
	now: string;
}

/** A commit-free (snapshot-space) merge's outcome on the source chapter row. */
export interface RecordChapterSnapshotMergeWrite {
	sourceChapterId: string;
	targetChapterId: string;
	strategy: string;
	mergeSnapshotCommitSha: string;
	preMergeTargetSnapshotSha: string;
	mergedSourceSnapshotSha: string;
	preMergeTargetSha: string | null;
	now: string;
}

/**
 * An unmerge's reactivation of the source chapter. `clearSnapshotMergeFields` is set
 * by the snapshot-unmerge path (whose coordinates described the merge being undone);
 * the commit-based unmerge leaves any snapshot coordinates alone, exactly as
 * `chapter-merge.ts` always has.
 */
export interface RestoreMergedChapterWrite {
	chapterId: string;
	worktreePath: string;
	clearSnapshotMergeFields: boolean;
	now: string;
}

/** The split's prefix chapter gets its commit window once the branch exists. */
export interface UpdateSplitPrefixHeadWrite {
	prefixId: string;
	startCommitSha: string | null;
	headCommitSha: string;
	now: string;
}

/**
 * The split's final rewrite of the original chapter into the continuation.
 *
 * One atomic section: the commit count is recomputed from `chapter_commits` (never
 * trusted from the caller) and the guarded update returns the rewritten row, or the
 * section rejects with `NotFoundError` having written nothing. `fallbackCommitCount`
 * is the original row's count, used when the recompute finds no rows — the exact
 * semantics of the pre-port `?? original.commitCount ?? 0`.
 */
export interface RewriteSplitContinuationWrite {
	chapterId: string;
	prefixId: string;
	commitSha: string;
	/** Present when the split truncates the narrator history at a message. */
	narratorMessageId?: string;
	fallbackCommitCount: number | null;
	now: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The port
// ─────────────────────────────────────────────────────────────────────────────

export interface ChapterWriteStore {
	// ── chapter rows ──
	/**
	 * Insert a chapter row. A lost race on `(project_id, branch)` or the primary key
	 * rejects with `WriteConflictError` and writes nothing.
	 */
	insertChapter(input: InsertChapterWrite): Promise<ChapterRow>;
	/** Delete a chapter row by id (the fork/split rollback compensation). */
	deleteChapter(id: string): Promise<void>;
	/** Copy the parent's container config onto a freshly forked chapter. */
	updateChapterContainerConfig(input: {
		chapterId: string;
		containerConfig: unknown;
		now: string;
	}): Promise<void>;

	// ── edges ──
	/**
	 * Create the fork edge for a chapter, or update the existing one in place. The
	 * check and the write are one atomic section (see the header for how each backend
	 * closes the race); concurrent upserts can never double the graph edge.
	 */
	upsertForkEdge(input: UpsertForkEdgeWrite): Promise<ChapterEdgeRow>;
	/** The merge-edge twin of {@link upsertForkEdge}. */
	upsertMergeEdge(input: UpsertMergeEdgeWrite): Promise<ChapterEdgeRow>;
	/**
	 * Repoint an existing fork edge at a different target chapter (the chapter
	 * split). Rejects non-fork edges, self-loops and cross-project retargets with the
	 * same `ValidationError`/`NotFoundError` identities the pre-port code produced.
	 * Returns the PREVIOUS target id so the caller can register a rollback.
	 */
	retargetForkEdge(input: { edgeId: string; newTargetId: string }): Promise<string>;
	/** Delete all merge edges whose source is the given chapter (unmerge/wake). */
	deleteMergeEdgesBySource(chapterId: string): Promise<void>;

	// ── merge outcomes ──
	/** Record a commit-producing merge on the source chapter (status `merged`). */
	recordChapterMerge(input: RecordChapterMergeWrite): Promise<void>;
	/** Record a snapshot-space merge on the source chapter (status `merged`). */
	recordChapterSnapshotMerge(input: RecordChapterSnapshotMergeWrite): Promise<void>;
	/** Reactivate a merged chapter after an unmerge (status `active`). */
	restoreMergedChapter(input: RestoreMergedChapterWrite): Promise<void>;
	/**
	 * Record where a chapter's uncommitted work is parked, or clear the pointer
	 * (`commitSha: null`). Single statement; carried here because the pointer must be
	 * writable from either backend like every other merge-flow write.
	 */
	setChapterParkedWork(input: {
		chapterId: string;
		commitSha: string | null;
		baseTree: string | null;
	}): Promise<void>;

	// ── split ──
	/** Pin the split prefix's commit window (single statement). */
	updateSplitPrefixHead(input: UpdateSplitPrefixHeadWrite): Promise<void>;
	/**
	 * Rewrite the split's original chapter into the continuation: recompute the
	 * commit count, reparent to the prefix and reset the fork point — one atomic
	 * section, rejecting with `NotFoundError` (and writing nothing) when the chapter
	 * vanished mid-split.
	 */
	rewriteSplitContinuation(input: RewriteSplitContinuationWrite): Promise<ChapterRow>;
}

/** Re-exported so callers of the port can name the guard vocabulary without
 *  importing `lib/errors` for types they never construct. */
export { NotFoundError, ValidationError };
