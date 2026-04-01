import { Hono } from "hono";
import { z } from "zod/v4";
import { requireAdmin } from "../middleware/auth";
import { runtimeService } from "../services/runtime-service";

export const runtimeRoutes = new Hono();

/**
 * GET /api/runtime/scan — Scan all runtime resources (admin only).
 */
runtimeRoutes.get("/scan", requireAdmin, async (c) => {
	const result = await runtimeService.scanRuntime();
	return c.json(result);
});

/**
 * GET /api/runtime/cached — Return cached scan result if available (admin only).
 */
runtimeRoutes.get("/cached", requireAdmin, (c) => {
	const cached = runtimeService.getCachedResult();
	if (!cached) {
		return c.json({ cached: false });
	}
	return c.json({ cached: true, data: cached });
});

const cleanupTargetSchema = z.object({
	target: z.enum(["terminals", "containers", "browsers"]),
});

/**
 * POST /api/runtime/cleanup — Execute cleanup for a specific target (admin only).
 */
runtimeRoutes.post("/cleanup", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = cleanupTargetSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid target" }, 400);
	}

	const { target } = parsed.data;

	switch (target) {
		case "terminals": {
			const result = await runtimeService.cleanupTerminals();
			return c.json({ ok: true, ...result });
		}
		case "containers": {
			const result = await runtimeService.cleanupContainers();
			return c.json({ ok: true, ...result });
		}
		case "browsers": {
			const result = await runtimeService.cleanupBrowsers();
			return c.json({ ok: true, ...result });
		}
	}
});
