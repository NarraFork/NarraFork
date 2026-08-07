/**
 * The model pool, the enabled-model catalog, and Cline's recommended lists.
 *
 * ## `provider.listModels` returns the enabled set, not the pool
 *
 * OpenRouter exposes 300+ models. Putting all of them into the host catalog would flood the
 * model picker and bury every other provider, so the user picks a subset and only that subset
 * is offered to the agent. The built-in adapter makes the same choice with its
 * `enabledModels` field.
 *
 * A consequence worth stating: this plugin does **not** paginate. The protocol supports
 * `cursor`/`limit` and the host follows `nextCursor` when present
 * (`plugin-provider-catalog-refresh.ts`), but the enabled set is bounded by what a human
 * selected — a single page always. Implementing pagination for a list that cannot fill one
 * page would be code that never runs.
 *
 * The full pool is still reachable, through the `models.search` and `recommended-models`
 * commands, which is how the settings view lets the user choose.
 *
 * ## Where the pool cache lives
 *
 * `NF_PLUGIN_DATA_DIR` is the writable directory the runtime provides (`SAFE_ENV_KEYS` in
 * `plugin-runtime.ts`). Falling back to the working directory would be wrong: the runtime sets
 * cwd to the *package* directory, so a fallback would write cache files into the plugin's own
 * source tree — which, for a plugin shipped from this repo, means into version control. The
 * fallback is the OS temp directory instead, where a cache simply does not outlive the process.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenRouterHeaders } from "./auth";
import { pfetch } from "./fetch";
import { log } from "./rpc";

/** Public OpenRouter model list. Not the Cline gateway: this endpoint needs no credential. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Cline's own curated lists. */
const RECOMMENDED_MODELS_PATH = "/api/v1/ai/cline/recommended-models";

/** How long a cached pool is served before it is re-fetched. */
const POOL_TTL_MS = 30 * 60 * 1000;

/**
 * Context window assumed when the pool does not report one.
 *
 * A guess, but a bounded one: the value is only used for the "headroom" display, and the
 * alternative — omitting it — makes the host show nothing at all.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Upper bound on models returned from `listModels`.
 *
 * Mirrors `limits.maxModelPageSize` in the manifest, which is the value the host enforces
 * (`plugin-provider-rpc.ts` clamps the request limit against it). Declared in both places
 * because the manifest is data the host reads and this is the code that must not exceed it;
 * the test suite asserts they agree.
 */
export const MAX_MODELS = 50;

export interface PoolModel {
	id: string;
	name?: string;
	contextLength?: number;
	promptPrice?: string;
	completionPrice?: string;
}

export interface RecommendedModel {
	id: string;
	name: string;
	description?: string;
	tags: string[];
}

export interface RecommendedModels {
	recommended: RecommendedModel[];
	free: RecommendedModel[];
}

/**
 * Fallback lists, used when the endpoint is unreachable and no cache exists.
 *
 * Copied from the built-in adapter. A stale suggestion is better than an empty page on first
 * run, which would look like the plugin was broken.
 */
const RECOMMENDED_FALLBACK: RecommendedModels = {
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

function dataDir(): string {
	const base = process.env.NF_PLUGIN_DATA_DIR?.trim();
	const dir = base ? join(base, "cline") : join(tmpdir(), `cline-external-${process.pid}`);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// Non-fatal: without a cache every lookup goes upstream, which is slower but correct.
	}
	return dir;
}

function poolCachePath(): string {
	return join(dataDir(), "openrouter-models.json");
}

function recommendedCachePath(): string {
	return join(dataDir(), "recommended-models.json");
}

interface PoolCache {
	fetchedAt: number;
	models: PoolModel[];
}

let memoryPool: PoolCache | undefined;

function readPoolCache(): PoolCache | undefined {
	if (memoryPool) return memoryPool;
	try {
		const parsed = JSON.parse(readFileSync(poolCachePath(), "utf-8")) as PoolCache;
		if (!Array.isArray(parsed.models)) return undefined;
		memoryPool = parsed;
		return parsed;
	} catch {
		return undefined;
	}
}

