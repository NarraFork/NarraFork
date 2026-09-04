import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
	buildOpenRouterHeaders,
	cancelBrowserAuth,
	clearCredentials,
	fetchAndUpdateUserInfo,
	fetchBalance,
	getAuthStatus,
	getPendingAuthorizeUrl,
	hasPendingAuth,
	importFromCallbackUrl,
	startBrowserAuth,
} from "../lib/cline-auth";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { resolveProxyForUrl } from "../lib/net/proxy";
import {
	type ClineProviderConfig,
	clineProviderPrefix,
	narraforkDir,
	registerClineModelChecker,
	registerClineModelLister,
	saveSettings,
	settings,
} from "../lib/settings";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const clineRoutes = new Hono();

// All Cline routes require admin privileges
clineRoutes.use("*", requireAuth, requireAdmin);

/**
 * Ensure at least one default Cline provider config exists.
 * Auto-creates one if settings.clineProviders is empty.
 * Also migrates legacy baseUrl from openrouter.ai to api.cline.bot.
 */
function ensureDefaultProvider(): ClineProviderConfig {
	if (!settings.clineProviders) {
		settings.clineProviders = [];
	}
	if (settings.clineProviders.length === 0) {
		const defaultProvider: ClineProviderConfig = {
			id: generateShortId(),
			name: "Cline",
			prefix: "cline",
			baseUrl: "https://api.cline.bot/api/v1",
			defaultModel: "anthropic/claude-sonnet-4",
			enabledModels: [],
		};
		settings.clineProviders.push(defaultProvider);
		saveSettings(settings);
		logger.info("Created default Cline provider config", { id: defaultProvider.id });
	}

	// Migrate legacy baseUrl: openrouter.ai → api.cline.bot
	let migrated = false;
	for (const p of settings.clineProviders) {
		if (p.baseUrl?.includes("openrouter.ai")) {
			p.baseUrl = "https://api.cline.bot/api/v1";
			migrated = true;
		}
	}
	if (migrated) {
		saveSettings(settings);
		logger.info("Migrated Cline provider baseUrl from openrouter.ai to api.cline.bot");
	}

	return settings.clineProviders[0];
}

// === Model cache ===

export interface ClineModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	promptPrice?: string;
	completionPrice?: string;
}

const cacheDir = narraforkDir;
const modelsCachePath = resolve(cacheDir, "cline-models.json");

/** Cached models keyed by provider config id. */
const cachedModelsByProvider = new Map<string, ClineModelInfo[]>();

function loadCachedModels(): void {
	try {
		if (existsSync(modelsCachePath)) {
			const data = JSON.parse(readFileSync(modelsCachePath, "utf-8")) as Record<
				string,
				ClineModelInfo[]
			>;
			for (const [id, models] of Object.entries(data)) {
				cachedModelsByProvider.set(id, models);
			}
		}
	} catch {
		// corrupt — ignore
	}
}

function saveCachedModels(): void {
	try {
		mkdirSync(cacheDir, { recursive: true });
		const data: Record<string, ClineModelInfo[]> = {};
		for (const [id, models] of cachedModelsByProvider) {
			data[id] = models;
		}
		writeFileSync(modelsCachePath, JSON.stringify(data));
	} catch {
		// non-critical
	}
}

// Load cache on startup and migrate legacy config
loadCachedModels();
ensureDefaultProvider();

/** Remove cached models for providers that no longer exist in settings. */
export function purgeClineProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedModelsByProvider.delete(id)) changed = true;
	}
	if (changed) saveCachedModels();
}

/** Get cached models for a specific provider. */
export function getClineCachedModelsByProvider(providerId: string): ClineModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
}

/** Get all cached models across all providers. */
export function getClineCachedModels(): ClineModelInfo[] {
	const seen = new Set<string>();
	const result: ClineModelInfo[] = [];
	for (const models of cachedModelsByProvider.values()) {
		for (const m of models) {
			if (m.id && !seen.has(m.id)) {
				seen.add(m.id);
				result.push(m);
			}
		}
	}
	return result;
}

