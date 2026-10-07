/**
 * Update API routes for delta updates.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { APP_VERSION } from "../lib/version";
import { requireAdmin, requireAuth } from "../middleware/auth";
import {
	applyUpdate,
	cancelPreparedUpdate,
	checkForUpdate,
	cleanupOldUpdates,
	downloadUpdate,
	getUpdateDirectory,
	getUpdateInstructions,
	getUpdateStatus,
	isUpdateSourceCurrent,
	shutdownForManualUpdate,
	type UpdateProgress,
} from "../services/update-service";

export const updateRoutes = new Hono();

class DownloadRequestError extends Error {
	constructor(
		message: string,
		public readonly status: 400 | 408 | 413,
	) {
		super(message);
	}
}

/** Identity-only requests must not accept unbounded client-supplied release metadata. */
async function readDownloadRequest(request: Request): Promise<Record<string, unknown> | null> {
	if (!request.body) return null;
	const maxBytes = 64 * 1024;
	if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
		throw new DownloadRequestError("Update request exceeds 64 KiB", 413);
	}
	const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw new DownloadRequestError("Update request body timed out", 408);
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new DownloadRequestError("Update request exceeds 64 KiB", 413);
			chunks.push(value);
		}
		if (signal.aborted) throw new DownloadRequestError("Update request body timed out", 408);
		if (!bytes) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
		} catch {
			throw new DownloadRequestError("Invalid update request JSON", 400);
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new DownloadRequestError("Update request must be a JSON object", 400);
		}
		return parsed as Record<string, unknown>;
	} finally {
		signal.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
	}
}

/**
 * GET /api/update/check
 * Check for available updates.
 *
 * Admin-only because this reaches out to the configured update server: an unauthenticated caller
 * could otherwise make the deployment emit outbound requests on demand, and the reply exposes
 * release metadata and download URLs. Every caller in the UI already sits behind the login gate,
 * and acting on the result (`/download`, `/apply`) is admin-only anyway.
 */
updateRoutes.get("/check", requireAuth, requireAdmin, async (c) => {
	const result = await checkForUpdate();
	return c.json(result);
});

/**
 * GET /api/update/version
 * Get current version info.
 *
 * Authenticated but not admin-gated: the build identity is useful to any signed-in user and is
 * purely local. It stays reachable without admin so a non-admin session can still tell which
 * build it is talking to. Unauthenticated clients that need this during startup should keep
 * using the public `/api/health`, which already reports version and platform.
 */
updateRoutes.get("/version", requireAuth, (c) => {
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
	let requestedSource: string | undefined;
	let requestedRepository: string | undefined;
	let retry = false;
	try {
		const body = await readDownloadRequest(c.req.raw);
		const info = body?.releaseInfo;
		const version =
			info && typeof info === "object" && "version" in info ? info.version : undefined;
		if (typeof version === "string" && version.trim()) requestedVersion = version.trim();
		if (typeof body?.source === "string") requestedSource = body.source;
		if (typeof body?.repository === "string") requestedRepository = body.repository;
		retry = body?.retry === true;
	} catch (error) {
		if (error instanceof DownloadRequestError)
			return c.json({ error: error.message }, error.status);
		return c.json({ error: "Could not read update request" }, 400);
	}

	// Force a fresh conditional check: only server-resolved URLs may deliver executable code.
	const checkResult = await checkForUpdate({ force: true });
	if (
		(requestedSource && requestedSource !== checkResult.source) ||
		(requestedRepository &&
			requestedRepository.toLowerCase() !== checkResult.repository?.toLowerCase())
	) {
		return c.json(
			{
				error: "Update source changed; check for updates again",
				errorCode: "UPDATE_SOURCE_CHANGED",
			},
			409,
		);
	}
	const releaseInfo = checkResult.releaseInfo;

	if (!releaseInfo) {
		if (checkResult.errorCode) {
			return c.json(
				{
					error: checkResult.error,
					errorCode: checkResult.errorCode,
					retryAfter: checkResult.retryAfter,
				},
				checkResult.errorCode === "NO_RELEASE" ? 404 : 503,
			);
		}
		return c.json({ error: "No update available" }, 404);
	}
	if (!isUpdateSourceCurrent(releaseInfo)) {
		return c.json(
			{
				error: "Update source changed during detection; check for updates again",
				errorCode: "UPDATE_SOURCE_CHANGED",
			},
			409,
		);
	}
	if (requestedVersion && requestedVersion !== releaseInfo.version) {
		return c.json(
			{
				error: "Requested update version no longer matches the latest server metadata",
				errorCode: "UPDATE_VERSION_CHANGED",
				requestedVersion,
				latestVersion: releaseInfo.version,
			},
			409,
		);
	}

	return streamSSE(c, async (stream) => {
		// At most one write and one latest snapshot: a slow SSE client must not build an
		// unbounded queue of increasingly stale download progress events.
		let pendingProgress: UpdateProgress | undefined;
		let progressWrite: Promise<void> | undefined;
		let progressError: unknown;
		const flushProgress = (): Promise<void> => {
			if (progressWrite) return progressWrite;
			progressWrite = (async () => {
				while (pendingProgress) {
					const progress = pendingProgress;
					pendingProgress = undefined;
					await stream.writeSSE({ event: "progress", data: JSON.stringify(progress) });
				}
			})()
				.catch((error) => {
					progressError = error;
					pendingProgress = undefined;
				})
				.finally(() => {
					progressWrite = undefined;
				});
			return progressWrite;
		};
		const onProgress = (progress: UpdateProgress) => {
			if (progressError) return;
			pendingProgress = progress;
			void flushProgress();
		};

		// A client that cancels its own fetch must also stop the server-side work; without this
		// the download and patch application keep running with nobody listening.
		const abort = new AbortController();
		stream.onAbort(() => abort.abort());

		const result = await downloadUpdate(releaseInfo, onProgress, {
			forceDownload: retry,
			signal: abort.signal,
		});

		while (progressWrite || pendingProgress) await flushProgress();
		if (progressError) return;
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
updateRoutes.get("/status", requireAuth, requireAdmin, async (c) => {
	const targetVersion = c.req.query("version") || undefined;
	return c.json(await getUpdateStatus(targetVersion));
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
	const result = await applyUpdate({ targetVersion });
	return c.json(result);
});

/**
 * POST /api/update/cancel
 * Abandon a scheduled update that is still waiting for narrator work to reach a safe point.
 *
 * The coordination waits are unbounded on purpose, so this is the operator's escape hatch.
 * Paused tool calls resume and the prepared binary stays in place for a later attempt.
 * Once the replacement process has been spawned (`restarting`) there is nothing to cancel.
 */
updateRoutes.post("/cancel", requireAuth, requireAdmin, (c) => {
	const { cancelled, status } = cancelPreparedUpdate("Cancelled from the update dialog");
	return c.json({ success: true, cancelled, ...status });
});

/**
 * POST /api/update/shutdown
 * Stop this server now so the administrator can start the downloaded version themselves.
 *
 * The counterpart to `/apply` for users who do not want to wait for narrator work to drain. The
 * response is returned first and teardown begins a moment later, because teardown terminates
 * in-flight requests — including this one.
 *
 * The operator-shutdown registry owns the response grace window atomically, so concurrent
 * callers cannot promise a new recovery preparation before this teardown begins.
 */
updateRoutes.post("/shutdown", requireAuth, requireAdmin, (c) => {
	const result = shutdownForManualUpdate({ reason: "operator_requested" });
	return c.json(result, result.success ? 200 : 409);
});
