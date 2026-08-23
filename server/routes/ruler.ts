import { formatOriginLabel } from "@shared/message-origin";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { chapterEdges, chapters, narrators, projects } from "../db/schema";
import { worktreeLock } from "../lib/async-mutex";
import { catalogError, NotFoundError, ValidationError } from "../lib/errors";
import { resolveUserGitIdentityEnv } from "../lib/git-identity";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import { requireProjectAccess } from "../lib/project-access";
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
import {
	MAX_ANCHOR_FALLBACK_LOOKUPS,
	resolveAnchorFallbacks,
} from "../services/ruler-anchor-fallback";
import {
	type ParkedWork,
	parkUncommittedWork,
	reapplyParkedWork,
	restoreParkedWork,
	settleParkedWork,
	untrackedCollisions,
} from "../services/snapshot-dirty-git-op";
import { worktreeTreeSnapshot } from "../services/worktree-tree-snapshot";

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
 * by git and instead corrupts the `firstOffset`/`lastOffset` the client pages against.
 * Coerce, then clamp, so neither path can see a bad value.
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

/**
 * Access gate for the ruler (linear timeline) surface.
 *
 * Every endpoint is `/:id/ruler/...` where `:id` is a project id, so one middleware
 * covers all nine — including the rebase/merge/fork/abandon operations, which rewrite
 * branches and worktrees and therefore need project write.
 */
rulerRoutes.use("/:id/ruler/*", async (c, next) => {
	const projectId = c.req.param("id");
	if (!projectId) return next();
	await requireProjectAccess(c, projectId, c.req.method === "GET" ? "read" : "write");
	return next();
});

