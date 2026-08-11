import { ValidationError } from "@server/lib/errors";
import { chapterEdgeService } from "@server/services/chapter-edge-service";
import { Hono } from "hono";

const app = new Hono();

/**
 * Read-only. Chapter edges are all derived from operations that own their own routes:
 * fork edges come from `chapter-fork`/`chapter-split`, merge edges from `chapter-merge`,
 * review edges from `review-service`. None of them are user-authored, so there is nothing
 * here to create or delete.
 *
 * `POST /` and `DELETE /:id` used to exist for `dependency` edges, which the user drew by
 * dragging between two nodes. That edge type has been removed: nothing read it, so it only
 * ever painted an orange dashed line. See `chapter-edge-service.ts` for the full reasoning.
 */

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
			const validTypes = ["fork", "merge", "review"] as const;
			if (!validTypes.includes(type as (typeof validTypes)[number])) {
				throw new ValidationError(`Invalid type: ${type}`);
			}
			const edges = await chapterEdgeService.getEdgesByType(
				projectId,
				type as "fork" | "merge" | "review",
			);
			return c.json(edges);
		}
		const edges = await chapterEdgeService.getEdgesByProject(projectId);
		return c.json(edges);
	}
	throw new ValidationError("projectId or chapterId required");
});

export default app;
