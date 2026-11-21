/**
 * Unattended mode HTTP surface (Issue #514).
 *
 * Permission asymmetry on purpose:
 * - Arming (which ends with the machine powering off) is an administrator action.
 * - CANCELLING is available to EVERY signed-in user. The whole point of the always-visible
 *   banner is that whoever is sitting in front of the machine can stop it; requiring an
 *   administrator session at that moment would defeat the safety valve.
 *
 * Consequently the status payload is redacted for non-administrators: counts and phases
 * only, never narrator ids, the exact power-off command, or diagnostic error text.
 */

import { type Context, Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { unattendedOptionsSchema } from "../lib/validators";
import { getAuthPrincipal, requireAdmin, requireAuth } from "../middleware/auth";
import { type UnattendedStatus, unattendedMode } from "../services/unattended-mode";

export const unattendedRoutes = new Hono();
unattendedRoutes.use("*", requireAuth);

function isAdminRequest(c: Context): boolean {
	return getAuthPrincipal(c)?.user.role === "admin";
}

/** Non-administrator view: enough to show the banner and its blockers, nothing identifying. */
function redactStatus(status: UnattendedStatus) {
	return {
		enabled: status.enabled,
		phase: status.phase,
		shutdownAt: status.shutdownAt,
		options: {
			powerOff: status.options.powerOff,
			quietSeconds: status.options.quietSeconds,
			armDelaySeconds: status.options.armDelaySeconds,
		},
		blocked: status.blocked,
		blockers: status.blockers,
	};
}

unattendedRoutes.get("/", (c) => {
	c.header("Cache-Control", "no-store");
	const status = unattendedMode.status();
	return c.json(isAdminRequest(c) ? status : redactStatus(status));
});

unattendedRoutes.post("/", requireAdmin, async (c) => {
	const parsed = unattendedOptionsSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { enabled, ...options } = parsed.data;
	if (enabled) {
		const status = unattendedMode.enable(options);
		if (status.phase === "shutting_down") return c.json({ success: false, status }, 409);
		return c.json({ success: true, status });
	}
	const result = unattendedMode.disable();
	return c.json({ success: result.success, status: result.status }, result.success ? 200 : 409);
});

/** The safety valve: any signed-in user may disarm the mode. Takes no options. */
unattendedRoutes.post("/cancel", (c) => {
	const result = unattendedMode.disable();
	// Answer in the caller's own shape, so a client that stores this response keeps a
	// consistent cache: an administrator keeps the full view, everyone else the summary.
	return c.json(
		{
			success: result.success,
			status: isAdminRequest(c) ? result.status : redactStatus(result.status),
		},
		result.success ? 200 : 409,
	);
});