// `GET /:id/ruler` itself is not matched by the `/ruler/*` pattern above.
rulerRoutes.use("/:id/ruler", async (c, next) => {
	const projectId = c.req.param("id");
	if (!projectId) return next();
	await requireProjectAccess(c, projectId, c.req.method === "GET" ? "read" : "write");
	return next();
});

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
	// the reported `firstOffset`/`lastOffset` would then be wrong.
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

	// Cursor-based pagination: locate the cursor in the SAME walk the pages come from.
	//
	// This used to read `rev-list --count <cursor>..<branch>` and treat the result as the
	// cursor's index in `git log`. Those are different measurements: `git log` sorts by
	// commit DATE, while the range count measures a REACHABILITY set, and they diverge by
	// every commit that is dated before the cursor without being its ancestor — which is
	// what a merge produces. On this repository the first page's last commit is at log
	// index 199 while the count says 202, so `skip = 203` began the next page three commits
	// too far in and those three were never returned by any page. A chapter anchored to one
	// of them had no tick, and the Ruler reported its start commit as "not on this branch".
	if (cursor) {
		try {
			const cursorIndex = await gitService.findCommitLogIndex(project.gitPath, cursor, {
				branch,
			});
			// null = the cursor is not in this walk (rewritten history, a deleted branch, a
			// commit from another ref). Keep the requested `skip` rather than guessing an
			// offset from a position we do not have.
			if (cursorIndex != null) {
				if (direction === "older") {
					skip = cursorIndex + 1;
				} else if (direction === "newer") {
					skip = Math.max(0, cursorIndex - limit);
				} else {
					skip = cursorIndex;
				}
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
			preMergeTargetSha: true,
			// Needed because the recovery entry point is otherwise unreachable after a
			// reload: the debt lives in the row, but nothing else in the Ruler's data path
			// reads it, so a refresh made the banner vanish while the next rebase still
			// refused with REBASE_PARKED_WORK_CONFLICT. A 40-char sha is not a large field
			// in the sense the list-API rule is about (no blobs, no JSON documents), so
			// carrying it costs the projection nothing meaningful.
			parkedSnapshotCommitSha: true,
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

	/**
	 * Trunk fork points for chapters the walk above could not place.
	 *
	 * Two different situations reach here, and the client has to tell them apart:
	 * a start commit that is on the branch but not in this page (paging fixes it), and one
	 * that is no longer reachable from the branch at all because history was rewritten
	 * under the chapter — a rebase, a squash-merge, an amend. The second case is
	 * unfixable by paging, and it used to end with the Ruler dropping the chapter while
	 * advising the user to open it from the story network view, which anchors on the same
	 * sha and fails the same way.
	 *
	 * `merge-base` answers both at once: it returns the start commit itself when that
	 * commit is an ancestor of the branch, and the divergence point when it is not. See
	 * `resolveAnchorFallbacks`. Only chapters with no resolvable placement are asked
	 * about, so a healthy project spawns no git here.
	 *
	 * ## Why this is asked in two rounds
	 *
	 * `resolveAnchorFallbacks` has a hard per-request spawn budget and, past it, simply
	 * stops answering. Collecting every unplaced chapter's whole parent chain into one
	 * set made the set O(chapters × chain depth) and let the budget be consumed in Set
	 * insertion order — so a deep chain belonging to the first chapter could eat the
	 * whole allowance before a later chapter's OWN start commit was ever asked about,
	 * even though `resolveAnchorFallback` below searches bottom-up and would have
	 * answered it immediately.
	 *
	 * Round 1 therefore asks about exactly one sha per unplaced chapter: its own start
	 * commit, which is both the cheapest and the most accurate position available. Round
	 * 2 walks the parent chains, but only for the chapters round 1 could not place, and
	 * spends what is left of the SAME allowance — a total spawn count still capped at
	 * `MAX_ANCHOR_FALLBACK_LOOKUPS`, now distributed per chapter instead of per sha.
	 */
	const unplacedChapters = projectChapters.filter((ch) => !resolveEffectiveSha(ch));

	const ownStartShas = new Set<string>();
	for (const ch of unplacedChapters) {
		if (ch.startCommitSha) ownStartShas.add(ch.startCommitSha);
	}

	const anchorFallbackBySha = new Map<string, string>();
	let anchorLookupBudget = MAX_ANCHOR_FALLBACK_LOOKUPS;
	if (ownStartShas.size > 0) {
		const round = await resolveAnchorFallbacks(project.gitPath, branch, [...ownStartShas], {
			budget: anchorLookupBudget,
		});
		for (const [sha, base] of round.resolved) anchorFallbackBySha.set(sha, base);
		anchorLookupBudget -= round.spent;
	}

	// Round 2: only the chapters still unplaced need their ancestors looked at. A child
	// whose own start commit was rewritten often hangs off a parent that can still be
	// located, and the parent's fork point is a better position than none.
	if (anchorLookupBudget > 0) {
		const ancestorShas = new Set<string>();
		for (const ch of unplacedChapters) {
			if (ch.startCommitSha && anchorFallbackBySha.has(ch.startCommitSha)) continue;
			const visited = new Set<string>([ch.id]);
			let cur = ch.parentChapterId ? chapterById.get(ch.parentChapterId) : undefined;
			while (cur && !visited.has(cur.id)) {
				visited.add(cur.id);
				// Already answered (possibly as another chapter's own start commit) — asking
				// again would only spend budget to re-learn it.
				if (cur.startCommitSha && !anchorFallbackBySha.has(cur.startCommitSha)) {
					ancestorShas.add(cur.startCommitSha);
				}
				cur = cur.parentChapterId ? chapterById.get(cur.parentChapterId) : undefined;
			}
		}
		if (ancestorShas.size > 0) {
			const round = await resolveAnchorFallbacks(project.gitPath, branch, [...ancestorShas], {
				budget: anchorLookupBudget,
			});
			for (const [sha, base] of round.resolved) anchorFallbackBySha.set(sha, base);
		}
	}

	/**
	 * Where an unplaceable chapter should be drawn, and whether paging can fix it.
	 *
	 * `onBranch` distinguishes the two cases the client renders differently: true means
	 * the commit is still an ancestor of the branch and simply outside the loaded window,
	 * false means history moved and no amount of paging will produce a tick for it.
	 */
	function resolveAnchorFallback(
		ch: (typeof projectChapters)[number],
	): { sha: string; onBranch: boolean } | null {
		const visited = new Set<string>();
		let cur: (typeof projectChapters)[number] | undefined = ch;
		while (cur && !visited.has(cur.id)) {
			visited.add(cur.id);
			if (cur.startCommitSha) {
				const base = anchorFallbackBySha.get(cur.startCommitSha);
				if (base) return { sha: base, onBranch: base === cur.startCommitSha };
			}
			cur = cur.parentChapterId ? chapterById.get(cur.parentChapterId) : undefined;
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
			const fallback = resolveAnchorFallback(ch);
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
				// Same name as the rebase endpoints' field on purpose: the Ruler's recovery
				// panel reads one shape regardless of whether it learned about the debt from
				// a rebase response or from a page load.
				parkedSnapshot: ch.parkedSnapshotCommitSha ?? null,
				// Only set when nothing on the loaded backbone could place this chapter. See
				// `resolveAnchorFallback`: `startCommitOnBranch: false` means history was
				// rewritten and paging will never produce a tick, so the client must draw the
				// chapter at the fork point instead of hiding it.
				anchorFallbackSha: fallback?.sha ?? null,
				startCommitOnBranch: fallback ? fallback.onBranch : null,
				axisOffset: ch.axisOffset ?? 0,
				crossOffset: ch.crossOffset ?? 0,
			};
		});

	// Build merged chapters summary (so they are always visible without waiting
	// for SegmentCanvas async loads — fixes disappearing merged chapters on re-mount)
	const mergedChapters = projectChapters
		.filter((ch) => ch.status === "merged")
		.map((ch) => {
			const fallback = resolveAnchorFallback(ch);
			return {
				id: ch.id,
				title: ch.title,
				branch: ch.branch,
				role: ch.role,
				parentChapterId: ch.parentChapterId ?? null,
				startCommitSha: ch.startCommitSha,
				mergeCommitSha: ch.mergeCommitSha,
				// A commit-free merge produces no merge commit, so the ruler has nothing on
				// the backbone to anchor its connector to. The target's HEAD at merge time is
				// on the backbone and is the closest honest position for "this is where the
				// chapter rejoined"; without it a snapshot-merged chapter draws no connector
				// at all and reads as never merged.
				mergeAnchorCommitSha: ch.mergeCommitSha ?? ch.preMergeTargetSha ?? null,
				// Carried for every chapter the endpoint returns, not just the active ones: the
				// field is what the recovery panel keys on, and a chapter that was merged while
				// still owing a parked reapply would otherwise present as debt-free.
				parkedSnapshot: ch.parkedSnapshotCommitSha ?? null,
				narratorId: null as string | null,
				narratorStatus: null as string | null,
				narratorModelUnavailable: false,
				// See the active summary: a merged chapter whose fork point was rewritten is
				// just as unplaceable, and hiding it reads as "the merge never happened".
				anchorFallbackSha: fallback?.sha ?? null,
				startCommitOnBranch: fallback ? fallback.onBranch : null,
				axisOffset: ch.axisOffset ?? 0,
				crossOffset: ch.crossOffset ?? 0,
			};
		});

	return c.json({
		commits,
		segments,
		activeChapters,
		mergedChapters,
		totalCommitCount,
		/**
		 * Absolute `git log` offsets of this page's first and last commit.
		 *
		 * Named after the WALK, not after time, because `git log` is newest-first: offset 0
		 * is HEAD and the offset GROWS towards older history. The previous names said the
		 * opposite (`oldestLoadedIndex` for `skip`, `newestLoadedIndex` for the far end),
		 * and the client paged against those names rather than against the walk — so the
		 * first page reported "oldest = 0", `getPreviousPageParam` asked `0 > 0`, and
		 * "load older commits" was permanently unavailable. On a repository longer than one
		 * page every chapter anchored past the window then had no tick, and the Ruler told
		 * the user their start commit was "not on this branch" while offering no way to
		 * load it.
		 *
		 * `firstOffset` is what `skip` produced; `lastOffset` addresses the final commit in
		 * `commits` (equal to `firstOffset` for a single-commit page, and `firstOffset - 1`
		 * for an empty one — an offset past HEAD is a legitimately empty page).
		 */
		firstOffset: skip,
		lastOffset: skip + commits.length - 1,
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
			preMergeTargetSha: true,
			// See the main endpoint: without it the recovery entry point disappears on
			// reload while the backend still considers the reapply owed. A short sha, so it
			// does not make this a large-field projection.
			parkedSnapshotCommitSha: true,
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
			// See the merged-chapters summary above: a snapshot merge has no merge commit,
			// so the connector anchors to the target's HEAD at merge time instead.
			mergeAnchorCommitSha: ch.mergeCommitSha ?? ch.preMergeTargetSha ?? null,
			// Same field name as the rebase endpoints report, so the recovery panel has one
			// shape to read whether the debt arrived in a mutation response or a page load.
			parkedSnapshot: ch.parkedSnapshotCommitSha ?? null,
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
			// Ruler's own three columns only. It must not write graphX/graphY: those are
			// the classic canvas's absolute coordinates, and having each canvas write the
			// other's storage is what made switching views destroy the layout arranged in
			// the one you left. See `chapters.graphX` in the schema.
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
		worktreeSource: "commit",
		inheritMode: body.inheritMode ?? "fresh",
	});

	return c.json(result, 201);
});

