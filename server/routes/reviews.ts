import { Hono } from "hono";
import { logger } from "../lib/logger";
import { reviewService } from "../services/review-service";

export const reviewsRouter = new Hono();

// POST /api/chapters/:id/review — Create a review node for a chapter
// (This is mounted on the chapters router, not here — see chapters.ts)
// The routes below handle review-specific operations.

// GET /api/reviews/:id/conclusion — Get the structured review conclusion
reviewsRouter.get("/:id/conclusion", async (c) => {
	const reviewChapterId = c.req.param("id");
	const conclusion = await reviewService.getConclusion(reviewChapterId);
	if (!conclusion) {
		return c.json({ conclusion: null });
	}
	return c.json({ conclusion });
});

// GET /api/reviews/by-source/:sourceChapterId/conclusion — Get latest conclusion for a source chapter
reviewsRouter.get("/by-source/:sourceChapterId/conclusion", async (c) => {
	const sourceChapterId = c.req.param("sourceChapterId");
	const conclusion = await reviewService.getLatestConclusionForSource(sourceChapterId);
	return c.json({ conclusion: conclusion ?? null });
});

// POST /api/reviews/:id/convert-to-subagent
reviewsRouter.post("/:id/convert-to-subagent", async (c) => {
	const reviewChapterId = c.req.param("id");
	const userId = c.get("user").sub;
	logger.info("Review convert-to-subagent requested", { reviewChapterId, userId });
	const narrator = await reviewService.convertToSubagent(reviewChapterId);
	return c.json({ narrator });
});

// POST /api/reviews/:id/promote
reviewsRouter.post("/:id/promote", async (c) => {
	const reviewChapterId = c.req.param("id");
	const userId = c.get("user").sub;
	logger.info("Review promote requested", { reviewChapterId, userId });
	const chapter = await reviewService.promoteToChapter(reviewChapterId);
	return c.json({ chapter });
});

// POST /api/reviews/:id/dismiss
reviewsRouter.post("/:id/dismiss", async (c) => {
	const reviewChapterId = c.req.param("id");
	const userId = c.get("user").sub;
	logger.info("Review dismiss requested", { reviewChapterId, userId });
	await reviewService.dismissReview(reviewChapterId);
	return c.json({ success: true });
});
