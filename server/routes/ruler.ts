import { formatOriginLabel } from "@shared/message-origin";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapterEdges, chapters, narrators, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { parseSubstatus } from "../lib/narrator-utils";
import { getPrompt, getUserLanguage, type Locale } from "../lib/prompt-i18n";

/**
 * Resolve a narrator's effective display status for the Ruler view.
 * Merges status + substatus into a single string that Pixi can color-map directly.
 * e.g. idle + ["unread"] → "unread", idle + ["error"] → "error", working → "working"
 *
 * NOTE: This only maps persistent substatus tags (error/suspended/manual_override/interrupted/unread).
 * Transient tags (reasoning/compacting/queued etc.) are irrelevant for the Ruler's
 * coarse-grained Pixi rendering. The frontend status-registry.ts handles the full
 * priority list for the detailed narrator panel view.
 */
function resolveNarratorDisplayStatus(status: string, substatusRaw?: string | null): string {
	const sub = parseSubstatus(substatusRaw);
	if (sub.includes("reflecting")) return "reflecting";
	if (status === "working" || status === "waiting") return status;
	if (status !== "idle") return status;
	// Priority: error > suspended > manual_override > interrupted > unread
	if (sub.includes("error")) return "error";
	if (sub.includes("suspended")) return "suspended";
	if (sub.includes("manual_override")) return "manual_override";
	if (sub.includes("interrupted")) return "interrupted";
	if (sub.includes("unread")) return "unread";
	return status;
}

/**
 * Whether the narrator is parked until an unavailable model recovers.
 *
 * Reported as a separate flag rather than folded into the display status because
 * the Pixi card paints `narratorStatus` as raw text (and measures it for card
 * width) with no i18n available, so the status string must stay short and
 * stable. The flag only drives color and offscreen-bubble suppression: this wait
 * is not actionable, so it must not use the attention hue or raise a bubble.
 */
function resolveNarratorModelUnavailable(substatusRaw?: string | null): boolean {
	return parseSubstatus(substatusRaw).includes("model_unavailable");
}

function hasChapterId<T extends { chapterId: string | null }>(
	narrator: T,
): narrator is T & { chapterId: string } {
	return Boolean(narrator.chapterId);
}

import {
	forkChapterSchema,
	rulerAbandonSchema,
	rulerMergeSchema,
	rulerRebaseResolveSchema,
	rulerRebaseSchema,
	updateRulerPositionsSchema,
} from "../lib/validators";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
import { commitSyncService } from "../services/commit-sync-service";
import { gitService } from "../services/git-service";
import { narratorService } from "../services/narrator-service";
import { sendMessage } from "../services/narrator-session";

/**
 * Check if a chapter belongs to a segment (identified by `targetSha`) by walking
 * up the parentChapterId chain. Returns true if the chapter's own startCommitSha
 * matches, or if any ancestor's startCommitSha matches.
 */
function chapterBelongsToSegment(
	ch: { startCommitSha: string | null; parentChapterId: string | null },
	targetSha: string,
	byId: Map<string, { startCommitSha: string | null; parentChapterId: string | null }>,
): boolean {
	if (ch.startCommitSha === targetSha) return true;
	const visited = new Set<string>();
	let cur = ch;
	while (cur.parentChapterId && !visited.has(cur.parentChapterId)) {
		visited.add(cur.parentChapterId);
		const parent = byId.get(cur.parentChapterId);
		if (!parent) break;
		if (parent.startCommitSha === targetSha) return true;
		cur = parent;
	}
	return false;
}

/** Commits per page when the client does not ask; matches the frontend's own default. */
const DEFAULT_COMMIT_LIMIT = 200;

/**
 * Hard ceiling on commits per request.
 *
 * `limit` reaches `gitService.getLog` as `--max-count`, so an unclamped value lets any
 * caller ask git to walk an entire repository's history and serialize it into one JSON
 * response — a slow `git log` subprocess plus an unbounded body, which is exactly the
 * "no upper bound on a list API" failure mode. The frontend never requests more than
 * `DEFAULT_COMMIT_LIMIT`; the extra headroom is only so a deliberate deep-link cannot
 * be capped below what the UI itself would ask for.
 */
const MAX_COMMIT_LIMIT = 1000;

/**
 * Parse a non-negative integer query parameter, falling back on anything unusable.
 *
 * `Number.parseInt` is lenient in ways that matter here: `?limit=abc` and
 * `?limit=Infinity` both yield NaN (it stops at the first non-digit), `?limit=-5` yields
 * a negative, and `?limit=50.9` a fraction. These reach a git subprocess and the
 * response's index arithmetic, where each fails differently: `--max-count=NaN` aborts
 * `git log` outright ("not an integer"), while a negative `--skip` is quietly ACCEPTED
 * by git and instead corrupts the `oldestLoadedIndex`/`newestLoadedIndex` the client
 * pages against. Coerce, then clamp, so neither path can see a bad value.
 */