/**
 * Delete a merged chapter's git branch — but only when the merge produced a commit.
 *
 * The Ruler deletes source branches to keep its timeline free of refs nothing points
 * at any more. That is safe for a commit merge: the source's bytes are reachable from
 * the merge commit on trunk, so the branch name carries no unique information.
 *
 * It is destructive for a snapshot (commit-free) merge, which is the DEFAULT mode here
 * — `resolveMergeMode` only leaves snapshot space when explicitly asked or when the
 * merge cannot be expressed as trees. A snapshot merge never advances the source
 * branch, and `chapterMerge.unmergeSnapshot` rebuilds the source workspace by running
 * `createWorktree` against exactly this branch before replaying
 * `mergedSourceSnapshotSha` into it. Delete the branch and `git worktree add` fails
 * with "invalid reference" — after unmerge has already reversed the target, which
 * leaves the user with a modified target, no source chapter, and uncommitted work
 * reachable only as a snapshot id in a log line.
 *
 * The obvious alternative — keep deleting and teach unmerge to recreate the branch
 * from `mergedSourceSnapshotSha` — was rejected: snapshot commits live in the shadow
 * repository, not in the user's, so there is no ref to recreate the branch from, and
 * synthesising one would put NarraFork bookkeeping commits into the user's history,
 * which is the exact thing commit-free merging exists to avoid.
 *
 * Tidiness is therefore given up in snapshot mode. If the leftover branch is visually
 * noisy, hide it in the UI: a hidden ref is recoverable, a deleted one is not.
 *
 * Which mode ran is read back from the chapter row rather than from the request: the
 * requested `mode` is only a preference, and `resolveMergeMode` silently falls back to
 * commit mode for `requireReviewBeforeMerge`, cherry-pick strategies and worktree-less
 * chapters. `mergeSnapshotCommitSha` is set exactly by the snapshot path and is the
 * same coordinate `unmerge` dispatches on, so it answers the only question that
 * matters: can an unmerge still need this branch?
 */
