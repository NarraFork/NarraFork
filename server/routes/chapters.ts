import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/prompt-i18n";
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
import { chapterBatchMerge } from "../services/chapter-batch-merge";
import { chapterCleanup } from "../services/chapter-cleanup";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";
import { containerService } from "../services/container-service";

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

// === Containers ===

chapterRoutes.get("/:id/containers", async (c) => {
	const id = c.req.param("id");
	const instances = await containerService.listByChapter(id);
	return c.json(instances);
});

chapterRoutes.post("/:id/containers/start", async (c) => {
	const id = c.req.param("id");
	await containerService.startChapterContainers(id);
	return c.json({ ok: true });
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

	const chapter = await chapterService.getById(id);

	const project = await db.select().from(projects).where(eq(projects.id, chapter.projectId)).get();
	if (!project?.gitPath) throw new ValidationError("Project has no git path");

	const cwd = chapter.worktreePath || project.gitPath;
	const args = ["log", `--max-count=${query.limit}`, "--format=%H|%s|%aI"];
	if (query.since) args.push(`${query.since}..HEAD`);

	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) {
		throw new ValidationError(`git log failed: ${result.stderr.toString().trim()}`);
	}
	const stdout = result.stdout.toString().trim();
	if (!stdout) return c.json([]);

	const commits = stdout.split("\n").map((line) => {
		const [sha, message, date] = line.split("|", 3);
		return { sha, message, date };
	});
	return c.json(commits);
});
