import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapterEdges, chapters, narrators, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import {
	forkChapterSchema,
	rulerAbandonSchema,
	rulerMergeSchema,
	updateRulerPositionsSchema,
} from "../lib/validators";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
import { gitService } from "../services/git-service";

export const rulerRoutes = new Hono();

// GET /:id/ruler — Main ruler data (commit backbone + segments + active chapters)
rulerRoutes.get("/:id/ruler", async (c) => {
	const projectId = c.req.param("id");
	const limitParam = c.req.query("limit");
	const skipParam = c.req.query("skip");
	const cursor = c.req.query("cursor");
	const direction = c.req.query("direction") as "older" | "newer" | undefined;
	const limit = limitParam ? Number.parseInt(limitParam, 10) : 200;
	let skip = skipParam ? Number.parseInt(skipParam, 10) : 0;

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project) throw new NotFoundError("Project", projectId);
	if (!project.gitPath) return c.json({ commits: [], segments: [], activeChapters: [] });

	// Get main branch commit log
	const branch = project.defaultBranch ?? "main";
	const totalCommitCount = await gitService.getCommitCount(project.gitPath, branch);

	// Cursor-based pagination: use git rev-list to find cursor's absolute position
	if (cursor) {
		try {
			// Count commits between cursor and branch HEAD to get cursor's position
			const countAfterCursor = await gitService.getCommitCount(
				project.gitPath,
				`${cursor}..${branch}`,
			);
			// In git log order (newest first), cursor is at index = countAfterCursor
			const cursorIndex = countAfterCursor;
			if (direction === "older") {
				skip = cursorIndex + 1;
			} else if (direction === "newer") {
				skip = Math.max(0, cursorIndex - limit);
			} else {
				skip = cursorIndex;
			}
		} catch {
			// If cursor SHA is invalid or not reachable, fall back to skip-based loading
		}
	}

	const commits = await gitService.getLog(project.gitPath, {
		limit,
		skip,
		branch,
	});

	// Build a SHA set for fast lookup
	const commitShaSet = new Set(commits.map((co) => co.sha));

	// Get all non-root chapters for this project
	const projectChapters = await db.query.chapters.findMany({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 0)),
		columns: {
			id: true,
			title: true,
			status: true,
			branch: true,
			role: true,
			startCommitSha: true,
			mergeCommitSha: true,
		},
	});

	// Get active chapter narrator info
	const activeChapterIds = projectChapters
		.filter((ch) => ch.status === "active")
		.map((ch) => ch.id);

	let narratorMap = new Map<string, { id: string; status: string }>();
	if (activeChapterIds.length > 0) {
		const chapterNarrators = await db.query.narrators.findMany({
			where: and(inArray(narrators.chapterId, activeChapterIds), eq(narrators.type, "primary")),
			columns: { id: true, chapterId: true, status: true },
		});
		narratorMap = new Map(
			chapterNarrators
				.filter((n) => n.chapterId)
				.map((n) => [n.chapterId!, { id: n.id, status: n.status }]),
		);
	}

	// Compute segments: find commit ranges that have chapters
	// A chapter belongs to the segment containing its startCommitSha
	const chaptersByStartSha = new Map<string, typeof projectChapters>();
	for (const ch of projectChapters) {
		if (ch.startCommitSha && commitShaSet.has(ch.startCommitSha)) {
			const list = chaptersByStartSha.get(ch.startCommitSha) ?? [];
			list.push(ch);
			chaptersByStartSha.set(ch.startCommitSha, list);
		}
	}

	// Build segments between consecutive commits that have chapters
	const segments: Array<{
		fromSha: string;
		toSha: string;
		fromIndex: number;
		toIndex: number;
		activeChapterCount: number;
		totalChapterCount: number;
		activeChapterIds: string[];
		isExpandable: boolean;
	}> = [];

	// For each commit that has chapters starting from it, create a segment
	// The segment spans from this commit to the next commit (or end)
	for (let i = 0; i < commits.length; i++) {
		const sha = commits[i].sha;
		const chaptersAtSha = chaptersByStartSha.get(sha);
		if (!chaptersAtSha || chaptersAtSha.length === 0) continue;

		const toIndex = i > 0 ? i - 1 : i; // segments go forward in time (older → newer)
		const toSha = commits[toIndex]?.sha ?? sha;
		const activeCount = chaptersAtSha.filter((ch) => ch.status === "active").length;
		const activeIds = chaptersAtSha.filter((ch) => ch.status === "active").map((ch) => ch.id);

		segments.push({
			fromSha: sha,
			toSha,
			fromIndex: i,
			toIndex,
			activeChapterCount: activeCount,
			totalChapterCount: chaptersAtSha.length,
			activeChapterIds: activeIds,
			isExpandable: chaptersAtSha.length > 0,
		});
	}

	// Build active chapters summary
	const activeChapters = projectChapters
		.filter((ch) => ch.status === "active")
		.map((ch) => {
			const narrator = narratorMap.get(ch.id);
			return {
				id: ch.id,
				title: ch.title,
				branch: ch.branch,
				role: ch.role,
				startCommitSha: ch.startCommitSha,
				narratorId: narrator?.id ?? null,
				narratorStatus: narrator?.status ?? null,
			};
		});

	return c.json({
		commits,
		segments,
		activeChapters,
		totalCommitCount,
		oldestLoadedIndex: skip,
		newestLoadedIndex: skip + commits.length - 1,
	});
});

