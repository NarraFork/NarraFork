import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { logger } from "../lib/logger";
import {
	type AnthropicProviderConfig,
	anthropicProviderPrefix,
	registerAnthropicModelChecker,
	registerAnthropicModelLister,
	settings,
} from "../lib/settings";

export const anthropicRoutes = new Hono();

const cacheDir = resolve(homedir(), ".narrafork");

export interface AnthropicModelInfo {
	id: string;
	display_name?: string;
	created_at?: string;
}

/** Per-provider cached model lists. Key = provider id. */
const cachedModelsByProvider = new Map<string, AnthropicModelInfo[]>();

// Load cache on startup
loadAllCachedModels();

function loadAllCachedModels(): void {
	const cachePath = resolve(cacheDir, "anthropic-models-providers.json");
	try {
		if (existsSync(cachePath)) {
			const data = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<
				string,
				AnthropicModelInfo[]
			>;
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
		const data: Record<string, AnthropicModelInfo[]> = {};
		for (const [id, models] of cachedModelsByProvider) {
			data[id] = models;
		}
		writeFileSync(resolve(cacheDir, "anthropic-models-providers.json"), JSON.stringify(data));
	} catch {
		// non-critical
	}
}

/** Get cached models for a specific provider. */
export function getAnthropicCachedModelsByProvider(providerId: string): AnthropicModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
}

function activeAnthropicProviderIds(): Set<string> {
	return new Set((settings.anthropicProviders ?? []).filter((p) => !p.disabled).map((p) => p.id));
}

/** Get all cached models across active providers. */
export function getAnthropicCachedModels(): AnthropicModelInfo[] {
	const providerIds = activeAnthropicProviderIds();
	const seen = new Set<string>();
	const result: AnthropicModelInfo[] = [];
	for (const [providerId, models] of cachedModelsByProvider) {
		if (!providerIds.has(providerId)) continue;
		for (const m of models) {
			if (!seen.has(m.id)) {
				seen.add(m.id);
				result.push(m);
			}
		}
	}
	return result;
}

/** Get all cached models grouped by provider. */
export function getAnthropicCachedModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: AnthropicModelInfo[];
}> {
	const providers = settings.anthropicProviders ?? [];
	return providers
		.filter((p) => !p.disabled && cachedModelsByProvider.has(p.id))
		.map((p) => ({
			providerId: p.id,
			providerName: p.name,
			models: cachedModelsByProvider.get(p.id) ?? [],
		}));
}

// Register model checker and lister
registerAnthropicModelChecker((model) => {
	const providerIds = activeAnthropicProviderIds();
	for (const [providerId, models] of cachedModelsByProvider) {
		if (!providerIds.has(providerId)) continue;
		if (models.some((m) => m.id === model)) return true;
	}
	return false;
});

registerAnthropicModelLister(() => {
	const result: string[] = [];
	const providers = settings.anthropicProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = anthropicProviderPrefix(p);
		const models = cachedModelsByProvider.get(p.id) ?? [];
		for (const m of models) {
			result.push(`${prefix}:${m.id}`);
		}
	}
	return result;
});

interface FetchAnthropicModelsResult {
	models: AnthropicModelInfo[];
	/** The base URL that actually succeeded (may differ from config if fallback was used). */
	resolvedBaseUrl?: string;
}

