import { Hono } from "hono";
import {
	type CodexImportCredentialInput,
	getCodexManager,
	type LoadBalancingMode,
	normalizeCodexTierOrder,
} from "../lib/codex-manager";
import { codexUsageQueue } from "../lib/codex-usage-queue";
import { ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getNormalizedSearchChannels, SEARCH_NATIVE_CHANNEL_ID } from "../lib/search/settings";
import { normalizeProxyUrl, saveSettings, settings } from "../lib/settings";
import {
	codexDefaultReasoningEffortSchema,
	codexTierOrderSchema,
	codexUseImageGenerationSchema,
	codexUseWebSearchSchema,
	codexUseWebSocketSchema,
} from "../lib/validators";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const codexRoutes = new Hono();

function isCodexLoadBalancingMode(mode: unknown): mode is LoadBalancingMode {
	return mode === "priority" || mode === "balanced" || mode === "tier-balanced";
}

const REFRESH_TOKEN_SEARCH_PATTERN = /rt_[A-Za-z0-9._-]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasCodexImportToken(credential: CodexImportCredentialInput): boolean {
	const nestedCredentials = optionalRecord(credential.credentials);
	const refreshToken = optionalString(
		credential.refreshToken ??
			credential.refresh_token ??
			nestedCredentials.refreshToken ??
			nestedCredentials.refresh_token,
	);
	const accessToken = optionalString(
		credential.accessToken ??
			credential.access_token ??
			nestedCredentials.accessToken ??
			nestedCredentials.access_token,
	);
	return !!refreshToken || !!accessToken;
}

function codexCredentialsFromAtMarkerRecord(
	record: string,
	email?: string,
): CodexImportCredentialInput[] {
	const parts = record.split(/-{4,}/).map((part) => part.trim());
	return parts.flatMap((part, index) => {
		if (part.toLowerCase() !== "at") return [];
		const accessToken = optionalString(parts[index + 1]);
		return accessToken
			? [
					{
						accessToken,
						...(email ? { email, displayName: email } : {}),
					},
				]
			: [];
	});
}

function codexCredentialsFromText(text: string): CodexImportCredentialInput[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return codexCredentialsFromParsedImport(JSON.parse(trimmed));
		} catch {
			// Fall through to token extraction for non-JSON text that starts with braces.
		}
	}

	const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
	return trimmed.split(/[,\n]+/).flatMap((record) => {
		const email = optionalString(record.match(emailRegex)?.[0]);
		const refreshCredentials = [...record.matchAll(REFRESH_TOKEN_SEARCH_PATTERN)].flatMap(
			(match) => {
				const refreshToken = optionalString(match[0]);
				return refreshToken
					? [
							{
								refreshToken,
								...(email ? { email, displayName: email } : {}),
							},
						]
					: [];
			},
		);
		return [...refreshCredentials, ...codexCredentialsFromAtMarkerRecord(record, email)];
	});
}

function codexCredentialsFromParsedImport(value: unknown): CodexImportCredentialInput[] {
	if (typeof value === "string") return codexCredentialsFromText(value);
	if (Array.isArray(value)) return value.flatMap((item) => codexCredentialsFromParsedImport(item));
	if (!isRecord(value)) return [];

	if (Array.isArray(value.accounts)) {
		return value.accounts.flatMap((item) => codexCredentialsFromParsedImport(item));
	}
	if (Array.isArray(value.credentials)) {
		return value.credentials.flatMap((item) => codexCredentialsFromParsedImport(item));
	}
	return [value as CodexImportCredentialInput];
}

/**
 * GET /api/codex/quota-overview
 * Public-safe Codex quota overview for all authenticated users.
 */
codexRoutes.get("/quota-overview", requireAuth, (c) => {
	const manager = getCodexManager();
	return c.json(manager.getPublicQuotaOverview());
});

// All remaining Codex routes require admin privileges
codexRoutes.use("*", requireAuth, requireAdmin);

/**
 * GET /api/codex/status
 * Get the Codex credential pool status.
 */
