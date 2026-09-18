/**
 * SQLite implementation of `ChapterWriteStore`.
 *
 * Every atomic section below is a STRICTLY SYNCHRONOUS `db.transaction` callback, and
 * that is not a style choice: `bun:sqlite` commits when the callback RETURNS, so an
 * `async` callback commits at its first `await` and every statement after it runs in
 * autocommit (see `server/db/transaction-atomicity-contract.test.ts`). The store
 * methods are `async` on the OUTSIDE — the caller only ever sees a Promise — while
 * the section between BEGIN and COMMIT contains no `await` at all.
 *
 * The section CONTENTS are value-for-value what the services ran inline before the
 * port existed: the edge upserts from `chapter-edge-service.ts`, the continuation
 * rewrite from `chapter-split.ts`, the merge-outcome updates from `chapter-merge.ts`.
 * What moved here is the dialect shape, not the business fact.
 *
 * CONFLICT TRANSLATION: a uniqueness violation is recognized STRUCTURALLY — the
 * driver reports the extended result code on `errno` (1555 primary-key, 2067 unique)
 * — and translated to `WriteConflictError` before it can cross the port boundary,
 * mirroring `services/knowledge/sqlite-write-store.ts`. No message-text sniffing
 * decides anything; the message is only read afterwards, for the column detail.
 *
 * The PostgreSQL implementation of the same port lives in `postgres-write-store.ts`
 * and is genuinely async. What the two share is this file's SECTION CONTENT — the
 * reads, guards and writes in the same order — never its driver shapes.
 */

import { WriteConflictError } from "@server/db/backend/write-port";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { chapterCommits, chapterEdges, chapters } from "../../db/schema";
import { NotFoundError, ValidationError } from "../../lib/errors";
import type {
	ChapterEdgeRow,
	ChapterRow,
	ChapterWriteStore,
	InsertChapterWrite,
	RecordChapterMergeWrite,
	RecordChapterSnapshotMergeWrite,
	RestoreMergedChapterWrite,
	RewriteSplitContinuationWrite,
	UpdateSplitPrefixHeadWrite,
	UpsertForkEdgeWrite,
	UpsertMergeEdgeWrite,
} from "./write-store";

/** Transaction handle as produced by `db.transaction((tx) => …)`. SQLite-side only. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Extended result codes the driver puts on `errno` for a uniqueness conflict (the
 * same two constants `services/knowledge/sqlite-write-store.ts` uses; duplicated
 * rather than shared because the dialect ledger tracks each store's own access path).
 */
const CONSTRAINT_PRIMARYKEY_ERRNO = 1555;
const CONSTRAINT_UNIQUE_ERRNO = 2067;
/** How deep `cause` chains are followed when looking for the driver error. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True only for a uniqueness conflict, read off the driver's structured `errno` —
 * never off message text. Other constraint failures (foreign keys, checks) are NOT
 * port conflicts and pass through untouched.
 */
function isSqliteUniqueViolation(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return false;
		const errno = (current as Record<string, unknown>).errno;
		if (errno === CONSTRAINT_PRIMARYKEY_ERRNO || errno === CONSTRAINT_UNIQUE_ERRNO) {
			return true;
		}
		current = (current as Record<string, unknown>).cause;
	}
	return false;
}

/**
 * The column detail of a uniqueness violation, for the error's `constraint` field.
 * SQLite has no constraint NAME to report, so the "table.column" list from the
 * message is the closest honest detail; null when the message has another shape.
 */
function extractConstraintDetail(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = /^UNIQUE constraint failed: (.+)$/.exec(message);
	return match?.[1] ?? null;
}

/**
 * Translate a uniqueness conflict into port vocabulary; everything else passes
 * through with its identity intact.
 */
