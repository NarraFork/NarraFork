import { Hono } from "hono";
import { NotFoundError } from "../lib/errors";
import { requireNarratorAccess } from "../lib/narrator-access";
import {
	narratorTimelineQuerySchema,
	narratorTimelineTurnsQuerySchema,
} from "../lib/validators/narrator-timeline";
import { getTurnTimeline, listTimelineTurns } from "../services/narrator-timeline";

/**
 * Native session timeline (read-only). Mounted under `/api/narrators` in its own file,
 * so it carries its own access gate rather than relying on `routes/narrators.ts`.
 */
export const narratorTimelineRoutes = new Hono();

narratorTimelineRoutes.use("/:id/timeline/*", async (c, next) => {
	await requireNarratorAccess(c, c.req.param("id") ?? "", "read");
	return next();
});
narratorTimelineRoutes.use("/:id/timeline", async (c, next) => {
	await requireNarratorAccess(c, c.req.param("id") ?? "", "read");
	return next();
});

/** GET /:id/timeline/turns — newest-first page of turns (`before` = startedAt cursor). */
narratorTimelineRoutes.get("/:id/timeline/turns", async (c) => {
	const query = narratorTimelineTurnsQuerySchema.parse(c.req.query());
	return c.json(await listTimelineTurns(c.req.param("id"), query));
});

/** GET /:id/timeline?turnId= — lanes of one turn; the latest turn when omitted. */
narratorTimelineRoutes.get("/:id/timeline", async (c) => {
	const narratorId = c.req.param("id");
	const { turnId } = narratorTimelineQuerySchema.parse(c.req.query());
	const timeline = await getTurnTimeline(narratorId, turnId);
	if (!timeline) throw new NotFoundError("Timeline turn", turnId ?? narratorId);
	return c.json(timeline);
});