// GET /:id/ruler/segment — Load segment detail (chapters within a commit range)
rulerRoutes.get("/:id/ruler/segment", async (c) => {
	const projectId = c.req.param("id");
	const fromSha = c.req.query("from");
	const _toSha = c.req.query("to");
	const detail = (c.req.query("detail") ?? "full") as "summary" | "full";

	if (!fromSha) return c.json({ chapters: [], edges: [] });

	if (detail === "summary") {
		// Lightweight: id, title, status, role, narrator status + layout position
		const projectChapters = await db.query.chapters.findMany({
			where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 0)),
			columns: {
				id: true,
				title: true,
				status: true,
				role: true,
				startCommitSha: true,
				anchorCommitSha: true,
				axisOffset: true,
				crossOffset: true,
			},
		});
		const segmentChapters = projectChapters.filter((ch) => ch.startCommitSha === fromSha);
		const chapterIds = segmentChapters.map((ch) => ch.id);

		let narratorMap = new Map<string, string>();
		if (chapterIds.length > 0) {
			const chapterNarrators = await db.query.narrators.findMany({
				where: and(inArray(narrators.chapterId, chapterIds), eq(narrators.type, "primary")),
				columns: { chapterId: true, status: true },
			});
			narratorMap = new Map(
				chapterNarrators.filter((n) => n.chapterId).map((n) => [n.chapterId!, n.status]),
			);
		}

		return c.json({
			chapters: segmentChapters.map((ch) => ({
				id: ch.id,
				title: ch.title,
				status: ch.status,
				role: ch.role,
				narratorStatus: narratorMap.get(ch.id) ?? null,
				anchorCommitSha: ch.anchorCommitSha ?? ch.startCommitSha ?? null,
				axisOffset: ch.axisOffset ?? 0,
				crossOffset: ch.crossOffset ?? 0,
			})),
			edges: [],
		});
	}

	// detail === "full" — existing behavior

	// Get chapters whose startCommitSha matches the segment range
	const projectChapters = await db.query.chapters.findMany({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 0)),
		columns: {
			id: true,
			title: true,
			status: true,
			branch: true,
			role: true,
			startCommitSha: true,
			mergeCommitSha: true,
			headCommitSha: true,
			anchorCommitSha: true,
			axisOffset: true,
			crossOffset: true,
			panelWidth: true,
			panelHeight: true,
			color: true,
			reviewSourceChapterId: true,
			reviewStatus: true,
		},
	});

	// Filter to chapters in this segment (startCommitSha == fromSha)
	const segmentChapters = projectChapters.filter((ch) => ch.startCommitSha === fromSha);
	const chapterIds = segmentChapters.map((ch) => ch.id);

	// Get narrator info
	let narratorMap = new Map<string, { id: string; status: string }>();
	if (chapterIds.length > 0) {
		const chapterNarrators = await db.query.narrators.findMany({
			where: and(inArray(narrators.chapterId, chapterIds), eq(narrators.type, "primary")),
			columns: { id: true, chapterId: true, status: true },
		});
		narratorMap = new Map(
			chapterNarrators
				.filter((n) => n.chapterId)
				.map((n) => [n.chapterId!, { id: n.id, status: n.status }]),
		);
	}

	// Get edges between these chapters
	let edges: Array<{
		id: string;
		sourceId: string;
		targetId: string;
		type: string;
	}> = [];
	if (chapterIds.length > 0) {
		edges = await db.query.chapterEdges.findMany({
			where: and(eq(chapterEdges.projectId, projectId), inArray(chapterEdges.sourceId, chapterIds)),
			columns: { id: true, sourceId: true, targetId: true, type: true },
		});
	}

	const result = segmentChapters.map((ch) => {
		const narrator = narratorMap.get(ch.id);
		return {
			id: ch.id,
			title: ch.title,
			status: ch.status,
			branch: ch.branch,
			role: ch.role,
			startCommitSha: ch.startCommitSha,
			mergeCommitSha: ch.mergeCommitSha,
			headCommitSha: ch.headCommitSha,
			color: ch.color,
			narratorId: narrator?.id ?? null,
			narratorStatus: narrator?.status ?? null,
			reviewSourceChapterId: ch.reviewSourceChapterId,
			reviewStatus: ch.reviewStatus,
			anchorCommitSha: ch.anchorCommitSha ?? ch.startCommitSha ?? null,
			axisOffset: ch.axisOffset ?? 0,
			crossOffset: ch.crossOffset ?? 0,
			panelWidth: ch.panelWidth ?? null,
			panelHeight: ch.panelHeight ?? null,
		};
	});

	return c.json({ chapters: result, edges });
});

