import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapters } from "../db/schema";

export interface GraphChapter {
	id: string;
	title: string;
	status: string;
	branch: string;
	parentChapterId: string | null;
	mergedIntoChapterId: string | null;
}

export interface GraphNode {
	id: string;
	type: string;
	data: {
		title: string;
		status: string;
		branch: string;
		narratorCount: number;
		hasContainers: boolean;
	};
	position: { x: number; y: number };
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	type: string;
}

export function buildGraph(
	projectChapters: GraphChapter[],
	narratorCounts: Map<string, number>,
	containerPresence: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const nodes: GraphNode[] = projectChapters.map((ch) => ({
		id: ch.id,
		type: "chapterNode",
		data: {
			title: ch.title,
			status: ch.status,
			branch: ch.branch,
			narratorCount: narratorCounts.get(ch.id) ?? 0,
			hasContainers: containerPresence.has(ch.id),
		},
		position: { x: 0, y: 0 },
	}));

	const edges: GraphEdge[] = [];
	for (const ch of projectChapters) {
		if (ch.parentChapterId) {
			edges.push({
				id: `fork-${ch.parentChapterId}-${ch.id}`,
				source: ch.parentChapterId,
				target: ch.id,
				type: "forkEdge",
			});
		}
		if (ch.mergedIntoChapterId) {
			edges.push({
				id: `merge-${ch.id}-${ch.mergedIntoChapterId}`,
				source: ch.id,
				target: ch.mergedIntoChapterId,
				type: "mergeEdge",
			});
		}
	}

	return { nodes, edges };
}

export const graphRoutes = new Hono();

graphRoutes.get("/:id/graph", async (c) => {
	const projectId = c.req.param("id");

	const projectChapters = await db.query.chapters.findMany({
		where: eq(chapters.projectId, projectId),
		columns: {
			id: true,
			title: true,
			status: true,
			branch: true,
			parentChapterId: true,
			mergedIntoChapterId: true,
			createdAt: true,
		},
	});

	// Get narrator counts and container presence per chapter
	const chapterIds = projectChapters.map((ch) => ch.id);

	const allNarrators = chapterIds.length
		? await db.query.narrators.findMany({
				where: (n, { inArray }) => inArray(n.chapterId, chapterIds),
				columns: { id: true, chapterId: true },
			})
		: [];

	const allContainers = chapterIds.length
		? await db.query.containerInstances.findMany({
				where: (ci, { inArray, and, ne }) =>
					and(inArray(ci.chapterId, chapterIds), ne(ci.status, "removed")),
				columns: { id: true, chapterId: true },
			})
		: [];

	const narratorCounts = new Map<string, number>();
	for (const n of allNarrators) {
		if (n.chapterId) {
			narratorCounts.set(n.chapterId, (narratorCounts.get(n.chapterId) ?? 0) + 1);
		}
	}

	const containerPresence = new Set<string>();
	for (const ci of allContainers) {
		containerPresence.add(ci.chapterId);
	}

	// Build graph
	const { nodes, edges } = buildGraph(
		projectChapters as GraphChapter[],
		narratorCounts,
		containerPresence,
	);

	return c.json({ nodes, edges });
});
