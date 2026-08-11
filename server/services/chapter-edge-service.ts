import { db } from "@server/db";
import { chapterEdges, chapters } from "@server/db/schema";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { and, eq, or } from "drizzle-orm";

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
	 * The lookup and the write share ONE synchronous `db.transaction`. `chapter_edges` has no
	 * UNIQUE constraint on (source, target, type) — only a plain index — so the database cannot
	 * reject a duplicate for us. Splitting this into `await findFirst()` + `await insert()` would
	 * leave an await point between the check and the write, and two concurrent forks of the same
	 * parent could both observe "no edge" and each insert one, silently doubling the graph edge.
	 * A synchronous bun:sqlite transaction has no such interleaving point.
	 */
	async createForkEdge(
		projectId: string,
		sourceId: string,
		targetId: string,
		metadata: {
			commitSha: string;
			inheritMode: string;
			narratorMessageUuid?: string;
			narratorMessageId?: string;
		},
	) {
		const id = generateId();
		const now = new Date().toISOString();

		return db.transaction((tx) => {
			const existing = tx
				.select({ id: chapterEdges.id })
				.from(chapterEdges)
				.where(
					and(
						eq(chapterEdges.sourceId, sourceId),
						eq(chapterEdges.targetId, targetId),
						eq(chapterEdges.type, "fork"),
					),
				)
				.limit(1)
				.get();

			if (existing) {
				return tx
					.update(chapterEdges)
					.set({ metadata })
					.where(eq(chapterEdges.id, existing.id))
					.returning()
					.get();
			}

			return tx
				.insert(chapterEdges)
				.values({
					id,
					projectId,
					sourceId,
					targetId,
					type: "fork",
					metadata,
					createdAt: now,
				})
				.returning()
				.get();
		});
	}

	/**
	 * Internal: create a merge edge (called automatically during chapter merge).
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
		const existing = await db.query.chapterEdges.findFirst({
			where: and(
				eq(chapterEdges.sourceId, sourceId),
				eq(chapterEdges.targetId, targetId),
				eq(chapterEdges.type, "merge"),
			),
		});
		if (existing) {
			const [edge] = await db
				.update(chapterEdges)
				.set({ metadata })
				.where(eq(chapterEdges.id, existing.id))
				.returning();
			return edge;
		}

		const id = generateId();
		const now = new Date().toISOString();

		const [edge] = await db
			.insert(chapterEdges)
			.values({
				id,
				projectId,
				sourceId,
				targetId,
				type: "merge",
				metadata,
				createdAt: now,
			})
			.returning();

		return edge;
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
		const edge = await db.query.chapterEdges.findFirst({
			where: eq(chapterEdges.id, id),
		});
		if (!edge) throw new NotFoundError("ChapterEdge", id);
		if (edge.type !== "fork") {
			throw new ValidationError("Only fork edges can be retargeted");
		}
		if (edge.sourceId === newTargetId) {
			// Would make the edge a self-loop, which the graph renders as an
			// unremovable artifact and every traversal treats as a cycle.
			throw new ValidationError("Cannot retarget a fork edge to its own source");
		}

		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, newTargetId),
			columns: { id: true, projectId: true },
		});
		if (!target) throw new NotFoundError("Chapter", newTargetId);
		if (target.projectId !== edge.projectId) {
			throw new ValidationError("Cannot retarget a fork edge across projects");
		}

		const previousTargetId = edge.targetId;
		if (previousTargetId === newTargetId) return previousTargetId;

		await db.update(chapterEdges).set({ targetId: newTargetId }).where(eq(chapterEdges.id, id));

		logger.debug("Fork edge retargeted", { edgeId: id, previousTargetId, newTargetId });
		return previousTargetId;
	}

	/**
	 * Delete all merge edges where the given chapter is the source (the merged branch).
	 * Called when waking a merged chapter to remove stale merge lines.
	 */
	async deleteMergeEdgesBySource(chapterId: string) {
		await db
			.delete(chapterEdges)
			.where(and(eq(chapterEdges.sourceId, chapterId), eq(chapterEdges.type, "merge")));
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