/** Fetch models from Anthropic API. */
async function fetchAnthropicModels(
	config: AnthropicProviderConfig,
): Promise<FetchAnthropicModelsResult> {
	const baseUrl = (config.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");

	if (!config.apiKey) {
		throw new Error(`Anthropic API key not configured for provider "${config.name}"`);
	}

	// Official API uses Bearer auth (Claude Code CLI protocol), proxy uses x-api-key
	const headers: Record<string, string> = {
		"anthropic-version": "2023-06-01",
	};
	if (config.officialApi) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	} else {
		headers["x-api-key"] = config.apiKey;
	}

	let response = await fetch(`${baseUrl}/models`, { headers });
	let resolvedBaseUrl: string | undefined;

	// If failed and baseUrl doesn't already end with /v1, retry with /v1 appended
	if (!response.ok && !/\/v1\/?$/i.test(baseUrl)) {
		logger.debug("Anthropic models fetch failed, retrying with /v1 suffix", {
			originalUrl: `${baseUrl}/models`,
			status: response.status,
		});
		response = await fetch(`${baseUrl}/v1/models`, { headers });
		if (response.ok) {
			resolvedBaseUrl = `${baseUrl}/v1`;
		}
	}

	// If still failed and baseUrl ends with a known gateway suffix (e.g. /anthropic),
	// retry with the suffix stripped. Common for third-party proxies like
	// https://api.deepseek.com/anthropic or https://token-plan-cn.xiaomimimo.com/anthropic
	if (!response.ok && /\/[a-z][\w-]*$/i.test(baseUrl)) {
		const strippedUrl = baseUrl.replace(/\/[a-z][\w-]*$/i, "");
		if (strippedUrl !== baseUrl && strippedUrl.length > 0) {
			logger.debug("Anthropic models fetch failed, retrying with suffix stripped", {
				originalUrl: `${baseUrl}/models`,
				strippedUrl: `${strippedUrl}/models`,
				status: response.status,
			});
			response = await fetch(`${strippedUrl}/models`, { headers });
			if (response.ok) {
				resolvedBaseUrl = strippedUrl;
			} else if (!/\/v1\/?$/i.test(strippedUrl)) {
				// Also try stripped + /v1
				response = await fetch(`${strippedUrl}/v1/models`, { headers });
				if (response.ok) {
					resolvedBaseUrl = `${strippedUrl}/v1`;
				}
			}
		}
	}

	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`Anthropic API error ${response.status}: ${errText}`);
	}

	const json = (await response.json()) as { data?: AnthropicModelInfo[] };
	const models = json.data ?? [];
	const seen = new Set<string>();
	const unique = models.filter((m) => {
		if (seen.has(m.id)) return false;
		seen.add(m.id);
		return true;
	});
	unique.sort((a, b) => a.id.localeCompare(b.id));
	return { models: unique, resolvedBaseUrl };
}

/** Remove cached models for providers that no longer exist in settings. */
export function purgeAnthropicProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedModelsByProvider.delete(id)) changed = true;
	}
	if (changed) saveAllCachedModels();
}

// Routes
anthropicRoutes.get("/models", (c) => {
	return c.json({ models: getAnthropicCachedModels(), fromCache: true });
});

anthropicRoutes.post("/models/refresh", async (c) => {
	const providers = settings.anthropicProviders ?? [];
	const results: Array<{
		providerId: string;
		name: string;
		count: number;
		error?: string;
		resolvedBaseUrl?: string;
	}> = [];
	for (const p of providers) {
		try {
			const { models, resolvedBaseUrl } = await fetchAnthropicModels(p);
			cachedModelsByProvider.set(p.id, models);
			results.push({
				providerId: p.id,
				name: p.name,
				count: models.length,
				resolvedBaseUrl,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("Anthropic listModels refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveAllCachedModels();
	return c.json({ results, models: getAnthropicCachedModels(), fromCache: false });
});

anthropicRoutes.get("/providers/:id/models", (c) => {
	const id = c.req.param("id");
	return c.json({ models: getAnthropicCachedModelsByProvider(id), fromCache: true });
});

anthropicRoutes.post("/providers/:id/models/refresh", async (c) => {
	const id = c.req.param("id");
	const providers = settings.anthropicProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) {
		return c.json({ error: `Provider "${id}" not found` }, 404);
	}
	try {
		const { models, resolvedBaseUrl } = await fetchAnthropicModels(config);
		cachedModelsByProvider.set(id, models);
		saveAllCachedModels();
		return c.json({ models, fromCache: false, resolvedBaseUrl });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("Anthropic listModels refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});
