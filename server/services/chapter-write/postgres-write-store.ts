/**
 * PostgreSQL implementation of `ChapterWriteStore`.
 *
 * Same capability as `sqlite-write-store.ts`, different engine — and deliberately not
 * the same code: what the two implementations share is the port (`write-store.ts`),
 * the section CONTENT (same reads, guards and writes in the same order) and the
 * domain errors. Everything dialect-shaped lives here: the PG schema, genuinely async
 * transactions, whole-section retry, row locks and conflict translation.
 *
 * HOW EACH REQUIREMENT OF THE PORT IS MET
 * ---------------------------------------
 * - PROMISE boundary: every method is honestly async against a networked driver. An
 *   `await` between BEGIN and COMMIT is safe here, which is exactly what the
 *   write-port base contrasts with the SQLite implementation's strictly synchronous
 *   section.
 * - ATOMICITY: each operation's whole section runs in one `db.transaction`. Any
 *   rejection rolls all of it back. Every section is a NAMED async function invoked
 *   through a non-async arrow (`db.transaction((tx) => section(tx, input))`) — the
 *   shape the transaction-atomicity gate requires, so no `async` callback literal
 *   ever reaches a `.transaction(` call site.
 * - RETRY: `withPgRetry` wraps the WHOLE section (BEGIN through COMMIT), never a
 *   single statement. Sections are idempotent under whole-section replay: every row
 *   id is supplied by the caller, so a replay after a commit whose acknowledgement
 *   was lost surfaces as a conflict (or an upsert hit) instead of duplicating
 *   anything.
 * - CONFLICTS AS VOCABULARY: SQLSTATE 23505 is translated to `WriteConflictError`
 *   (with the constraint name the server reported) before it can cross the port
 *   boundary. `withPgRetry` classifies that as a unique-violation and never retries
 *   it into a false success.
 *
 * THE EDGE UPSERT RACE ON POSTGRESQL
 * ----------------------------------
 * `chapter_edges` has no UNIQUE constraint on (source, target, type), so the database
 * cannot reject a duplicate — under SQLite the single-writer transaction was the
 * lock. Here each upsert first takes the SOURCE chapter's row lock
 * (`SELECT … FOR UPDATE`): two concurrent upserts sharing a source serialize on that
 * row, the loser re-reads and finds the winner's edge, and upserts of different
 * sources proceed in parallel. The row always exists at this point (edges are written
 * after both endpoint chapters), so the lock is never a no-op guard. This is the
 * row-lock form of the same claim the SQLite section makes with its synchronous
 * transaction — see the port header.
 */

import { WriteConflictError } from "@server/db/backend/write-port";
import { isPgUniqueViolation } from "@server/db/pg-errors";
import { withPgRetry } from "@server/db/pg-retry";
import { chapterCommits, chapterEdges, chapters } from "@server/db/postgres-schema";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { and, count, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
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

/** Transaction handle as produced by `db.transaction(async (tx) => …)`. PG-side only. */
type PgTransaction = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];

/** How deep `cause` chains are followed when looking for the driver error's detail. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The constraint name the server attached to a unique violation, when it reported
 * one. Bun SQL surfaces it as `PostgresError.constraint`; Drizzle may wrap the driver
 * error under `cause`, so the chain is walked with the same bound `pg-errors.ts`
 * uses. Mirrors `services/knowledge/postgres-write-store.ts`.
 */
function extractConstraintName(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return null;
		const constraint = (current as Record<string, unknown>).constraint;
		if (typeof constraint === "string" && constraint.length > 0) return constraint;
		current = (current as Record<string, unknown>).cause;
	}
	return null;
}

/**
 * Translate a unique violation into port vocabulary; everything else passes through.
 * The original error rides as `cause`, which keeps the SQLSTATE reachable for
 * classification — `withPgRetry` sees a unique-violation, not a retryable failure.
 */