async function deleteMergedSourceBranch(projectId: string, sourceChapterId: string): Promise<void> {
	const [project, source] = await Promise.all([
		db.query.projects.findFirst({
			where: eq(projects.id, projectId),
			columns: { gitPath: true },
		}),
		db.query.chapters.findFirst({
			where: eq(chapters.id, sourceChapterId),
			columns: { branch: true, mergeSnapshotCommitSha: true, mergedSourceSnapshotSha: true },
		}),
	]);
	if (!project?.gitPath || !source?.branch) return;
	if (source.mergeSnapshotCommitSha || source.mergedSourceSnapshotSha) {
		logger.debug("Keeping the merged chapter's branch: a commit-free merge needs it to unmerge", {
			projectId,
			sourceChapterId,
			branch: source.branch,
		});
		return;
	}
	try {
		await gitService.deleteBranch(project.gitPath, source.branch);
	} catch (err) {
		// Not fatal — the merge already succeeded and the branch is redundant either way.
		// Logged rather than swallowed: the previous silent catch made a branch that is
		// still present indistinguishable from one that was cleanly deleted.
		logger.warn("Could not delete the merged chapter's branch", {
			projectId,
			sourceChapterId,
			branch: source.branch,
			error: String(err),
		});
	}
}

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
		if (trunkStatus.trim()) throw catalogError("MERGE_DIRTY_TRUNK");
		if (source.worktreePath) {
			const sourceStatus = await gitService.getStatus(source.worktreePath);
			if (sourceStatus.trim()) throw catalogError("MERGE_DIRTY_SOURCE");
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
		await deleteMergedSourceBranch(projectId, sourceChapterId);
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
			// `rulerAiResolve` goes through `finalizeTempMerge`, which merges a temp branch
			// into trunk and calls `markMerged` — the commit path — so no snapshot
			// coordinates are recorded and the shared guard lets the deletion through.
			await deleteMergedSourceBranch(projectId, sourceChapterId);
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
	const gitPath = project.gitPath;

	const trunkBranch = project.defaultBranch ?? "main";

	// Verify source chapter.
	//
	// Only `worktreePath` is taken from this read, and only because it is the lock key —
	// it cannot be read from inside the lock it selects, and a rebase never changes it.
	// Every other field, in particular the parked-work coordinates, is deliberately
	// re-read after the lock is held: a request that queues behind another rebase enters
	// the critical section against a row the previous holder has already rewritten, so
	// deciding what to settle from *this* read means settling against coordinates that
	// have since been cleared or replaced.
	const preLockChapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
		columns: { worktreePath: true },
	});
	if (!preLockChapter) throw new NotFoundError("Chapter", chapterId);
	if (!preLockChapter.worktreePath) throw new ValidationError("Chapter has no worktree");
	const worktreePath = preLockChapter.worktreePath;

	// Everything from here on is one indivisible sequence over a single workspace:
	// settle → reset+capture (park) → `git rebase` → three-way reapply. Each step reads a
	// state the previous one produced, so anything that writes to the worktree in between
	// — a concurrent autoCommit, a narrator's Write tool, the worktree watcher's capture,
	// or simply a second rebase from a double-clicked button — is enough to make the
	// parked coordinates describe a state that no longer exists. Two overlapping
	// `git rebase` runs additionally collide on `.git/rebase-merge` and leave the
	// workspace mid-rebase with no owner.
	//
	// NOTE for future readers: `worktreeLock` is now the *only* worktree mutex —
	// git-service's formerly-separate module-private lock derives its key the same way, so
	// a nested `gitService` write from inside this block would wait on the lock this block
	// already holds. It is not re-entrant and has no owner tracking, so that is a
	// deterministic hang, not a race.
	//
	// Every write reached from here therefore uses an `*Unlocked` variant:
	// `gitService.rebase` never locked at all, and `resetHard`/`cleanUntracked` (reached
	// via `parkUncommittedWork`, which documents that its caller owns the lock) call the
	// unlocked forms. `worktree-tree-snapshot`'s shadow-repo mutex is still a separate
	// instance keyed by the shadow directory, and is a level below this one in the
	// hierarchy documented in `lib/async-mutex`.
	//
	// Adding a `gitService` write call inside this block? Use its `*Unlocked` variant.
	// `git-service-worktree-lock.test.ts` fails on a deadline if this is got wrong.
	return worktreeLock.acquire(worktreePath, async () => {
		// Re-read now that nobody else can be mid-sequence. The status check lives here for
		// the same reason: a chapter that was merged or abandoned by whoever held the lock
		// must not then be rebased on the strength of a pre-queue observation.
		const chapter = await db.query.chapters.findFirst({
			where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
		});
		if (!chapter) throw new NotFoundError("Chapter", chapterId);
		if (chapter.status !== "active") throw new ValidationError("Can only rebase active chapters");
		if (chapter.worktreePath !== worktreePath) {
			// The lock protects one path, so a chapter that moved worktrees while this
			// request was queued is being guarded by the wrong key. Refusing sends the user
			// back through a fresh request that locks the path the chapter now lives on.
			throw new ValidationError(
				"The chapter's worktree changed while this rebase was waiting; retry the rebase",
			);
		}

		/**
		 * Reported alongside the rebase result when an earlier rebase's parked work could
		 * not be recovered at all. Not a reason to refuse this rebase — the snapshot is
		 * already unreachable, so refusing would block the chapter permanently — but the
		 * user has to be told rather than have it disappear into a log line.
		 */
		let lostParkedSnapshot: string | null = null;

		// Settle a debt left by an earlier conflicted rebase before creating a new one.
		// That rebase was finished by the narrator running `rebase --continue`, so no
		// request ran at the moment it ended and the reapply had nowhere to happen. Doing
		// it here keeps the invariant that a rebase never starts while another one's work
		// is still parked, which would otherwise overwrite the first snapshot's
		// coordinates and orphan it.
		if (chapter.parkedSnapshotCommitSha && chapter.parkedSnapshotBaseTree) {
			let settled: Awaited<ReturnType<typeof settleParkedWork>>;
			try {
				settled = await settleParkedWork(
					worktreePath,
					chapter.parkedSnapshotCommitSha,
					chapter.parkedSnapshotBaseTree,
				);
			} catch (err) {
				// A throw here means the workspace itself could not be captured, so parking
				// would fail next anyway. Refusing keeps the coordinates — the debt is still
				// owed and becomes settleable again once the workspace is readable — instead
				// of clearing them and losing the only pointer to the work.
				logger.warn("Could not settle work parked by an earlier rebase", {
					chapterId,
					snapshotCommitSha: chapter.parkedSnapshotCommitSha,
					error: String(err),
				});
				return c.json(
					{
						error: "REBASE_PARKED_WORK_UNSETTLED",
						code: "VALIDATION_ERROR",
						parkedSnapshot: chapter.parkedSnapshotCommitSha,
						parkedWorkPending: true,
						detail: String(err),
					},
					409,
				);
			}
			if (settled === null) {
				// `settleParkedWork` documents null as "the snapshot no longer resolves",
				// which its own comment says the caller must report rather than treat as
				// success. Nothing can be recovered, so the coordinates are cleared to let
				// the chapter move again — but the id travels back in the response.
				logger.error("Work parked by an earlier rebase can no longer be recovered", {
					chapterId,
					snapshotCommitSha: chapter.parkedSnapshotCommitSha,
				});
				lostParkedSnapshot = chapter.parkedSnapshotCommitSha;
				await clearParkedSnapshot(chapterId);
			} else if (settled.conflicts.length) {
				// Refusing is the safe direction: proceeding would park a workspace that is
				// itself missing the earlier work, compounding the loss silently.
				return c.json(
					{
						error: "REBASE_PARKED_WORK_CONFLICT",
						code: "VALIDATION_ERROR",
						conflictFiles: settled.conflicts,
						parkedSnapshot: chapter.parkedSnapshotCommitSha,
						parkedWorkPending: true,
					},
					409,
				);
			} else {
				await clearParkedSnapshot(chapterId);
			}
		}

		// The trunk worktree is deliberately NOT dirty-checked. `git rebase` reads the
		// trunk *branch*, not its worktree, so uncommitted work over there cannot affect
		// the outcome — the check only ever refused a rebase that would have succeeded.
		//
		// A dirty source is a real obstacle (git refuses to start), but not a reason to
		// refuse: the work is parked in the snapshot DAG, git gets a clean worktree, and it
		// is three-way reapplied afterwards.
		//
		// `parkUncommittedWork` refuses rather than proceeding whenever it cannot prove the
		// reset is recoverable: an operation already in progress, unmerged paths, or a
		// parked tree that does not cover every dirty path git reported. All three arrive
		// as ValidationError and are left to propagate on purpose — the global handler
		// turns them into a 400 whose `error` field is the message itself, which the Ruler
		// shows verbatim for unrecognised codes. That matters most for the coverage
		// refusal, which names the specific files the user has to commit first; mapping it
		// to a generic string would delete the only actionable part. Nothing has been reset
		// when any of them throws, so failing the request is the whole of the cleanup.
		//
		// An untracked-only workspace parks nothing (git replays straight over untracked
		// files), unless one of those files is a path the incoming history also creates —
		// then git refuses the entire rebase with "untracked working tree files would be
		// overwritten" before touching anything. Checked up front rather than by retrying
		// after the failure: the collision set is what decides whether the reset+clean
		// round trip is worth paying for, and asking git first means the workspace is never
		// left holding a failed rebase attempt. Deliberately NOT detected from git's error
		// text — that message is localised, so a regex over it silently stops matching
		// under a non-English locale and the collision becomes an unexplained failure.
		const collisions = await untrackedCollisions(worktreePath, trunkBranch).catch((err) => {
			// Non-fatal: a failure here only means the optimisation cannot be made. The
			// rebase still runs, and a real collision surfaces as git's own error.
			logger.warn("Could not check for untracked collisions before rebasing", {
				chapterId,
				trunkBranch,
				error: String(err),
			});
			return [] as string[];
		});
		if (collisions.length > 0) {
			logger.info("Parking an untracked-only workspace: the rebase would collide with it", {
				chapterId,
				collisions: collisions.slice(0, 10),
				collisionCount: collisions.length,
			});
		}
		const parked = await parkUncommittedWork(worktreePath, "pre-rebase workspace state", {
			// Only forces when git would actually have refused. `force` on a workspace with
			// no collision spends a reset + clean + capture to change nothing.
			force: collisions.length > 0,
		});
		if (parked) {
			// Persisted because a conflicted rebase stops with the worktree mid-rebase: the
			// reapply then belongs to whichever later request resolves or aborts it.
			await db
				.update(chapters)
				.set({
					parkedSnapshotCommitSha: parked.commitSha,
					parkedSnapshotBaseTree: parked.baseTree,
				})
				.where(eq(chapters.id, chapterId));
		}

		let result: Awaited<ReturnType<typeof gitService.rebase>>;
		try {
			result = await gitService.rebase(
				worktreePath,
				trunkBranch,
				await resolveUserGitIdentityEnv(c.get("user").sub),
			);
		} catch (err) {
			// The rebase never started, so the pre-rebase state is still the correct one.
			if (parked) {
				await restoreParkedWork(worktreePath, parked);
				await clearParkedSnapshot(chapterId);
			}
			throw err;
		}

		if (result.success) {
			// Read the tip of the trunk *branch*, not the HEAD of the trunk worktree. The
			// rebase was run against the branch, so the branch tip is the new base by
			// definition; the trunk worktree can legitimately be detached or itself mid
			// rebase/bisect, in which case its HEAD names a commit this chapter was never
			// rebased onto and `startCommitSha` would place the chapter at the wrong point
			// on the ruler's backbone. Non-fatal on failure: the rebase already happened,
			// and a missing `startCommitSha` update only costs layout precision.
			const trunkTip = await gitService.getRefCommit(gitPath, trunkBranch).catch((err) => {
				logger.warn("Rebase succeeded but the trunk branch tip could not be read", {
					chapterId,
					trunkBranch,
					error: String(err),
				});
				return null;
			});
			await db
				.update(chapters)
				.set({
					...(trunkTip ? { startCommitSha: trunkTip } : {}),
					headCommitSha: result.commitSha,
				})
				.where(eq(chapters.id, chapterId));

			// Sync commits
			await commitSyncService.syncChapterCommits(chapterId).catch(() => {});

			const reapply = parked ? await reapplyParked(chapterId, worktreePath, parked) : null;

			return c.json({
				success: true,
				commitSha: result.commitSha,
				...parkedWorkResponse(parked, reapply, lostParkedSnapshot),
			});
		}

		// Conflict — the worktree stays mid-rebase for the narrator or the user to resolve,
		// so the parked work stays parked and its coordinates stay in the DB.
		return c.json({
			success: false,
			conflictFiles: result.conflictFiles,
			...(parked ? { parkedSnapshot: parked.commitSha, parkedWorkPending: true } : {}),
			...(lostParkedSnapshot ? { lostParkedSnapshot } : {}),
		});
	});
});

