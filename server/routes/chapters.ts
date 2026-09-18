import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { activeDatabaseBackend, db } from "../db";
import { chapters, projects } from "../db/schema";
import { AppError, catalogError, NotFoundError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getContainerUnsupportedReason, supportsContainers } from "../lib/platform";
import {
	projectPrincipalOf,
	requireChapterAccess,
	requireProjectAccess,
} from "../lib/project-access";
import { getUserLanguage } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import { safeSpawn } from "../lib/spawn";
import {
	batchCleanupSchema,
	batchMergeSchema,
	containerRemoveSchema,
	createChapterSchema,
	createReviewSchema,
	forkChapterSchema,
	listCommitsSchema,
	mergeChapterSchema,
	splitChapterSchema,
	updateChapterDetachedPanelsSchema,
	updateChapterDockLayoutSchema,
	updateChapterSchema,
} from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import { chapterBatchMerge } from "../services/chapter-batch-merge";
import { chapterCleanup } from "../services/chapter-cleanup";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
import { chapterSplit } from "../services/chapter-split";
import { commitSyncService } from "../services/commit-sync-service";
import { buildProxyUrl } from "../services/container-proxy";
import {
	containerService,
	getContainerSetupStatus,
	getPodmanStatus,
	parseComposeFile,
	resetPodmanCache,
	resolveComposeFile,
} from "../services/container-service";
import { gitService } from "../services/git-service";
import { syncTitleToNarrator } from "../services/narrator-title";
import { projectReadAdapter } from "../services/read";
import { collectAllPages, parseLimitQuery, singlePage } from "../services/read/read-collect";
import { reviewService } from "../services/review-service";

export const chapterRoutes = new Hono();

/**
 * Chapter lifecycle routes still combine host-side git/worktree/container work with legacy SQLite
 * reads. Refuse those mutations before access checks or any host-side effect while PG is active.
 */
export function requireSqliteChapterMutation(
	operation: string,
	backend: string = activeDatabaseBackend,
): void {
	if (backend === "postgres") {
		throw new AppError(
			`${operation} is not yet supported on the PostgreSQL backend`,
			503,
			"POSTGRES_UNSUPPORTED",
		);
	}
}

const CHAPTER_MUTATION_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isPodmanInstallPath(pathname: string): boolean {
	const segments = pathname.split("/").filter(Boolean);
	return segments.at(-2) === "podman" && segments.at(-1) === "install";
}

/**
 * Reject every chapter-router mutation by default while PostgreSQL is active. This broad policy
 * makes newly added lifecycle endpoints fail closed instead of relying on each handler to remember
 * a guard. Podman installation is deliberately exempt: it is an admin-only host operation with no
 * chapter/project database dependency.
 */
export function createChapterMutationAdmissionMiddleware(
	backend: string = activeDatabaseBackend,
): MiddlewareHandler {
	return async (c, next) => {
		if (
			!CHAPTER_MUTATION_SAFE_METHODS.has(c.req.method.toUpperCase()) &&
			!isPodmanInstallPath(c.req.path)
		) {
			requireSqliteChapterMutation("Chapter mutation", backend);
		}
		return next();
	};
}

// This must remain the first router middleware: PostgreSQL refusal has to happen before body
// parsing, project/chapter ACL lookup, or any git/worktree/container side effect.
chapterRoutes.use("*", createChapterMutationAdmissionMiddleware());

/**
 * Access gate for every `/:id/...` route in this router.
 *
 * Chapters have no ACL of their own: they inherit their project's verdict wholesale,
 * because every chapter worktree lives inside the same git repository and anything
 * with filesystem access to one chapter can read every branch through `git` or a
 * `../` path. Per-chapter isolation would be fiction.
 *
 * A middleware rather than a call in each of ~30 handlers, so a route is protected
 * by virtue of existing here and a newly added endpoint does not start out open.
 * GET is read; every mutating method is project write — creating chapters,
 * committing, merging, waking worktrees and driving containers all change shared
 * state.
 *
 * Literal collection paths that share the `/:id` shape are skipped; they are matched
 * by their own more specific routes.
 */
const CHAPTER_ID_GATE_EXEMPT_SEGMENTS = new Set([
	"merge-sessions",
	"container-setup",
	"cleanup",
	"batch-merge",
	"podman",
]);

