/**
 * Update API routes for delta updates.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { APP_VERSION } from "../lib/version";
import {
	checkForUpdate,
	cleanupOldUpdates,
	downloadUpdate,
	getUpdateDirectory,
	getUpdateInstructions,
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
 */
updateRoutes.post("/download", async (c) => {
	const body = await c.req.json();
	const { releaseInfo } = body;

	if (!releaseInfo) {
		return c.json({ error: "Missing releaseInfo" }, 400);
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