function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number) {
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	// Also rejects ±Infinity: parseInt never produces it, but Number.isFinite keeps this
	// correct if the coercion is ever swapped for Number().
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export const rulerRoutes = new Hono();

// GET /:id/ruler — Main ruler data (commit backbone + segments + active chapters)
rulerRoutes.get("/:id/ruler", async (c) => {
	const projectId = c.req.param("id");
	const cursor = c.req.query("cursor");
	const direction = c.req.query("direction") as "older" | "newer" | undefined;
	// Minimum of 1: `--max-count=0` returns no commits at all, which the segment/index
	// arithmetic below would report as an empty backbone rather than a bad request.
	const limit = parseBoundedInt(c.req.query("limit"), DEFAULT_COMMIT_LIMIT, 1, MAX_COMMIT_LIMIT);
	// `skip` needs no upper bound — an offset past HEAD is a legitimately empty page, and
	// git does the walking — but it must not go negative: git accepts that silently and
	// the reported `oldestLoadedIndex`/`newestLoadedIndex` would then be wrong.
	// MAX_SAFE_INTEGER only keeps the arithmetic below exact.
	let skip = parseBoundedInt(c.req.query("skip"), 0, 0, Number.MAX_SAFE_INTEGER);

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project) throw new NotFoundError("Project", projectId);
	if (!project.gitPath) return c.json({ commits: [], segments: [], activeChapters: [] });

	// Get main branch commit log
	const branch = project.defaultBranch ?? "main";
	const totalCommitCountPromise = gitService.getCommitCount(project.gitPath, branch);

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

	const [totalCommitCount, commits] = await Promise.all([
		totalCommitCountPromise,
		gitService.getLog(project.gitPath, {
			limit,
			skip,
			branch,
		}),
	]);

	// Build a SHA set for fast lookup
	const commitShaSet = new Set(commits.map((co) => co.sha));

	// Get all non-root chapters for this project.
	//
	// Deliberately UNPAGINATED: `resolveEffectiveSha` walks each chapter's
	// parentChapterId chain to find an ancestor on the backbone, so a truncated set
	// would silently drop chapters whose parent fell outside the page. Bounded instead
	// by the `columns` projection (no large fields) and by chapters-per-project, which
	// is human-scale. The commit log is the side that pages.
	const projectChapters = await db.query.chapters.findMany({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 0)),
		columns: {
			id: true,
			title: true,
			status: true,
			branch: true,
			role: true,
			parentChapterId: true,
			startCommitSha: true,
			mergeCommitSha: true,
			axisOffset: true,
			crossOffset: true,
		},
	});

	// Get active chapter narrator info
	const activeChapterIds = projectChapters
		.filter((ch) => ch.status === "active")
		.map((ch) => ch.id);

	let narratorMap = new Map<string, { id: string; status: string; modelUnavailable: boolean }>();
	if (activeChapterIds.length > 0) {
		const chapterNarrators = await db.query.narrators.findMany({
			where: and(inArray(narrators.chapterId, activeChapterIds), eq(narrators.variant, "primary")),
			columns: { id: true, chapterId: true, status: true, substatus: true },
		});
		narratorMap = new Map(
			chapterNarrators.filter(hasChapterId).map((n) => [
				n.chapterId,
				{
					id: n.id,
					status: resolveNarratorDisplayStatus(n.status, n.substatus),
					modelUnavailable: resolveNarratorModelUnavailable(n.substatus),
				},
			]),
		);
	}

	// Resolve effective startCommitSha for chapters whose own startCommitSha
	// is not on the main branch (e.g. forked from a sub-branch commit).
	// Walk up the parentChapterId chain to find an ancestor on the backbone.
	const chapterById = new Map(projectChapters.map((ch) => [ch.id, ch]));
	function resolveEffectiveSha(ch: (typeof projectChapters)[number]): string | null {
		if (ch.startCommitSha && commitShaSet.has(ch.startCommitSha)) return ch.startCommitSha;
		const visited = new Set<string>();
		let cur = ch;
		while (cur.parentChapterId && !visited.has(cur.parentChapterId)) {
			visited.add(cur.parentChapterId);
			const parent = chapterById.get(cur.parentChapterId);
			if (!parent) break;
			if (parent.startCommitSha && commitShaSet.has(parent.startCommitSha)) {
				return parent.startCommitSha;
			}
			cur = parent;
		}
		return null;
	}

	// Compute segments: find commit ranges that have chapters
	// A chapter belongs to the segment containing its effective startCommitSha
	const chaptersByStartSha = new Map<string, typeof projectChapters>();
	for (const ch of projectChapters) {
		const sha = resolveEffectiveSha(ch);
		if (sha) {
			const list = chaptersByStartSha.get(sha) ?? [];
			list.push(ch);
			chaptersByStartSha.set(sha, list);
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
				parentChapterId: ch.parentChapterId ?? null,
				startCommitSha: ch.startCommitSha,
				narratorId: narrator?.id ?? null,
				narratorStatus: narrator?.status ?? null,
				narratorModelUnavailable: narrator?.modelUnavailable ?? false,
				axisOffset: ch.axisOffset ?? 0,
				crossOffset: ch.crossOffset ?? 0,
			};
		});

	// Build merged chapters summary (so they are always visible without waiting
	// for SegmentCanvas async loads — fixes disappearing merged chapters on re-mount)
	const mergedChapters = projectChapters
		.filter((ch) => ch.status === "merged")
		.map((ch) => ({
			id: ch.id,
			title: ch.title,
			branch: ch.branch,
			role: ch.role,
			parentChapterId: ch.parentChapterId ?? null,
			startCommitSha: ch.startCommitSha,
			mergeCommitSha: ch.mergeCommitSha,
			narratorId: null as string | null,
			narratorStatus: null as string | null,
			narratorModelUnavailable: false,
			axisOffset: ch.axisOffset ?? 0,
			crossOffset: ch.crossOffset ?? 0,
		}));

	return c.json({
		commits,
		segments,
		activeChapters,
		mergedChapters,
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
	// Compared against "summary" below, so any unrecognised value falls through to the
	// "full" branch. Nothing here reaches git or a LIMIT, so an odd value costs at most
	// the wider column projection — no clamping needed, unlike the commit log above.
	const detail = (c.req.query("detail") ?? "full") as "summary" | "full";

	if (!fromSha) return c.json({ chapters: [], edges: [] });

	if (detail === "summary") {
		// Lightweight: id, title, status, role, narrator status + layout position.
		// Unpaginated for the same reason as the main endpoint: `chapterBelongsToSegment`
		// needs the full parentChapterId chain to decide membership.
		const projectChapters = await db.query.chapters.findMany({
			where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 0)),
			columns: {
				id: true,
				title: true,
				status: true,
				role: true,
				parentChapterId: true,
				startCommitSha: true,
				anchorCommitSha: true,
				axisOffset: true,
				crossOffset: true,
			},
		});

		// Resolve chapters to this segment via parent-chain fallback
		const byId = new Map(projectChapters.map((ch) => [ch.id, ch]));
		const segmentChapters = projectChapters.filter((ch) =>
			chapterBelongsToSegment(ch, fromSha, byId),
		);
		const chapterIds = segmentChapters.map((ch) => ch.id);

		let narratorMap = new Map<string, { status: string; modelUnavailable: boolean }>();
		if (chapterIds.length > 0) {
			const chapterNarrators = await db.query.narrators.findMany({
				where: and(inArray(narrators.chapterId, chapterIds), eq(narrators.variant, "primary")),
				columns: { chapterId: true, status: true, substatus: true },
			});
			narratorMap = new Map(
				chapterNarrators.filter(hasChapterId).map((n) => [
					n.chapterId,
					{
						status: resolveNarratorDisplayStatus(n.status, n.substatus),
						modelUnavailable: resolveNarratorModelUnavailable(n.substatus),
					},
				]),
			);
		}

		return c.json({
			chapters: segmentChapters.map((ch) => ({
				id: ch.id,
				title: ch.title,
				status: ch.status,
				role: ch.role,
				narratorStatus: narratorMap.get(ch.id)?.status ?? null,
				narratorModelUnavailable: narratorMap.get(ch.id)?.modelUnavailable ?? false,
				anchorCommitSha: ch.anchorCommitSha ?? ch.startCommitSha ?? null,
				axisOffset: ch.axisOffset ?? 0,
				crossOffset: ch.crossOffset ?? 0,
			})),
			edges: [],
		});
	}

	// detail === "full" — existing behavior

	// Get chapters whose startCommitSha matches the segment range.
	// Unpaginated by design (full parent chain required); the projection keeps large
	// columns out of the response.
	const projectChapters = await db.query.chapters.findMany({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 0)),
		columns: {
			id: true,
			title: true,
			status: true,
			branch: true,
			role: true,
			parentChapterId: true,
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

	// Filter to chapters in this segment — includes parent-chain fallback
	const fullById = new Map(projectChapters.map((ch) => [ch.id, ch]));
	const segmentChapters = projectChapters.filter((ch) =>
		chapterBelongsToSegment(ch, fromSha, fullById),
	);
	const chapterIds = segmentChapters.map((ch) => ch.id);

	const [chapterNarrators, edges] = chapterIds.length
		? await Promise.all([
				db.query.narrators.findMany({
					where: and(inArray(narrators.chapterId, chapterIds), eq(narrators.variant, "primary")),
					columns: { id: true, chapterId: true, status: true, substatus: true },
				}),
				db.query.chapterEdges.findMany({
					where: and(
						eq(chapterEdges.projectId, projectId),
						inArray(chapterEdges.sourceId, chapterIds),
					),
					columns: { id: true, sourceId: true, targetId: true, type: true },
				}),
			])
		: [[], []];

	const narratorMap = new Map(
		chapterNarrators.filter(hasChapterId).map((n) => [
			n.chapterId,
			{
				id: n.id,
				status: resolveNarratorDisplayStatus(n.status, n.substatus),
				modelUnavailable: resolveNarratorModelUnavailable(n.substatus),
			},
		]),
	);

	const result = segmentChapters.map((ch) => {
		const narrator = narratorMap.get(ch.id);
		return {
			id: ch.id,
			title: ch.title,
			status: ch.status,
			branch: ch.branch,
			role: ch.role,
			parentChapterId: ch.parentChapterId ?? null,
			startCommitSha: ch.startCommitSha,
			mergeCommitSha: ch.mergeCommitSha,
			headCommitSha: ch.headCommitSha,
			color: ch.color,
			narratorId: narrator?.id ?? null,
			narratorStatus: narrator?.status ?? null,
			narratorModelUnavailable: narrator?.modelUnavailable ?? false,
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

	db.transaction((tx) => {
		for (const pos of positions) {
			const updates: Record<string, unknown> = {
				anchorCommitSha: pos.anchorCommitSha,
				axisOffset: pos.axisOffset,
				crossOffset: pos.crossOffset,
			};
			if (pos.width != null) updates.panelWidth = pos.width;
			if (pos.height != null) updates.panelHeight = pos.height;
			tx.update(chapters)
				.set(updates)
				.where(and(eq(chapters.id, pos.chapterId), eq(chapters.projectId, projectId)))
				.run();
		}
	});

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
	if (!rootChapter.worktreePath) {
		throw new ValidationError("Root chapter has no worktree");
	}

	const source = await db.query.chapters.findFirst({
		where: and(eq(chapters.id, sourceChapterId), eq(chapters.projectId, projectId)),
	});
	if (!source) throw new NotFoundError("Chapter", sourceChapterId);

	// Only the commit-based merge needs clean worktrees: it reads branch tips, so
	// uncommitted work would be dropped. The default snapshot merge operates on the
	// workspaces themselves, where being dirty is normal.
	if (parsed.data.mode === "commit") {
		const trunkStatus = await gitService.getStatus(rootChapter.worktreePath);
		if (trunkStatus.trim()) {
			return c.json({ error: "MERGE_DIRTY_TRUNK", code: "VALIDATION_ERROR" }, 400);
		}
		if (source.worktreePath) {
			const sourceStatus = await gitService.getStatus(source.worktreePath);
			if (sourceStatus.trim()) {
				return c.json({ error: "MERGE_DIRTY_SOURCE", code: "VALIDATION_ERROR" }, 400);
			}
		}
	}

	const mergeStrategy = strategy ?? "merge";

	// Execute merge
	const result = await chapterMerge.merge(sourceChapterId, {
		targetChapterId: rootChapter.id,
		strategy: mergeStrategy,
		message,
		mode: parsed.data.mode,
	});

	if (result.success) {
		// Ruler mode: delete the source git branch after merge
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, projectId),
		});
		if (project?.gitPath && source.branch) {
			try {
				await gitService.deleteBranch(project.gitPath, source.branch);
			} catch {
				// Branch may already be deleted
			}
		}
		return c.json(result);
	}

	// Conflict detected — attempt AI resolution via temporary chapter
	if (result.conflictFiles?.length) {
		const userId = c.get("user").sub;
		const locale = await getUserLanguage(userId);

		const aiResult = await chapterMerge.rulerAiResolve(sourceChapterId, rootChapter.id, {
			strategy: mergeStrategy,
			message,
			locale,
			userId,
		});

		if (aiResult.resolved) {
			// AI resolved — delete source branch (Ruler-specific)
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, projectId),
			});
			if (project?.gitPath && source.branch) {
				try {
					await gitService.deleteBranch(project.gitPath, source.branch);
				} catch {
					// Branch may already be deleted
				}
			}
			return c.json({
				...aiResult.mergeResult,
				aiResolved: true,
				resolvedConflictFiles: result.conflictFiles,
			});
		}

		// AI failed — return 409 with temp chapter info
		return c.json(
			{
				success: false,
				conflictFiles: result.conflictFiles,
				aiAttempted: true,
				aiError: aiResult.error,
				tempChapterId: aiResult.tempChapterId,
				remainingFiles: aiResult.remainingFiles,
			},
			409,
		);
	}

	return c.json(result, 409);
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

