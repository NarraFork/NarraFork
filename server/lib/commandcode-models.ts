/**
 * Command Code 模型列表（带缓存）。
 *
 * Provider API 的 `GET /provider/v1/models` 是运行时数据（上游随时增删模型），所以不像 codex
 * 那样硬编码，而是拉取后缓存。设置读取只看缓存并在后台补拉，不把上游延迟算进这次响应。
 */

import { type CommandCodeCredential, resolveCommandCodeToken } from "./commandcode-manager";
import {
	type CommandCodeModelInfo,
	commandCodeProviderBase,
	parseCommandCodeModels,
} from "./commandcode-protocol";
import { readResponseJsonLimited } from "./commandcode-usage";
import { captureModelOptionsArray, optionInput } from "./model-options-contract";
import { getProviderKeyStore } from "./provider-keys";
import { settings, subscribeSettingsChanges } from "./settings";
import type { SourceGroupView } from "./sourcing/source-groups";

const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

interface ModelCache {
	models: CommandCodeModelInfo[];
	fetchedAt: number;
	token: string;
	base: string;
	source: CommandCodeCredential["source"];
	/** 上游失败。短时间内不再打，避免设置页每次读取都等满超时。 */
	negative: boolean;
}

let cache: ModelCache | undefined;
let generation = 0;
let inflight: { key: string; task: Promise<void> } | undefined;
let publicationGeneration = 0;
/** Read only the owner cache; options must not trigger stale-while-revalidate network work. */
export function captureCommandCodeModelOptions(
	group: SourceGroupView,
	apiKey?: string,
	baseUrl?: string,
) {
	const pinned = getCachedCommandCodeModels(apiKey, baseUrl);
	return captureModelOptionsArray(
		pinned,
		(model) => optionInput(group, model.id),
		publicationGeneration,
	);
}

export interface CommandCodeModelSnapshot {
	models: string[];
	/** 缓存过期或还没有，后台正在拉。调用方可以过一会儿再读一次。 */
	pending: boolean;
}

function cacheKey(token: string, base: string, source: CommandCodeCredential["source"]): string {
	return `${source}\n${base}\n${token}`;
}

function sameSlot(entry: ModelCache, token: string, base: string): boolean {
	return entry.token === token && entry.base === base;
}

function fresh(entry: ModelCache): boolean {
	const ttl = entry.negative ? NEGATIVE_TTL_MS : CACHE_TTL_MS;
	return Date.now() - entry.fetchedAt < ttl;
}

/** 丢弃缓存，让下一次拉取重新向上游请求（设置页的「刷新模型」）。 */
export function invalidateCommandCodeModelsCache(): void {
	generation += 1;
	publicationGeneration++;
	cache = undefined;
	inflight = undefined;
}

export function getCachedCommandCodeModel(modelId: string): CommandCodeModelInfo | undefined {
	return cache?.models.find((model) => model.id === modelId);
}

/** Published directory only: no auth-file reads, TTL revalidation or background refresh. */
export function getCachedCommandCodeModels(
	apiKey?: string,
	baseUrl?: string,
): readonly CommandCodeModelInfo[] {
	if (!cache || cache.base !== commandCodeProviderBase(baseUrl)) return [];
	const token = apiKey?.trim();
	// A cleared settings key must not turn its old directory into a CLI publication.
	return (token ? cache.token === token : cache.source === "cli") ? cache.models : [];
}

/** Prime before startup recovery; later connection edits refresh through the same owner. */
export async function startCommandCodeModelCatalog(): Promise<() => void> {
	let connection: string | undefined;
	let stopped = false;
	let queued = false;
	const refresh = async () => {
		if (stopped) return;
		const config = settings.commandCode;
		const next = JSON.stringify([
			config?.apiKey?.trim() ?? "",
			commandCodeProviderBase(config?.baseUrl),
			!!config?.disabled,
		]);
		if (next === connection) return;
		if (connection === undefined) {
			// Preserve the owner's same-slot stale fallback if startup refresh fails.
			generation++;
			inflight = undefined;
		} else {
			// A changed connection must not inherit a late response or old directory.
			invalidateCommandCodeModelsCache();
		}
		connection = next;
		if (!config?.disabled) await listCommandCodeModels(config?.apiKey, config?.baseUrl);
	};
	const changed = () => {
		if (stopped || queued) return;
		queued = true;
		// saveSettings can update keys before publishing its new endpoint. Read the
		// committed projection once, not a key/endpoint pair from the middle of a save.
		queueMicrotask(() => {
			queued = false;
			void refresh().catch(() => {});
		});
	};
	const stopSettings = subscribeSettingsChanges(changed);
	const stopKeys = getProviderKeyStore().onChange(changed);
	await refresh().catch(() => {});
	return () => {
		stopped = true;
		stopSettings();
		stopKeys();
		invalidateCommandCodeModelsCache();
	};
}