// PATCH /:id/ruler/positions — Save node positions within segments
rulerRoutes.patch("/:id/ruler/positions", async (c) => {
	const projectId = c.req.param("id");
	const parsed = updateRulerPositionsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { positions } = parsed.data;

	for (const pos of positions) {
		const updates: Record<string, unknown> = {
			anchorCommitSha: pos.anchorCommitSha,
			axisOffset: pos.axisOffset,
			crossOffset: pos.crossOffset,
		};
		if (pos.width != null) updates.panelWidth = pos.width;
		if (pos.height != null) updates.panelHeight = pos.height;
		await db
			.update(chapters)
			.set(updates)
			.where(and(eq(chapters.id, pos.chapterId), eq(chapters.projectId, projectId)));
	}

	return c.json({ success: true });
});

// POST /:id/ruler/fork — Fork from a specific commit (trunk or sub-branch)
rulerRoutes.post("/:id/ruler/fork", async (c) => {
	const projectId = c.req.param("id");
	const parsed = forkChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const body = parsed.data;

	if (!body.startCommitSha) {
		throw new ValidationError("startCommitSha is required for ruler fork");
	}

	// parentChapterId can be passed explicitly (sub-ruler fork) or defaults to root
	const parentChapterId = body.parentChapterId;

	let parentId: string;
	if (parentChapterId) {
		const parent = await db.query.chapters.findFirst({
			where: and(eq(chapters.id, parentChapterId), eq(chapters.projectId, projectId)),
		});
		if (!parent) throw new NotFoundError("Chapter", parentChapterId);
		parentId = parent.id;
	} else {
		const rootChapter = await db.query.chapters.findFirst({
			where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 1)),
		});
		if (!rootChapter) throw new NotFoundError("Root chapter for project", projectId);
		parentId = rootChapter.id;
	}

	const result = await chapterFork.fork(parentId, {
		...body,
		inheritMode: body.inheritMode ?? "fresh",
	});

	return c.json(result, 201);
});

// POST /:id/ruler/merge — Merge a chapter back to trunk (freeze on merge)
rulerRoutes.post("/:id/ruler/merge", async (c) => {
	const projectId = c.req.param("id");
	const parsed = rulerMergeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { sourceChapterId, strategy, message } = parsed.data;

	// Find root chapter as merge target
	const rootChapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 1)),
	});
	if (!rootChapter) throw new NotFoundError("Root chapter for project", projectId);

	// Execute merge
	const result = await chapterMerge.merge(sourceChapterId, {
		targetChapterId: rootChapter.id,
		strategy: strategy ?? "merge",
		message,
	});

	if (!result.success) {
		return c.json(result, 409);
	}

	// Ruler mode: also delete the git branch after merge (freeze completely)
	const source = await db.query.chapters.findFirst({
		where: eq(chapters.id, sourceChapterId),
	});
	if (source) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, projectId),
		});
		if (project?.gitPath && source.branch) {
			try {
				await gitService.deleteBranch(project.gitPath, source.branch);
			} catch {
				// Branch may already be deleted or not exist
			}
		}
	}

	return c.json(result);
});

// POST /:id/ruler/abandon — Abandon a chapter (delete worktree + branch)
rulerRoutes.post("/:id/ruler/abandon", async (c) => {
	const projectId = c.req.param("id");
	const parsed = rulerAbandonSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { chapterId } = parsed.data;

	// Verify chapter belongs to this project
	const chapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
	});
	if (!chapter) throw new NotFoundError("Chapter", chapterId);
	if (chapter.status !== "active") throw new ValidationError("Can only abandon active chapters");

	await chapterService.remove(chapterId);

	return c.json({ success: true });
});