chapterRoutes.use("/:id/*", async (c, next) => {
	const id = c.req.param("id");
	if (!id || CHAPTER_ID_GATE_EXEMPT_SEGMENTS.has(id)) return next();
	await requireChapterAccess(c, id, c.req.method === "GET" ? "read" : "write");
	return next();
});

// The bare `/:id` routes are not covered by the `/:id/*` pattern above.
chapterRoutes.use("/:id", async (c, next) => {
	const id = c.req.param("id");
	if (!id || CHAPTER_ID_GATE_EXEMPT_SEGMENTS.has(id)) return next();
	await requireChapterAccess(c, id, c.req.method === "GET" ? "read" : "write");
	return next();
});

function containerUnsupportedPayload() {
	return {
		error: getContainerUnsupportedReason() ?? "Container management is unsupported",
		code: "CONTAINERS_UNSUPPORTED",
		supported: false,
	};
}

/**
 * A project's chapters, as a bare JSON array.
 *
 * `requireProjectAccess` is not redundant with the adapter's ACL predicate, and dropping it
 * was a change of ANSWER rather than of status code: the predicate makes an unreadable project
 * return `[]`, which is exactly what a real, readable, empty project returns. Without this the
 * endpoint stopped distinguishing "not yours" — 404, with no confirmation the id exists — from
 * "no chapters yet".
 *
 * Paging matches the project list: no parameters returns the whole readable set assembled from
 * bounded pages, `?limit`/`?cursor` returns one page, and a ceiling reached is reported in
 * `X-Next-Cursor`/`X-Read-Truncated` rather than silently dropped. That matters here because
 * the merge modal builds its target list from this array — a chapter missing from it looks like
 * a chapter that cannot be merged into.
 */
chapterRoutes.get("/", async (c) => {
	const projectId = c.req.query("projectId");
	const status = c.req.query("status");
	if (!projectId) return c.json({ error: "projectId is required" }, 400);
	await requireProjectAccess(c, projectId, "read");
	const principal = projectPrincipalOf(c);
	const limit = parseLimitQuery(c.req.query("limit"));
	const cursor = c.req.query("cursor");
	const adapter = projectReadAdapter();
	const result =
		limit === undefined && !cursor
			? await collectAllPages((page) =>
					adapter.listChaptersPage(projectId, principal, page, status ?? undefined),
				)
			: singlePage(
					await adapter.listChaptersPage(
						projectId,
						principal,
						{ limit, cursor },
						status ?? undefined,
					),
				);
	if (result.nextCursor) c.header("X-Next-Cursor", result.nextCursor);
	if (result.truncated) c.header("X-Read-Truncated", "1");
	return c.json(result.rows);
});

chapterRoutes.post("/", async (c) => {
	requireSqliteChapterMutation("Chapter creation");
	const parsed = createChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Creating a chapter creates a branch and a worktree in the project's repository,
	// so it needs project write. Not covered by the `/:id` gate — this route has no id.
	await requireProjectAccess(c, parsed.data.projectId, "write");
	// Server-trusted creator, so the auto-created narrator has a real owner.
	const chapter = await chapterService.create({
		...parsed.data,
		createdByUserId: c.get("user").sub,
	});
	return c.json(chapter, 201);
});

chapterRoutes.get("/merge-sessions/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");
	const session = await chapterBatchMerge.getSession(sessionId);
	if (!session) throw new NotFoundError("MergeSession", sessionId);
	return c.json(session);
});

chapterRoutes.get("/container-setup", async (c) => {
	const refresh = c.req.query("refresh") === "true";
	return c.json(await getContainerSetupStatus(refresh));
});

chapterRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const chapter = await projectReadAdapter().getChapter(id, projectPrincipalOf(c));
	if (!chapter) throw new NotFoundError("Chapter", id);
	return c.json(chapter);
});

chapterRoutes.patch("/:id", async (c) => {
	requireSqliteChapterMutation("Chapter updates");
	const id = c.req.param("id");
	const parsed = updateChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const chapter = await chapterService.update(id, parsed.data);

	// Sync title to primary narrator if title was updated
	if (parsed.data.title !== undefined) {
		syncTitleToNarrator(id, parsed.data.title).catch((err) => {
			logger.warn("syncTitleToNarrator failed", { chapterId: id, error: String(err) });
		});
	}

	return c.json(chapter);
});