// POST /:id/ruler/rebase — Rebase a chapter onto trunk
rulerRoutes.post("/:id/ruler/rebase", async (c) => {
	const projectId = c.req.param("id");
	const parsed = rulerRebaseSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { chapterId } = parsed.data;

	// Find root chapter (trunk)
	const rootChapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 1)),
	});
	if (!rootChapter) throw new NotFoundError("Root chapter for project", projectId);

	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	if (!project?.gitPath) throw new ValidationError("Project has no git path");

	const trunkBranch = project.defaultBranch ?? "main";

	// Verify source chapter
	const chapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
	});
	if (!chapter) throw new NotFoundError("Chapter", chapterId);
	if (chapter.status !== "active") throw new ValidationError("Can only rebase active chapters");
	if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

	// Dirty check
	const status = await gitService.getStatus(chapter.worktreePath);
	if (status.trim()) {
		return c.json({ error: "REBASE_DIRTY_SOURCE", code: "VALIDATION_ERROR" }, 400);
	}

	// Also check trunk worktree is clean
	if (rootChapter.worktreePath) {
		const trunkStatus = await gitService.getStatus(rootChapter.worktreePath);
		if (trunkStatus.trim()) {
			return c.json({ error: "REBASE_DIRTY_TRUNK", code: "VALIDATION_ERROR" }, 400);
		}
	}

	// Execute rebase
	const result = await gitService.rebase(chapter.worktreePath, trunkBranch);

	if (result.success) {
		// Update chapter SHAs
		const trunkHead = await gitService.getHeadCommit(project.gitPath);
		await db
			.update(chapters)
			.set({
				startCommitSha: trunkHead,
				headCommitSha: result.commitSha,
			})
			.where(eq(chapters.id, chapterId));

		// Sync commits
		await commitSyncService.syncChapterCommits(chapterId).catch(() => {});

		return c.json({ success: true, commitSha: result.commitSha });
	}

	// Conflict — return file list, worktree stays in rebase state
	return c.json({
		success: false,
		conflictFiles: result.conflictFiles,
	});
});

