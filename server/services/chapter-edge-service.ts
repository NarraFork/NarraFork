import { db } from "@server/db";
import { chapterEdges } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import type { ForkWorktreeSource } from "@shared/chapter-fork";
import { and, eq, or } from "drizzle-orm";
import { chapterWriteStore } from "./chapter-write/store";

// Safety cap: prevent unbounded result sets from blocking the main thread
// during serialization. 2000 edges covers any realistic project while
// keeping response time bounded.
const EDGE_QUERY_LIMIT = 2000;

/**
 * === dependency edges: removed ===
 *
 * `createDependencyEdge` and the generic `deleteEdge` used to live here. The user drew a
 * `dependency` edge by dragging from one node's handle to another, and the intent was
 * "chapter B depends on chapter A, warn me when A moves ahead".
 *
 * Nothing consumed it. `chapter-merge`, `chapter-fork` and `chapter-service` never read
 * dependency edges, so the edge changed no behaviour: it did not order merges, block them,
 * trigger a rebase, or feed batch-merge planning. `getEdgesByType` was only reachable from
 * `GET /api/chapter-edges`, i.e. "read back what you wrote". The promised upstream tracking
 * was never built: `hasUpstreamUpdates` was hardcoded `false` in `graph.ts`, so the badge
 * never lit; `dependency:upstream_updated` and `dependency:synced` were never emitted; and
 * `GET /chapters/:id/dependency-status` plus `POST /chapters/:id/sync-upstream` never
 * existed despite typed frontend clients naming them.
 *
 * It was also unsound as a feature. Creation checked only self-loop, existence and same
 * project — no cycle detection and no dedupe (unlike `createForkEdge`, which uses a
 * synchronous transaction precisely because the table has no UNIQUE constraint), so a
 * user could build A→B→C→A or stack identical edges. `metadata.lastSyncedCommit` was
 * written as `null` and never updated by anything. And the UI could create edges but not
 * remove them: `NarraFlow` wired `onConnect` with no `onEdgesChange`/`onEdgesDelete`, and
 * `useDeleteChapterEdge` had zero call sites, so one stray drag produced a permanent edge.
 *
 * The relationships it modelled are already available without hand-maintained bookkeeping:
 * "B is based on A" is the fork edge (created automatically), "B took A's changes" is the
 * merge edge, and "A is ahead of B" is `git log B..A`. A manually-curated
 * `lastSyncedCommit` can only drift once anyone rebases or force-pushes outside the API.
 * If purely semantic grouping is wanted later, `groupLabel` is the field for it, not a
 * directed edge.
 *
 * No dependency edge was ever created in practice, so no data migration is needed. The
 * `dependency` value stays in the `chapter_edges.type` enum so historical rows (if any)
 * still load; nothing writes it.
 */
class ChapterEdgeService {
	/**
	 * Internal: create a fork edge (called automatically during chapter fork).
	 * Idempotent: if the same (source, target, "fork") edge already exists, update it in place.
	 *
	 * The lookup and the write share ONE atomic section inside the chapter write
	 * store (`services/chapter-write/`). `chapter_edges` has no UNIQUE constraint on
	 * (source, target, type) — only a plain index — so the database cannot reject a
	 * duplicate for us, and splitting this into `await findFirst()` + `await insert()`
	 * would leave an await point between the check and the write: two concurrent
	 * forks of the same parent could both observe "no edge" and each insert one,
	 * silently doubling the graph edge. How the section closes that race is the
	 * backend's business (SQLite: one strictly synchronous transaction; PostgreSQL:
	 * the source chapter's row lock) — the port header states the contract.
	 */
	async createForkEdge(
		projectId: string,
		sourceId: string,
		targetId: string,
		metadata: {
			commitSha: string;
			worktreeSource: ForkWorktreeSource;
			inheritMode: string;
			narratorMessageUuid?: string;
			narratorMessageId?: string;
		},
	) {
		return chapterWriteStore.upsertForkEdge({
			id: generateId(),
			projectId,
			sourceId,
			targetId,
			metadata,
			now: new Date().toISOString(),
		});
	}