/** How a post-rebase reapply of parked work ended. */
type ReapplyOutcome =
	| { status: "reapplied" }
	| { status: "conflict"; conflictFiles: string[] }
	| { status: "failed"; detail: string };

/**
 * Put parked work back after a successful rebase, keeping the coordinates on any
 * outcome the user still has to act on.
 *
 * The coordinates used to be cleared unconditionally here, on the theory that a
 * conflicted reapply is "resolved by the user in the worktree". That was wrong in a way
 * that loses data: the conflict path in `reapplyParkedWork` deliberately writes NOTHING
 * — no markers, no partial tree — so there is nothing in the worktree to resolve, and
 * once the snapshot id is dropped from the row the work is reachable only from a log
 * line. `/ruler/rebase-parked` is the way back, and it needs these coordinates.
 */
async function reapplyParked(
	chapterId: string,
	worktreePath: string,
	parked: ParkedWork,
): Promise<ReapplyOutcome> {
	try {
		const reapplied = await reapplyParkedWork(worktreePath, parked);
		if (reapplied.conflicts.length) {
			logger.warn("Rebase succeeded but the parked work conflicts with the rebased result", {
				chapterId,
				snapshotCommitSha: parked.commitSha,
				conflictFiles: reapplied.conflicts,
			});
			return { status: "conflict", conflictFiles: reapplied.conflicts };
		}
		await clearParkedSnapshot(chapterId);
		return { status: "reapplied" };
	} catch (err) {
		logger.error("Rebase succeeded but the parked work could not be reapplied", {
			chapterId,
			snapshotCommitSha: parked.commitSha,
			error: String(err),
		});
		return { status: "failed", detail: String(err) };
	}
}

