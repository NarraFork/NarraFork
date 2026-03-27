/**
 * Update API routes for delta updates.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { APP_VERSION } from "../lib/version";
import {
	applyUpdate,
	checkForUpdate,
	cleanupOldUpdates,
	downloadUpdate,
	getUpdateDirectory,
	getUpdateInstructions,
	getUpdateStatus,
	type ReleaseInfo,
	type UpdateProgress,
} from "../services/update-service";

export const updateRoutes = new Hono();

/**
 * GET /api/update/check
 * Check for available updates.
 */
updateRoutes.get("/check", async (c) => {
	const result = await checkForUpdate();
	return c.json(result);
});

/**
 * GET /api/update/version
 * Get current version info.
 */
updateRoutes.get("/version", (c) => {
	return c.json({
		version: APP_VERSION,
		platform: process.platform,
		arch: process.arch,
	});
});

/**
 * POST /api/update/download
 * Download an update. Streams progress via SSE.
 * The frontend sends a minimal releaseInfo, but we re-fetch the full check
 * to get _v2 URLs (zstd patch, patch chain).
 */
updateRoutes.post("/download", async (c) => {
	let clientReleaseInfo: ReleaseInfo | undefined;
	try {
		const body = await c.req.json();
		clientReleaseInfo = body?.releaseInfo;
	} catch {
		// Empty body is OK — we'll re-check
	}

	// Re-check to get full releaseInfo with _v2 URLs
	const checkResult = await checkForUpdate();
	const releaseInfo = checkResult.releaseInfo ?? clientReleaseInfo;

	if (!releaseInfo) {
		return c.json({ error: "No update available" }, 404);
	}

	return streamSSE(c, async (stream) => {
		const onProgress = (progress: UpdateProgress) => {
			stream.writeSSE({
				event: "progress",
				data: JSON.stringify(progress),
			});
		};

		const result = await downloadUpdate(releaseInfo, onProgress);

		if (result.success && result.updatePath) {
			const instructions = getUpdateInstructions(result.updatePath);
			await stream.writeSSE({
				event: "complete",
				data: JSON.stringify({
					success: true,
					updatePath: result.updatePath,
					instructions,
				}),
			});
		} else {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					success: false,
					error: result.error,
				}),
			});
		}
	});
});

/**
 * POST /api/update/cleanup
 * Clean up old update files.
 */
updateRoutes.post("/cleanup", (c) => {
	cleanupOldUpdates();
	return c.json({ success: true });
});

/**
 * GET /api/update/directory
 * Get the update download directory.
 */
updateRoutes.get("/directory", (c) => {
	return c.json({ directory: getUpdateDirectory() });
});

/**
 * GET /api/update/status
 * Check if an update is downloaded and ready to apply.
 */
updateRoutes.get("/status", (c) => {
	return c.json(getUpdateStatus());
});

/**
 * POST /api/update/apply
 * Move the downloaded update next to the current binary and exit.
 * The user needs to start the new binary manually.
 */
updateRoutes.post("/apply", (c) => {
	const result = applyUpdate();
	return c.json(result);
});
