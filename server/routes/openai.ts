import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { logger } from "../lib/logger";
import {
	getBuiltinCodexModels,
	type OpenAIProviderConfig,
	openaiProviderPrefix,
	registerOpenaiModelChecker,
	registerOpenaiModelLister,
	settings,
} from "../lib/settings";

export const openaiRoutes = new Hono();

const cacheDir = resolve(homedir(), ".narrafork");
const cachePath = resolve(cacheDir, "openai-models.json");

export interface OpenAIModelInfo {
	id: string;
	object?: string;
	owned_by?: string;
}

/** Per-provider cached model lists. Key = provider id. */
const cachedModelsByProvider = new Map<string, OpenAIModelInfo[]>();

// Load legacy flat cache and per-provider cache on startup
loadAllCachedModels();

function loadAllCachedModels(): void {
	// Try per-provider cache first
	const perProviderPath = resolve(cacheDir, "openai-models-providers.json");
	try {
		if (existsSync(perProviderPath)) {
			const data = JSON.parse(readFileSync(perProviderPath, "utf-8")) as Record<
				string,
				OpenAIModelInfo[]
			>;
			for (const [id, models] of Object.entries(data)) {
				cachedModelsByProvider.set(id, models);
			}
			return;
		}
	} catch {
		// corrupt — fall through to legacy
	}
	// Legacy flat cache migration
	try {
		if (existsSync(cachePath)) {
			const models = JSON.parse(readFileSync(cachePath, "utf-8")) as OpenAIModelInfo[];
			// Assign to first provider if available
			const firstProvider = settings.openaiProviders?.[0];
			if (firstProvider) {
				cachedModelsByProvider.set(firstProvider.id, models);
				saveAllCachedModels();
			}
		}
	} catch {
		// corrupt — ignore
	}
}

function saveAllCachedModels(): void {
	try {
		mkdirSync(cacheDir, { recursive: true });
		const data: Record<string, OpenAIModelInfo[]> = {};
		for (const [id, models] of cachedModelsByProvider) {
			data[id] = models;
		}
		writeFileSync(resolve(cacheDir, "openai-models-providers.json"), JSON.stringify(data));
	} catch {
		// non-critical
	}
}

/** Get cached models for a specific provider. */
export function getOpenaiCachedModelsByProvider(providerId: string): OpenAIModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
}

/** Get all cached models across all providers (for backward compat). */
export function getOpenaiCachedModels(): OpenAIModelInfo[] {
	const seen = new Set<string>();
	const result: OpenAIModelInfo[] = [];
	for (const models of cachedModelsByProvider.values()) {
		for (const m of models) {
			if (!seen.has(m.id)) {
				seen.add(m.id);
				result.push(m);
			}
		}
	}
	return result;
}

/** Get all cached models grouped by provider, with provider prefix in id. */
export function getOpenaiCachedModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: OpenAIModelInfo[];
}> {
	const providers = settings.openaiProviders ?? [];
	return providers
		.filter((p) => cachedModelsByProvider.has(p.id))
		.map((p) => ({
			providerId: p.id,
			providerName: p.name,
			models: cachedModelsByProvider.get(p.id) ?? [],
		}));
}

// Register model checker and lister so settings module can detect/list OpenAI models
registerOpenaiModelChecker((model) => {
	for (const models of cachedModelsByProvider.values()) {
		if (models.some((m) => m.id === model)) return true;
	}
	return false;
});
registerOpenaiModelLister(() => {
	const result: string[] = [];
	const providers = settings.openaiProviders ?? [];
	for (const p of providers) {
		const prefix = openaiProviderPrefix(p);
		const models = cachedModelsByProvider.get(p.id) ?? [];
		for (const m of models) {
			result.push(`${prefix}:${m.id}`);
		}
	}
	return result;
});

function defaultBaseUrl(config: OpenAIProviderConfig): string {
	return config.apiMode === "codex"
		? "https://chatgpt.com/backend-api/codex"
		: "https://api.openai.com/v1";
}

function isOfficialCodexDomain(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com");
	} catch {
		return false;
	}
}

/**
 * Build a list of candidate URLs for the /models endpoint.
 */
