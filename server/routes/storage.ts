import { Hono } from "hono";
import { z } from "zod/v4";
import { requireAdmin } from "../middleware/auth";
import { databaseCleanupService } from "../services/database-cleanup-service";
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

const databaseCleanupTargetSchema = z.enum([
	"archivedSessions",
	"staleSessions",
	"apiRequestDumps",
]);

const databasePreviewSchema = z.object({
	target: databaseCleanupTargetSchema,
	olderThanDays: z.coerce.number().int().positive().max(3650).optional(),
	sampleLimit: z.coerce.number().int().min(0).max(25).optional(),
});

const databaseCleanupSchema = z.object({
	target: databaseCleanupTargetSchema,
	olderThanDays: z.coerce.number().int().positive().max(3650).optional(),
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

/**
 * POST /api/storage/database/preview — Preview database cleanup candidates (admin only).
 */
storageRoutes.post("/database/preview", requireAdmin, async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = databasePreviewSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid database cleanup preview request" }, 400);
	}
	const result = await databaseCleanupService.previewCleanup(parsed.data.target, {
		olderThanDays: parsed.data.olderThanDays,
		sampleLimit: parsed.data.sampleLimit,
	});
	return c.json(result);
});

/**
 * POST /api/storage/database/cleanup — Execute database cleanup (admin only).
 */
storageRoutes.post("/database/cleanup", requireAdmin, async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = databaseCleanupSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "Invalid database cleanup request" }, 400);
	}
	const result = await databaseCleanupService.executeCleanup(parsed.data.target, {
		olderThanDays: parsed.data.olderThanDays,
	});
	storageService.invalidateStorageCache();
	return c.json(result);
});

/**
 * POST /api/storage/database/vacuum — Run SQLite VACUUM to release reusable free pages.
 */
storageRoutes.post("/database/vacuum", requireAdmin, async (c) => {
	// Full VACUUM rebuilds the SQLite file and can monopolize Bun's JS thread for
	// a long time on multi-GB databases, blocking all other requests until it
	// finishes. This is a deliberate, admin-initiated maintenance action: the
	// operator explicitly clicks the button knowing the backend will pause. The
	// service serializes it behind the database-maintenance lock and checkpoints
	// the WAL before/after so the freed space is actually returned to disk.
	const result = await databaseCleanupService.vacuumDatabase();
	storageService.invalidateStorageCache();
	return c.json(result);
});
