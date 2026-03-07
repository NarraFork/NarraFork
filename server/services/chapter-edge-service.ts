import { db } from "@server/db";
import { chapterEdges, chapters } from "@server/db/schema";
import { NotFoundError, ValidationError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { generateId } from "@server/lib/id";
import { and, eq, or } from "drizzle-orm";

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
	 */
	async createForkEdge(
		projectId: string,
		sourceId: string,
		targetId: string,
		metadata: { commitSha: string; inheritMode: string; narratorMessageUuid?: string },
	) {
		const id = generateId();
		const now = new Date().toISOString();

		const [edge] = await db
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
			.returning();

		return edge;
	}

	/**
	 * Internal: create a merge edge (called automatically during chapter merge).
	 */
	async createMergeEdge(
		projectId: string,
		sourceId: string,
		targetId: string,
		metadata: { mergeCommitSha?: string; strategy: string },
	) {
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
		return db.select().from(chapterEdges).where(eq(chapterEdges.projectId, projectId));
	}

	/**
	 * Get all edges for a chapter (both incoming and outgoing).
	 */
	async getEdgesByChapter(chapterId: string) {
		return db
			.select()
			.from(chapterEdges)
			.where(or(eq(chapterEdges.sourceId, chapterId), eq(chapterEdges.targetId, chapterId)));
	}

	/**
	 * Get edges by type within a project.
	 */
	async getEdgesByType(projectId: string, type: "fork" | "merge" | "dependency" | "cherry_pick") {
		return db
			.select()
			.from(chapterEdges)
			.where(and(eq(chapterEdges.projectId, projectId), eq(chapterEdges.type, type)));
	}
}

export const chapterEdgeService = new ChapterEdgeService();
