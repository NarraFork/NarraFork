import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/prompt-i18n";
import { settings } from "../lib/settings";
import {
	batchCleanupSchema,
	batchMergeSchema,
	containerRemoveSchema,
	createChapterSchema,
	forkChapterSchema,
	listCommitsSchema,
	mergeChapterSchema,
	updateChapterSchema,
} from "../lib/validators";
import { requireAdmin } from "../middleware/auth";
import { chapterBatchMerge } from "../services/chapter-batch-merge";
import { chapterCleanup } from "../services/chapter-cleanup";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
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

export const chapterRoutes = new Hono();

chapterRoutes.get("/", async (c) => {
	const projectId = c.req.query("projectId");
	const status = c.req.query("status");
	if (!projectId) return c.json({ error: "projectId is required" }, 400);
	const result = await chapterService.listByProject(projectId, status ?? undefined);
	return c.json(result);
});

chapterRoutes.post("/", async (c) => {
	const parsed = createChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const chapter = await chapterService.create(parsed.data);
	return c.json(chapter, 201);
});

chapterRoutes.get("/merge-sessions/:sessionId", async (c) => {
	const sessionId = c.req.param("sessionId");
	const session = await chapterBatchMerge.getSession(sessionId);
	if (!session) throw new NotFoundError("MergeSession", sessionId);
	return c.json(session);
});

chapterRoutes.get("/container-setup", (c) => {
	const refresh = c.req.query("refresh") === "true";
	return c.json(getContainerSetupStatus(refresh));
});

chapterRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	const chapter = await chapterService.getById(id);
	return c.json(chapter);
});

chapterRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const parsed = updateChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const chapter = await chapterService.update(id, parsed.data);
	return c.json(chapter);
});

chapterRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await chapterService.remove(id);
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
	const result = await chapterMerge.merge(id, parsed.data);
	return c.json(result);
});

chapterRoutes.post("/:id/ai-resolve", async (c) => {
	const id = c.req.param("id");
	const parsed = mergeChapterSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const result = await chapterMerge.aiResolveConflicts(id, parsed.data, locale);
	return c.json(result);
});

chapterRoutes.post("/:id/unmerge", async (c) => {
	const id = c.req.param("id");
	const result = await chapterMerge.unmerge(id);
	return c.json(result);
});

// === Dormant / Wake ===

chapterRoutes.post("/:id/dormant", async (c) => {
	const id = c.req.param("id");
	await chapterCleanup.dormant(id);
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
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const result = await chapterBatchMerge.run({ ...parsed.data, locale });
	return c.json(result, 201);
});

// === Podman ===

chapterRoutes.get("/podman/status", (c) => {
	const status = getPodmanStatus();
	const platform =
		process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
	return c.json({ ...status, platform });
});

chapterRoutes.post("/podman/install", requireAdmin, async (c) => {
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

	const proc = Bun.spawn(["sh", "-c", cmd], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;

	if (exitCode === 0) {
		resetPodmanCache();
		const status = getPodmanStatus();
		return c.json({ ok: true, ...status });
	}
	return c.json({ ok: false, error: (stderr || stdout).trim() }, 500);
});

// === Containers ===

chapterRoutes.get("/:id/compose-info", async (c) => {
	const id = c.req.param("id");
	const chapter = await chapterService.getById(id);
	if (!chapter.worktreePath) return c.json({ services: [] });
	const config = chapter.containerConfig as { composeFile?: string } | null;
	const composeFile = resolveComposeFile(chapter.worktreePath, config);
	if (!composeFile) return c.json({ services: [] });
	const services = parseComposeFile(chapter.worktreePath, composeFile);
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
	const id = c.req.param("id");
	await containerService.startChapterContainers(id);
	return c.json({ ok: true, status: "starting" });
});

chapterRoutes.post("/:id/containers/stop", async (c) => {
	const id = c.req.param("id");
	await containerService.stopChapterContainers(id);
	return c.json({ ok: true });
});

chapterRoutes.post("/:id/containers/pause", async (c) => {
	const id = c.req.param("id");
	await containerService.pauseChapterContainers(id);
	return c.json({ ok: true });
});

chapterRoutes.post("/:id/containers/unpause", async (c) => {
	const id = c.req.param("id");
	await containerService.unpauseChapterContainers(id);
	return c.json({ ok: true });
});

chapterRoutes.get("/:id/containers/logs", async (c) => {
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