/**
 * Describe the fate of parked work in the response.
 *
 * Additive on purpose. `parkedSnapshot` and `reapplyConflictFiles` keep their existing
 * shape and meaning because the Ruler UI reads them today and is deployed
 * independently; the new fields separate the two states the old response conflated. A
 * conflict is a decision waiting for the user, while a failure is a NarraFork or git
 * fault that no user action fixes — worth different wording and different urgency, and
 * previously indistinguishable because both only set `parkedSnapshot`.
 */
function parkedWorkResponse(
	parked: ParkedWork | null,
	reapply: ReapplyOutcome | null,
	lostParkedSnapshot: string | null,
): Record<string, unknown> {
	const lost = lostParkedSnapshot ? { lostParkedSnapshot } : {};
	if (!parked || !reapply || reapply.status === "reapplied") return lost;
	return {
		...lost,
		// Legacy field: present whenever work did not fully land back on disk.
		parkedSnapshot: parked.commitSha,
		// True while the coordinates are still in the row, i.e. while
		// `/ruler/rebase-parked` can still act on them.
		parkedWorkPending: true,
		parkedWorkStatus: reapply.status,
		...(reapply.status === "conflict"
			? { reapplyConflictFiles: reapply.conflictFiles }
			: { reapplyError: reapply.detail }),
	};
}

