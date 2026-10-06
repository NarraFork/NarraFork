/**
 * Public executor bootstrap endpoints.
 *
 * A machine being enrolled has no NarraFork session yet, so these routes are
 * mounted before the global session gate and authorize with a single enrollment
 * ticket instead. Three narrowly scoped actions, all bound to one platform:
 *
 * - `GET  /install/:platform` — the install script body. Exists so the operator can
 *   paste one command instead of a 200-line script.
 * - `GET  /download/:platform` — the executor binary.
 * - `POST /enroll/:platform`  — exchange the ticket for the device key, once.
 *
 * The enroll endpoint is the only place in the system where a device key crosses
 * the wire in plaintext (everywhere else it only participates in the `/ws/device`
 * nonce/HMAC handshake), so it additionally requires a transport the key can
 * survive — see `executor-enrollment-policy.ts`. It is checked here rather than at
 * issue time as well, because the origin a request actually arrives on is the only
 * thing that reflects how the key will really travel.
 */

import { isExecutorPlatform } from "@shared/remote-executor";
import { type Context, Hono } from "hono";
import { getClientIp } from "../lib/client-ip";
import { RateLimitError, ValidationError } from "../lib/errors";
import { ExecutorDistributionError, ensureExecutorBinary } from "../lib/executor-binaries";
import { type ExecutorTicketPurpose, redeemExecutorTicket } from "../lib/executor-bootstrap-ticket";
import {
	enrollmentRefusalMessage,
	evaluateEnrollmentTransport,
} from "../lib/executor-enrollment-policy";
import { logger } from "../lib/logger";
import { resolvePublicOrigin } from "../lib/public-origin";
import { settings } from "../lib/settings";
import { enrollDeviceToken } from "../services/device-service";

/**
 * Per-IP attempts allowed inside the window, across all bootstrap endpoints.
 *
 * One successful install spends 3 (script + binary + token), but the limit is not
 * sized for one machine: enrolling several hosts behind a single NAT egress — the
 * typical LAN deployment — makes them share this counter, and at 20 the sixth
 * concurrent install would fail with a message about rate limits that has nothing
 * to do with the operator's ticket.
 *
 * 90 covers ~30 machines per minute from one address. The counter is not the
 * security boundary in the first place: every endpoint requires an unguessable
 * 32-byte ticket, so this only bounds brute-force noise and tracker growth.
 */
const MAX_ATTEMPTS_PER_WINDOW = 90;
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

/**
 * Shared front half of every bootstrap request: rate limit, platform parse, ticket
 * redemption.
 *
 * Returns a discriminated result rather than throwing, because a rejected ticket
 * must produce one generic message: a caller without a valid ticket should learn
 * nothing about which tickets exist. The specific reason is logged server-side
 * only.
 */
function authorize(c: Context, purpose: ExecutorTicketPurpose) {
	const ip = getClientIp(c);
	const retryAfterMs = consumeAttempt(ip);
	if (retryAfterMs > 0) {
		throw new RateLimitError(
			"EXECUTOR_BOOTSTRAP_RATE_LIMITED",
			retryAfterMs,
			"Too many executor bootstrap attempts. Please try again shortly.",
		);
	}

	const platform = c.req.param("platform") ?? "";
	if (!isExecutorPlatform(platform)) {
		throw new ValidationError("Unknown executor platform");
	}

	const redemption = redeemExecutorTicket(c.req.query("ticket"), platform, purpose, {
		ip,
		userAgent: c.req.header("User-Agent") ?? null,
	});
	return { ip, platform, redemption } as const;
}

/**
 * Log fields for a rejected redemption.
 *
 * A rejection is generic to the caller, so the log is the only place the reason
 * exists. When the ticket was already spent it also names WHO spent it first —
 * without that, the record shows only the address that lost the race, which is the
 * one party that needs no explanation. This is what makes "my install failed"
 * distinguishable from "someone else redeemed my command".
 */
