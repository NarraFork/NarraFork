import { Hono } from "hono";
import { NugProvider } from "../lib/agent/nug-provider";
import { logger } from "../lib/logger";
import {
	deleteNugCachedModels,
	getNugCachedModels,
	getNugCachedModelsByProvider,
	type NugModelInfo,
	saveAllCachedNugModels,
} from "../lib/nug-model-cache";
import { applyNugModelCatalogUpdate } from "../lib/nug-model-sync";
import {
	type NUGProviderConfig,
	nugProviderPrefix,
	registerNugModelChecker,
	registerNugModelLister,
	saveSettings,
	settings,
} from "../lib/settings";

export const nugRoutes = new Hono();

// === In-memory NUG quota cache (key = provider id) ===

interface NugQuotaCache {
	balance: number | null;
	totalGranted: number | null;
	fetchedAt: number;
}

const cachedQuotaByProvider = new Map<string, NugQuotaCache>();

function getNugProvider(id: string): { config: NUGProviderConfig; provider: NugProvider } | null {
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return null;
	return { config, provider: new NugProvider(config) };
}

type NugUsageRecord = Record<string, unknown>;

function toRecord(value: unknown): NugUsageRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as NugUsageRecord)
		: {};
}

function numericField(record: NugUsageRecord, keys: string[], fallback = 0): number {
	for (const key of keys) {
		const value = record[key];
		const numberValue =
			typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
		if (Number.isFinite(numberValue)) return numberValue;
	}
	return fallback;
}

function stringField(record: NugUsageRecord, keys: string[], fallback = ""): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return fallback;
}

function normalizeNugUsageEvent(value: unknown, index: number): NugUsageRecord {
	const record = toRecord(value);
	return {
		...record,
		id: stringField(record, ["id"], `usage-${index}`),
		channelType: stringField(record, ["channelType", "channel_type", "channel"], "unknown"),
		model: stringField(record, ["model", "model_id", "modelId"]),
		inputTokens: numericField(record, ["inputTokens", "input_tokens", "tokensIn", "tokens_in"]),
		outputTokens: numericField(record, ["outputTokens", "output_tokens", "completionTokens"]),
		cacheCreationInputTokens: numericField(record, [
			"cacheCreationInputTokens",
			"cache_creation_input_tokens",
			"cacheCreationTokens",
			"cache_creation_tokens",
			"cacheWriteInputTokens",
			"cache_write_input_tokens",
			"cacheWriteTokens",
			"cache_write_tokens",
		]),
		cacheReadInputTokens: numericField(record, [
			"cacheReadInputTokens",
			"cache_read_input_tokens",
			"cachedInputTokens",
			"cached_input_tokens",
			"cacheReadTokens",
			"cache_read_tokens",
		]),
		quotaCost: numericField(record, ["quotaCost", "quota_cost"]),
		meterUsage: numericField(record, ["meterUsage", "meter_usage"]),
		status: stringField(record, ["status"], "unknown"),
		durationMs: numericField(record, ["durationMs", "duration_ms"]),
		createdAt: stringField(record, ["createdAt", "created_at", "timestamp"]),
	};
}

function normalizeNugUsageResponse(value: unknown): NugUsageRecord {
	const record = toRecord(value);
	const rawEvents = Array.isArray(record.events)
		? record.events
		: Array.isArray(record.data)
			? record.data
			: [];
	const events = rawEvents.map((event, index) => normalizeNugUsageEvent(event, index));
	return {
		...record,
		events,
		total: numericField(record, ["total", "count"], events.length),
	};
}

/** Fetch quota from a single NUG provider. */
async function fetchNugQuota(
	config: NUGProviderConfig,
): Promise<{ balance: number; totalGranted: number } | null> {
	const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl || !config.apiKey) return null;
	try {
		const provider = new NugProvider(config);
		return await provider.getQuota();
	} catch {
		return null;
	}
}

/** Fetch quota for all configured NUG providers (called on startup). */
export async function fetchAllNugQuotas(): Promise<void> {
	const providers = settings.nugProviders ?? [];
	await Promise.allSettled(
		providers.map(async (p) => {
			const data = await fetchNugQuota(p);
			if (data) {
				cachedQuotaByProvider.set(p.id, {
					balance: data.balance,
					totalGranted: data.totalGranted,
					fetchedAt: Date.now(),
				});
				logger.debug("NUG quota fetched on startup", {
					provider: p.name,
					balance: data.balance,
				});
			}
		}),
	);
}

/** Update cached quota balance for a provider identified by prefix. */
export function updateNugQuotaByPrefix(prefix: string, quotaBalance: number | null): void {
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.prefix === prefix);
	if (!config) return;
	const existing = cachedQuotaByProvider.get(config.id);
	cachedQuotaByProvider.set(config.id, {
		balance: quotaBalance,
		totalGranted: existing?.totalGranted ?? null,
		fetchedAt: Date.now(),
	});
}