/**
 * Fill context window sizes into settings for newly added models,
 * using OpenRouter cached data. Fetches from API if cache is empty.
 */
async function fillContextWindows(
	newModels: string[],
	provider: ClineProviderConfig,
): Promise<void> {
	let cached = getClineCachedModels();
	if (cached.length === 0) {
		cached = await fetchOpenRouterModels(provider);
		cachedModelsByProvider.set(provider.id, cached);
		saveCachedModels();
	}
	let contextMap = new Map(cached.map((m) => [m.id, m.contextLength]));

	// If any new model is missing from cache, refresh from OpenRouter API
	const missing = newModels.filter((id) => !contextMap.has(id));
	if (missing.length > 0) {
		try {
			cached = await fetchOpenRouterModels(provider);
			cachedModelsByProvider.set(provider.id, cached);
			saveCachedModels();
			contextMap = new Map(cached.map((m) => [m.id, m.contextLength]));
		} catch {
			// Non-critical — proceed with whatever we have
		}
	}

	let changed = false;
	const windows = settings.agent.modelContextWindows ?? {};
	settings.agent.modelContextWindows = windows;
	for (const modelId of newModels) {
		const ctx = contextMap.get(modelId);
		if (ctx != null && !windows[`${provider.prefix}:${modelId}`]) {
			windows[`${provider.prefix}:${modelId}`] = ctx;
			changed = true;
		}
	}
	if (changed) saveSettings(settings);
}

/** Get enabled models grouped by provider (only user-selected models). */
export function getClineEnabledModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: ClineModelInfo[];
}> {
	const providers = settings.clineProviders ?? [];
	return providers
		.filter((p) => !p.disabled && p.enabledModels && p.enabledModels.length > 0)
		.map((p) => {
			const poolModels = cachedModelsByProvider.get(p.id) ?? [];
			// Match enabled IDs against pool for metadata, fall back to bare ID
			const models = (p.enabledModels ?? []).map((id) => {
				const poolMatch = poolModels.find((m) => m.id === id);
				return poolMatch ?? { id };
			});
			return {
				providerId: p.id,
				providerName: p.name,
				models,
			};
		});
}

// Register model checker and lister — only report user-enabled models
registerClineModelChecker((model) => {
	const providers = settings.clineProviders ?? [];
	for (const p of providers) {
		if (!p.disabled && p.enabledModels?.includes(model)) return true;
	}
	return false;
});

registerClineModelLister(() => {
	const result: string[] = [];
	const providers = settings.clineProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = clineProviderPrefix(p);
		for (const modelId of p.enabledModels ?? []) {
			result.push(`${prefix}:${modelId}`);
		}
	}
	return result;
});

/** Fetch models from OpenRouter API (public endpoint, always from openrouter.ai). */
async function fetchOpenRouterModels(config: ClineProviderConfig): Promise<ClineModelInfo[]> {
	const baseUrl = "https://openrouter.ai/api/v1";

	const url = `${baseUrl}/models`;
	// Honour the global outbound proxy policy and this provider's proxy
	// override (plain fetch would bypass both).
	const proxy = resolveProxyForUrl(url, config.proxy);
	const response = await fetch(url, {
		headers: buildOpenRouterHeaders(),
		...(proxy ? { proxy } : {}),
		// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
	} as any);

	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`OpenRouter models API error ${response.status}: ${errText}`);
	}

	const json = (await response.json()) as {
		data?: Array<{
			id: string;
			name?: string;
			context_length?: number | null;
			pricing?: {
				prompt?: string;
				completion?: string;
			} | null;
		}>;
	};

	const models: ClineModelInfo[] = (json.data ?? [])
		.filter((m) => m.id)
		.map((m) => ({
			id: m.id,
			name: m.name,
			contextLength: m.context_length ?? undefined,
			promptPrice: m.pricing?.prompt,
			completionPrice: m.pricing?.completion,
		}));

	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

// === Recommended / free models ===

const CLINE_API_BASE_URL = "https://api.cline.bot";