/**
 * What to do with work a rebase parked and could not put back.
 *
 * Exists because the conflict path is otherwise a dead end. A conflicted reapply writes
 * nothing to the worktree by design, so the user is left with a rebased workspace, a
 * warning naming a snapshot id, and no operation that accepts that id — every
 * `materializeTree` caller in the codebase is on an internal merge/wake path. These
 * three actions are the ones that are actually decidable by a user:
 *
 *   - `retry` — attempt the three-way reapply again. Worth offering because the
 *     conflicting side is the *current* workspace: editing or reverting the offending
 *     file makes the same merge succeed.
 *   - `materialize` — write the conflicted tree, markers and all, so it can be resolved
 *     in an editor. Mirrors `materializeConflicts` on the snapshot-merge path, which is
 *     the established answer to "the user must see both sides".
 *   - `discard` — forget the coordinates. Explicit, because the alternative is a
 *     permanent banner on a chapter whose parked work the user no longer wants.
 *
 * Restoring the parked tree wholesale is deliberately NOT offered: it would overwrite
 * the rebased result, which is the mistake `reapplyParkedWork` avoids by being a
 * three-way merge rather than a restore.
 */
const rulerRebaseParkedSchema = z.object({
	chapterId: z.string().min(1),
	action: z.enum(["retry", "materialize", "discard"]),
});

// POST /:id/ruler/rebase-parked — Recover work a rebase parked and could not reapply
rulerRoutes.post("/:id/ruler/rebase-parked", async (c) => {
	const projectId = c.req.param("id");
	const parsed = rulerRebaseParkedSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { chapterId, action } = parsed.data;

	const chapter = await db.query.chapters.findFirst({
		where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
	});
	if (!chapter) throw new NotFoundError("Chapter", chapterId);
	if (!chapter.worktreePath) throw new ValidationError("Chapter has no worktree");
	const worktreePath = chapter.worktreePath;
	const commitSha = chapter.parkedSnapshotCommitSha;
	const baseTree = chapter.parkedSnapshotBaseTree;
	if (!commitSha || !baseTree) {
		throw new ValidationError("This chapter has no parked work to recover");
	}

	if (action === "discard") {
		// No git work, so no lock is needed: this only drops the row's pointer. The
		// snapshot commit itself stays in the shadow DAG and is logged, so a user who
		// discards by mistake has not destroyed anything irreversibly.
		//
		// Conditional on the sha the user was actually shown, though, because *this* read
		// happened outside any lock. An unconditional `SET NULL` raced a concurrent rebase:
		// that rebase holds `worktreeLock`, parks a NEW snapshot and writes its coordinates,
		// and the discard then erased the new pointer while reporting the old id as
		// discarded — losing work that was never displayed to anyone and cannot be reached
		// from the row any more. Matching on the sha makes the update a no-op in that case.
		logger.info("Discarding the coordinates of work parked by a rebase", {
			chapterId,
			snapshotCommitSha: commitSha,
		});
		const discarded = await clearParkedSnapshotIfUnchanged(chapterId, commitSha);
		if (!discarded) {
			// Refusing rather than discarding whatever is there now: the user consented to
			// forgetting one specific snapshot, not to forgetting the chapter's parked work
			// in general.
			logger.warn("Refused to discard parked work: its coordinates changed meanwhile", {
				chapterId,
				snapshotCommitSha: commitSha,
			});
			return c.json(
				{
					error: "PARKED_SNAPSHOT_CHANGED",
					code: "VALIDATION_ERROR",
					staleSnapshot: commitSha,
					detail:
						"This chapter's parked work changed while the page was open, so nothing was discarded. Reload and check the current state before discarding.",
				},
				409,
			);
		}
		return c.json({ success: true, discardedSnapshot: commitSha });
	}

	// Same lock as the rebase endpoint, for the same reason: both read the workspace,
	// merge against it and write the result back.
	return worktreeLock.acquire(worktreePath, async () => {
		const treeHash = await worktreeTreeSnapshot
			.treeOfSnapshot(worktreePath, commitSha)
			.catch(() => null);
		if (!treeHash) {
			// The pointer outlived what it points at. Reported, then cleared, matching the
			// rebase endpoint's handling of the same condition.
			logger.error("Parked work can no longer be recovered: its snapshot does not resolve", {
				chapterId,
				snapshotCommitSha: commitSha,
			});
			await clearParkedSnapshot(chapterId);
			return c.json(
				{
					error: "PARKED_SNAPSHOT_UNRESOLVABLE",
					code: "VALIDATION_ERROR",
					lostParkedSnapshot: commitSha,
				},
				409,
			);
		}

		if (action === "retry") {
			const outcome = await reapplyParked(chapterId, worktreePath, {
				commitSha,
				treeHash,
				baseTree,
			});
			if (outcome.status === "reapplied") {
				return c.json({ success: true, parkedSnapshot: commitSha, parkedWorkStatus: "reapplied" });
			}
			return c.json(
				{
					success: false,
					parkedSnapshot: commitSha,
					parkedWorkPending: true,
					parkedWorkStatus: outcome.status,
					...(outcome.status === "conflict"
						? { reapplyConflictFiles: outcome.conflictFiles }
						: { reapplyError: outcome.detail }),
				},
				409,
			);
		}

		// action === "materialize"
		const current = await worktreeTreeSnapshot.tryCapture(worktreePath);
		if (!current) {
			throw new ValidationError(
				`Could not read the current workspace, so the conflict cannot be written out. Your work is still in snapshot ${commitSha.slice(0, 12)}.`,
			);
		}
		const merged = await worktreeTreeSnapshot.mergeTreesWithBase(
			worktreePath,
			baseTree,
			current,
			treeHash,
		);
		const changedFiles = await worktreeTreeSnapshot.materializeTree(worktreePath, merged.tree);
		// The bytes are on disk now — with markers where the two sides disagree — so the
		// snapshot is no longer the only copy and the debt is discharged. Keeping the
		// coordinates instead would make the next rebase try to settle a reapply against a
		// worktree full of markers and refuse to start.
		await clearParkedSnapshot(chapterId);
		logger.info("Wrote parked work into the workspace as a conflicted tree", {
			chapterId,
			snapshotCommitSha: commitSha,
			conflictFiles: merged.conflicts,
		});
		return c.json({
			success: true,
			parkedSnapshot: commitSha,
			parkedWorkStatus: "materialized",
			conflictFiles: merged.conflicts,
			changedFiles,
		});
	});
});

