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
const GEMINI_REFRESH_TIMEOUT_MS = 30_000;
const MAX_GEMINI_PAGES = 25;
const MAX_GEMINI_MODELS = 5_000;
const MAX_GEMINI_MODELS_PER_PAGE = 1_000;
const MAX_GEMINI_PAGE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GEMINI_ERROR_BODY_BYTES = 16 * 1024;

export interface GeminiModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	outputTokenLimit?: number;
}

export function isUsableGeminiModel(
	model: { name?: string; supportedGenerationMethods?: string[] },
	transport: NonNullable<GeminiProviderConfig["geminiTransport"]> = "generate-content",
): boolean {
	const id = model.name?.replace(/^models\//, "") ?? "";
	if (!id) return false;
	if (transport === "generate-content") {
		return model.supportedGenerationMethods?.includes("generateContent") ?? false;
	}
	// Interactions catalogs may omit the legacy generateContent marker.
	return id.startsWith("gemini-") && !/(?:^|[-_])(embedding|aqa)(?:[-_]|$)/i.test(id);
}

const cacheDir = narraforkDir;
const modelsCachePath = resolve(cacheDir, "gemini-models-providers.json");

export interface GeminiModelCacheEntry {
	transport: NonNullable<GeminiProviderConfig["geminiTransport"]>;
	models: GeminiModelInfo[];
}

/** Cached models keyed by provider config id and tagged with the wire transport. */
const cachedModelsByProvider = new Map<string, GeminiModelCacheEntry>();

function geminiTransport(config: Pick<GeminiProviderConfig, "geminiTransport">) {
	return config.geminiTransport ?? "generate-content";
}

function matchingCachedModels(
	provider: Pick<GeminiProviderConfig, "id" | "geminiTransport">,
	cache: ReadonlyMap<string, GeminiModelCacheEntry | GeminiModelInfo[]>,
): GeminiModelInfo[] {
	const cached = cache.get(provider.id);
	if (!cached) return [];
	if (Array.isArray(cached)) {
		return geminiTransport(provider) === "generate-content" ? cached : [];
	}
	return cached.transport === geminiTransport(provider) ? cached.models : [];
}

function loadCachedModels(): void {
	try {
		if (existsSync(modelsCachePath)) {
			const data = JSON.parse(readFileSync(modelsCachePath, "utf-8")) as Record<
				string,
				GeminiModelCacheEntry | GeminiModelInfo[]
			>;
			for (const [id, cached] of Object.entries(data)) {
				if (Array.isArray(cached)) {
					cachedModelsByProvider.set(id, { transport: "generate-content", models: cached });
				} else if (
					(cached.transport === "generate-content" || cached.transport === "interactions") &&
					Array.isArray(cached.models)
				) {
					cachedModelsByProvider.set(id, cached);
				}
			}
		}
	} catch {
		// corrupt — ignore
	}
}

function saveCachedModels(): void {
	try {
		mkdirSync(cacheDir, { recursive: true });
		const data: Record<string, GeminiModelCacheEntry> = {};
		for (const [id, cached] of cachedModelsByProvider) {
			data[id] = cached;
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

/** Get cached models for a specific provider when its transport still matches. */
export function getGeminiCachedModelsByProvider(providerId: string): GeminiModelInfo[] {
	const provider = (settings.geminiProviders ?? []).find(
		(candidate) => candidate.id === providerId,
	);
	return provider ? matchingCachedModels(provider, cachedModelsByProvider) : [];
}

/** Get all cached models across active providers with matching transports. */
export function getGeminiCachedModels(): GeminiModelInfo[] {
	const seen = new Set<string>();
	const result: GeminiModelInfo[] = [];
	for (const provider of settings.geminiProviders ?? []) {
		if (provider.disabled) continue;
		for (const model of matchingCachedModels(provider, cachedModelsByProvider)) {
			if (model.id && !seen.has(model.id)) {
				seen.add(model.id);
				result.push(model);
			}
		}
	}
	return result;
}

export function resolveGeminiModelPrefix(
	model: string,
	providers: GeminiProviderConfig[],
	modelsByProvider: ReadonlyMap<string, GeminiModelCacheEntry | GeminiModelInfo[]>,
	providerOrder: string[] = [],
): string | undefined {
	const order = new Map(providerOrder.map((prefix, index) => [prefix, index]));
	const matches = providers
		.map((provider, settingsIndex) => ({ provider, settingsIndex }))
		.filter(
			({ provider }) =>
				!provider.disabled &&
				matchingCachedModels(provider, modelsByProvider).some(
					(candidate) => candidate.id === model,
				),
		)
		.sort((left, right) => {
			const leftOrder = order.get(left.provider.prefix) ?? Number.MAX_SAFE_INTEGER;
			const rightOrder = order.get(right.provider.prefix) ?? Number.MAX_SAFE_INTEGER;
			return leftOrder - rightOrder || left.settingsIndex - right.settingsIndex;
		});
	return matches[0]?.provider.prefix;
}

/** Get all fetched models grouped by active provider. */
export function getGeminiCachedModelsGrouped(): Array<{
	providerId: string;
	providerName: string;
	models: GeminiModelInfo[];
}> {
	const providers = settings.geminiProviders ?? [];
	return providers
		.filter((provider) => !provider.disabled)
		.map((provider) => ({
			providerId: provider.id,
			providerName: provider.name,
			models: matchingCachedModels(provider, cachedModelsByProvider),
		}))
		.filter((group) => group.models.length > 0);
}

// Register model checker and lister — report all fetched models for active providers.
registerGeminiModelChecker((model) =>
	resolveGeminiModelPrefix(
		model,
		settings.geminiProviders ?? [],
		cachedModelsByProvider,
		settings.agent.providerOrder ?? [],
	),
);

registerGeminiModelLister(() => {
	const result: string[] = [];
	const providers = settings.geminiProviders ?? [];
	for (const p of providers) {
		if (p.disabled) continue;
		const prefix = geminiProviderPrefix(p);
		const models = matchingCachedModels(p, cachedModelsByProvider);
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

type GeminiFetch = (
	config: GeminiProviderConfig,
	input: string,
	init?: RequestInit,
) => Promise<Response>;

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel("Gemini response exceeded size limit").catch(() => {});
				throw new Error(`Gemini models API response exceeded ${maxBytes} bytes`);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

function createRefreshSignal(parentSignal?: AbortSignal): {
	signal: AbortSignal;
	cleanup: () => void;
	timedOut: () => boolean;
} {
	const controller = new AbortController();
	let timeoutTriggered = false;
	const timeout = setTimeout(() => {
		timeoutTriggered = true;
		controller.abort(new Error("Gemini model refresh timed out"));
	}, GEMINI_REFRESH_TIMEOUT_MS);
	const onParentAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timeoutTriggered,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onParentAbort);
		},
	};
}

/** Fetch the model list from the Gemini API (paginated). Only content models. */
export async function fetchGeminiModels(
	config: GeminiProviderConfig,
	options: { signal?: AbortSignal; fetcher?: GeminiFetch } = {},
): Promise<GeminiModelInfo[]> {
	if (!config.apiKey) {
		throw new Error(`Gemini API key not configured for provider "${config.name}"`);
	}
	const baseUrl = (config.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
	const models: GeminiModelInfo[] = [];
	const seenPageTokens = new Set<string>();
	const refreshSignal = createRefreshSignal(options.signal);
	const fetcher = options.fetcher ?? pfetch;
	let pageToken: string | undefined;
	let pageCount = 0;

	try {
		do {
			pageCount += 1;
			if (pageCount > MAX_GEMINI_PAGES) {
				throw new Error(`Gemini models API exceeded ${MAX_GEMINI_PAGES} pages`);
			}
			const params = new URLSearchParams({ pageSize: "200" });
			if (pageToken) params.set("pageToken", pageToken);
			const url = `${baseUrl}/models?${params.toString()}`;
			const response = await fetcher(config, url, {
				headers: { "x-goog-api-key": config.apiKey },
				signal: refreshSignal.signal,
			});
			if (!response.ok) {
				const errText = await readBoundedResponseText(response, MAX_GEMINI_ERROR_BODY_BYTES).catch(
					(error) => (error instanceof Error ? error.message : ""),
				);
				throw new Error(`Gemini models API error ${response.status}: ${errText}`);
			}
			const responseText = await readBoundedResponseText(response, MAX_GEMINI_PAGE_RESPONSE_BYTES);
			let json: GeminiListModelsResponse;
			try {
				json = JSON.parse(responseText) as GeminiListModelsResponse;
			} catch {
				throw new Error("Gemini models API returned invalid JSON");
			}
			if (json.error)
				throw new Error(`Gemini models API error: ${json.error.message ?? "unknown"}`);
			const pageModels = json.models ?? [];
			if (pageModels.length > MAX_GEMINI_MODELS_PER_PAGE) {
				throw new Error(
					`Gemini models API returned more than ${MAX_GEMINI_MODELS_PER_PAGE} models in one page`,
				);
			}

			for (const model of pageModels) {
				if (!isUsableGeminiModel(model, geminiTransport(config))) continue;
				if (models.length >= MAX_GEMINI_MODELS) {
					throw new Error(`Gemini models API exceeded ${MAX_GEMINI_MODELS} models`);
				}
				models.push({
					id: model.name?.replace(/^models\//, "") ?? "",
					name: model.displayName,
					contextLength: model.inputTokenLimit,
					outputTokenLimit: model.outputTokenLimit,
				});
			}

			const nextPageToken = json.nextPageToken?.trim() || undefined;
			if (nextPageToken && seenPageTokens.has(nextPageToken)) {
				throw new Error("Gemini models API returned a repeated page token");
			}
			if (nextPageToken) seenPageTokens.add(nextPageToken);
			pageToken = nextPageToken;
		} while (pageToken);
	} catch (error) {
		if (refreshSignal.timedOut()) {
			throw new Error(`Gemini model refresh timed out after ${GEMINI_REFRESH_TIMEOUT_MS}ms`);
		}
		if (options.signal?.aborted) throw new Error("Gemini model refresh was cancelled");
		throw error;
	} finally {
		refreshSignal.cleanup();
	}

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
			const models = await fetchGeminiModels(p, { signal: c.req.raw.signal });
			cachedModelsByProvider.set(p.id, { transport: geminiTransport(p), models });
			fillContextWindows(models, p);
			results.push({ providerId: p.id, name: p.name, count: models.length });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			logger.error("Gemini model refresh failed", { error: msg, provider: p.name });
			results.push({ providerId: p.id, name: p.name, count: 0, error: msg });
		}
	}
	saveCachedModels();
	return c.json({
		results,
		models: getGeminiCachedModels(),
		fromCache: false,
		modelContextWindows: settings.agent.modelContextWindows ?? {},
	});
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
		const models = await fetchGeminiModels(config, { signal: c.req.raw.signal });
		cachedModelsByProvider.set(id, { transport: geminiTransport(config), models });
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