function rethrowAsPortError(error: unknown): never {
	if (isSqliteUniqueViolation(error)) {
		throw new WriteConflictError("write conflicts with an existing row", {
			constraint: extractConstraintDetail(error),
			cause: error,
		});
	}
	throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic sections (named, strictly synchronous — see the header)
// ─────────────────────────────────────────────────────────────────────────────

type EdgeUpsertInput = (UpsertForkEdgeWrite | UpsertMergeEdgeWrite) & { type: "fork" | "merge" };

/**
 * The check-then-insert edge upsert, exactly as `chapter-edge-service.ts` ran it:
 * look up the existing (source, target, type) edge, update its metadata in place
 * when found, insert otherwise. One synchronous transaction — the race it closes is
 * described in the port header.
 */
function upsertEdgeSection(tx: Tx, input: EdgeUpsertInput): ChapterEdgeRow {
	const existing = tx
		.select({ id: chapterEdges.id })
		.from(chapterEdges)
		.where(
			and(
				eq(chapterEdges.sourceId, input.sourceId),
				eq(chapterEdges.targetId, input.targetId),
				eq(chapterEdges.type, input.type),
			),
		)
		.limit(1)
		.get();

	if (existing) {
		return tx
			.update(chapterEdges)
			.set({ metadata: input.metadata })
			.where(eq(chapterEdges.id, existing.id))
			.returning()
			.get() as ChapterEdgeRow;
	}

	return tx
		.insert(chapterEdges)
		.values({
			id: input.id,
			projectId: input.projectId,
			sourceId: input.sourceId,
			targetId: input.targetId,
			type: input.type,
			metadata: input.metadata,
			createdAt: input.now,
		})
		.returning()
		.get() as ChapterEdgeRow;
}

/**
 * The fork-edge retarget, exactly as `chapter-edge-service.ts` sequenced it: read
 * the edge, reject non-fork/self-loop, read the target chapter, reject cross-project,
 * then move the target. The pre-port code ran the reads as separate `await`s with no
 * transaction at all; running the same sequence inside one synchronous section keeps
 * every observable outcome (same validations, same errors, same no-op shortcut) while
 * removing the read/write interleaving window.
 */
function retargetForkEdgeSection(tx: Tx, input: { edgeId: string; newTargetId: string }): string {
	const edge = tx.select().from(chapterEdges).where(eq(chapterEdges.id, input.edgeId)).get();
	if (!edge) throw new NotFoundError("ChapterEdge", input.edgeId);
	if (edge.type !== "fork") {
		throw new ValidationError("Only fork edges can be retargeted");
	}
	if (edge.sourceId === input.newTargetId) {
		throw new ValidationError("Cannot retarget a fork edge to its own source");
	}

	const target = tx
		.select({ id: chapters.id, projectId: chapters.projectId })
		.from(chapters)
		.where(eq(chapters.id, input.newTargetId))
		.get();
	if (!target) throw new NotFoundError("Chapter", input.newTargetId);
	if (target.projectId !== edge.projectId) {
		throw new ValidationError("Cannot retarget a fork edge across projects");
	}

	const previousTargetId = edge.targetId;
	if (previousTargetId === input.newTargetId) return previousTargetId;

	tx.update(chapterEdges)
		.set({ targetId: input.newTargetId })
		.where(eq(chapterEdges.id, input.edgeId))
		.run();
	return previousTargetId;
}

/**
 * The split's continuation rewrite, value-for-value from `chapter-split.ts`: the
 * commit count is recomputed inside the same section, the update is guarded by the
 * chapter id, and a missing row rejects with `NotFoundError` having written nothing.
 */
function rewriteSplitContinuationSection(tx: Tx, input: RewriteSplitContinuationWrite): ChapterRow {
	const counted = tx
		.select({ total: sql<number>`COUNT(*)` })
		.from(chapterCommits)
		.where(eq(chapterCommits.chapterId, input.chapterId))
		.get();
	const updated = tx
		.update(chapters)
		.set({
			parentChapterId: input.prefixId,
			startCommitSha: input.commitSha,
			forkPoint: {
				commitSha: input.commitSha,
				...(input.narratorMessageId ? { narratorMessageId: input.narratorMessageId } : {}),
			},
			commitCount: counted?.total ?? input.fallbackCommitCount ?? 0,
			updatedAt: input.now,
		})
		.where(eq(chapters.id, input.chapterId))
		.returning()
		.get();
	if (!updated) throw new NotFoundError("Chapter", input.chapterId);
	return updated as ChapterRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export const sqliteChapterWriteStore: ChapterWriteStore = {
	async insertChapter(input: InsertChapterWrite): Promise<ChapterRow> {
		try {
			// The port's `status`/`role` are plain strings (the PG schema types them as
			// text); the SQLite column carries a TypeScript-level enum, so the cast
			// bridges the two spellings of the same vocabulary. The callers — the fork
			// and split flows — only ever supply the enum's values.
			const rows = await db
				.insert(chapters)
				.values(input as typeof chapters.$inferInsert)
				.returning();
			const row = rows[0];
			if (!row) throw new Error("chapter insert returned no row");
			return row as ChapterRow;
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async deleteChapter(id: string): Promise<void> {
		await db.delete(chapters).where(eq(chapters.id, id));
	},

	async updateChapterContainerConfig(input: {
		chapterId: string;
		containerConfig: unknown;
		now: string;
	}): Promise<void> {
		await db
			.update(chapters)
			// The column is JSON-mode on both backends; the port's `unknown` is the
			// caller's already-structured value, as the pre-port code passed it.
			.set({ containerConfig: input.containerConfig, updatedAt: input.now })
			.where(eq(chapters.id, input.chapterId));
	},

	async upsertForkEdge(input: UpsertForkEdgeWrite): Promise<ChapterEdgeRow> {
		try {
			return db.transaction((tx) => upsertEdgeSection(tx, { ...input, type: "fork" }));
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async upsertMergeEdge(input: UpsertMergeEdgeWrite): Promise<ChapterEdgeRow> {
		try {
			return db.transaction((tx) => upsertEdgeSection(tx, { ...input, type: "merge" }));
		} catch (error) {
			rethrowAsPortError(error);
		}
	},

	async retargetForkEdge(input: { edgeId: string; newTargetId: string }): Promise<string> {
		return db.transaction((tx) => retargetForkEdgeSection(tx, input));
	},

	async deleteMergeEdgesBySource(chapterId: string): Promise<void> {
		await db
			.delete(chapterEdges)
			.where(and(eq(chapterEdges.sourceId, chapterId), eq(chapterEdges.type, "merge")));
	},

	async recordChapterMerge(input: RecordChapterMergeWrite): Promise<void> {
		await db
			.update(chapters)
			.set({
				status: "merged",
				worktreePath: null,
				mergedIntoChapterId: input.targetChapterId,
				mergeCommitSha: input.mergeCommitSha,
				mergeStrategy: input.strategy as "merge" | "squash" | "cherry-pick",
				preMergeTargetSha: input.preMergeTargetSha,
				// A real git commit retires any snapshot coordinate left by an earlier
				// commit-free merge — see `chapter-merge.ts` (clearedSnapshotMergeFields).
				mergeSnapshotCommitSha: null,
				preMergeTargetSnapshotSha: null,
				mergedSourceSnapshotSha: null,
				updatedAt: input.now,
			})
			.where(eq(chapters.id, input.sourceChapterId));
	},

	async recordChapterSnapshotMerge(input: RecordChapterSnapshotMergeWrite): Promise<void> {
		await db
			.update(chapters)
			.set({
				status: "merged",
				worktreePath: null,
				mergedIntoChapterId: input.targetChapterId,
				mergeStrategy: input.strategy as "merge" | "squash" | "cherry-pick",
				mergeSnapshotCommitSha: input.mergeSnapshotCommitSha,
				preMergeTargetSnapshotSha: input.preMergeTargetSnapshotSha,
				mergedSourceSnapshotSha: input.mergedSourceSnapshotSha,
				preMergeTargetSha: input.preMergeTargetSha,
				updatedAt: input.now,
			})
			.where(eq(chapters.id, input.sourceChapterId));
	},

	async restoreMergedChapter(input: RestoreMergedChapterWrite): Promise<void> {
		await db
			.update(chapters)
			.set({
				status: "active",
				worktreePath: input.worktreePath,
				mergedIntoChapterId: null,
				mergeCommitSha: null,
				mergeStrategy: null,
				preMergeTargetSha: null,
				...(input.clearSnapshotMergeFields
					? {
							mergeSnapshotCommitSha: null,
							preMergeTargetSnapshotSha: null,
							mergedSourceSnapshotSha: null,
						}
					: {}),
				lastAccessedAt: input.now,
				updatedAt: input.now,
			})
			.where(eq(chapters.id, input.chapterId));
	},

	async setChapterParkedWork(input: {
		chapterId: string;
		commitSha: string | null;
		baseTree: string | null;
	}): Promise<void> {
		await db
			.update(chapters)
			.set({
				parkedSnapshotCommitSha: input.commitSha,
				parkedSnapshotBaseTree: input.baseTree,
			})
			.where(eq(chapters.id, input.chapterId));
	},

	async updateSplitPrefixHead(input: UpdateSplitPrefixHeadWrite): Promise<void> {
		await db
			.update(chapters)
			.set({
				startCommitSha: input.startCommitSha,
				headCommitSha: input.headCommitSha,
				updatedAt: input.now,
			})
			.where(eq(chapters.id, input.prefixId));
	},

	async rewriteSplitContinuation(input: RewriteSplitContinuationWrite): Promise<ChapterRow> {
		return db.transaction((tx) => rewriteSplitContinuationSection(tx, input));
	},
};
