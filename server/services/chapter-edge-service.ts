import { db } from "@server/db";
import { chapterEdges, chapters } from "@server/db/schema";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { and, eq, or } from "drizzle-orm";

// Safety cap: prevent unbounded result sets from blocking the main thread
// during serialization. 2000 edges covers any realistic project while
// keeping response time bounded.
const EDGE_QUERY_LIMIT = 2000;

class ChapterEdgeService {
	/**
	 * Create a dependency edge (user-initiated).
	 */
	async createDependencyEdge(input: {
		sourceId: string;
		targetId: string;
		metadata?: { description?: string };
	}) {
		if (input.sourceId === input.targetId) {
			throw new ValidationError("Cannot create a dependency edge to itself");
		}

		const source = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.sourceId),
		});
		if (!source) throw new NotFoundError("Chapter", input.sourceId);

		const target = await db.query.chapters.findFirst({
			where: eq(chapters.id, input.targetId),
		});
		if (!target) throw new NotFoundError("Chapter", input.targetId);

		if (source.projectId !== target.projectId) {
			throw new ValidationError("Cannot create dependency between chapters of different projects");
		}

		const id = generateId();
		const now = new Date().toISOString();

		const [edge] = await db
			.insert(chapterEdges)
			.values({
				id,
				projectId: source.projectId,
				sourceId: input.sourceId,
				targetId: input.targetId,
				type: "dependency",
				metadata: {
					description: input.metadata?.description,
					lastSyncedCommit: null,
				},
				createdAt: now,
			})
			.returning();

		eventBus.emit({
			type: "dependency:created",
			edgeId: id,
			sourceId: input.sourceId,
			targetId: input.targetId,
		});

		return edge;
	}

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
	 * Delete an edge (only dependency type can be manually deleted).
	 */
	async deleteEdge(id: string) {
		const edge = await db.query.chapterEdges.findFirst({
			where: eq(chapterEdges.id, id),
		});
		if (!edge) throw new NotFoundError("ChapterEdge", id);

		if (edge.type !== "dependency") {
			throw new ValidationError("Only dependency edges can be manually deleted");
		}

		await db.delete(chapterEdges).where(eq(chapterEdges.id, id));

		eventBus.emit({
			type: "dependency:removed",
			edgeId: id,
			sourceId: edge.sourceId,
			targetId: edge.targetId,
		});
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
	async getEdgesByType(projectId: string, type: "fork" | "merge" | "dependency" | "cherry_pick") {
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
