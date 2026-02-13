import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	batchCleanupSchema,
	batchMergeSchema,
	createChapterSchema,
	forkChapterSchema,
	mergeChapterSchema,
	updateChapterSchema,
} from "../lib/validators";
import { chapterBatchMerge } from "../services/chapter-batch-merge";
import { chapterCleanup } from "../services/chapter-cleanup";
import { chapterFork } from "../services/chapter-fork";
import { chapterMerge } from "../services/chapter-merge";
import { chapterService } from "../services/chapter-service";

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
	const chapter = await chapterFork.fork(id, parsed.data);
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
	const result = await chapterMerge.aiResolveConflicts(id, parsed.data);
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
	const result = await chapterBatchMerge.run(parsed.data);
	return c.json(result, 201);
});