chapterRoutes.delete("/:id", async (c) => {
	requireSqliteChapterMutation("Chapter deletion");
	const id = c.req.param("id");
	await chapterService.remove(id);
	return c.json({ ok: true });
});

// === Graph node dock layout ===
//
// The dockview layout of a chapter node's embedded surface (which tool panels are
// open, how they are split). Its own endpoint rather than a field on the chapter
// or on `PATCH /graph/positions`: it is a multi-KB blob that must never ride
// along with a node drag or appear in the project graph's per-chapter payload.
// Access is already gated by the `/:id` middleware above (GET → read, PUT → write).

chapterRoutes.get("/:id/dock-layout", async (c) => {
	const id = c.req.param("id");
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, id),
		columns: { dockLayoutJson: true },
	});
	if (!row) throw new NotFoundError("Chapter", id);
	return c.json({ layout: row.dockLayoutJson ?? null });
});

chapterRoutes.put("/:id/dock-layout", async (c) => {
	requireSqliteChapterMutation("Chapter dock layout updates");
	const id = c.req.param("id");
	const parsed = updateChapterDockLayoutSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Existence is checked before writing so a stale client (node deleted in
	// another tab) gets a 404 instead of a silent no-op update.
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, id),
		columns: { id: true },
	});
	if (!row) throw new NotFoundError("Chapter", id);
	await db.update(chapters).set({ dockLayoutJson: parsed.data.layout }).where(eq(chapters.id, id));
	return c.json({ ok: true });
});

// === Detached panels ===
//
// Tool panels torn out of this chapter's node dock, now standing as their own
// canvas nodes. Separate from the dock layout because that column holds dockview's
// own serialized grid; custom entries there would break its `fromJSON`.

chapterRoutes.get("/:id/detached-panels", async (c) => {
	const id = c.req.param("id");
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, id),
		columns: { detachedPanelsJson: true },
	});
	if (!row) throw new NotFoundError("Chapter", id);
	return c.json({ panels: row.detachedPanelsJson ?? null });
});

chapterRoutes.put("/:id/detached-panels", async (c) => {
	requireSqliteChapterMutation("Chapter detached panel updates");
	const id = c.req.param("id");
	const parsed = updateChapterDetachedPanelsSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const row = await db.query.chapters.findFirst({
		where: eq(chapters.id, id),
		columns: { id: true },
	});
	if (!row) throw new NotFoundError("Chapter", id);
	await db
		.update(chapters)
		.set({ detachedPanelsJson: parsed.data.panels })
		.where(eq(chapters.id, id));
	return c.json({ ok: true });
});

// === Fork ===

chapterRoutes.post("/:id/fork", async (c) => {
	const id = c.req.param("id");
	const parsed = forkChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const chapter = await chapterFork.fork(id, { ...parsed.data, locale });
	return c.json(chapter, 201);
});

// === Split at commit ===

chapterRoutes.post("/:id/split", async (c) => {
	const id = c.req.param("id");
	const parsed = splitChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const result = await chapterSplit.split(id, { ...parsed.data, locale });
	return c.json(result, 201);
});

// === Review ===

chapterRoutes.post("/:id/review", async (c) => {
	const id = c.req.param("id");
	const parsed = createReviewSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const locale = parsed.data.locale ?? (await getUserLanguage(userId));
	const chapter = await reviewService.createReview(id, {
		...parsed.data,
		locale,
		createdByUserId: userId,
	});
	return c.json(chapter, 201);
});

// === Merge ===

chapterRoutes.get("/:id/merge-check", async (c) => {
	const id = c.req.param("id");
	const targetChapterId = c.req.query("targetChapterId");
	if (!targetChapterId) throw new ValidationError("targetChapterId query param is required");
	const result = await chapterMerge.checkConflicts(id, targetChapterId);
	return c.json(result);
});