	/**
	 * Internal: create a merge edge (called automatically during chapter merge).
	 *
	 * Upserted inside ONE atomic section of the chapter write store, for the same
	 * reason `createForkEdge` is: without it two concurrent merges could both observe
	 * "no edge" and both insert — a double-clicked merge button, or two batch-merge
	 * passes touching the same pair, produced duplicate merge edges, which the graph
	 * then draws twice.
	 */
	async createMergeEdge(
		projectId: string,
		sourceId: string,
		targetId: string,
		metadata: {
			mergeCommitSha?: string;
			/**
			 * Set instead of `mergeCommitSha` when the merge happened in snapshot space
			 * and produced no git commit.
			 */
			mergeSnapshotCommitSha?: string;
			strategy: string;
			status?: "pending" | "completed";
		},
	) {
		return chapterWriteStore.upsertMergeEdge({
			id: generateId(),
			projectId,
			sourceId,
			targetId,
			metadata,
			now: new Date().toISOString(),
		});
	}

	/**
	 * Internal: repoint an existing fork edge at a different target chapter.
	 *
	 * Exists for the chapter split, which inserts a new "prefix" chapter between a
	 * chapter and its parent and therefore has to hand the parent→child edges over
	 * to the prefix. Returns the *previous* target so the caller can register a
	 * rollback that puts it back.
	 *
	 * A narrow method rather than a general edge update, and certainly rather than
	 * raw SQL at the call site. `deleteEdge` refuses everything except dependency
	 * edges on purpose (fork and merge edges mirror columns on `chapters`, so a
	 * loose delete would desynchronize the graph from the rows), and this keeps
	 * that invariant intact: only the target moves, the type and metadata are
	 * untouched, and every edge write stays inside this service where the fork/merge
	 * rules live.
	 *
	 * Rejects non-fork edges for the same reason `deleteEdge` does: a merge or
	 * dependency edge's endpoints carry meaning this method makes no attempt to
	 * keep consistent.
	 */
	async redirectForkEdgeTarget(id: string, newTargetId: string): Promise<string> {
		const previousTargetId = await chapterWriteStore.retargetForkEdge({
			edgeId: id,
			newTargetId,
		});

		// Post-commit, deliberately: the store's resolved Promise is the exactly-once
		// boundary, and a replayed section must not emit the log line twice.
		if (previousTargetId !== newTargetId) {
			logger.debug("Fork edge retargeted", { edgeId: id, previousTargetId, newTargetId });
		}
		return previousTargetId;
	}

	/**
	 * Delete all merge edges where the given chapter is the source (the merged branch).
	 * Called when waking a merged chapter to remove stale merge lines.
	 */
	async deleteMergeEdgesBySource(chapterId: string) {
		await chapterWriteStore.deleteMergeEdgesBySource(chapterId);
	}

	/**
	 * Get all edges for a project.
	 */
	async getEdgesByProject(projectId: string) {
		const rows = await db
			.select()
			.from(chapterEdges)
			.where(eq(chapterEdges.projectId, projectId))
			.limit(EDGE_QUERY_LIMIT + 1);
		if (rows.length > EDGE_QUERY_LIMIT) {
			logger.warn("getEdgesByProject hit safety limit, graph may be incomplete", {
				projectId,
				limit: EDGE_QUERY_LIMIT,
			});
			return rows.slice(0, EDGE_QUERY_LIMIT);
		}
		return rows;
	}

	/**
	 * Get all edges for a chapter (both incoming and outgoing).
	 */
	async getEdgesByChapter(chapterId: string) {
		const rows = await db
			.select()
			.from(chapterEdges)
			.where(or(eq(chapterEdges.sourceId, chapterId), eq(chapterEdges.targetId, chapterId)))
			.limit(EDGE_QUERY_LIMIT + 1);
		if (rows.length > EDGE_QUERY_LIMIT) {
			logger.warn("getEdgesByChapter hit safety limit, results may be incomplete", {
				chapterId,
				limit: EDGE_QUERY_LIMIT,
			});
			return rows.slice(0, EDGE_QUERY_LIMIT);
		}
		return rows;
	}

	/**
	 * Get edges by type within a project.
	 */
	async getEdgesByType(projectId: string, type: "fork" | "merge" | "review") {
		const rows = await db
			.select()
			.from(chapterEdges)
			.where(and(eq(chapterEdges.projectId, projectId), eq(chapterEdges.type, type)))
			.limit(EDGE_QUERY_LIMIT + 1);
		if (rows.length > EDGE_QUERY_LIMIT) {
			logger.warn("getEdgesByType hit safety limit, results may be incomplete", {
				projectId,
				type,
				limit: EDGE_QUERY_LIMIT,
			});
			return rows.slice(0, EDGE_QUERY_LIMIT);
		}
		return rows;
	}
}

export const chapterEdgeService = new ChapterEdgeService();