/** Get cached quota for a provider by ID. */
export function getNugCachedQuota(providerId: string): NugQuotaCache | undefined {
	return cachedQuotaByProvider.get(providerId);
}

/** Get all cached quotas keyed by provider ID. */
export function getAllNugCachedQuotas(): Record<
	string,
	{ balance: number | null; totalGranted: number | null }
> {
	const result: Record<string, { balance: number | null; totalGranted: number | null }> = {};
	for (const [id, cache] of cachedQuotaByProvider) {
		result[id] = {
			balance: cache.balance,
			totalGranted: cache.totalGranted,
		};
	}
	return result;
}

/** Remove cached models and quotas for providers that no longer exist in settings. */
export function purgeNugProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (deleteNugCachedModels(id)) changed = true;
		cachedQuotaByProvider.delete(id);
	}
	if (changed) saveAllCachedNugModels();
}

// Register model checker and lister
registerNugModelChecker((model) => {
	return getNugCachedModels().some((m) => String(m.id ?? "") === model);
});

registerNugModelLister(() => {
	const result: string[] = [];
	const providers = settings.nugProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = nugProviderPrefix(p);
		const models = getNugCachedModelsByProvider(p.id);
		for (const m of models) {
			result.push(`${prefix}:${String(m.id ?? "")}`);
		}
	}
	return result;
});

/** Fetch models from NUG service (/v1/models endpoint). */
async function fetchNugModels(
	config: NUGProviderConfig,
): Promise<{ models: NugModelInfo[]; modelHash?: string }> {
	const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl) {
		throw new Error(`NUG base URL not configured for provider "${config.name}"`);
	}
	if (!config.apiKey) {
		throw new Error(`NUG API key not configured for provider "${config.name}"`);
	}

	const provider = new NugProvider(config);
	const json = await provider.getModels();
	const models = (json.models ?? []) as NugModelInfo[];
	const modelHash =
		typeof json.modelHash === "string"
			? json.modelHash
			: typeof json.hash === "string"
				? json.hash
				: undefined;

	const seen = new Set<string>();
	const unique = models.filter((m) => {
		const id = String(m.id ?? "");
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});
	unique.sort((a, b) => {
		const aId = String(a.id ?? "");
		const bId = String(b.id ?? "");
		return aId.localeCompare(bId);
	});
	return { models: unique, modelHash };
}

// === Routes ===

nugRoutes.get("/models", (c) => {
	return c.json({ models: getNugCachedModels(), fromCache: true });
});

