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
		narratorId: string | null;
		narratorStatus: string | null;
		hasContainers: boolean;
		hasUpstreamUpdates: boolean;
		isRoot: boolean;
		commitCount: number;
		headCommitSha: string | null;
		panelExpanded: boolean;
		panelWidth: number | null;
		panelHeight: number | null;
		worktreePath: string | null;
	};
	position: {
		anchorCommitSha: string | null;
		axisOffset: number;
		crossOffset: number;
	};
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
		anchorCommitSha: string | null;
		axisOffset: number | null;
		crossOffset: number | null;
		commitCount: number | null;
		headCommitSha: string | null;
		panelExpanded: number | null;
		panelWidth: number | null;
		panelHeight: number | null;
		worktreePath?: string | null;
		reviewSourceChapterId?: string | null;
		reviewStatus?: string | null;
	}[],
	narratorCounts: Map<string, number>,
	narratorIds: Map<string, string>,
	narratorStatuses: Map<string, string>,
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
		type: ch.role === "review" ? "reviewNode" : "chapterNode",
		data: {
			title: ch.title,
			status: ch.status,
			branch: ch.branch,
			role: ch.role,
			color: ch.color,
			groupLabel: ch.groupLabel,
			explorationGroupId: ch.explorationGroupId,
			narratorCount: narratorCounts.get(ch.id) ?? 0,
			narratorId: narratorIds.get(ch.id) ?? null,
			narratorStatus: narratorStatuses.get(ch.id) ?? null,
			hasContainers: containerPresence.has(ch.id),
			hasUpstreamUpdates: false,
			isRoot: !!ch.isRoot,
			commitCount: ch.commitCount ?? 0,
			headCommitSha: ch.headCommitSha ?? null,
			panelExpanded: !!ch.panelExpanded,
			panelWidth: ch.panelWidth ?? null,
			panelHeight: ch.panelHeight ?? null,
			worktreePath: ch.worktreePath ?? null,
			reviewSourceChapterId: ch.reviewSourceChapterId ?? null,
			reviewStatus: ch.reviewStatus ?? null,
		},
		position: {
			anchorCommitSha: ch.anchorCommitSha ?? null,
			axisOffset: ch.axisOffset ?? 0,
			crossOffset: ch.crossOffset ?? 0,
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
			anchorCommitSha: true,
			axisOffset: true,
			crossOffset: true,
			createdAt: true,
			commitCount: true,
			headCommitSha: true,
			worktreePath: true,
			panelExpanded: true,
			panelWidth: true,
			panelHeight: true,
			reviewSourceChapterId: true,
			reviewStatus: true,
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
				columns: { id: true, chapterId: true, status: true },
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
	const narratorIds = new Map<string, string>();
	const narratorStatuses = new Map<string, string>();
	for (const n of allNarrators) {
		if (n.chapterId) {
			narratorCounts.set(n.chapterId, (narratorCounts.get(n.chapterId) ?? 0) + 1);
			// Keep the first narrator ID and status per chapter
			if (!narratorIds.has(n.chapterId)) {
				narratorIds.set(n.chapterId, n.id);
				if (n.status) narratorStatuses.set(n.chapterId, n.status);
			}
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
	const { nodes, edges } = buildGraph(
		projectChapters,
		narratorCounts,
		narratorIds,
		narratorStatuses,
		containerPresence,
		edgeRows,
	);

	// Get terminals that are opened in the graph
	const openedTerminals = chapterIds.length
		? await db.query.terminals.findMany({
				where: (t, { and, inArray, eq }) =>
					and(inArray(t.chapterId, chapterIds), eq(t.graphOpened, 1), eq(t.status, "running")),
				columns: {
					id: true,
					chapterId: true,
					name: true,
					graphX: true,
					graphY: true,
					graphWidth: true,
					graphHeight: true,
				},
			})
		: [];

	return c.json({ nodes, edges, explorationGroups: groups, openedTerminals });
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
		const updates: Record<string, unknown> = {
			anchorCommitSha: pos.anchorCommitSha ?? null,
			axisOffset: pos.axisOffset,
			crossOffset: pos.crossOffset,
		};
		if (pos.panelExpanded !== undefined) updates.panelExpanded = pos.panelExpanded ? 1 : 0;
		if (pos.panelWidth !== undefined) updates.panelWidth = pos.panelWidth;
		if (pos.panelHeight !== undefined) updates.panelHeight = pos.panelHeight;
		await db.update(chapters).set(updates).where(eq(chapters.id, pos.chapterId));
	}

	return c.json({ ok: true });
});