chapterRoutes.post("/:id/merge", async (c) => {
	const id = c.req.param("id");
	const parsed = mergeChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const source = await db.query.chapters.findFirst({ where: eq(chapters.id, id) });
	if (!source) throw new NotFoundError("Chapter", id);
	const target = await db.query.chapters.findFirst({
		where: eq(chapters.id, parsed.data.targetChapterId),
	});

	// Uncommitted changes are only a problem for the commit-based merge, which reads
	// branch tips and would silently drop them. The default snapshot merge takes the
	// workspaces as they are, so a dirty chapter is an ordinary state there rather
	// than an error — refusing it was the very restriction being removed.
	if (parsed.data.mode === "commit") {
		if (source.worktreePath) {
			const sourceStatus = await gitService.getStatus(source.worktreePath);
			// These used to smuggle the code through the `error` field, which forced the client
			// to compare prose. The catalog carries it in `messageCode`, so `error` can hold a
			// real sentence again for consumers without translations.
			if (sourceStatus.trim()) throw catalogError("MERGE_DIRTY_SOURCE");
		}
		if (target?.worktreePath) {
			const targetStatus = await gitService.getStatus(target.worktreePath);
			if (targetStatus.trim()) throw catalogError("MERGE_DIRTY_TARGET");
		}
	}

	const userId = c.get("user").sub;
	const result = await chapterMerge.merge(id, parsed.data, userId);
	if (!result.success) {
		return c.json(
			{
				...result,
				error: result.conflictFiles?.length
					? `Merge conflicts in ${result.conflictFiles.length} file(s): ${result.conflictFiles.slice(0, 5).join(", ")}${result.conflictFiles.length > 5 ? "…" : ""}`
					: "Merge failed",
			},
			409,
		);
	}
	return c.json(result);
});

chapterRoutes.post("/:id/ai-resolve", async (c) => {
	const id = c.req.param("id");
	const parsed = mergeChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const result = await chapterMerge.aiResolveConflicts(id, parsed.data, locale, userId);
	return c.json(result);
});

chapterRoutes.post("/:id/unmerge", async (c) => {
	const id = c.req.param("id");
	const result = await chapterMerge.unmerge(id, c.get("user").sub);
	return c.json(result);
});

// === Dormant / Wake ===

chapterRoutes.post("/:id/dormant", async (c) => {
	const id = c.req.param("id");
	await chapterCleanup.dormant(id, c.get("user").sub);
	return c.json({ ok: true });
});

chapterRoutes.post("/:id/wake", async (c) => {
	const id = c.req.param("id");
	await chapterCleanup.wake(id);
	return c.json({ ok: true });
});

// === Batch Cleanup ===

chapterRoutes.post("/cleanup", async (c) => {
	const parsed = batchCleanupSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// The chapter ids arrive in the body, so the `/:id` gate cannot see them. Each is
	// authorized individually: a batch must not become a way to destroy worktrees in a
	// project the caller cannot write to, and one unauthorized id fails the whole call
	// rather than being silently skipped.
	for (const chapterId of parsed.data.chapterIds) {
		await requireChapterAccess(c, chapterId, "write");
	}
	const report = await chapterCleanup.batchCleanup(parsed.data.chapterIds, {
		force: parsed.data.force,
		deleteBranch: parsed.data.deleteBranch,
	});
	return c.json(report);
});

// === Batch Merge ===

chapterRoutes.post("/batch-merge", async (c) => {
	const parsed = batchMergeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Merging changes both the sources and the destination, so every chapter involved
	// is checked. `targetChapterId` is optional — without it the merge forks a new
	// chapter off `baseChapterId`, which is still a write to that project — so the
	// base is always checked and the target only when present.
	for (const chapterId of [
		parsed.data.baseChapterId,
		parsed.data.targetChapterId,
		...parsed.data.sourceChapterIds,
	]) {
		if (chapterId) await requireChapterAccess(c, chapterId, "write");
	}
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const result = await chapterBatchMerge.run({ ...parsed.data, locale, userId });
	return c.json(result, 201);
});

// === Podman ===

chapterRoutes.get("/podman/status", async (c) => {
	const platform =
		process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
	if (!supportsContainers()) {
		return c.json({ installed: false, platform, ...containerUnsupportedPayload() });
	}
	const status = await getPodmanStatus();
	return c.json({ ...status, platform, supported: true });
});