nugRoutes.post("/models/refresh", async (c) => {
	const providers = settings.nugProviders ?? [];
	const results: Array<{
		providerId: string;
		name: string;
		count: number;
		modelHash?: string;
		error?: string;
	}> = [];
	let changedContextWindows = false;
	for (const p of providers) {
		try {
			const { models, modelHash } = await fetchNugModels(p);
			const applied = applyNugModelCatalogUpdate(p, models, modelHash, {
				saveCache: false,
				saveSettingsOnContextChange: false,
			});
			changedContextWindows = applied.changedContextWindows || changedContextWindows;
			results.push({ providerId: p.id, name: p.name, count: applied.models.length, modelHash });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("NUG listModels refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveAllCachedNugModels();
	if (changedContextWindows) saveSettings(settings);
	return c.json({
		results,
		models: getNugCachedModels(),
		fromCache: false,
		modelContextWindows: settings.agent.modelContextWindows ?? {},
	});
});

nugRoutes.get("/providers/:id/models", (c) => {
	const id = c.req.param("id");
	return c.json({ models: getNugCachedModelsByProvider(id), fromCache: true });
});

nugRoutes.post("/providers/:id/models/refresh", async (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) {
		return c.json({ error: `Provider "${id}" not found` }, 404);
	}
	try {
		const { models, modelHash } = await fetchNugModels(config);
		const applied = applyNugModelCatalogUpdate(config, models, modelHash);
		return c.json({
			models: applied.models,
			fromCache: false,
			modelHash: applied.modelHash,
			modelContextWindows: settings.agent.modelContextWindows ?? {},
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG listModels refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});

/** Proxy channel health status from NUG service. */
nugRoutes.get("/providers/:id/channels/health", async (c) => {
	const entry = getNugProvider(c.req.param("id"));
	if (!entry) return c.json({ error: `Provider "${c.req.param("id")}" not found` }, 404);
	try {
		const data = await entry.provider.getChannelsHealth();
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG channels/health fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy quota balance from NUG service (updates cache). */
nugRoutes.get("/providers/:id/quota", async (c) => {
	const id = c.req.param("id");
	const entry = getNugProvider(id);
	if (!entry) return c.json({ error: `Provider "${id}" not found` }, 404);
	try {
		const data = await entry.provider.getQuota();
		cachedQuotaByProvider.set(id, {
			balance: data.balance,
			totalGranted: data.totalGranted,
			fetchedAt: Date.now(),
		});
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG quota fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy usage records from NUG service. */
nugRoutes.get("/providers/:id/usage", async (c) => {
	const entry = getNugProvider(c.req.param("id"));
	if (!entry) return c.json({ error: `Provider "${c.req.param("id")}" not found` }, 404);
	const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
	const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
	try {
		const data = await entry.provider.getUsage(limit, offset);
		return c.json(normalizeNugUsageResponse(data));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG usage fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy usage summary from NUG service. */
nugRoutes.get("/providers/:id/usage/summary", async (c) => {
	const entry = getNugProvider(c.req.param("id"));
	if (!entry) return c.json({ error: `Provider "${c.req.param("id")}" not found` }, 404);
	// Frontend sends `range` (today/7days/30days/all), NUG expects `period` (today/7days/month/all)
	const range = c.req.query("range") ?? "month";
	const periodMap: Record<string, string> = {
		today: "today",
		"7days": "7days",
		"30days": "month",
		month: "month",
		all: "all",
	};
	const period = periodMap[range] ?? "month";
	try {
		const raw = (await entry.provider.getUsageSummary(period)) as Record<string, unknown>;
		// NUG returns snake_case fields with string numeric values; convert to camelCase numbers
		const data = {
			requestCount: Number(raw.request_count ?? raw.requestCount ?? 0),
			totalMeterUsage: Number(raw.total_meter_usage ?? raw.totalMeterUsage ?? 0),
			totalQuotaCost: Number(raw.total_quota_cost ?? raw.totalQuotaCost ?? 0),
			totalInputTokens: Number(raw.total_input_tokens ?? raw.totalInputTokens ?? 0),
			totalOutputTokens: Number(raw.total_output_tokens ?? raw.totalOutputTokens ?? 0),
			totalCacheWriteTokens: Number(raw.total_cache_write_tokens ?? raw.totalCacheWriteTokens ?? 0),
			totalCacheReadTokens: Number(raw.total_cache_read_tokens ?? raw.totalCacheReadTokens ?? 0),
		};
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG usage/summary fetch failed", { error: msg, provider: entry.config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy NUG login — authenticate with NUG, then create an API key in one step. */
nugRoutes.post("/providers/:id/login", async (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return c.json({ error: `Provider "${id}" not found` }, 404);

	const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl) return c.json({ error: "Provider base URL not configured" }, 400);

	const body = await c.req.json();
	const { username, password } = body as { username?: string; password?: string };
	if (!username || !password) {
		return c.json({ error: "Missing username or password" }, 400);
	}

	try {
		// Step 1: Login to get session cookie
		const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
		});
		if (!loginResponse.ok) {
			const errText = await loginResponse.text().catch(() => "");
			return c.json({ error: `NUG login failed: ${errText}` }, 502);
		}

		// Extract session cookie from Set-Cookie header
		const setCookieHeader = loginResponse.headers.get("set-cookie") ?? "";
		const sessionMatch = setCookieHeader.match(/nug_session=([^;]+)/);
		const sessionToken = sessionMatch?.[1];
		if (!sessionToken) {
			return c.json({ error: "NUG login succeeded but no session cookie received" }, 502);
		}

		const loginData = (await loginResponse.json()) as { user?: Record<string, unknown> };

		// Step 2: Create API key using the session cookie
		const apiKeyResponse = await fetch(`${baseUrl}/api/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `nug_session=${sessionToken}`,
			},
			body: JSON.stringify({ name: `narrafork-${Date.now()}` }),
		});
		if (!apiKeyResponse.ok) {
			const errText = await apiKeyResponse.text().catch(() => "");
			return c.json({ error: `NUG API key creation failed: ${errText}` }, 502);
		}

		const apiKeyData = (await apiKeyResponse.json()) as { apiKey?: string };
		return c.json({ apiKey: apiKeyData.apiKey, user: loginData.user });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG login failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Proxy NUG API key creation. */
nugRoutes.post("/providers/:id/api-key", async (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return c.json({ error: `Provider "${id}" not found` }, 404);

	const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl) return c.json({ error: "Provider base URL not configured" }, 400);

	const body = await c.req.json();
	const { sessionToken, name } = body as { sessionToken?: string; name?: string };
	if (!sessionToken) {
		return c.json({ error: "Missing sessionToken" }, 400);
	}

	try {
		const response = await fetch(`${baseUrl}/api/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `nug_session=${sessionToken}`,
			},
			body: JSON.stringify({ name: name ?? `narrafork-${Date.now()}` }),
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			return c.json({ error: `NUG API key creation failed: ${errText}` }, 502);
		}
		const data = await response.json();
		return c.json(data);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG API key creation failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 502);
	}
});

/** Get cached quotas for all NUG providers. */
nugRoutes.get("/quotas", (c) => {
	return c.json(getAllNugCachedQuotas());
});

// ─── OAuth Flow ───

/** In-memory store for pending OAuth states (TTL: 10 minutes). */
const pendingOAuthStates = new Map<
	string,
	{ providerId: string; callbackUrl: string; expiresAt: number }
>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function cleanExpiredOAuthStates() {
	const now = Date.now();
	for (const [key, val] of pendingOAuthStates) {
		if (val.expiresAt <= now) pendingOAuthStates.delete(key);
	}
}

/** Generate OAuth authorization URL for a NUG provider. */
nugRoutes.get("/providers/:id/oauth/start", (c) => {
	const id = c.req.param("id");
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) return c.json({ error: `Provider "${id}" not found` }, 404);

	const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
	if (!baseUrl) return c.json({ error: "Provider base URL not configured" }, 400);
	if (!config.oauthClientId) return c.json({ error: "OAuth client ID not configured" }, 400);

	// Build the callback URL for this narrafork instance.
	// Priority: manual config > x-forwarded-host > host header > fallback
	let callbackUrl: string;
	if (config.oauthCallbackUrl) {
		callbackUrl = config.oauthCallbackUrl;
	} else {
		const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "localhost:7779";
		const proto = c.req.header("x-forwarded-proto") ?? "http";
		callbackUrl = `${proto}://${host}/api/nug/oauth/callback`;
	}

	// Generate a random state parameter and store it server-side
	const state = `${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	cleanExpiredOAuthStates();
	pendingOAuthStates.set(state, {
		providerId: id,
		callbackUrl,
		expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
	});

	// Build NUG authorization URL
	const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
	authorizeUrl.searchParams.set("client_id", config.oauthClientId);
	authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
	authorizeUrl.searchParams.set("state", state);

	return c.json({
		authorizeUrl: authorizeUrl.toString(),
		state,
	});
});

/** OAuth callback handler — exported so app.ts can mount it before requireAuth. */
export async function handleNugOAuthCallback(c: import("hono").Context) {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) {
		// User denied or error occurred — redirect to settings with error
		return c.redirect(`/settings/providers?oauth_error=${encodeURIComponent(error)}`);
	}

	if (!code || !state) {
		return c.redirect("/settings/providers?oauth_error=missing_params");
	}

	// Validate state against server-side store (consume on use)
	const pending = pendingOAuthStates.get(state);
	if (!pending || pending.expiresAt <= Date.now()) {
		pendingOAuthStates.delete(state ?? "");
		return c.redirect("/settings/providers?oauth_error=state_expired");
	}
	pendingOAuthStates.delete(state);

	const providerId = pending.providerId;
	const providers = settings.nugProviders ?? [];
	const config = providers.find((p) => p.id === providerId);
	if (!config) {
		return c.redirect(`/settings/providers?oauth_error=invalid_provider`);
	}

	const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
	if (!config.oauthClientId || !config.oauthClientSecret) {
		return c.redirect(`/settings/providers?oauth_error=oauth_not_configured`);
	}

	// Reuse the exact callbackUrl that was sent in /oauth/start to guarantee
	// redirect_uri matches, even if host/proto headers differ between requests.
	const callbackUrl = pending.callbackUrl;

	try {
		// Exchange code for API key
		const tokenResponse = await fetch(`${baseUrl}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code,
				client_id: config.oauthClientId,
				client_secret: config.oauthClientSecret,
				redirect_uri: callbackUrl,
			}),
		});

		if (!tokenResponse.ok) {
			const errText = await tokenResponse.text().catch(() => "");
			logger.error("NUG OAuth token exchange failed", { error: errText, provider: config.name });
			return c.redirect(`/settings/providers?oauth_error=${encodeURIComponent(errText)}`);
		}

		const tokenData = (await tokenResponse.json()) as {
			api_key: string;
			device_id: string;
			device_name: string;
			username?: string;
			user_id?: string;
		};

		// Update provider config with the new API key and device info
		config.apiKey = tokenData.api_key;
		config.oauthDeviceId = tokenData.device_id;
		if (tokenData.username) config.nugUsername = tokenData.username;
		if (tokenData.user_id) config.nugUserId = tokenData.user_id;

		// Persist settings
		saveSettings(settings);

		// Redirect to settings page with success
		return c.redirect(`/settings/providers?oauth_success=${providerId}`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("NUG OAuth callback failed", { error: msg, provider: config.name });
		return c.redirect(`/settings/providers?oauth_error=${encodeURIComponent(msg)}`);
	}
}
