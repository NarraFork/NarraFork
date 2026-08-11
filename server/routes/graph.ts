import { and, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapterEdges, chapters, containerInstances } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
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
		narratorSubstatus: string[] | null;
		hasContainers: boolean;
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

/**
 * One degraded aspect of a graph response, so the client can say *what* is stale
 * rather than silently rendering cached numbers as if they were fresh.
 *
 * `feature`/`reason` are stable machine-readable identifiers the frontend formats
 * into its alert; `message` is prose *we* wrote. Aggregated per feature — see the
 * dedup note at the call site.
 *
 * Deliberately has no field for a raw error string. Not because of the worktree path
 * such a string usually contains — `GraphNode.data.worktreePath` publishes that to
 * the same clients anyway — but because git's stderr is unbounded output from a
 * subprocess, shaped by the user's git version, locale and config. Putting it in a
 * response means an untranslatable, arbitrarily long, arbitrarily detailed string
 * rendered verbatim in the UI, and a response size nobody budgeted. `reason` is what
 * the client actually needs: a fixed identifier it can translate and act on.
 *
 * The detail is not lost. It goes to `logger.warn` at the call site, which is where
 * an operator diagnosing a broken repository is already looking.
 *
 * Adding a field that carries subprocess output or an exception message puts this
 * back. Name a new `reason` instead.
 */
export interface GraphFallback {
	feature: string;
	reason?: string;
	message?: string;
	/** How many chapters were affected, so a repo-wide outage is distinguishable. */
	failedChapters?: number;
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
	narratorSubstatuses: Map<string, string[]>,
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
			narratorSubstatus: narratorSubstatuses.get(ch.id) ?? null,
			hasContainers: containerPresence.has(ch.id),
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

	// Degradation is reported per feature, not per chapter: a repo-wide problem (git
	// missing, worktrees gone after a disk move) fails every active chapter at once,
	// and a few hundred identical entries would blow up a response the frontend
	// renders as a single alert. `failedChapters` carries the scale instead.
	const fallbacks: GraphFallback[] = [];
	let commitSyncFailures = 0;
	let firstCommitSyncError: string | undefined;

	// Refresh git info for active chapters with worktrees (lightweight, with concurrency limit)
	const activeChapters = projectChapters.filter((ch) => ch.status === "active" && ch.worktreePath);
	if (activeChapters.length > 0) {
		const MAX_CONCURRENT = 3;
		const refreshResults: PromiseSettledResult<void>[] = [];
		for (let i = 0; i < activeChapters.length; i += MAX_CONCURRENT) {
			const batch = activeChapters.slice(i, i + MAX_CONCURRENT);
			const batchResults = await Promise.allSettled(
				batch.map(async (ch) => {
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
					} catch (err) {
						// Still non-fatal — the cached commit count and HEAD are served as-is.
						// But it is counted, because swallowing it silently is what made the
						// `allSettled` check below dead code: this catch is inside the mapped
						// function, so nothing ever rejected and `failures` was always empty.
						commitSyncFailures += 1;
						firstCommitSyncError ??= String(err);
					}
				}),
			);
			refreshResults.push(...batchResults);
		}
		if (commitSyncFailures > 0) {
			// The error text stays here and does not go into the response; see the note on
			// `GraphFallback`.
			logger.warn("Graph served stale git metadata for some chapters", {
				projectId,
				failedChapters: commitSyncFailures,
				error: firstCommitSyncError,
			});
			fallbacks.push({
				feature: "graph.commitSync",
				reason: "commit_sync_refresh_failed",
				failedChapters: commitSyncFailures,
			});
		}
		// Reserved for a rejection the per-chapter catch could not see (e.g. the DB
		// write-back below it throwing). Raised to warn: the user is looking at a
		// stale commit count and HEAD, which debug-level logging never revealed.
		const failures = refreshResults.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		if (failures.length > 0) {
			logger.warn("Some graph git refreshes failed", {
				projectId,
				failCount: failures.length,
				error: String(failures[0]?.reason),
			});
			fallbacks.push({
				feature: "graph.gitMetadata",
				reason: "git_metadata_refresh_failed",
				failedChapters: failures.length,
			});
		}
	}

	// Get graph metadata once chapter IDs are known.
	const chapterIds = projectChapters.map((ch) => ch.id);
	const [allNarrators, allContainers, edgeRows, openedTerminals] = await Promise.all([
		chapterIds.length
			? db.query.narrators.findMany({
					where: (n, { inArray }) => inArray(n.chapterId, chapterIds),
					columns: { id: true, chapterId: true, status: true, substatus: true },
				})
			: Promise.resolve([]),
		chapterIds.length
			? db
					.select({ chapterId: containerInstances.chapterId })
					.from(containerInstances)
					.where(
						and(
							inArray(containerInstances.chapterId, chapterIds),
							ne(containerInstances.status, "removed"),
						),
					)
					.groupBy(containerInstances.chapterId)
					.all()
			: Promise.resolve([]),
		db.select().from(chapterEdges).where(eq(chapterEdges.projectId, projectId)).all(),
		chapterIds.length
			? db.query.terminals.findMany({
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
			: Promise.resolve([]),
	]);

	const narratorCounts = new Map<string, number>();
	const narratorIds = new Map<string, string>();
	const narratorStatuses = new Map<string, string>();
	const narratorSubstatuses = new Map<string, string[]>();
	for (const n of allNarrators) {
		if (n.chapterId) {
			narratorCounts.set(n.chapterId, (narratorCounts.get(n.chapterId) ?? 0) + 1);
			// Keep the first narrator ID and status per chapter
			if (!narratorIds.has(n.chapterId)) {
				narratorIds.set(n.chapterId, n.id);
				if (n.status) narratorStatuses.set(n.chapterId, n.status);
				narratorSubstatuses.set(n.chapterId, parseSubstatus(n.substatus));
			}
		}
	}

	const containerPresence = new Set<string>();
	for (const ci of allContainers) {
		containerPresence.add(ci.chapterId);
	}

	// Build graph
	const { nodes, edges } = buildGraph(
		projectChapters,
		narratorCounts,
		narratorIds,
		narratorStatuses,
		narratorSubstatuses,
		containerPresence,
		edgeRows,
	);

	// No `explorationGroups` here: the rows were queried on every graph request and
	// returned, but nothing rendered them, and the frontend type even declared a
	// `chapterIds` field this endpoint never sent. The table and its validators stay for
	// the schema; reviving the feature means adding the query back next to a real reader.
	return c.json({
		nodes,
		edges,
		openedTerminals,
		degraded: fallbacks.length > 0,
		fallbacks,
	});
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

	db.transaction((tx) => {
		for (const pos of parsed.data.positions) {
			const updates: Record<string, unknown> = {
				anchorCommitSha: pos.anchorCommitSha ?? null,
				axisOffset: pos.axisOffset,
				crossOffset: pos.crossOffset,
			};
			if (pos.panelExpanded !== undefined) updates.panelExpanded = pos.panelExpanded ? 1 : 0;
			if (pos.panelWidth !== undefined) updates.panelWidth = pos.panelWidth;
			if (pos.panelHeight !== undefined) updates.panelHeight = pos.panelHeight;
			tx.update(chapters).set(updates).where(eq(chapters.id, pos.chapterId)).run();
		}
	});

	return c.json({ ok: true });
});