chapterRoutes.post("/podman/install", requireAdmin, async (c) => {
	if (!supportsContainers()) {
		return c.json({ ok: false, ...containerUnsupportedPayload() }, 400);
	}
	const platform = process.platform;
	let cmd: string;
	if (platform === "darwin") {
		cmd = "brew install podman && podman machine init && podman machine start";
	} else if (platform === "win32") {
		cmd = "winget install -e --id RedHat.Podman";
	} else {
		// Linux — try common package managers
		cmd = [
			"(command -v apt-get >/dev/null 2>&1 && sudo apt-get update && sudo apt-get install -y podman)",
			"|| (command -v dnf >/dev/null 2>&1 && sudo dnf install -y podman)",
			"|| (command -v pacman >/dev/null 2>&1 && sudo pacman -S --noconfirm podman)",
			'|| (echo "No supported package manager found" && exit 1)',
		].join(" ");
	}

	const result = await safeSpawn({
		cmd: ["sh", "-c", cmd],
		env: process.env as Record<string, string>,
	});

	if (result.exitCode === 0) {
		resetPodmanCache();
		const status = await getPodmanStatus();
		return c.json({ ok: true, ...status });
	}
	return c.json({ ok: false, error: (result.stderr || result.stdout).trim() }, 500);
});

// === Containers ===

chapterRoutes.get("/:id/compose-info", async (c) => {
	const id = c.req.param("id");
	const chapter = await chapterService.getById(id);
	if (!chapter.worktreePath) return c.json({ services: [] });
	const config = chapter.containerConfig as { composeFile?: string } | null;
	const composeFile = resolveComposeFile(chapter.worktreePath, config);
	if (!composeFile) return c.json({ services: [] });
	const services = await parseComposeFile(chapter.worktreePath, composeFile);
	return c.json({ services });
});

chapterRoutes.get("/:id/containers", async (c) => {
	const id = c.req.param("id");
	const instances = await containerService.listByChapter(id);

	// Enrich with proxyUrl if proxy mode is active
	const proxyPort = settings.containers.proxy?.port ?? 7780;
	let proxyDomain: string | null = null;

	// All instances belong to the same chapter — look up project domain once
	const hasProxyInstances = instances.some((inst) => !!inst.proxyLabel);
	if (hasProxyInstances) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, id),
			columns: { projectId: true },
		});
		if (chapter) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, chapter.projectId),
				columns: { proxyDomain: true },
			});
			proxyDomain = project?.proxyDomain ?? null;
		}
	}

	const enriched = instances.map((inst) => {
		const proxyUrl =
			inst.proxyLabel && proxyDomain
				? buildProxyUrl(inst.proxyLabel, proxyDomain, proxyPort)
				: null;
		return { ...inst, proxyUrl };
	});

	return c.json(enriched);
});

chapterRoutes.post("/:id/containers/start", async (c) => {
	if (!supportsContainers()) {
		return c.json(containerUnsupportedPayload(), 400);
	}
	const id = c.req.param("id");
	await containerService.startChapterContainers(id);
	return c.json({ ok: true, status: "starting" });
});

chapterRoutes.post("/:id/containers/stop", async (c) => {
	if (!supportsContainers()) {
		return c.json(containerUnsupportedPayload(), 400);
	}
	const id = c.req.param("id");
	await containerService.stopChapterContainers(id);
	return c.json({ ok: true });
});

chapterRoutes.post("/:id/containers/pause", async (c) => {
	if (!supportsContainers()) {
		return c.json(containerUnsupportedPayload(), 400);
	}
	const id = c.req.param("id");
	await containerService.pauseChapterContainers(id);
	return c.json({ ok: true });
});

chapterRoutes.post("/:id/containers/unpause", async (c) => {
	if (!supportsContainers()) {
		return c.json(containerUnsupportedPayload(), 400);
	}
	const id = c.req.param("id");
	await containerService.unpauseChapterContainers(id);
	return c.json({ ok: true });
});

chapterRoutes.get("/:id/containers/logs", async (c) => {
	if (!supportsContainers()) {
		return c.json(containerUnsupportedPayload(), 400);
	}
	const id = c.req.param("id");
	const tail = c.req.query("tail");
	const service = c.req.query("service");
	const logs = await containerService.getContainerLogs(id, {
		tail: tail ? Number.parseInt(tail, 10) : undefined,
		service: service ?? undefined,
	});
	return c.json({ logs });
});

chapterRoutes.post("/:id/containers/remove", async (c) => {
	if (!supportsContainers()) {
		return c.json(containerUnsupportedPayload(), 400);
	}
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => ({}));
	const parsed = containerRemoveSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	await containerService.removeChapterContainers(id, {
		deleteVolumes: parsed.data.deleteVolumes,
	});
	return c.json({ ok: true });
});

