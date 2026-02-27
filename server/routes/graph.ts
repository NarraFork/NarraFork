import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapterEdges, chapters, explorationGroups } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { updateGraphPositionsSchema } from "../lib/validators";
import { commitSyncService } from "../services/commit-sync-service";
import { gitService } from "../services/git-service";

export interface GraphNode {
	id: string;
	type: string;
	data: {
		title: string;
		status: string;
		branch: string;
		role: string;
		color: string | null;
		groupLabel: string | null;
		explorationGroupId: string | null;
		narratorCount: number;
		hasContainers: boolean;
		hasUpstreamUpdates: boolean;
		isRoot: boolean;
		commitCount: number;
		headCommitSha: string | null;
	};
	position: { x: number; y: number };
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	type: string;
	metadata?: unknown;
}

export function buildGraph(
	projectChapters: {
		id: string;
		title: string;
		status: string;
		branch: string;
		role: string;
		color: string | null;
		groupLabel: string | null;
		explorationGroupId: string | null;
		isRoot: number | null;
		positionX: number | null;
		positionY: number | null;
		commitCount: number | null;
		headCommitSha: string | null;
		worktreePath?: string | null;
	}[],
	narratorCounts: Map<string, number>,
	containerPresence: Set<string>,
	edgeRows: {
		id: string;
		sourceId: string;
		targetId: string;
		type: string;
		metadata: unknown;
	}[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const nodes: GraphNode[] = projectChapters.map((ch) => ({
		id: ch.id,
		type: "chapterNode",
		data: {
			title: ch.title,
			status: ch.status,
			branch: ch.branch,
			role: ch.role,
			color: ch.color,
			groupLabel: ch.groupLabel,
			explorationGroupId: ch.explorationGroupId,
			narratorCount: narratorCounts.get(ch.id) ?? 0,
			hasContainers: containerPresence.has(ch.id),
			hasUpstreamUpdates: false,
			isRoot: !!ch.isRoot,
			commitCount: ch.commitCount ?? 0,
			headCommitSha: ch.headCommitSha ?? null,
		},
		position: {
			x: ch.positionX ?? 0,
			y: ch.positionY ?? 0,
		},
	}));

	const edges: GraphEdge[] = edgeRows.map((e) => ({
		id: e.id,
		source: e.sourceId,
		target: e.targetId,
		type: e.type,
		metadata: e.metadata,
	}));

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
			role: true,
			color: true,
			groupLabel: true,
			explorationGroupId: true,
			isRoot: true,
			positionX: true,
			positionY: true,
			createdAt: true,
			commitCount: true,
			headCommitSha: true,
			worktreePath: true,
		},
	});

	// Refresh git info for active chapters with worktrees (lightweight, parallel)
	const activeChapters = projectChapters.filter((ch) => ch.status === "active" && ch.worktreePath);
	if (activeChapters.length > 0) {
		const refreshResults = await Promise.allSettled(
			activeChapters.map(async (ch) => {
				const cwd = ch.worktreePath;
				if (!cwd) return;
				try {
					const liveHead = await gitService.getHeadCommit(cwd);
					if (liveHead && liveHead !== ch.headCommitSha) {
						// HEAD changed — sync commits and update cache
						const newCount = await commitSyncService.syncChapterCommits(ch.id);
						if (newCount > 0 || liveHead !== ch.headCommitSha) {
							// Re-read updated values from DB
							const updated = await db.query.chapters.findFirst({
								where: eq(chapters.id, ch.id),
								columns: { commitCount: true, headCommitSha: true },
							});
							if (updated) {
								ch.commitCount = updated.commitCount;
								ch.headCommitSha = updated.headCommitSha;
							}
						}
					}
				} catch {
					// Non-fatal — use cached values
				}
			}),
		);
		const failures = refreshResults.filter((r) => r.status === "rejected");
		if (failures.length > 0) {
			logger.debug("Some graph git refreshes failed", {
				projectId,
				failCount: failures.length,
			});
		}
	}

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

	// Get edges from chapter_edges table
	const edgeRows = await db
		.select()
		.from(chapterEdges)
		.where(eq(chapterEdges.projectId, projectId))
		.all();

	// Get exploration groups for this project
	const groups = await db
		.select()
		.from(explorationGroups)
		.where(eq(explorationGroups.projectId, projectId))
		.all();

	// Build graph
	const { nodes, edges } = buildGraph(projectChapters, narratorCounts, containerPresence, edgeRows);

	return c.json({ nodes, edges, explorationGroups: groups });
});

graphRoutes.patch("/:id/graph/positions", async (c) => {
	const projectId = c.req.param("id");
	const body = await c.req.json();
	const parsed = updateGraphPositionsSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	// Validate all chapterIds belong to this project
	const chapterIds = parsed.data.positions.map((p) => p.chapterId);
	if (chapterIds.length > 0) {
		const owned = await db
			.select({ id: chapters.id })
			.from(chapters)
			.where(and(inArray(chapters.id, chapterIds), eq(chapters.projectId, projectId)));
		const ownedIds = new Set(owned.map((r) => r.id));
		const invalid = chapterIds.filter((id) => !ownedIds.has(id));
		if (invalid.length > 0) {
			throw new ValidationError(`Chapters not in project: ${invalid.join(", ")}`);
		}
	}

	for (const pos of parsed.data.positions) {
		await db
			.update(chapters)
			.set({ positionX: pos.x, positionY: pos.y })
			.where(eq(chapters.id, pos.chapterId));
	}

	return c.json({ ok: true });
});
