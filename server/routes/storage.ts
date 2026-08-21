import { Hono } from "hono";
import { z } from "zod/v4";
import { requireAdmin } from "../middleware/auth";
import { databaseCleanupService } from "../services/database-cleanup-service";
import {
	cancelStorageScan,
	getStorageScanJob,
	startStorageScan,
} from "../services/storage-scan-job";
import { storageService } from "../services/storage-service";

export const storageRoutes = new Hono();

/**
 * POST /api/storage/scan/start — Kick off a storage scan as a server-side background job
 * (admin only). Scanning is decoupled from the HTTP connection: the client may navigate
 * away and the scan still runs to completion and populates the shared cache. Concurrent
 * calls dedupe onto the in-flight job (`started: false`).
 */
storageRoutes.post("/scan/start", requireAdmin, (c) => {
	const { started, state } = startStorageScan();
	return c.json({ started, state });
});

/**
 * GET /api/storage/scan/status — Poll the background scan job (admin only).
 */
storageRoutes.get("/scan/status", requireAdmin, (c) => {
	return c.json({ state: getStorageScanJob() });
});

/**
 * POST /api/storage/scan/cancel — Abort the running scan job, if any (admin only).
 */
storageRoutes.post("/scan/cancel", requireAdmin, async (c) => {
	// Awaited: `abort()` alone leaves the state at `running`, so the response would
	// report the very status the caller just cancelled. The service waits (briefly,
	// bounded) for the scan to reach its terminal state before answering.
	return c.json({ state: await cancelStorageScan() });
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
	target: z.enum(["uploads", "chatAttachments", "shares", "worktrees", "containers"]),
});

const databaseCleanupTargetSchema = z.enum([
	"archivedSessions",
	"staleSessions",
	"apiRequestDumps",
	"toolCallPayloads",
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
		case "chatAttachments": {
			const result = await storageService.cleanupOrphanedChatAttachments();
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
 *
 * This is a deliberate service-wide maintenance window, not ordinary CRUD: the
 * administrator explicitly confirms it, and normal HTTP/WS/Agent activity may pause
 * until the synchronous database rebuild finishes.
 */
storageRoutes.post("/database/vacuum", requireAdmin, async (c) => {
	// Keep this synchronous by design. `requireAdmin` plus explicit UI confirmation
	// make the availability trade-off intentional; do not move it to a worker or hide
	// it behind a generic capability fallback unless the maintenance-window contract
	// changes. The service serializes VACUUM behind its maintenance lock and checkpoints
	// the WAL before and after so reusable pages are returned to disk.
	const result = await databaseCleanupService.vacuumDatabase();
	storageService.invalidateStorageCache();
	return c.json(result);
});