codexRoutes.get("/status", (c) => {
	const manager = getCodexManager();
	const mode = settings.codex?.loadBalancingMode;
	const tierOrder = normalizeCodexTierOrder(settings.codex?.tierOrder);
	if (isCodexLoadBalancingMode(mode)) {
		manager.setLoadBalancingMode(mode);
	}
	manager.setTierOrder(tierOrder);

	const availablePage = Number(c.req.query("availablePage")) || undefined;
	const unavailablePage = Number(c.req.query("unavailablePage")) || undefined;
	const pageSize = Number(c.req.query("pageSize")) || undefined;

	const snapshot = manager.snapshot({ availablePage, unavailablePage, pageSize });

	return c.json({
		...snapshot,
		// Backward-compat: surface the custom proxy URL from the global policy.
		globalProxy: settings.proxy?.mode === "custom" ? settings.proxy.url : undefined,
		loadBalancingMode: isCodexLoadBalancingMode(mode) ? mode : snapshot.loadBalancingMode,
		tierOrder,
		effectiveTierOrder: snapshot.effectiveTierOrder,
		defaultReasoningEffort: settings.codex?.defaultReasoningEffort,
		useWebSocket: settings.codex?.useWebSocket ?? true,
		useWebSearch: settings.codex?.useWebSearch ?? true,
		useImageGeneration: settings.codex?.useImageGeneration ?? true,
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
 * DELETE /api/codex/credentials/unhealthy
 * Remove all credentials disabled for too many failures or banned status.
 */
codexRoutes.delete("/credentials/unhealthy", (c) => {
	const manager = getCodexManager();
	const result = manager.removeUnhealthyCredentials();
	return c.json(result);
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
	if (!isCodexLoadBalancingMode(body.mode)) {
		return c.json(
			{ error: "Invalid mode. Must be 'priority', 'balanced', or 'tier-balanced'" },
			400,
		);
	}

	settings.codex = settings.codex || {};
	settings.codex.loadBalancingMode = body.mode;
	saveSettings(settings);

	const manager = getCodexManager();
	manager.setLoadBalancingMode(body.mode);

	return c.json({ ok: true, mode: body.mode });
});

/**
 * POST /api/codex/tier-order
 * Set the account tier order used by tier-balanced mode.
 */
codexRoutes.post("/tier-order", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = codexTierOrderSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.message);
	}

	const tierOrder = normalizeCodexTierOrder(parsed.data.tierOrder);
	settings.codex = settings.codex || {};
	settings.codex.tierOrder = tierOrder;
	saveSettings(settings);

	const manager = getCodexManager();
	manager.setTierOrder(tierOrder);
	const snapshot = manager.snapshot();

	return c.json({ ok: true, tierOrder, effectiveTierOrder: snapshot.effectiveTierOrder });
});

/**
 * POST /api/codex/global-proxy
 * Set the global proxy for all Codex requests.
 */
codexRoutes.post("/global-proxy", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { proxy?: string };

	// Backward-compat: map the legacy per-provider proxy onto the unified global
	// policy. A URL switches to "custom"; clearing it falls back to "system".
	const normalized = normalizeProxyUrl(body.proxy);
	settings.proxy = normalized ? { mode: "custom", url: normalized } : { mode: "system" };
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
 * POST /api/codex/use-web-search
 * Set whether to inject the native web_search tool for Codex models.
 */
codexRoutes.post("/use-web-search", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = codexUseWebSearchSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.message);
	}

	const useWebSearch = parsed.data.useWebSearch ?? true;
	settings.codex = settings.codex || {};
	settings.codex.useWebSearch = useWebSearch;
	settings.search = settings.search ?? { channels: [], customProviders: [] };
	settings.search.channels = getNormalizedSearchChannels(settings).map((channel) =>
		channel.id === SEARCH_NATIVE_CHANNEL_ID ? { ...channel, enabled: useWebSearch } : channel,
	);
	saveSettings(settings);

	return c.json({ ok: true, useWebSearch: settings.codex.useWebSearch ?? true });
});

/**
 * POST /api/codex/use-image-generation
 * Set whether to inject the native image_generation tool for Codex models.
 */
codexRoutes.post("/use-image-generation", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const parsed = codexUseImageGenerationSchema.safeParse(body);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.message);
	}

	settings.codex = settings.codex || {};
	settings.codex.useImageGeneration = parsed.data.useImageGeneration ?? true;
	saveSettings(settings);

	return c.json({ ok: true, useImageGeneration: settings.codex.useImageGeneration ?? true });
});

/**
 * POST /api/codex/import
 * Import credentials from refresh tokens or access tokens.
 */
codexRoutes.post("/import", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		credentials?: unknown;
		text?: unknown;
		importText?: unknown;
	};
	const credentialItems =
		body.credentials === undefined
			? []
			: Array.isArray(body.credentials)
				? body.credentials
				: [body.credentials];
	const credentials = [
		...codexCredentialsFromParsedImport(credentialItems),
		...codexCredentialsFromParsedImport(body.text),
		...codexCredentialsFromParsedImport(body.importText),
	];

	if (!credentials.length) {
		return c.json({ error: "No credentials provided" }, 400);
	}

	// Validate that at least one credential has a refresh token or access token.
	const validCredentials = credentials.filter(hasCodexImportToken);
	if (validCredentials.length === 0) {
		return c.json(
			{
				error:
					"No valid credentials: each credential must have a non-empty refreshToken or accessToken",
			},
			400,
		);
	}

	const manager = getCodexManager();
	const result = manager.importCredentials(credentials);
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
