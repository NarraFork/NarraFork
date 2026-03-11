import { Hono } from "hono";
import { logger } from "../lib/logger";
import { reviewService } from "../services/review-service";

export const reviewsRouter = new Hono();

// POST /api/chapters/:id/review — Create a review node for a chapter
// (This is mounted on the chapters router, not here — see chapters.ts)
// The routes below handle review-specific operations.

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