interface ClineRecommendedModel {
	id: string;
	name: string;
	description?: string;
	tags: string[];
}

interface ClineRecommendedModelsData {
	recommended: ClineRecommendedModel[];
	free: ClineRecommendedModel[];
}

const recommendedModelsCachePath = resolve(cacheDir, "cline-recommended-models.json");
let recommendedModelsCache: { data: ClineRecommendedModelsData; timestamp: number } | null = null;
const RECOMMENDED_MODELS_TTL = 30 * 60 * 1000; // 30 minutes

/** Fallback recommended models when API is unavailable. */
const RECOMMENDED_MODELS_FALLBACK: ClineRecommendedModelsData = {
	recommended: [
		{
			id: "anthropic/claude-sonnet-4.6",
			name: "Anthropic Claude Sonnet 4.6",
			description: "Latest Sonnet release with strong coding and agent performance",
			tags: ["NEW"],
		},
		{
			id: "anthropic/claude-opus-4.6",
			name: "Anthropic Claude Opus 4.6",
			description: "Most intelligent model for agents and coding",
			tags: ["BEST"],
		},
	],
	free: [
		{
			id: "kwaipilot/kat-coder-pro",
			name: "KwaiKAT Kat Coder Pro",
			description: "KwaiKAT's most advanced agentic coding model",
			tags: ["FREE"],
		},
	],
};

async function fetchRecommendedModels(): Promise<ClineRecommendedModelsData> {
	// Check in-memory cache
	if (
		recommendedModelsCache &&
		Date.now() - recommendedModelsCache.timestamp < RECOMMENDED_MODELS_TTL
	) {
		return recommendedModelsCache.data;
	}

	try {
		const recommendedUrl = `${CLINE_API_BASE_URL}/api/v1/ai/cline/recommended-models`;
		// Global outbound proxy policy only — this endpoint is not tied to a provider.
		const proxy = resolveProxyForUrl(recommendedUrl);
		// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
		const response = await fetch(recommendedUrl, proxy ? ({ proxy } as any) : undefined);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const json = (await response.json()) as {
			data?: ClineRecommendedModelsData;
			recommended?: ClineRecommendedModel[];
			free?: ClineRecommendedModel[];
		};

		// Normalize response — may be wrapped in { data: ... } or flat
		const data: ClineRecommendedModelsData = json.data ?? {
			recommended: json.recommended ?? [],
			free: json.free ?? [],
		};

		if (data.recommended.length > 0 || data.free.length > 0) {
			recommendedModelsCache = { data, timestamp: Date.now() };
			try {
				writeFileSync(recommendedModelsCachePath, JSON.stringify(data));
			} catch {
				// non-critical
			}
		}
		return data;
	} catch (err) {
		logger.warn("Failed to fetch Cline recommended models, using cache/fallback", {
			error: String(err),
		});

		// Try file cache
		try {
			if (existsSync(recommendedModelsCachePath)) {
				const cached = JSON.parse(
					readFileSync(recommendedModelsCachePath, "utf-8"),
				) as ClineRecommendedModelsData;
				return cached;
			}
		} catch {
			// corrupt
		}

		return RECOMMENDED_MODELS_FALLBACK;
	}
}

/**
 * After first-time authentication, automatically fetch free models
 * and add them to the provider's enabledModels so the user has
 * something usable out of the box.
 */
async function autoAddFreeModels(provider: ClineProviderConfig): Promise<void> {
	try {
		const data = await fetchRecommendedModels();
		const freeIds = data.free.map((m) => m.id);
		if (freeIds.length === 0) return;

		const existing = new Set(provider.enabledModels ?? []);
		const toAdd = freeIds.filter((id) => !existing.has(id));
		if (toAdd.length === 0) return;

		provider.enabledModels = [...(provider.enabledModels ?? []), ...toAdd];
		saveSettings(settings);
		await fillContextWindows(toAdd, provider);
		logger.info("Auto-added free models after Cline auth", { count: toAdd.length, models: toAdd });
	} catch (err) {
		logger.warn("Failed to auto-add free models after Cline auth", { error: String(err) });
	}
}