/**
 * 设置响应用：有新鲜缓存就返回，否则启动一次去重的后台拉取并立刻返回已有结果（可能为空）。
 */
export function peekCommandCodeModels(apiKey?: string, baseUrl?: string): CommandCodeModelSnapshot {
	const auth = resolveCommandCodeToken(apiKey);
	if (!auth.credential) {
		if (cache?.source === "cli") invalidateCommandCodeModelsCache();
		return { models: [], pending: false };
	}
	const { token, source } = auth.credential;
	const base = commandCodeProviderBase(baseUrl);
	if (cache && sameSlot(cache, token, base) && fresh(cache)) {
		if (cache.source !== source) {
			cache.source = source;
			publicationGeneration++;
		}
		return { models: cache.models.map((model) => model.id), pending: false };
	}
	void loadCommandCodeModels(token, base, source);
	const stale = cache && sameSlot(cache, token, base) ? cache.models.map((model) => model.id) : [];
	return { models: stale, pending: true };
}

/** 等到这次拉取结束。刷新按钮走这里；失败时 `ok` 为 false，并留下短负缓存。 */
export async function listCommandCodeModels(
	apiKey?: string,
	baseUrl?: string,
): Promise<{ models: string[]; ok: boolean }> {
	const auth = resolveCommandCodeToken(apiKey);
	if (!auth.credential) {
		if (cache?.source === "cli") invalidateCommandCodeModelsCache();
		return { models: [], ok: false };
	}
	const { token, source } = auth.credential;
	const base = commandCodeProviderBase(baseUrl);
	if (cache && sameSlot(cache, token, base) && fresh(cache)) {
		if (cache.source !== source) {
			cache.source = source;
			publicationGeneration++;
		}
		return { models: cache.models.map((model) => model.id), ok: !cache.negative };
	}
	await loadCommandCodeModels(token, base, source);
	if (!cache || !sameSlot(cache, token, base)) return { models: [], ok: false };
	return { models: cache.models.map((model) => model.id), ok: !cache.negative };
}

function loadCommandCodeModels(
	token: string,
	base: string,
	source: CommandCodeCredential["source"],
): Promise<void> {
	const key = cacheKey(token, base, source);
	if (inflight?.key === key) return inflight.task;
	const gen = generation;
	const task = fetchCommandCodeModels(token, base, gen, source).finally(() => {
		if (inflight?.task === task) inflight = undefined;
	});
	inflight = { key, task };
	return task;
}

async function fetchCommandCodeModels(
	token: string,
	base: string,
	gen: number,
	source: CommandCodeCredential["source"],
): Promise<void> {
	const previous = cache && sameSlot(cache, token, base) ? cache.models : [];
	try {
		const response = await fetch(`${base}/models`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (gen !== generation) return;
		if (!response.ok) {
			rememberFailure(token, base, previous, source);
			return;
		}
		const models = parseCommandCodeModels(await readResponseJsonLimited(response, MAX_BODY_BYTES));
		if (gen !== generation) return;
		publicationGeneration++;
		cache = { models, fetchedAt: Date.now(), token, base, source, negative: false };
	} catch {
		if (gen !== generation) return;
		rememberFailure(token, base, previous, source);
	}
}

function rememberFailure(
	token: string,
	base: string,
	previous: CommandCodeModelInfo[],
	source: CommandCodeCredential["source"],
): void {
	publicationGeneration++;
	cache = {
		models: previous,
		fetchedAt: Date.now(),
		token,
		base,
		source,
		negative: true,
	};
}