function writePoolCache(cache: PoolCache): void {
	memoryPool = cache;
	try {
		writeFileSync(poolCachePath(), JSON.stringify(cache));
	} catch {
		// Non-fatal: the in-memory copy still serves this process.
	}
}

/** Test seam: drop cached pool state so cases do not leak into one another. */
export function resetModelCaches(): void {
	memoryPool = undefined;
	memoryRecommended = undefined;
}

/**
 * Fetch the OpenRouter pool.
 *
 * Sorted by id so `models.search` results and the settings view are stable between calls;
 * OpenRouter's own ordering is not guaranteed.
 */
export async function fetchModelPool(proxyUrl?: string): Promise<PoolModel[]> {
	const response = await pfetch(
		OPENROUTER_MODELS_URL,
		{ headers: buildOpenRouterHeaders() },
		proxyUrl,
	);
	if (!response.ok) {
		throw new Error(`OpenRouter models request failed with ${response.status}`);
	}
	const json = (await response.json()) as {
		data?: Array<{
			id?: string;
			name?: string;
			context_length?: number | null;
			pricing?: { prompt?: string; completion?: string } | null;
		}>;
	};
	const models: PoolModel[] = [];
	for (const entry of json.data ?? []) {
		if (!entry.id) continue;
		models.push({
			id: entry.id,
			...(entry.name ? { name: entry.name } : {}),
			...(typeof entry.context_length === "number" ? { contextLength: entry.context_length } : {}),
			...(entry.pricing?.prompt ? { promptPrice: entry.pricing.prompt } : {}),
			...(entry.pricing?.completion ? { completionPrice: entry.pricing.completion } : {}),
		});
	}
	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

/** The pool, from cache when fresh. `force` re-fetches regardless of age. */
export async function getModelPool(
	options: { force?: boolean; proxyUrl?: string } = {},
): Promise<PoolModel[]> {
	const cached = readPoolCache();
	if (!options.force && cached && Date.now() - cached.fetchedAt < POOL_TTL_MS) {
		return cached.models;
	}
	try {
		const models = await fetchModelPool(options.proxyUrl);
		writePoolCache({ fetchedAt: Date.now(), models });
		return models;
	} catch (error) {
		// Serve a stale pool rather than failing: it is a metadata lookup, and the ids in it are
		// still valid. Only a first run with no cache surfaces the error.
		if (cached) {
			log("model pool refresh failed; serving cached pool", {
				error: error instanceof Error ? error.name : "unknown",
			});
			return cached.models;
		}
		throw error;
	}
}

/**
 * The pool if one is already cached, without any network call.
 *
 * `listModels` uses this: the host calls it on a schedule the user never sees, and blocking a
 * catalog refresh on a third-party endpoint would make the provider look broken whenever
 * OpenRouter is slow. Missing metadata degrades to the default context window instead.
 */
export function cachedModelPool(): PoolModel[] {
	return readPoolCache()?.models ?? [];
}

export interface CatalogModel {
	id: string;
	displayName: string;
	contextWindow: number;
	capabilities: {
		chat: true;
		generate: true;
		streaming: true;
		tools: true;
		reasoning: false;
		sessionMode: "stateless";
	};
}

export interface CatalogResult {
	models: CatalogModel[];
	catalogVersion?: string;
	cacheTtlMs?: number;
	stale?: boolean;
}

/**
 * The catalog for the user's enabled models.
 *
 * An empty selection returns an empty, stale catalog rather than an error: an unconfigured
 * provider is the normal state right after install, and the host refreshes catalogs for every
 * registered provider before the user has chosen anything. Reporting an error there would
 * surface as a broken plugin and, during release validation, as a failing package.
 */
export function buildCatalog(enabledModels: readonly string[]): CatalogResult {
	if (enabledModels.length === 0) {
		log("listModels called before any model was enabled");
		return { models: [], stale: true };
	}

	const selected =
		enabledModels.length > MAX_MODELS ? enabledModels.slice(0, MAX_MODELS) : enabledModels;
	if (selected.length !== enabledModels.length) {
		log("enabled model list truncated to the declared page size", {
			enabled: enabledModels.length,
			returned: selected.length,
		});
	}

	const pool = new Map(cachedModelPool().map((model) => [model.id, model]));
	const models: CatalogModel[] = selected.map((id) => {
		const entry = pool.get(id);
		return {
			id,
			displayName: entry?.name || id,
			contextWindow: entry?.contextLength ?? DEFAULT_CONTEXT_WINDOW,
			capabilities: {
				chat: true,
				generate: true,
				streaming: true,
				tools: true,
				// OpenAI chat/completions gives no way to return a thinking block, so a model
				// that reasons internally still cannot expose it here. Claiming otherwise would
				// have the host request continuations this provider cannot honour.
				reasoning: false,
				sessionMode: "stateless",
			},
		};
	});

	return {
		models,
		// Changes whenever the selection changes, so the host can tell a real update from a
		// no-op refresh.
		catalogVersion: `cline-${models.length}-${hashIds(selected)}`,
		cacheTtlMs: 300_000,
	};
}

/** Short stable digest of an id list, for the catalog version. */
function hashIds(ids: readonly string[]): string {
	let hash = 0;
	for (const id of ids) {
		for (let index = 0; index < id.length; index += 1) {
			hash = (hash * 31 + id.charCodeAt(index)) | 0;
		}
	}
	return (hash >>> 0).toString(36);
}

/** The context window for one model, from the cached pool. */
export function contextWindowFor(modelId: string): number {
	const entry = cachedModelPool().find((model) => model.id === modelId);
	return entry?.contextLength ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Search the pool.
 *
 * All whitespace-separated terms must match somewhere in the id or name, which is what the
 * built-in `/pool/search` endpoint does — an OR match over 300 models returns almost
 * everything and is useless for narrowing.
 */
export function searchPool(
	pool: readonly PoolModel[],
	query: string,
	limit: number,
): { models: PoolModel[]; total: number } {
	const normalized = query.toLowerCase().trim();
	if (!normalized) return { models: pool.slice(0, limit), total: pool.length };
	const terms = normalized.split(/\s+/);
	const matched = pool.filter((model) => {
		const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
	return { models: matched.slice(0, limit), total: matched.length };
}

let memoryRecommended: { fetchedAt: number; data: RecommendedModels } | undefined;

/**
 * Cline's recommended and free model lists.
 *
 * Three layers on failure — memory, then disk, then the hardcoded lists — because this drives
 * the first screen a user sees after signing in, and an empty list there is
 * indistinguishable from a broken plugin.
 */
export async function fetchRecommendedModels(
	accountBaseUrl: string,
	proxyUrl?: string,
): Promise<RecommendedModels> {
	if (memoryRecommended && Date.now() - memoryRecommended.fetchedAt < POOL_TTL_MS) {
		return memoryRecommended.data;
	}

	try {
		const response = await pfetch(
			`${accountBaseUrl.replace(/\/+$/, "")}${RECOMMENDED_MODELS_PATH}`,
			{ headers: buildOpenRouterHeaders() },
			proxyUrl,
		);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const json = (await response.json()) as {
			data?: RecommendedModels;
			recommended?: RecommendedModel[];
			free?: RecommendedModel[];
		};
		// The endpoint has been observed both wrapped in `data` and flat.
		const data: RecommendedModels = json.data ?? {
			recommended: json.recommended ?? [],
			free: json.free ?? [],
		};
		if (data.recommended.length > 0 || data.free.length > 0) {
			memoryRecommended = { fetchedAt: Date.now(), data };
			try {
				writeFileSync(recommendedCachePath(), JSON.stringify(data));
			} catch {
				// Non-fatal.
			}
			return data;
		}
		// An empty success is treated as a failure so the fallback applies; an empty list is
		// never a useful answer here.
		throw new Error("recommended models response was empty");
	} catch (error) {
		log("recommended models request failed; using cache or fallback", {
			error: error instanceof Error ? error.name : "unknown",
		});
		try {
			const cached = JSON.parse(readFileSync(recommendedCachePath(), "utf-8")) as RecommendedModels;
			if (Array.isArray(cached.recommended) && Array.isArray(cached.free)) return cached;
		} catch {
			// Fall through to the built-in lists.
		}
		return RECOMMENDED_FALLBACK;
	}
}