function rethrowAsPortError(error: unknown): never {
	if (isPgUniqueViolation(error)) {
		throw new WriteConflictError("write conflicts with an existing row", {
			constraint: extractConstraintName(error),
			cause: error,
		});
	}
	throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic sections (named async functions — see the header)
// ─────────────────────────────────────────────────────────────────────────────

type EdgeUpsertInput = (UpsertForkEdgeWrite | UpsertMergeEdgeWrite) & { type: "fork" | "merge" };

/**
 * The check-then-insert edge upsert under the source chapter's row lock. Same
 * reads/decision/writes in the same order as the SQLite section; the lock is what
 * makes "no edge found → insert" atomic against a concurrent upsert of the same
 * (source, target, type).
 */
async function upsertEdgeSection(
	tx: PgTransaction,
	input: EdgeUpsertInput,
): Promise<ChapterEdgeRow> {
	// Serialize concurrent upserts sharing this source. Locking the target as well
	// would buy nothing — the edge identity being checked is (source, target, type),
	// and two upserts disagreeing about the source cannot produce the same edge.
	const source = await tx
		.select({ id: chapters.id })
		.from(chapters)
		.where(eq(chapters.id, input.sourceId))
		.for("update");
	if (source.length === 0) throw new NotFoundError("Chapter", input.sourceId);

	const existing = await tx
		.select({ id: chapterEdges.id })
		.from(chapterEdges)
		.where(
			and(
				eq(chapterEdges.sourceId, input.sourceId),
				eq(chapterEdges.targetId, input.targetId),
				eq(chapterEdges.type, input.type),
			),
		)
		.limit(1);

	if (existing[0]) {
		const updated = await tx
			.update(chapterEdges)
			.set({ metadata: input.metadata })
			.where(eq(chapterEdges.id, existing[0].id))
			.returning();
		const row = updated[0];
		if (!row) throw new NotFoundError("ChapterEdge", existing[0].id);
		return row as ChapterEdgeRow;
	}

	const inserted = await tx
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
		.returning();
	const row = inserted[0];
	if (!row) throw new Error("chapter edge insert returned no row");
	return row as ChapterEdgeRow;
}

/**
 * The fork-edge retarget: same validations in the same order as the SQLite section,
 * with the edge row locked so two concurrent retargets of the same edge serialize
 * instead of both reading the same pre-image.
 */
async function retargetForkEdgeSection(
	tx: PgTransaction,
	input: { edgeId: string; newTargetId: string },
): Promise<string> {
	const edges = await tx
		.select()
		.from(chapterEdges)
		.where(eq(chapterEdges.id, input.edgeId))
		.for("update");
	const edge = edges[0];
	if (!edge) throw new NotFoundError("ChapterEdge", input.edgeId);
	if (edge.type !== "fork") {
		throw new ValidationError("Only fork edges can be retargeted");
	}
	if (edge.sourceId === input.newTargetId) {
		throw new ValidationError("Cannot retarget a fork edge to its own source");
	}

	const targets = await tx
		.select({ id: chapters.id, projectId: chapters.projectId })
		.from(chapters)
		.where(eq(chapters.id, input.newTargetId));
	const target = targets[0];
	if (!target) throw new NotFoundError("Chapter", input.newTargetId);
	if (target.projectId !== edge.projectId) {
		throw new ValidationError("Cannot retarget a fork edge across projects");
	}

	const previousTargetId = edge.targetId;
	if (previousTargetId === input.newTargetId) return previousTargetId;

	await tx
		.update(chapterEdges)
		.set({ targetId: input.newTargetId })
		.where(eq(chapterEdges.id, input.edgeId));
	return previousTargetId;
}

/**
 * The split's continuation rewrite: the commit count is recomputed inside the same
 * section (drizzle's `count()` decodes to a JS number on this driver) and the guarded
 * update returns the rewritten row or rejects with `NotFoundError` having written
 * nothing.
 */
async function rewriteSplitContinuationSection(
	tx: PgTransaction,
	input: RewriteSplitContinuationWrite,
): Promise<ChapterRow> {
	const counted = await tx
		.select({ total: count() })
		.from(chapterCommits)
		.where(eq(chapterCommits.chapterId, input.chapterId));
	const updated = await tx
		.update(chapters)
		.set({
			parentChapterId: input.prefixId,
			startCommitSha: input.commitSha,
			forkPoint: {
				commitSha: input.commitSha,
				...(input.narratorMessageId ? { narratorMessageId: input.narratorMessageId } : {}),
			},
			commitCount: counted[0]?.total ?? input.fallbackCommitCount ?? 0,
			updatedAt: input.now,
		})
		.where(eq(chapters.id, input.chapterId))
		.returning();
	const row = updated[0];
	if (!row) throw new NotFoundError("Chapter", input.chapterId);
	return row as ChapterRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose the PostgreSQL chapter write store over a caller-supplied handle. Nothing
 * here opens a connection — tests and the future composition root build their own.
 */
export function createPostgresChapterWriteStore(db: BunSQLDatabase): ChapterWriteStore {
	return {
		insertChapter(input: InsertChapterWrite): Promise<ChapterRow> {
			return withPgRetry(
				async () => {
					try {
						const rows = await db.insert(chapters).values(input).returning();
						const row = rows[0];
						if (!row) throw new Error("chapter insert returned no row");
						return row as ChapterRow;
					} catch (error) {
						rethrowAsPortError(error);
					}
				},
				{ label: "chapter.insertChapter" },
			);
		},

		async deleteChapter(id: string): Promise<void> {
			await withPgRetry(() => db.delete(chapters).where(eq(chapters.id, id)), {
				label: "chapter.deleteChapter",
			});
		},

		async updateChapterContainerConfig(input: {
			chapterId: string;
			containerConfig: unknown;
			now: string;
		}): Promise<void> {
			await withPgRetry(
				() =>
					db
						.update(chapters)
						.set({ containerConfig: input.containerConfig, updatedAt: input.now })
						.where(eq(chapters.id, input.chapterId)),
				{ label: "chapter.updateChapterContainerConfig" },
			);
		},

		async upsertForkEdge(input: UpsertForkEdgeWrite): Promise<ChapterEdgeRow> {
			try {
				return await withPgRetry(
					() => db.transaction((tx) => upsertEdgeSection(tx, { ...input, type: "fork" })),
					{ label: "chapter.upsertForkEdge" },
				);
			} catch (error) {
				rethrowAsPortError(error);
			}
		},

		async upsertMergeEdge(input: UpsertMergeEdgeWrite): Promise<ChapterEdgeRow> {
			try {
				return await withPgRetry(
					() => db.transaction((tx) => upsertEdgeSection(tx, { ...input, type: "merge" })),
					{ label: "chapter.upsertMergeEdge" },
				);
			} catch (error) {
				rethrowAsPortError(error);
			}
		},

		async retargetForkEdge(input: { edgeId: string; newTargetId: string }): Promise<string> {
			return withPgRetry(() => db.transaction((tx) => retargetForkEdgeSection(tx, input)), {
				label: "chapter.retargetForkEdge",
			});
		},

		async deleteMergeEdgesBySource(chapterId: string): Promise<void> {
			await withPgRetry(
				() =>
					db
						.delete(chapterEdges)
						.where(and(eq(chapterEdges.sourceId, chapterId), eq(chapterEdges.type, "merge"))),
				{ label: "chapter.deleteMergeEdgesBySource" },
			);
		},

		async recordChapterMerge(input: RecordChapterMergeWrite): Promise<void> {
			await withPgRetry(
				() =>
					db
						.update(chapters)
						.set({
							status: "merged",
							worktreePath: null,
							mergedIntoChapterId: input.targetChapterId,
							mergeCommitSha: input.mergeCommitSha,
							mergeStrategy: input.strategy,
							preMergeTargetSha: input.preMergeTargetSha,
							mergeSnapshotCommitSha: null,
							preMergeTargetSnapshotSha: null,
							mergedSourceSnapshotSha: null,
							updatedAt: input.now,
						})
						.where(eq(chapters.id, input.sourceChapterId)),
				{ label: "chapter.recordChapterMerge" },
			);
		},

		async recordChapterSnapshotMerge(input: RecordChapterSnapshotMergeWrite): Promise<void> {
			await withPgRetry(
				() =>
					db
						.update(chapters)
						.set({
							status: "merged",
							worktreePath: null,
							mergedIntoChapterId: input.targetChapterId,
							mergeStrategy: input.strategy,
							mergeSnapshotCommitSha: input.mergeSnapshotCommitSha,
							preMergeTargetSnapshotSha: input.preMergeTargetSnapshotSha,
							mergedSourceSnapshotSha: input.mergedSourceSnapshotSha,
							preMergeTargetSha: input.preMergeTargetSha,
							updatedAt: input.now,
						})
						.where(eq(chapters.id, input.sourceChapterId)),
				{ label: "chapter.recordChapterSnapshotMerge" },
			);
		},

		async restoreMergedChapter(input: RestoreMergedChapterWrite): Promise<void> {
			await withPgRetry(
				() =>
					db
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
						.where(eq(chapters.id, input.chapterId)),
				{ label: "chapter.restoreMergedChapter" },
			);
		},

		async setChapterParkedWork(input: {
			chapterId: string;
			commitSha: string | null;
			baseTree: string | null;
		}): Promise<void> {
			await withPgRetry(
				() =>
					db
						.update(chapters)
						.set({
							parkedSnapshotCommitSha: input.commitSha,
							parkedSnapshotBaseTree: input.baseTree,
						})
						.where(eq(chapters.id, input.chapterId)),
				{ label: "chapter.setChapterParkedWork" },
			);
		},

		async updateSplitPrefixHead(input: UpdateSplitPrefixHeadWrite): Promise<void> {
			await withPgRetry(
				() =>
					db
						.update(chapters)
						.set({
							startCommitSha: input.startCommitSha,
							headCommitSha: input.headCommitSha,
							updatedAt: input.now,
						})
						.where(eq(chapters.id, input.prefixId)),
				{ label: "chapter.updateSplitPrefixHead" },
			);
		},

		async rewriteSplitContinuation(input: RewriteSplitContinuationWrite): Promise<ChapterRow> {
			return withPgRetry(() => db.transaction((tx) => rewriteSplitContinuationSection(tx, input)), {
				label: "chapter.rewriteSplitContinuation",
			});
		},
	};
}
