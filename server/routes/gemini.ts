import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { logger } from "../lib/logger";
import { resolveProxyForUrl } from "../lib/net/proxy";
import {
	type GeminiProviderConfig,
	geminiProviderPrefix,
	narraforkDir,
	registerGeminiModelChecker,
	registerGeminiModelLister,
	saveSettings,
	settings,
} from "../lib/settings";
import { requireAdmin, requireAuth } from "../middleware/auth";

export const geminiRoutes = new Hono();

// All Gemini routes require admin privileges
geminiRoutes.use("*", requireAuth, requireAdmin);

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	outputTokenLimit?: number;
}

const cacheDir = narraforkDir;
const modelsCachePath = resolve(cacheDir, "gemini-models-providers.json");

/** Cached models keyed by provider config id. */
const cachedModelsByProvider = new Map<string, GeminiModelInfo[]>();

function loadCachedModels(): void {
	try {
		if (existsSync(modelsCachePath)) {
			const data = JSON.parse(readFileSync(modelsCachePath, "utf-8")) as Record<
				string,
				GeminiModelInfo[]
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
		const data: Record<string, GeminiModelInfo[]> = {};
		for (const [id, models] of cachedModelsByProvider) {
			data[id] = models;
		}
		writeFileSync(modelsCachePath, JSON.stringify(data));
	} catch {
		// non-critical
	}
}

loadCachedModels();

/** Remove cached models for providers that no longer exist in settings. */
export function purgeGeminiProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedModelsByProvider.delete(id)) changed = true;
	}
	if (changed) saveCachedModels();
}

/** Get cached models for a specific provider. */
export function getGeminiCachedModelsByProvider(providerId: string): GeminiModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
}

/** Get all cached models across all providers. */
export function getGeminiCachedModels(): GeminiModelInfo[] {
	const seen = new Set<string>();
	const result: GeminiModelInfo[] = [];
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

function activeGeminiProviderIds(): Set<string> {
	return new Set((settings.geminiProviders ?? []).filter((p) => !p.disabled).map((p) => p.id));
}

/** Get all fetched models grouped by active provider. */
export function getGeminiCachedModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: GeminiModelInfo[];
}> {
	const providers = settings.geminiProviders ?? [];
	return providers
		.filter((p) => !p.disabled && cachedModelsByProvider.has(p.id))
		.map((p) => ({
			providerId: p.id,
			providerName: p.name,
			models: cachedModelsByProvider.get(p.id) ?? [],
		}));
}

// Register model checker and lister — report all fetched models for active providers.
registerGeminiModelChecker((model) => {
	const providerIds = activeGeminiProviderIds();
	for (const [providerId, models] of cachedModelsByProvider) {
		if (!providerIds.has(providerId)) continue;
		if (models.some((m) => m.id === model)) return true;
	}
	return false;
});

registerGeminiModelLister(() => {
	const result: string[] = [];
	const providers = settings.geminiProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = geminiProviderPrefix(p);
		const models = cachedModelsByProvider.get(p.id) ?? [];
		for (const m of models) {
			result.push(`${prefix}:${m.id}`);
		}
	}
	return result;
});

/** Proxy-aware fetch honouring the provider's proxy override. */
function pfetch(
	config: GeminiProviderConfig,
	input: string,
	init?: RequestInit,
): Promise<Response> {
	const proxy = resolveProxyForUrl(input, config.proxy);
	if (proxy) {
		// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
		return fetch(input, { ...init, proxy } as any);
	}
	return fetch(input, init);
}

interface GeminiListModelsResponse {
	models?: Array<{
		name?: string;
		displayName?: string;
		inputTokenLimit?: number;
		outputTokenLimit?: number;
		supportedGenerationMethods?: string[];
	}>;
	nextPageToken?: string;
	error?: { message?: string };
}

/** Fetch the model list from the Gemini API (paginated). Only content models. */
async function fetchGeminiModels(config: GeminiProviderConfig): Promise<GeminiModelInfo[]> {
	if (!config.apiKey) {
		throw new Error(`Gemini API key not configured for provider "${config.name}"`);
	}
	const baseUrl = (config.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
	const models: GeminiModelInfo[] = [];
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({ pageSize: "200" });
		if (pageToken) params.set("pageToken", pageToken);
		const url = `${baseUrl}/models?${params.toString()}`;
		const response = await pfetch(config, url, {
			headers: { "x-goog-api-key": config.apiKey },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Gemini models API error ${response.status}: ${errText}`);
		}
		const json = (await response.json()) as GeminiListModelsResponse;
		if (json.error) throw new Error(`Gemini models API error: ${json.error.message}`);

		for (const m of json.models ?? []) {
			if (!m.name) continue;
			// Only include models that support content generation (chat).
			if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
			// name is "models/gemini-2.5-flash" → strip the prefix.
			const id = m.name.replace(/^models\//, "");
			models.push({
				id,
				name: m.displayName,
				contextLength: m.inputTokenLimit,
				outputTokenLimit: m.outputTokenLimit,
			});
		}
		pageToken = json.nextPageToken;
	} while (pageToken);

	models.sort((a, b) => a.id.localeCompare(b.id));
	return models;
}

/** Fill context window sizes into settings for a provider's fetched models. */
function fillContextWindows(models: GeminiModelInfo[], provider: GeminiProviderConfig): void {
	let changed = false;
	const windows = settings.agent.modelContextWindows ?? {};
	settings.agent.modelContextWindows = windows;
	for (const m of models) {
		if (m.contextLength != null && !windows[`${provider.prefix}:${m.id}`]) {
			windows[`${provider.prefix}:${m.id}`] = m.contextLength;
			changed = true;
		}
	}
	if (changed) saveSettings(settings);
}

// === Routes ===

/** GET /api/gemini/models — cached model list across providers. */
geminiRoutes.get("/models", (c) => {
	return c.json({ models: getGeminiCachedModels(), fromCache: true });
});

/** POST /api/gemini/models/refresh — refresh all providers' model lists. */
geminiRoutes.post("/models/refresh", async (c) => {
	const providers = settings.geminiProviders ?? [];
	const results: Array<{ providerId: string; name: string; count: number; error?: string }> = [];
	for (const p of providers) {
		if (p.disabled || !p.apiKey) continue;
		try {
			const models = await fetchGeminiModels(p);
			cachedModelsByProvider.set(p.id, models);
			fillContextWindows(models, p);
			results.push({ providerId: p.id, name: p.name, count: models.length });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("Gemini model refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveCachedModels();
	return c.json({ results, models: getGeminiCachedModels(), fromCache: false });
});

/** GET /api/gemini/providers/:id/models — cached models for a specific provider. */
geminiRoutes.get("/providers/:id/models", (c) => {
	const id = c.req.param("id");
	return c.json({ models: getGeminiCachedModelsByProvider(id), fromCache: true });
});

/** POST /api/gemini/providers/:id/models/refresh — refresh one provider. */
geminiRoutes.post("/providers/:id/models/refresh", async (c) => {
	const id = c.req.param("id");
	const config = (settings.geminiProviders ?? []).find((p) => p.id === id);
	if (!config) {
		return c.json({ error: `Provider "${id}" not found` }, 404);
	}
	try {
		const models = await fetchGeminiModels(config);
		cachedModelsByProvider.set(id, models);
		fillContextWindows(models, config);
		saveCachedModels();
		return c.json({
			models,
			count: models.length,
			fromCache: false,
			modelContextWindows: settings.agent.modelContextWindows ?? {},
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("Gemini model refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});
