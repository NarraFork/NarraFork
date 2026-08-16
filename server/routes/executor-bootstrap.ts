/**
 * Public executor bootstrap endpoint.
 *
 * A machine being enrolled has no NarraFork session yet, so this route is mounted
 * before the global session gate and authorizes downloads with a single-use
 * ticket instead. The ticket grants exactly one action — fetch the executor
 * binary for one platform, once — and nothing else.
 *
 * Deliberately not reachable with a device token: that secret only participates
 * in the /ws/device nonce/HMAC handshake and never crosses the wire in plaintext.
 */

import { isExecutorPlatform } from "@shared/remote-executor";
import { Hono } from "hono";
import { getClientIp } from "../lib/client-ip";
import { RateLimitError, ValidationError } from "../lib/errors";
import { ExecutorDistributionError, ensureExecutorBinary } from "../lib/executor-binaries";
import { redeemExecutorTicket } from "../lib/executor-bootstrap-ticket";
import { logger } from "../lib/logger";

/** Per-IP download attempts allowed inside the window. */
const MAX_ATTEMPTS_PER_WINDOW = 20;
const RATE_WINDOW_MS = 60_000;
/** Bound the tracker so untrusted callers cannot grow it without limit. */
const MAX_TRACKED_IPS = 1_000;

interface AttemptWindow {
	count: number;
	resetAt: number;
}

const attempts = new Map<string, AttemptWindow>();

function consumeAttempt(ip: string, now = Date.now()): number {
	for (const [key, window] of attempts) {
		if (window.resetAt <= now) attempts.delete(key);
	}
	if (attempts.size >= MAX_TRACKED_IPS && !attempts.has(ip)) {
		// Prefer shedding the oldest window over refusing service outright.
		const oldest = [...attempts.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)[0];
		if (oldest) attempts.delete(oldest[0]);
	}
	const existing = attempts.get(ip);
	if (!existing || existing.resetAt <= now) {
		attempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return 0;
	}
	existing.count += 1;
	return existing.count > MAX_ATTEMPTS_PER_WINDOW ? existing.resetAt - now : 0;
}

/** Clear rate-limit state. Test-only seam. */
export function resetExecutorBootstrapRateLimit(): void {
	attempts.clear();
}

export const executorBootstrapRoutes = new Hono();

// GET /api/executor/download/:platform?ticket=<hex>
executorBootstrapRoutes.get("/download/:platform", async (c) => {
	const ip = getClientIp(c);
	const retryAfterMs = consumeAttempt(ip);
	if (retryAfterMs > 0) {
		throw new RateLimitError(
			"EXECUTOR_DOWNLOAD_RATE_LIMITED",
			retryAfterMs,
			"Too many executor download attempts. Please try again shortly.",
		);
	}

	const platform = c.req.param("platform");
	if (!isExecutorPlatform(platform)) {
		throw new ValidationError("Unknown executor platform");
	}

	const redemption = redeemExecutorTicket(c.req.query("ticket"), platform);
	if (!redemption.ok) {
		// One generic message: a caller without a valid ticket learns nothing about
		// which tickets exist. The reason is only logged server-side.
		logger.warn("Rejected executor download", { platform, reason: redemption.reason, ip });
		return c.json({ error: "Invalid or expired download ticket" }, 403);
	}

	try {
		const artifact = await ensureExecutorBinary(platform);
		const file = Bun.file(artifact.path);
		if (!(await file.exists())) {
			throw new ExecutorDistributionError("Executor binary disappeared from the local cache");
		}
		logger.info("Serving executor binary", {
			platform,
			version: artifact.version,
			deviceId: redemption.deviceId ?? undefined,
		});
		// Streamed rather than buffered: an ~8 MB read into the JS heap on the main
		// thread would compete with every other request.
		return new Response(file.stream(), {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": `attachment; filename="${artifact.filename}"`,
				"Content-Length": String(artifact.size),
				"X-Executor-Version": artifact.version,
				"X-Executor-SHA256": artifact.sha256,
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		if (error instanceof ExecutorDistributionError) {
			logger.warn("Executor binary unavailable", { platform, error: error.message });
			return c.json({ error: error.message }, 503);
		}
		throw error;
	}
});
