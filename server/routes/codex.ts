import { Hono } from "hono";
import { getCodexManager, type LoadBalancingMode } from "../lib/codex-manager";
import { codexUsageQueue } from "../lib/codex-usage-queue";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { saveSettings, settings } from "../lib/settings";
import { codexDefaultReasoningEffortSchema, codexUseWebSocketSchema } from "../lib/validators";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const codexRoutes = new Hono();

// All Codex routes require admin privileges
codexRoutes.use("*", requireAuth, requireAdmin);

/**
 * GET /api/codex/status
 * Get the Codex credential pool status.
 */
codexRoutes.get("/status", (c) => {
	const manager = getCodexManager();
	const mode = settings.codex?.loadBalancingMode;
	if (mode === "priority" || mode === "balanced") {
		manager.setLoadBalancingMode(mode);
	}

	const availablePage = Number(c.req.query("availablePage")) || undefined;
	const unavailablePage = Number(c.req.query("unavailablePage")) || undefined;
	const pageSize = Number(c.req.query("pageSize")) || undefined;

	const snapshot = manager.snapshot({ availablePage, unavailablePage, pageSize });

	return c.json({
		...snapshot,
		globalProxy: settings.codex?.proxy,
		loadBalancingMode: mode ?? snapshot.loadBalancingMode,
		defaultReasoningEffort: settings.codex?.defaultReasoningEffort,
		useWebSocket: settings.codex?.useWebSocket ?? true,
	});
});

/**
 * POST /api/codex/auth/browser
 * Start browser-based OAuth flow. Returns the authorization URL.
 */
codexRoutes.post("/auth/browser", async (c) => {
	try {
		const manager = getCodexManager();
		const { authorizeUrl } = await manager.startBrowserAuth();

		return c.json({ authorizeUrl });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Failed to start Codex browser OAuth", { error: msg });
		return c.json({ error: msg }, 500);
	}
});

/**
 * POST /api/codex/auth/browser/wait
 * Start browser OAuth and wait for completion (long-poll).
 */
codexRoutes.post("/auth/browser/wait", async (c) => {
	try {
		const manager = getCodexManager();
		const { authorizeUrl } = await manager.startBrowserAuth();

		// Wait a short time for completion (front-end will poll /status)
		await Bun.sleep(1000);

		const pending = manager.getPendingDeviceFlow();
		return c.json({
			authorizeUrl,
			success: !pending,
			message: pending ? "Waiting for browser authorization..." : "Authorization started",
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg, success: false }, 400);
	}
});

/**
 * POST /api/codex/auth/browser/cancel
 * Cancel any pending browser OAuth flow.
 */
codexRoutes.post("/auth/browser/cancel", (c) => {
	try {
		const { cancelBrowserOAuth } = require("../lib/codex-auth");
		cancelBrowserOAuth();
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Failed to cancel browser OAuth", { error: msg });
		return c.json({ error: msg }, 500);
	}
});

/**
 * POST /api/codex/auth/device/start
 * Start device code flow. Returns the user code and verification URL.
 */
codexRoutes.post("/auth/device/start", async (c) => {
	try {
		const manager = getCodexManager();
		const info = await manager.startDeviceAuth();

		return c.json(info);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Failed to start Codex device code flow", { error: msg });
		return c.json({ error: msg }, 500);
	}
});

/**
 * POST /api/codex/auth/device/poll
 * Check if device code authorization is pending.
 * Returns the current pending flow status.
 */
codexRoutes.post("/auth/device/poll", (c) => {
	const manager = getCodexManager();
	const pending = manager.getPendingDeviceFlow();
	if (pending) {
		return c.json({ pending: true, ...pending });
	}
	return c.json({ pending: false });
});

/**
 * POST /api/codex/auth/device/cancel
 * Cancel an active device code flow.
 */
codexRoutes.post("/auth/device/cancel", (c) => {
	const manager = getCodexManager();
	manager.cancelDeviceAuth();
	return c.json({ ok: true });
});

/**
 * POST /api/codex/credentials/:id/disable
 * Disable a credential.
 */
codexRoutes.post("/credentials/:id/disable", (c) => {
	const id = c.req.param("id");
	const manager = getCodexManager();
	try {
		manager.setDisabled(id, true);
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 404);
	}
});

/**
 * POST /api/codex/credentials/:id/enable
 * Enable a credential.
 */
codexRoutes.post("/credentials/:id/enable", (c) => {
	const id = c.req.param("id");
	const manager = getCodexManager();
	try {
		manager.setDisabled(id, false);
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 404);
	}
});

/**
 * POST /api/codex/credentials/:id/reset
 * Reset failure count and enable a credential.
 */
codexRoutes.post("/credentials/:id/reset", (c) => {
	const id = c.req.param("id");
	const manager = getCodexManager();
	try {
		manager.resetAndEnable(id);
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 404);
	}
});

/**
 * DELETE /api/codex/credentials/batch
 * Remove multiple credentials at once.
 */
