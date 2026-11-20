/**
 * Command Code 模型列表（带缓存）。
 *
 * Provider API 的 `GET /provider/v1/models` 是运行时数据（上游随时增删模型），所以不像 codex
 * 那样硬编码，而是拉取后缓存。设置读取只看缓存并在后台补拉，不把上游延迟算进这次响应。
 *
 * 同一平台可以有多条实例，每条的 API key 与 base 都可能不同，因此缓存按「凭据 + base」分槽：
 * 否则实例之间会互相覆盖，模型列表随打开顺序反复清空。
 */

import { resolveCommandCodeToken } from "./commandcode-manager";
import {
	type CommandCodeModelInfo,
	commandCodeProviderBase,
	parseCommandCodeModels,
} from "./commandcode-protocol";
import { readResponseJsonLimited } from "./commandcode-usage";

const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
/** 实例数量有上限，这里再兜一层，避免异常 key 把缓存撑大。 */
const MAX_CACHE_SLOTS = 32;

interface ModelCache {
	models: CommandCodeModelInfo[];
	fetchedAt: number;
	/** 上游失败。短时间内不再打，避免设置页每次读取都等满超时。 */
	negative: boolean;
}

interface ModelSlot {
	key: string;
	base: string;
	token: string;
}

const cache = new Map<string, ModelCache>();
/** 每个槽的版本号：刷新时只作废这一条实例正在飞的请求。 */
const epochs = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();

export interface CommandCodeModelSnapshot {
	models: string[];
	/** 缓存过期或还没有，后台正在拉。调用方可以过一会儿再读一次。 */
	pending: boolean;
}

/** 一次查询要用的槽；没有可用凭据时返回 undefined。 */
function slotOf(apiKey: string | undefined, baseUrl: string | undefined): ModelSlot | undefined {
	const auth = resolveCommandCodeToken(apiKey);
	if (!auth.credential) return undefined;
	const base = commandCodeProviderBase(baseUrl);
	const token = auth.credential.token;
	return { key: `${base}\n${token}`, base, token };
}

function fresh(entry: ModelCache): boolean {
	const ttl = entry.negative ? NEGATIVE_TTL_MS : CACHE_TTL_MS;
	return Date.now() - entry.fetchedAt < ttl;
}

function bumpEpoch(key: string): void {
	epochs.set(key, (epochs.get(key) ?? 0) + 1);
}

function modelIds(entry: ModelCache | undefined): string[] {
	return entry?.models.map((model) => model.id) ?? [];
}

/**
 * 丢弃缓存，让下一次拉取重新向上游请求（设置页的「刷新模型」）。
 * 给了 key/base 时只丢那一条实例的槽，其它实例的模型列表不受影响。
 */
export function invalidateCommandCodeModelsCache(apiKey?: string, baseUrl?: string): void {
	if (apiKey === undefined && baseUrl === undefined) {
		for (const key of new Set([...cache.keys(), ...inflight.keys()])) bumpEpoch(key);
		cache.clear();
		inflight.clear();
		return;
	}
	const slot = slotOf(apiKey, baseUrl);
	if (!slot) return;
	bumpEpoch(slot.key);
	cache.delete(slot.key);
	inflight.delete(slot.key);
}

/**
 * 目录里某个模型的端点信息。
 *
 * 给了实例的 key/base 就只查该实例的槽；没有实例上下文时（历史流量重算）取任一缓存到的目录。
 */
export function getCachedCommandCodeModel(
	modelId: string,
	apiKey?: string,
	baseUrl?: string,
): CommandCodeModelInfo | undefined {
	if (apiKey !== undefined || baseUrl !== undefined) {
		const slot = slotOf(apiKey, baseUrl);
		return slot ? cache.get(slot.key)?.models.find((model) => model.id === modelId) : undefined;
	}
	for (const entry of cache.values()) {
		const found = entry.models.find((model) => model.id === modelId);
		if (found) return found;
	}
	return undefined;
}

/**
 * 设置响应用：有新鲜缓存就返回，否则启动一次去重的后台拉取并立刻返回已有结果（可能为空）。
 */
export function peekCommandCodeModels(apiKey?: string, baseUrl?: string): CommandCodeModelSnapshot {
	const slot = slotOf(apiKey, baseUrl);
	if (!slot) return { models: [], pending: false };
	const entry = cache.get(slot.key);
	if (entry && fresh(entry)) return { models: modelIds(entry), pending: false };
	void loadCommandCodeModels(slot);
	return { models: modelIds(entry), pending: true };
}

/** 等到这次拉取结束。刷新按钮走这里；失败时 `ok` 为 false，并留下短负缓存。 */
export async function listCommandCodeModels(
	apiKey?: string,
	baseUrl?: string,
): Promise<{ models: string[]; ok: boolean }> {
	const slot = slotOf(apiKey, baseUrl);
	if (!slot) return { models: [], ok: false };
	const entry = cache.get(slot.key);
	if (entry && fresh(entry)) return { models: modelIds(entry), ok: !entry.negative };
	await loadCommandCodeModels(slot);
	const loaded = cache.get(slot.key);
	return { models: modelIds(loaded), ok: !!loaded && !loaded.negative };
}

function loadCommandCodeModels(slot: ModelSlot): Promise<void> {
	const existing = inflight.get(slot.key);
	if (existing) return existing;
	const task = fetchCommandCodeModels(slot).finally(() => {
		if (inflight.get(slot.key) === task) inflight.delete(slot.key);
	});
	inflight.set(slot.key, task);
	return task;
}

async function fetchCommandCodeModels(slot: ModelSlot): Promise<void> {
	const previous = cache.get(slot.key)?.models ?? [];
	const epoch = epochs.get(slot.key) ?? 0;
	const current = () => (epochs.get(slot.key) ?? 0) === epoch;
	try {
		const response = await fetch(`${slot.base}/models`, {
			headers: { Authorization: `Bearer ${slot.token}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!current()) return;
		if (!response.ok) {
			remember({ models: previous, fetchedAt: Date.now(), negative: true }, slot.key);
			return;
		}
		const models = parseCommandCodeModels(await readResponseJsonLimited(response, MAX_BODY_BYTES));
		if (!current()) return;
		remember({ models, fetchedAt: Date.now(), negative: false }, slot.key);
	} catch {
		if (!current()) return;
		remember({ models: previous, fetchedAt: Date.now(), negative: true }, slot.key);
	}
}

function remember(entry: ModelCache, key: string): void {
	cache.delete(key);
	cache.set(key, entry);
	while (cache.size > MAX_CACHE_SLOTS) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}
