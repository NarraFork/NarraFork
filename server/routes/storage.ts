import { STORAGE_CATEGORY_KEYS } from "@shared/storage-categories";
import { Hono } from "hono";
import { z } from "zod/v4";
import { requireAdmin } from "../middleware/auth";
import { databaseCleanupService } from "../services/database-cleanup-service";
import {
	blockBackfillStatus,
	setBlockBackfillPaused,
	startProjectionJob,
	stopProjectionJobs,
} from "../services/narrator-block-backfill";
import {
	cancelStorageScan,
	getStorageScanJob,
	startStorageScan,
} from "../services/storage-scan-job";
import { storageService } from "../services/storage-service";

export const storageRoutes = new Hono();

const scanSelectionSchema = z.object({
	categories: z.array(z.enum(STORAGE_CATEGORY_KEYS)).min(1).optional(),
});

/**
 * POST /api/storage/scan/start — Kick off category scans as server-side background work
 * (admin only). Omit `categories` to start every category. They run together; a category
 * that is already running is left alone (`started` is false only when nothing new began).
 * Scanning is decoupled from the HTTP connection.
 */
storageRoutes.post("/scan/start", requireAdmin, async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = scanSelectionSchema.safeParse(body ?? {});
	if (!parsed.success) return c.json({ error: "Invalid scan request" }, 400);
	const { started, state } = startStorageScan(parsed.data);
	return c.json({ started, state });
});

/**
 * GET /api/storage/scan/status — Poll every category job (admin only).
 */
storageRoutes.get("/scan/status", requireAdmin, (c) => {
	return c.json({ state: getStorageScanJob() });
});

/**
 * POST /api/storage/scan/cancel — Abort running category scans (admin only).
 * Omit `categories` to abort every running category.
 */
storageRoutes.post("/scan/cancel", requireAdmin, async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = scanSelectionSchema.safeParse(body ?? {});
	if (!parsed.success) return c.json({ error: "Invalid scan request" }, 400);
	// Awaited: `abort()` alone leaves the category at `running`, so the response would
	// report the very status the caller just cancelled. The service waits (briefly,
	// bounded) for those categories to reach a terminal state before answering.
	return c.json({ state: await cancelStorageScan(parsed.data) });
});

/**
 * GET /api/storage/blocks/backfill — Progress of the background block jobs that convert
 * older messages to block storage and check converted ones (admin only).
 */
storageRoutes.get("/blocks/backfill", requireAdmin, (c) => {
	return c.json({ status: blockBackfillStatus() });
});

const backfillPauseSchema = z.object({ paused: z.boolean() });

/**
 * POST /api/storage/blocks/backfill/pause — Pause (`{ paused: true }`) or resume the block
 * jobs (admin only). Resuming restarts them from their saved position.
 */
storageRoutes.post("/blocks/backfill/pause", requireAdmin, async (c) => {
	const parsed = backfillPauseSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: "Invalid pause request" }, 400);
	return c.json({ status: setBlockBackfillPaused(parsed.data.paused) });
});

const projectionSchema = z.object({ action: z.enum(["clear", "restore", "stop"]) });

/**
 * POST /api/storage/blocks/projection — Start the job that drops verified messages'
 * duplicate `content_json` (`clear`, needs `narratorBlocks.compactJson`), the one that
 * writes it back (`restore`, needs the switch off), or stop either (admin only). 409 when
 * what the job needs is missing; the status names it.
 */
storageRoutes.post("/blocks/projection", requireAdmin, async (c) => {
	const parsed = projectionSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: "Invalid projection request" }, 400);
	const { action } = parsed.data;
	return c.json({ status: action === "stop" ? stopProjectionJobs() : startProjectionJob(action) });
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
			const result = await storageService.repackTreeSnapshots();
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
 * POST /api/storage/database/legacy-request-dumps/clear — Clear request dumps an upgrade kept
 * when it deferred migration 0207's column rewrites (admin only).
 */
storageRoutes.post("/database/legacy-request-dumps/clear", requireAdmin, async (c) => {
	const result = await databaseCleanupService.clearLegacyRequestDumps();
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
