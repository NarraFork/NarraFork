import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { NugProvider } from "../lib/agent/nug-provider";
import { logger } from "../lib/logger";
import {
	type NUGProviderConfig,
	nugProviderPrefix,
	registerNugModelChecker,
	registerNugModelLister,
	settings,
} from "../lib/settings";

export const nugRoutes = new Hono();

const cacheDir = resolve(homedir(), ".narrafork");

/** NUG model info — OpenAI-list compatible shape from NUG /v1/models. */
export type NugModelInfo = Record<string, unknown>;

/** Per-provider cached model lists. Key = provider id. */
const cachedModelsByProvider = new Map<string, NugModelInfo[]>();

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

// Load cache on startup
loadAllCachedModels();

function loadAllCachedModels(): void {
	const cachePath = resolve(cacheDir, "nug-models-providers.json");
	try {
		if (existsSync(cachePath)) {
			const data = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, NugModelInfo[]>;
			for (const [id, models] of Object.entries(data)) {
				cachedModelsByProvider.set(id, models);
			}
		}
	} catch {
		// corrupt — ignore
	}
}

function saveAllCachedModels(): void {
	try {
		mkdirSync(cacheDir, { recursive: true });
		const data: Record<string, NugModelInfo[]> = {};
		for (const [id, models] of cachedModelsByProvider) {
			data[id] = models;
		}
		writeFileSync(resolve(cacheDir, "nug-models-providers.json"), JSON.stringify(data));
	} catch {
		// non-critical
	}
}

/** Remove cached models and quotas for providers that no longer exist in settings. */
export function purgeNugProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedModelsByProvider.delete(id)) changed = true;
		cachedQuotaByProvider.delete(id);
	}
	if (changed) saveAllCachedModels();
}

/** Get cached models for a specific provider. */
export function getNugCachedModelsByProvider(providerId: string): NugModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
}

/** Get all cached models across all providers. */
export function getNugCachedModels(): NugModelInfo[] {
	const seen = new Set<string>();
	const result: NugModelInfo[] = [];
	for (const models of cachedModelsByProvider.values()) {
		for (const m of models) {
			const id = String(m.id ?? "");
			if (id && !seen.has(id)) {
				seen.add(id);
				result.push(m);
			}
		}
	}
	return result;
}

/** Get all cached models grouped by provider. */
export function getNugCachedModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: NugModelInfo[];
}> {
	const providers = settings.nugProviders ?? [];
	return providers
		.filter((p) => !p.disabled && cachedModelsByProvider.has(p.id))
		.map((p) => ({
			providerId: p.id,
			providerName: p.name,
			models: cachedModelsByProvider.get(p.id) ?? [],
		}));
}

// Register model checker and lister
registerNugModelChecker((model) => {
	for (const models of cachedModelsByProvider.values()) {
		if (models.some((m) => String(m.id ?? "") === model)) return true;
	}
	return false;
});

registerNugModelLister(() => {
	const result: string[] = [];
	const providers = settings.nugProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = nugProviderPrefix(p);
		const models = cachedModelsByProvider.get(p.id) ?? [];
		for (const m of models) {
			result.push(`${prefix}:${String(m.id ?? "")}`);
		}
	}
	return result;
});

/** Fetch models from NUG service (/v1/models endpoint). */
async function fetchNugModels(config: NUGProviderConfig): Promise<NugModelInfo[]> {
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
	return unique;
}

// === Routes ===

nugRoutes.get("/models", (c) => {
	return c.json({ models: getNugCachedModels(), fromCache: true });
});

nugRoutes.post("/models/refresh", async (c) => {
	const providers = settings.nugProviders ?? [];
	const results: Array<{ providerId: string; name: string; count: number; error?: string }> = [];
	for (const p of providers) {
		try {
			const models = await fetchNugModels(p);
			cachedModelsByProvider.set(p.id, models);
			results.push({ providerId: p.id, name: p.name, count: models.length });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("NUG listModels refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveAllCachedModels();
	return c.json({ results, models: getNugCachedModels(), fromCache: false });
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
		const models = await fetchNugModels(config);
		cachedModelsByProvider.set(id, models);
		saveAllCachedModels();
		return c.json({ models, fromCache: false });
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
		return c.json(data);
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