// === Routes ===

/**
 * GET /api/cline/status
 * Get Cline authentication status and model count.
 */
clineRoutes.get("/status", (c) => {
	const authStatus = getAuthStatus();
	const providers = settings.clineProviders ?? [];
	const totalModels = getClineCachedModels().length;

	return c.json({
		...authStatus,
		providers: providers.map((p) => ({
			id: p.id,
			name: p.name,
			prefix: p.prefix,
			hasToken: !!p.accessToken,
		})),
		totalModels,
		pendingAuth: hasPendingAuth(),
		authorizeUrl: getPendingAuthorizeUrl() ?? undefined,
	});
});

/**
 * POST /api/cline/auth/browser
 * Start browser-based OAuth flow. Returns the authorization URL.
 */
clineRoutes.post("/auth/browser", async (c) => {
	try {
		const body = (await c.req.json().catch(() => ({}))) as { apiBaseUrl?: string };
		const { authorizeUrl, waitForCompletion } = await startBrowserAuth(body.apiBaseUrl);

		// Start waiting in background — the frontend will poll /status
		waitForCompletion()
			.then(async (creds) => {
				// Ensure provider exists and update access token
				const provider = ensureDefaultProvider();
				provider.accessToken = creds.accessToken;
				saveSettings(settings);
				logger.info("Cline OAuth completed", { email: creds.email });
				// Auto-add free models on first auth
				await autoAddFreeModels(provider);
			})
			.catch((err) => {
				logger.error("Cline OAuth failed", { error: String(err) });
			});

		return c.json({ authorizeUrl });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Failed to start Cline browser OAuth", { error: msg });
		return c.json({ error: msg }, 500);
	}
});

/**
 * POST /api/cline/auth/cancel
 * Cancel any pending browser OAuth flow.
 */
clineRoutes.post("/auth/cancel", (c) => {
	cancelBrowserAuth();
	return c.json({ ok: true });
});

/**
 * POST /api/cline/auth/callback
 * Import credentials from a pasted callback URL.
 * The callback URL contains a base64-encoded JSON with credentials in the `code` parameter.
 * This supports remote deployments where the local callback server is not reachable.
 */