codexRoutes.delete("/credentials/batch", async (c) => {
	const body = await c.req.json<{ ids?: string[] }>();
	const ids = body?.ids;
	if (!Array.isArray(ids) || ids.length === 0) {
		throw new ValidationError("ids must be a non-empty array");
	}
	const manager = getCodexManager();
	const result = manager.removeCredentials(ids);
	return c.json(result);
});

/**
 * DELETE /api/codex/credentials/:id
 * Remove a credential.
 */
codexRoutes.delete("/credentials/:id", (c) => {
	const id = c.req.param("id");
	const manager = getCodexManager();
	try {
		manager.removeCredential(id);
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 404);
	}
});

/**
 * PATCH /api/codex/credentials/:id
 * Update credential fields (displayName, priority).
 */
codexRoutes.patch("/credentials/:id", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => ({}))) as {
		displayName?: string;
		priority?: number;
	};
	const manager = getCodexManager();
	try {
		manager.updateCredential(id, body);
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 404);
	}
});

/**
 * POST /api/codex/credentials/:id/refresh
 * Manually refresh a credential's token.
 */
codexRoutes.post("/credentials/:id/refresh", async (c) => {
	const id = c.req.param("id");
	const manager = getCodexManager();
	try {
		await manager.manualRefresh(id);
		return c.json({ ok: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 400);
	}
});

/**
 * POST /api/codex/credentials/:id/usage
 * Get usage information for a credential.
 */
codexRoutes.post("/credentials/:id/usage", async (c) => {
	const id = c.req.param("id");
	const manager = getCodexManager();
	try {
		const usage = await manager.getUsage(id);
		return c.json(usage);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Failed to get Codex usage", { error: msg, credentialId: id });
		return c.json({ error: msg }, 400);
	}
});

/**
 * POST /api/codex/load-balancing-mode
 * Set the load balancing mode.
 */
codexRoutes.post("/load-balancing-mode", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { mode?: LoadBalancingMode };
	if (!body.mode || (body.mode !== "priority" && body.mode !== "balanced")) {
		return c.json({ error: "Invalid mode. Must be 'priority' or 'balanced'" }, 400);
	}

	settings.codex = settings.codex || {};
	settings.codex.loadBalancingMode = body.mode;
	saveSettings(settings);

	const manager = getCodexManager();
	manager.setLoadBalancingMode(body.mode);

	return c.json({ ok: true, mode: body.mode });
});

/**
 * POST /api/codex/global-proxy
 * Set the global proxy for all Codex requests.
 */
codexRoutes.post("/global-proxy", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { proxy?: string };

	settings.codex = settings.codex || {};
	settings.codex.proxy = body.proxy || undefined;
	saveSettings(settings);

	return c.json({ ok: true });
});

/**
 * GET /api/codex/default-reasoning-effort
 * Get default reasoning effort for Codex models.
 */
codexRoutes.get("/default-reasoning-effort", (c) => {
	return c.json({ reasoningEffort: settings.codex?.defaultReasoningEffort ?? null });
});

/**
 * POST /api/codex/default-reasoning-effort
 * Set default reasoning effort for Codex models.
 */
codexRoutes.post("/default-reasoning-effort", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = codexDefaultReasoningEffortSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.message);
	}

	settings.codex = settings.codex || {};
	settings.codex.defaultReasoningEffort = parsed.data.reasoningEffort ?? undefined;
	saveSettings(settings);

	return c.json({ ok: true, reasoningEffort: settings.codex.defaultReasoningEffort ?? null });
});

/**
 * POST /api/codex/use-websocket
 * Set whether to use Responses WebSocket transport for Codex connections.
 */
codexRoutes.post("/use-websocket", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = codexUseWebSocketSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.message);
	}

	settings.codex = settings.codex || {};
	settings.codex.useWebSocket = parsed.data.useWebSocket ?? true;
	saveSettings(settings);

	return c.json({ ok: true, useWebSocket: settings.codex.useWebSocket ?? true });
});

/**
 * POST /api/codex/import
 * Import credentials from refresh tokens.
 */
codexRoutes.post("/import", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		credentials?: Array<{
			refreshToken: string;
			displayName?: string;
			priority?: number;
		}>;
	};

	if (!body.credentials?.length) {
		return c.json({ error: "No credentials provided" }, 400);
	}

	// Validate that at least one credential has a refreshToken
	const validCredentials = body.credentials.filter(
		(c) => c.refreshToken && typeof c.refreshToken === "string",
	);
	if (validCredentials.length === 0) {
		return c.json(
			{ error: "No valid credentials: each credential must have a non-empty refreshToken" },
			400,
		);
	}

	const manager = getCodexManager();
	const result = manager.importCredentials(body.credentials);
	return c.json(result);
});

/**
 * POST /api/codex/usage-queue/clear
 * Clear completed/failed items from the usage fetch queue.
 */
codexRoutes.post("/usage-queue/clear", (c) => {
	codexUsageQueue.clearCompleted();
	return c.json({ ok: true });
});