/**
 * Forget a chapter's parked-work coordinates.
 *
 * Called at every terminal outcome. A stale value is not cosmetic: the next rebase
 * would find it and restore a workspace the user has long since edited past.
 */
async function clearParkedSnapshot(chapterId: string): Promise<void> {
	await db
		.update(chapters)
		.set({ parkedSnapshotCommitSha: null, parkedSnapshotBaseTree: null })
		.where(eq(chapters.id, chapterId));
}

/**
 * Forget the coordinates only while they still name `expectedCommitSha`.
 *
 * For the one caller that decides outside `worktreeLock`: `discard` acts on a sha the
 * user was shown, and between that read and the write a rebase holding the lock can
 * have parked something else and stored its coordinates. An unconditional clear then
 * erases a live pointer to work nobody has seen yet, while the response claims the old
 * snapshot was the one discarded.
 *
 * Returns false when the row no longer matches, i.e. when the caller must report a
 * stale view rather than assume the clear happened. `returning()` is used instead of a
 * driver-specific affected-row count so the answer comes from the row itself.
 */
async function clearParkedSnapshotIfUnchanged(
	chapterId: string,
	expectedCommitSha: string,
): Promise<boolean> {
	const updated = await db
		.update(chapters)
		.set({ parkedSnapshotCommitSha: null, parkedSnapshotBaseTree: null })
		.where(and(eq(chapters.id, chapterId), eq(chapters.parkedSnapshotCommitSha, expectedCommitSha)))
		.returning({ id: chapters.id });
	return updated.length > 0;
}

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
	const resolveWorktreePath = chapter.worktreePath;

	if (action === "abort") {
		// Locked for the same reason the rebase endpoint is: `rebaseAbort` and
		// `restoreParkedWork` both write the workspace, and the second one is a wholesale
		// restore, so a concurrent capture or a second rebase landing between them makes
		// the restore overwrite state it never saw. The row is re-read inside the lock
		// because the coordinates are what the restore acts on and whoever held the lock
		// before may have settled or replaced them.
		return worktreeLock.acquire(resolveWorktreePath, async () => {
			const current = await db.query.chapters.findFirst({
				where: and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)),
				columns: { parkedSnapshotCommitSha: true, parkedSnapshotBaseTree: true },
			});
			// Work parked by the rebase that is now ending, in whichever way.
			const parked =
				current?.parkedSnapshotCommitSha && current.parkedSnapshotBaseTree
					? {
							commitSha: current.parkedSnapshotCommitSha,
							treeHash: "",
							baseTree: current.parkedSnapshotBaseTree,
						}
					: null;

			await gitService.rebaseAbort(resolveWorktreePath);
			if (!parked) return c.json({ success: true });

			// An abort means "as if the rebase never happened", so the parked tree — the
			// exact pre-rebase workspace — is restored wholesale rather than merged.
			const treeHash = await worktreeTreeSnapshot
				.treeOfSnapshot(resolveWorktreePath, parked.commitSha)
				.catch(() => null);
			if (!treeHash) {
				// Reported in the response rather than only logged. The old code cleared the
				// coordinates and still answered `{ success: true, parkedSnapshot }`, which
				// reads as "the abort put your workspace back" — while the uncommitted work is
				// neither on disk nor tracked any more. `lostParkedSnapshot` is the field the
				// rebase endpoint already uses for exactly this condition, and the Ruler's
				// `parked-work` mapping renders it as an unrecoverable loss.
				logger.error("Could not restore parked work after a rebase abort", {
					chapterId,
					snapshotCommitSha: parked.commitSha,
				});
				await clearParkedSnapshot(chapterId);
				return c.json({ success: true, lostParkedSnapshot: parked.commitSha });
			}
			await restoreParkedWork(resolveWorktreePath, { ...parked, treeHash });
			await clearParkedSnapshot(chapterId);
			return c.json({ success: true, parkedSnapshot: parked.commitSha });
		});
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
			// The user resolving the rebase conflict owns the session created for it.
			ownerUserId: c.get("user").sub,
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
