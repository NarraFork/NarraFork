import { Hono } from "hono";
import { z } from "zod/v4";
import { requireAdmin } from "../middleware/auth";
import { storageService } from "../services/storage-service";

export const storageRoutes = new Hono();

/**
 * GET /api/storage/scan — SSE stream that scans all storage categories (admin only).
 * Events: progress (status message), category (scan result), complete, error.
 */
storageRoutes.get("/scan", requireAdmin, async (_c) => {
	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event:${event}\ndata:${JSON.stringify(data)}\n\n`));
			};

			try {
				const gen = storageService.scanStorage();
				let finalResult: unknown = null;

				for (;;) {
					const { value, done } = await gen.next();
					if (done) {
						finalResult = value;
						break;
					}
					if (value.type === "progress") {
						send("progress", { message: value.message });
					} else if (value.type === "category") {
						send("category", value.data);
					}
				}

				send("complete", finalResult);
			} catch (err) {
				send("error", { error: String(err) });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
});

/**
 * GET /api/storage/cached — Return cached scan result if available (admin only).
 */
storageRoutes.get("/cached", requireAdmin, (c) => {
	const cached = storageService.getCachedScanResult();
	if (!cached) {
		return c.json({ cached: false });
	}
	return c.json({ cached: true, data: cached });
});

const cleanupTargetSchema = z.object({
	target: z.enum(["uploads", "shares", "worktrees", "containers"]),
});

/**
 * POST /api/storage/cleanup — Execute cleanup for a specific target (admin only).
 */
storageRoutes.post("/cleanup", requireAdmin, async (c) => {
	const body = await c.req.json();
	const parsed = cleanupTargetSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid target" }, 400);
	}

	const { target } = parsed.data;

	switch (target) {
		case "uploads": {
			const result = await storageService.cleanupOrphanedUploads();
			return c.json({ ok: true, ...result });
		}
		case "shares": {
			const result = await storageService.cleanupAllShares();
			return c.json({ ok: true, ...result });
		}
		case "worktrees": {
			const result = await storageService.cleanupOrphanedWorktrees();
			return c.json({ ok: true, ...result });
		}
		case "containers": {
			const result = await storageService.pruneContainerImages();
			return c.json({ ok: true, ...result });
		}
	}
});