// === Commits ===

chapterRoutes.get("/:id/commits", async (c) => {
	const id = c.req.param("id");
	const query = listCommitsSchema.parse({
		limit: c.req.query("limit"),
		since: c.req.query("since"),
	});
	const sync = c.req.query("sync") === "true";

	// Ensure chapter exists
	await chapterService.getById(id);

	// Note: query.since is accepted for backward compat but not used in DB query;
	// the old git-log-based implementation used it as a commit range. If needed,
	// add authoredAt filtering in commitSyncService.getChapterCommits.
	const commits = await commitSyncService.getChapterCommits(id, {
		limit: query.limit,
		sync,
	});

	return c.json(
		commits.map((commit) => ({
			id: commit.id,
			sha: commit.sha,
			message: commit.message,
			authorName: commit.authorName,
			authorEmail: commit.authorEmail,
			authoredAt: commit.authoredAt,
			source: commit.source,
			narratorId: commit.narratorId,
			narratorMessageId: commit.narratorMessageId,
			filesChanged: commit.filesChanged,
			linesAdded: commit.linesAdded,
			linesRemoved: commit.linesRemoved,
		})),
	);
});

chapterRoutes.get("/:id/commits/:sha", async (c) => {
	const id = c.req.param("id");
	const sha = c.req.param("sha");

	const chapter = await chapterService.getById(id);

	const commit = await commitSyncService.getCommitBySha(id, sha);
	if (!commit) throw new NotFoundError("Commit", sha);

	const project = await db.select().from(projects).where(eq(projects.id, chapter.projectId)).get();
	const repoPath = chapter.worktreePath || project?.gitPath;

	let files: Array<{
		path: string;
		oldPath?: string;
		status: string;
		linesAdded: number;
		linesRemoved: number;
		diff?: string;
	}> = [];
	let diffInlined = false;

	if (repoPath) {
		try {
			const fileList = await gitService.getCommitFiles(repoPath, sha);
			const totalLines = fileList.reduce((s, f) => s + f.linesAdded + f.linesRemoved, 0);

			// Small commit: inline all diffs directly (≤30 files and ≤5000 total lines)
			if (fileList.length <= 30 && totalLines <= 5000) {
				diffInlined = true;
				const filesWithDiff = await Promise.all(
					fileList.map(async (f) => {
						try {
							const { diff } = await gitService.getCommitFileDiff(repoPath, sha, f.path);
							return { ...f, diff };
						} catch {
							return { ...f, diff: "" };
						}
					}),
				);
				files = filesWithDiff;
			} else {
				files = fileList;
			}
		} catch {
			// Non-fatal — commit may not be reachable from current worktree
		}
	}

	return c.json({
		...commit,
		files,
		diffInlined,
	});
});

chapterRoutes.get("/:id/commits/:sha/files/*", async (c) => {
	const id = c.req.param("id");
	const sha = c.req.param("sha");
	// Extract file path from wildcard — everything after /files/
	const filePath = c.req.path.split("/files/").slice(1).join("/files/");
	if (!filePath) throw new ValidationError("File path is required");

	const chapter = await chapterService.getById(id);
	const project = await db.select().from(projects).where(eq(projects.id, chapter.projectId)).get();
	const repoPath = chapter.worktreePath || project?.gitPath;
	if (!repoPath) throw new ValidationError("No git repository available");

	const result = await gitService.getCommitFileDiff(repoPath, sha, filePath);
	return c.json(result);
});

// === Git Status (commits ahead + uncommitted lines) ===

chapterRoutes.get("/:id/git-status", async (c) => {
	const id = c.req.param("id");
	const chapter = await chapterService.getById(id);

	if (!chapter.worktreePath) {
		return c.json({
			commitsAhead: 0,
			linesAdded: 0,
			linesRemoved: 0,
			baseBranch: chapter.baseBranch,
		});
	}

	const [ahead, lines] = await Promise.all([
		gitService.getCommitsAhead(chapter.worktreePath, chapter.baseBranch),
		gitService.getUncommittedLineStats(chapter.worktreePath),
	]);

	return c.json({
		commitsAhead: ahead.count,
		baseBranch: ahead.baseBranch,
		linesAdded: lines.added,
		linesRemoved: lines.removed,
	});
});