// POST /:id/ruler/rebase-resolve — Resolve rebase conflict (abort or let narrator handle)
rulerRoutes.post("/:id/ruler/rebase-resolve", async (c) => {
	const projectId = c.req.param("id");
	const parsed = rulerRebaseResolveSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { chapterId, action } = parsed.data;

	const chapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
	});
	if (!chapter) throw new NotFoundError("Chapter", chapterId);
	if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");

	if (action === "abort") {
		await gitService.rebaseAbort(chapter.worktreePath);
		return c.json({ success: true });
	}

	// action === "continue" — send conflict resolution message to narrator
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
	});
	const trunkBranch = project?.defaultBranch ?? "main";

	// Get or create primary narrator for this chapter
	let narrator = await db.query.narrators.findFirst({
		where: and(eq(narrators.chapterId, chapterId), eq(narrators.variant, "primary")),
	});
	if (!narrator) {
		narrator = await narratorService.create({
			chapterId,
			permissionMode: "default",
		});
	}

	// Build rebase conflict prompt
	const conflictFiles = await gitService.getConflictFilesWithLines(chapter.worktreePath);
	const fileList = conflictFiles
		.map((f) => `  - ${f.file} (${f.conflictLines} conflict(s))`)
		.join("\n");

	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);

	const prompt = getPrompt("rebaseConflictResolution", locale as Locale)
		.replace("{ontoBranch}", trunkBranch)
		.replace("{fileList}", fileList);

	// Conflict-resolution prompt built from the git state. The user triggered it,
	// so keep their id for attribution, but the text is system-generated.
	await sendMessage(
		narrator.id,
		prompt,
		undefined,
		locale as Locale,
		false,
		null,
		userId,
		undefined,
		null,
		{ origin: "system", originLabel: formatOriginLabel("rebase") },
	);

	return c.json({ success: true, narratorId: narrator.id });
});
