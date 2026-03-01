import { ValidationError } from "@server/lib/errors";
import { createChapterEdgeSchema } from "@server/lib/validators";
import { chapterEdgeService } from "@server/services/chapter-edge-service";
import { Hono } from "hono";

const app = new Hono();

// GET / — 列表（?projectId=&chapterId=&type=）
app.get("/", async (c) => {
	const projectId = c.req.query("projectId");
	const chapterId = c.req.query("chapterId");
	const type = c.req.query("type");

	if (chapterId) {
		const edges = await chapterEdgeService.getEdgesByChapter(chapterId);
		return c.json(edges);
	}
	if (projectId) {
		if (type) {
			const validTypes = ["fork", "merge", "dependency", "cherry_pick"] as const;
			if (!validTypes.includes(type as (typeof validTypes)[number])) {
				throw new ValidationError(`Invalid type: ${type}`);
			}
			const edges = await chapterEdgeService.getEdgesByType(
				projectId,
				type as "fork" | "merge" | "dependency" | "cherry_pick",
			);
			return c.json(edges);
		}
		const edges = await chapterEdgeService.getEdgesByProject(projectId);
		return c.json(edges);
	}
	throw new ValidationError("projectId or chapterId required");
});

// POST / — 创建边（仅 dependency）
app.post("/", async (c) => {
	const body = await c.req.json();
	const parsed = createChapterEdgeSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.message);
	}
	const edge = await chapterEdgeService.createDependencyEdge(parsed.data);
	return c.json(edge, 201);
});

// DELETE /:id — 删除边（仅 dependency）
app.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await chapterEdgeService.deleteEdge(id);
	return c.json({ ok: true });
});

export default app;