function rejectionLogFields(
	platform: string,
	redemption: { reason?: string; deviceId?: string | null; deviceSlug?: string | null } & {
		firstUse?: { ip: string; at: number; userAgent: string | null } | null;
	},
	ip: string,
): Record<string, unknown> {
	const first = redemption.firstUse;
	return {
		platform,
		reason: redemption.reason,
		ip,
		device: redemption.deviceSlug ?? redemption.deviceId ?? undefined,
		...(first
			? {
					firstRedeemedByIp: first.ip,
					firstRedeemedAt: new Date(first.at).toISOString(),
					firstRedeemedUserAgent: first.userAgent ?? undefined,
					// The same address re-running its own command is ordinary; a different one
					// means two parties held the command.
					redeemedByDifferentClient: first.ip !== ip,
				}
			: {}),
	};
}

// GET /api/executor/install/:platform?ticket=<hex>
//
// Serves the pre-rendered script recorded on the ticket. Deliberately does not
// regenerate it: re-deriving the body here would mean a public endpoint reading
// the device row and the release manifest on every fetch, and would let the
// script drift from the one the operator reviewed in the UI.
executorBootstrapRoutes.get("/install/:platform", async (c) => {
	const { ip, platform, redemption } = authorize(c, "script");
	if (!redemption.ok || !redemption.script) {
		logger.warn(
			"Rejected executor install-script fetch",
			rejectionLogFields(platform, redemption, ip),
		);
		return c.json({ error: "Invalid or expired install ticket" }, 403);
	}

	logger.info("Serving executor install script", {
		platform,
		deviceId: redemption.deviceId ?? undefined,
	});
	// text/plain, not a shell MIME type: this response is piped into a shell by the
	// operator's own command, and nothing should encourage a browser to treat it as
	// executable.
	return new Response(redemption.script.body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

// GET /api/executor/download/:platform?ticket=<hex>
executorBootstrapRoutes.get("/download/:platform", async (c) => {
	const { ip, platform, redemption } = authorize(c, "binary");
	if (!redemption.ok) {
		logger.warn("Rejected executor download", rejectionLogFields(platform, redemption, ip));
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

// POST /api/executor/enroll/:platform?ticket=<hex>
//
// Exchanges the ticket for a freshly rotated device key. POST because it changes
// server state; a GET would additionally invite prefetchers and history to touch
// the one URL that yields a credential.
executorBootstrapRoutes.post("/enroll/:platform", async (c) => {
	// Transport is checked BEFORE the ticket is redeemed. Redeeming first would
	// burn the operator's only-once exchange on a request that was always going to
	// be refused, forcing them to regenerate the install command for a
	// configuration problem.
	const origin = resolvePublicOrigin(c);
	const transport = evaluateEnrollmentTransport({
		origin,
		allowPrivateNetworkPlaintext:
			settings.devices?.allowPlaintextEnrollmentOnPrivateNetwork ?? false,
	});
	if (!transport.allowed) {
		logger.warn("Refused executor enrollment over unsuitable transport", {
			reason: transport.reason,
			ip: getClientIp(c),
		});
		return c.json(
			{ error: enrollmentRefusalMessage(transport.reason, { hostname: origin.hostname }) },
			403,
		);
	}

	const { ip, platform, redemption } = authorize(c, "token");
	if (!redemption.ok || !redemption.deviceId) {
		// The highest-value rejection log in the system: a spent enrollment ticket is
		// exactly the signature of a leaked install command, and `rejectionLogFields`
		// names the client that redeemed it first.
		logger.warn("Rejected executor enrollment", rejectionLogFields(platform, redemption, ip));
		return c.json({ error: "Invalid or expired enrollment ticket" }, 403);
	}

	const enrolled = await enrollDeviceToken(redemption.deviceId, {
		ip,
		userAgent: c.req.header("User-Agent") ?? null,
	});
	if (!enrolled) {
		// The device was revoked or deleted between script generation and enrollment.
		logger.warn("Enrollment ticket referenced an unavailable device", {
			deviceId: redemption.deviceId,
		});
		return c.json({ error: "This device is no longer available" }, 403);
	}

	logger.info("Executor enrolled", { deviceId: redemption.deviceId, platform, ip });
	return c.json({ token: enrolled.token }, 200, { "Cache-Control": "no-store" });
});