clineRoutes.post("/auth/callback", async (c) => {
	try {
		const body = (await c.req.json()) as { callbackUrl?: string };
		if (!body.callbackUrl) {
			return c.json({ error: "callbackUrl is required" }, 400);
		}

		const creds = importFromCallbackUrl(body.callbackUrl);

		// Ensure provider exists and update access token
		const provider = ensureDefaultProvider();
		provider.accessToken = creds.accessToken;
		saveSettings(settings);

		// Cancel any pending browser auth since we got credentials directly
		cancelBrowserAuth();

		// Auto-add free models on first auth
		await autoAddFreeModels(provider);

		return c.json({
			ok: true,
			email: creds.email,
			displayName: creds.displayName,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Failed to import Cline callback URL", { error: msg });
		return c.json({ error: msg }, 400);
	}
});

/**
 * POST /api/cline/auth/logout
 * Clear Cline credentials.
 */
clineRoutes.post("/auth/logout", (c) => {
	clearCredentials();

	// Clear access token from provider configs
	for (const p of settings.clineProviders ?? []) {
		p.accessToken = undefined;
	}
	if ((settings.clineProviders ?? []).length > 0) {
		saveSettings(settings);
	}

	return c.json({ ok: true });
});

/**
 * GET /api/cline/models
 * Get cached model list.
 */
clineRoutes.get("/models", (c) => {
	return c.json({ models: getClineCachedModels(), fromCache: true });
});

/**
 * POST /api/cline/models/refresh
 * Refresh model list from OpenRouter.
 */
clineRoutes.post("/models/refresh", async (c) => {
	const providers = settings.clineProviders ?? [];
	const results: Array<{ providerId: string; name: string; count: number; error?: string }> = [];

	for (const p of providers) {
		try {
			const models = await fetchOpenRouterModels(p);
			cachedModelsByProvider.set(p.id, models);
			results.push({ providerId: p.id, name: p.name, count: models.length });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("Cline model refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}

	saveCachedModels();
	return c.json({ results, models: getClineCachedModels(), fromCache: false });
});

/**
 * GET /api/cline/providers/:id/models
 * Get cached models for a specific provider.
 */
clineRoutes.get("/providers/:id/models", (c) => {
	const id = c.req.param("id");
	return c.json({ models: getClineCachedModelsByProvider(id), fromCache: true });
});

/**
 * POST /api/cline/providers/:id/models/refresh
 * Refresh models for a specific provider.
 */
clineRoutes.post("/providers/:id/models/refresh", async (c) => {
	const id = c.req.param("id");
	const providers = settings.clineProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) {
		return c.json({ error: `Provider "${id}" not found` }, 404);
	}
	try {
		const models = await fetchOpenRouterModels(config);
		cachedModelsByProvider.set(id, models);
		saveCachedModels();
		return c.json({ count: models.length, fromCache: false });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("Cline model refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});

/**
 * GET /api/cline/pool/search?q=...&limit=50
 * Search the cached OpenRouter model pool. Returns matching models.
 */
clineRoutes.get("/pool/search", (c) => {
	const q = (c.req.query("q") ?? "").toLowerCase().trim();
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);

	const allModels = getClineCachedModels();
	if (!q) {
		return c.json({ models: allModels.slice(0, limit), total: allModels.length });
	}

	const terms = q.split(/\s+/);
	const matched = allModels.filter((m) => {
		const haystack = `${m.id} ${m.name ?? ""}`.toLowerCase();
		return terms.every((t) => haystack.includes(t));
	});

	return c.json({ models: matched.slice(0, limit), total: matched.length });
});

/**
 * GET /api/cline/pool/count
 * Get the total number of models in the cached pool.
 */
clineRoutes.get("/pool/count", (c) => {
	return c.json({ count: getClineCachedModels().length });
});

/**
 * POST /api/cline/enabled-models
 * Set the enabled models list for the first cline provider.
 * Body: { models: string[] }
 */
clineRoutes.post("/enabled-models", async (c) => {
	const body = (await c.req.json()) as { models?: string[] };
	if (!Array.isArray(body.models)) {
		return c.json({ error: "models must be an array" }, 400);
	}

	const provider = ensureDefaultProvider();
	const oldSet = new Set(provider.enabledModels ?? []);
	provider.enabledModels = body.models;
	saveSettings(settings);

	// Auto-fill context windows for newly added models
	const newModels = body.models.filter((id) => !oldSet.has(id));
	if (newModels.length > 0) {
		await fillContextWindows(newModels, provider);
	}

	return c.json({
		ok: true,
		count: body.models.length,
		modelContextWindows: settings.agent.modelContextWindows ?? {},
	});
});

/**
 * GET /api/cline/balance
 * Get Cline account balance.
 */
clineRoutes.get("/balance", async (c) => {
	try {
		const balance = await fetchBalance();
		if (!balance) {
			// Use 422 instead of 401 — this is a Cline auth issue, not a NarraFork auth issue.
			// Returning 401 causes the frontend global handler to clear the NarraFork JWT token
			// and redirect to the login page.
			return c.json({ error: "Not authenticated or balance unavailable" }, 422);
		}
		return c.json(balance);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 500);
	}
});

/**
 * GET /api/cline/recommended-models
 * Get recommended and free models from Cline API.
 */
clineRoutes.get("/recommended-models", async (c) => {
	try {
		const data = await fetchRecommendedModels();
		return c.json(data);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 500);
	}
});

/**
 * POST /api/cline/user-info/refresh
 * Refresh user info (to populate userId for balance API).
 */
clineRoutes.post("/user-info/refresh", async (c) => {
	try {
		await fetchAndUpdateUserInfo();
		const status = getAuthStatus();
		return c.json(status);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ error: msg }, 500);
	}
});
