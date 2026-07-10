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

/**
 * Fetch the model list for an Anthropic-compatible provider.
 *
 * Background: the official Anthropic Messages API has **no model-list
 * endpoint** — `GET /v1/models` is an OpenAI convention. Third-party relays
 * that speak the Anthropic protocol therefore expose their model list at the
 * OpenAI-style `/v1/models` path, which often lives at the host root rather
 * than under the Anthropic messages base path. For example xiaomi serves
 * messages at `https://host/anthropic/v1` but its model list at
 * `https://host/v1/models`. Because of this we try a series of candidate base
 * URLs (including the host origin) until one returns a valid list.
 */
export async function fetchAnthropicModels(
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

	// Ordered list of candidate base URLs to try for the /models endpoint. The
	// first entry is always the user-configured base URL, so its error (if any)
	// is reported first — this is the endpoint the user controls and the one
	// they most likely need to fix. `suggest` marks whether the candidate is
	// also a valid *messages* base URL worth surfacing to the user as a
	// correction. Origin-based candidates are NOT suggested: the model list may
	// live at the host root while messages stay under a sub-path (e.g. xiaomi
	// serves messages at https://host/anthropic/v1 but the model list at
	// https://host/v1), so rewriting the messages baseUrl to the origin would
	// break chat.
	const candidates: Array<{ base: string; suggest: boolean }> = [{ base: baseUrl, suggest: false }];
	const seenCandidates = new Set<string>([baseUrl]);
	const pushCandidate = (b: string, suggest: boolean) => {
		if (b && !seenCandidates.has(b)) {
			seenCandidates.add(b);
			candidates.push({ base: b, suggest });
		}
	};

	if (!/\/v1\/?$/i.test(baseUrl)) pushCandidate(`${baseUrl}/v1`, true);

	// Strip a trailing gateway path segment (e.g. /anthropic or /v1).
	if (/\/[a-z][\w-]*$/i.test(baseUrl)) {
		const stripped = baseUrl.replace(/\/[a-z][\w-]*$/i, "");
		if (stripped.length > 0) {
			pushCandidate(stripped, true);
			if (!/\/v1\/?$/i.test(stripped)) pushCandidate(`${stripped}/v1`, true);
		}
	}

	// Host root + /v1 (and bare host root). Since the model list is an
	// OpenAI-style endpoint (Anthropic has none), relays commonly serve it at
	// `{origin}/v1/models` regardless of where the Anthropic messages base
	// path points. NOT suggested as a messages baseUrl for the same reason.
	try {
		const origin = new URL(baseUrl).origin;
		pushCandidate(`${origin}/v1`, false);
		pushCandidate(origin, false);
	} catch {
		// baseUrl not a valid absolute URL — skip origin-based candidates
	}

	// Try each candidate in order, collecting per-candidate errors so that when
	// all fail we can surface every attempt (with the configured URL first)
	// instead of hiding the real endpoint's error behind a wrong fallback's 404.
	let response: Response | undefined;
	let resolvedBaseUrl: string | undefined;
	const errors: string[] = [];

	for (const candidate of candidates) {
		const candidateUrl = `${candidate.base}/models`;
		try {
			const resp = await fetch(candidateUrl, { headers });
			if (resp.ok) {
				response = resp;
				// candidates[0] is the configured base URL — no correction needed.
				resolvedBaseUrl =
					candidate.base !== baseUrl && candidate.suggest ? candidate.base : undefined;
				break;
			}
			const errText = await resp.text().catch(() => "");
			errors.push(`${candidateUrl} → ${resp.status}${errText ? `: ${errText}` : ""}`);
			logger.debug("Anthropic models fetch retry", {
				retryUrl: candidateUrl,
				status: resp.status,
			});
		} catch (err) {
			errors.push(`${candidateUrl} → ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (!response) {
		throw new Error(`Anthropic API error. Tried: ${errors.join("; ")}`);
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
