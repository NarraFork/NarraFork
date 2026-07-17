/**
 * Update API routes for delta updates.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { APP_VERSION } from "../lib/version";
import { requireAdmin, requireAuth } from "../middleware/auth";
import {
	applyUpdate,
	checkForUpdate,
	cleanupOldUpdates,
	downloadUpdate,
	getUpdateDirectory,
	getUpdateInstructions,
	getUpdateStatus,
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
 * The frontend may send the version it expects, but all release metadata and
 * patch URLs are re-fetched from the configured update server.
 */
updateRoutes.post("/download", requireAuth, requireAdmin, async (c) => {
	let requestedVersion: string | undefined;
	let retry = false;
	try {
		const body = await c.req.json();
		const version = body?.releaseInfo?.version;
		if (typeof version === "string" && version.trim()) requestedVersion = version.trim();
		retry = body?.retry === true;
	} catch {
		// Empty body is OK — we'll re-check and use server-side release metadata.
	}

	// Re-check to get full releaseInfo with trusted _v2 URLs. Never trust client-supplied URLs.
	const checkResult = await checkForUpdate();
	const releaseInfo = checkResult.releaseInfo;

	if (!releaseInfo) {
		return c.json({ error: "No update available" }, 404);
	}
	if (requestedVersion && requestedVersion !== releaseInfo.version) {
		return c.json(
			{
				error: "Requested update version no longer matches the latest server metadata",
				requestedVersion,
				latestVersion: releaseInfo.version,
			},
			409,
		);
	}

	return streamSSE(c, async (stream) => {
		const onProgress = (progress: UpdateProgress) => {
			stream.writeSSE({
				event: "progress",
				data: JSON.stringify(progress),
			});
		};

		const result = await downloadUpdate(releaseInfo, onProgress, { forceDownload: retry });

		if (result.success && result.updatePath) {
			const instructions = getUpdateInstructions(result.updatePath, result.newBinaryPath);
			await stream.writeSSE({
				event: "complete",
				data: JSON.stringify({
					success: true,
					version: result.version ?? releaseInfo.version,
					updatePath: result.updatePath,
					newBinaryPath: result.newBinaryPath,
					placed: result.placed,
					instructions,
				}),
			});
		} else {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					success: false,
					version: releaseInfo.version,
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
updateRoutes.post("/cleanup", requireAuth, requireAdmin, (c) => {
	cleanupOldUpdates();
	return c.json({ success: true });
});

/**
 * GET /api/update/directory
 * Get the update download directory.
 */
updateRoutes.get("/directory", requireAuth, requireAdmin, (c) => {
	return c.json({ directory: getUpdateDirectory() });
});

/**
 * GET /api/update/status
 * Check if an update is downloaded and ready to apply.
 */
updateRoutes.get("/status", requireAuth, requireAdmin, (c) => {
	const targetVersion = c.req.query("version") || undefined;
	return c.json(getUpdateStatus(targetVersion));
});

/**
 * POST /api/update/apply
 * Schedule the downloaded update. The response returns immediately while the
 * server drains active Bash/subagent executions before starting the replacement.
 */
updateRoutes.post("/apply", requireAuth, requireAdmin, async (c) => {
	let targetVersion: string | undefined;
	try {
		const body = await c.req.json();
		if (typeof body?.version === "string" && body.version.trim()) {
			targetVersion = body.version.trim();
		}
	} catch {
		// Empty body is OK; applyUpdate still validates the prepared update metadata.
	}
	const result = applyUpdate({ targetVersion });
	return c.json(result);
});
