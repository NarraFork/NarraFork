import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { buildOpencodeSessionHeader } from "../lib/agent/opencode-session";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import {
	getBuiltinCodexModels,
	type OpenAIProviderConfig,
	openaiProviderPrefix,
	registerOpenaiModelChecker,
	registerOpenaiModelLister,
	settings,
} from "../lib/settings";

export const openaiRoutes = new Hono();

const cacheDir = getNarraforkHome();
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

function activeOpenaiProviderIds(): Set<string> {
	return new Set((settings.openaiProviders ?? []).filter((p) => !p.disabled).map((p) => p.id));
}

/** Get all cached models across active providers (for backward compat). */
export function getOpenaiCachedModels(): OpenAIModelInfo[] {
	const providerIds = activeOpenaiProviderIds();
	const seen = new Set<string>();
	const result: OpenAIModelInfo[] = [];
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

/** Get all cached models grouped by provider, with provider prefix in id. */
export function getOpenaiCachedModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: OpenAIModelInfo[];
}> {
	const providers = settings.openaiProviders ?? [];
	return providers
		.filter((p) => !p.disabled && cachedModelsByProvider.has(p.id))
		.map((p) => ({
			providerId: p.id,
			providerName: p.name,
			models: cachedModelsByProvider.get(p.id) ?? [],
		}));
}

// Register model checker and lister so settings module can detect/list OpenAI models
registerOpenaiModelChecker((model) => {
	const providerIds = activeOpenaiProviderIds();
	for (const [providerId, models] of cachedModelsByProvider) {
		if (!providerIds.has(providerId)) continue;
		if (models.some((m) => m.id === model)) return true;
	}
	return false;
});
registerOpenaiModelLister(() => {
	const result: string[] = [];
	const providers = settings.openaiProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
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

/** A candidate /models URL, plus (optionally) the chat base URL it implies. */
interface ModelsUrlCandidate {
	/** Full URL to fetch the model list from. */
	url: string;
	/**
	 * When set, this candidate is derived by appending `/v1` to the configured
	 * base URL — a form that is ALSO a valid chat base URL, so if it succeeds we
	 * can safely suggest the user persist it. Origin-based candidates leave this
	 * undefined: the model list may live at the host root while chat stays under
	 * a sub-path, so suggesting them as the chat base URL would break chat.
	 */
	suggestBaseUrl?: string;
}

/**
 * Build a list of candidate URLs for the /models endpoint.
 *
 * The first entry is always the configured base URL. When the base URL lacks a
 * trailing `/v1`, a suggest-safe `${baseUrl}/v1/models` candidate is added next
 * (mirroring the Anthropic model-list fallback): it carries `suggestBaseUrl` so
 * a success can prompt the user to fix their base URL. Remaining origin-based
 * candidates are informational only (no `suggestBaseUrl`).
 */
export function buildModelsUrls(baseUrl: string): ModelsUrlCandidate[] {
	const candidates: ModelsUrlCandidate[] = [{ url: `${baseUrl}/models` }];
	const seen = new Set<string>([`${baseUrl}/models`]);
	const push = (candidate: ModelsUrlCandidate) => {
		if (!seen.has(candidate.url)) {
			seen.add(candidate.url);
			candidates.push(candidate);
		}
	};

	// Suggest-safe: appending /v1 to the configured base URL yields a valid chat
	// base URL too, so a success here is worth suggesting as a baseUrl fix.
	if (!/\/v1\/?$/i.test(baseUrl)) {
		push({ url: `${baseUrl}/v1/models`, suggestBaseUrl: `${baseUrl}/v1` });
	}

	try {
		const parsed = new URL(baseUrl);
		const origin = parsed.origin;
		const originCandidates = [`${origin}/api/v1/models`, `${origin}/v1/models`];
		const segments = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
		const v1Idx = segments.lastIndexOf("v1");
		if (v1Idx > 0) {
			const stripped = `${origin}/${segments.slice(v1Idx).join("/")}/models`;
			if (!originCandidates.includes(stripped)) originCandidates.unshift(stripped);
		}
		// Origin-based candidates are informational only (no suggestBaseUrl).
		for (const url of originCandidates) push({ url });
	} catch {
		// Invalid URL — just use the original
	}
	return candidates;
}

interface FetchOpenaiModelsResult {
	models: OpenAIModelInfo[];
	/**
	 * A chat base URL worth suggesting to the user (only set when the model list
	 * succeeded at `${baseUrl}/v1/models`, a form that is also a valid chat base
	 * URL). Safe to persist as the provider's base URL.
	 */
	resolvedBaseUrl?: string;
	/**
	 * The fallback URL the model list was actually fetched from, when it differs
	 * from the configured base URL but is NOT safe to suggest as the chat base
	 * URL (origin-based). Informational only — the chat base URL may not need to
	 * change.
	 */
	resolvedModelsUrl?: string;
}

/** Fetch models from a specific OpenAI-compatible provider. */
async function fetchOpenaiModels(config: OpenAIProviderConfig): Promise<FetchOpenaiModelsResult> {
	const apiKey = config.apiKey;
	const baseUrl = (config.baseUrl || defaultBaseUrl(config)).replace(/\/+$/, "");

	if (!apiKey) {
		throw new Error(`OpenAI API key not configured for provider "${config.name}"`);
	}

	if (config.apiMode === "codex" && isOfficialCodexDomain(baseUrl)) {
		return { models: getBuiltinCodexModels().map((id) => ({ id })) };
	}

	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	// The catalog is a request to the same gateway as inference, and OpenCode
	// announced that requests without a session header may start erroring — an
	// empty model dropdown is how that would surface here.
	Object.assign(
		headers,
		buildOpencodeSessionHeader({ baseUrl: config.baseUrl, extraHeaders: config.extraHeaders }),
	);
	if (config.apiMode === "codex") {
		headers.originator = "narrafork";
		if (config.codexAccountId && isOfficialCodexDomain(baseUrl)) {
			headers["ChatGPT-Account-Id"] = config.codexAccountId;
		}
	}
	const candidates = buildModelsUrls(baseUrl);
	const errors: string[] = [];

	for (const candidate of candidates) {
		const { url } = candidate;
		try {
			const response = await fetch(url, { headers });
			if (response.status === 404) {
				errors.push(`${url} → 404`);
				continue;
			}
			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				errors.push(`${url} → ${response.status}${errText ? `: ${errText}` : ""}`);
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
			const isFallback = url !== candidates[0].url;
			if (isFallback) {
				logger.info("OpenAI models fetched from fallback URL", {
					url,
					provider: config.name,
				});
			}
			return {
				models: unique,
				// A suggest-safe candidate (baseUrl + /v1) → offer as a baseUrl fix.
				resolvedBaseUrl: candidate.suggestBaseUrl,
				// Any other fallback URL → informational only.
				resolvedModelsUrl: isFallback && !candidate.suggestBaseUrl ? url : undefined,
			};
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
			const { models } = await fetchOpenaiModels(p);
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
		const { models, resolvedBaseUrl, resolvedModelsUrl } = await fetchOpenaiModels(config);
		cachedModelsByProvider.set(id, models);
		saveAllCachedModels();
		return c.json({ models, fromCache: false, resolvedBaseUrl, resolvedModelsUrl });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		logger.error("OpenAI listModels refresh failed", { error: msg, provider: config.name });
		return c.json({ error: msg }, 500);
	}
});