function buildModelsUrls(baseUrl: string): string[] {
	const urls = [`${baseUrl}/models`];
	try {
		const parsed = new URL(baseUrl);
		const origin = parsed.origin;
		const candidates = [`${origin}/api/v1/models`, `${origin}/v1/models`];
		const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
		const v1Idx = segments.lastIndexOf("v1");
		if (v1Idx > 0) {
			const stripped = `${origin}/${segments.slice(v1Idx).join("/")}/models`;
			if (!candidates.includes(stripped)) candidates.unshift(stripped);
		}
		for (const c of candidates) {
			if (!urls.includes(c)) urls.push(c);
		}
	} catch {
		// Invalid URL — just use the original
	}
	return urls;
}

/** Fetch models from a specific OpenAI-compatible provider. */
async function fetchOpenaiModels(config: OpenAIProviderConfig): Promise<OpenAIModelInfo[]> {
	const apiKey = config.apiKey;
	const baseUrl = (config.baseUrl || defaultBaseUrl(config)).replace(/\/+$/, "");

	if (!apiKey) {
		throw new Error(`OpenAI API key not configured for provider "${config.name}"`);
	}

	if (config.apiMode === "codex" && isOfficialCodexDomain(baseUrl)) {
		return getBuiltinCodexModels().map((id) => ({ id }));
	}

	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	if (config.apiMode === "codex") {
		headers.originator = "narrafork";
		if (config.codexAccountId && isOfficialCodexDomain(baseUrl)) {
			headers["ChatGPT-Account-Id"] = config.codexAccountId;
		}
	}
	const candidateUrls = buildModelsUrls(baseUrl);
	const errors: string[] = [];

	for (const url of candidateUrls) {
		try {
			const response = await fetch(url, { headers });
			if (response.status === 404) {
				errors.push(`${url} → 404`);
				continue;
			}
			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				errors.push(`${url} → ${response.status}: ${errText}`);
				continue;
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.includes("json")) {
				errors.push(`${url} → non-JSON response (${contentType || "no content-type"})`);
				continue;
			}
			const json = (await response.json()) as { data?: OpenAIModelInfo[] };
			const models = json.data ?? [];
			const seen = new Set<string>();
			const unique = models.filter((m) => {
				if (seen.has(m.id)) return false;
				seen.add(m.id);
				return true;
			});
			unique.sort((a, b) => a.id.localeCompare(b.id));
			if (url !== candidateUrls[0]) {
				logger.info("OpenAI models fetched from fallback URL", {
					url,
					provider: config.name,
				});
			}
			return unique;
		} catch (err) {
			errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(`Failed to fetch models from all candidate URLs: ${errors.join("; ")}`);
}

/** Remove cached models for providers that no longer exist in settings. */
export function purgeOpenaiProviderCache(removedIds: string[]): void {
	let changed = false;
	for (const id of removedIds) {
		if (cachedModelsByProvider.delete(id)) changed = true;
	}
	if (changed) saveAllCachedModels();
}

// Legacy endpoints (backward compat)
openaiRoutes.get("/models", (c) => {
	return c.json({ models: getOpenaiCachedModels(), fromCache: true });
});

openaiRoutes.post("/models/refresh", async (c) => {
	// Refresh all providers
	const providers = settings.openaiProviders ?? [];
	const results: Array<{ providerId: string; name: string; count: number; error?: string }> = [];
	for (const p of providers) {
		try {
			const models = await fetchOpenaiModels(p);
			cachedModelsByProvider.set(p.id, models);
			results.push({ providerId: p.id, name: p.name, count: models.length });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("OpenAI listModels refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveAllCachedModels();
	return c.json({ results, models: getOpenaiCachedModels(), fromCache: false });
});

// Per-provider endpoints
openaiRoutes.get("/providers/:id/models", (c) => {
	const id = c.req.param("id");
	return c.json({ models: getOpenaiCachedModelsByProvider(id), fromCache: true });
});

openaiRoutes.post("/providers/:id/models/refresh", async (c) => {
	const id = c.req.param("id");
	const providers = settings.openaiProviders ?? [];
	const config = providers.find((p) => p.id === id);
	if (!config) {
		return c.json({ error: `Provider "${id}" not found` }, 404);
	}
	try {
		const models = await fetchOpenaiModels(config);
		cachedModelsByProvider.set(id, models);
		saveAllCachedModels();
		return c.json({ models, fromCache: false });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("OpenAI listModels refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});
