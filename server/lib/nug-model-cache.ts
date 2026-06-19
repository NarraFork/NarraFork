import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { NUGProviderConfig } from "./settings/types";

const cacheDir = resolve(homedir(), ".narrafork");
const cachePath = resolve(cacheDir, "nug-models-providers.json");


export interface NugModelInfo extends Record<string, unknown> {
	id: string;
	model?: string;
	name?: string;
	channel?: string;
	channelType?: NugChannelType;
	available?: boolean;
	contextLength?: number;
	contextWindow?: number;
	effortLevels?: string[];
}

export interface ResolvedNugModelMeta {
	providerId: string;
	providerPrefix: string;
	nugModelId: string;
	routedModel: string;
	channel: string;
	channelType: NugChannelType;
	bareModel: string;
	name?: string;
	available?: boolean;
	effortLevels?: string[];
}

export interface NugModelsGroup {
	providerId: string;
	providerName: string;
	models: NugModelInfo[];
	modelHash?: string;
	/** USD→billing-unit exchange rate from NUG (0/undefined = unset). */
	usdRate?: number;
}

export interface NugModelCacheEntry {
	models: NugModelInfo[];
	modelHash?: string;
	fetchedAt?: number;
	usdRate?: number;
}

const cachedModelsByProvider = new Map<string, NugModelInfo[]>();
const cachedModelHashByProvider = new Map<string, string>();
const cachedModelsFetchedAtByProvider = new Map<string, number>();
const cachedUsdRateByProvider = new Map<string, number>();


function numericModelField(raw: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = raw[key];
		const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
		if (Number.isFinite(n) && n > 0) return Math.trunc(n);
	}
	return undefined;
}

function toNugModelInfo(raw: Record<string, unknown>): NugModelInfo | null {
	const id = String(raw.id ?? "").trim();
	if (!id) return null;
	const info: NugModelInfo = { ...raw, id };
	if (raw.model != null) info.model = String(raw.model);
	if (raw.name != null) info.name = String(raw.name);
	if (raw.channel != null) info.channel = String(raw.channel);
	if (raw.channelType != null) info.channelType = String(raw.channelType);
	if (typeof raw.available === "boolean") info.available = raw.available;
	const contextLength = numericModelField(raw, [
		"contextLength",
		"contextWindow",
		"context_length",
		"context_window",
	]);
	if (contextLength != null) {
		info.contextLength = contextLength;
		info.contextWindow = contextLength;
	}
	const effortLevels = stringArrayField(raw, ["effortLevels", "effort_levels"]);
	if (effortLevels && effortLevels.length > 0) info.effortLevels = effortLevels;
	return info;
}

function stringArrayField(raw: Record<string, unknown>, keys: string[]): string[] | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (Array.isArray(value)) {
			const out = value
				.filter((v): v is string => typeof v === "string")
				.map((v) => v.trim())
				.filter((v) => v !== "");
			if (out.length > 0) return out;
		}
	}
	return undefined;
}

function normalizeModels(models: Array<Record<string, unknown>>): NugModelInfo[] {
	const seen = new Set<string>();
	const out: NugModelInfo[] = [];
	for (const raw of models) {
		const info = toNugModelInfo(raw);
		if (!info || seen.has(info.id)) continue;
		seen.add(info.id);
		out.push(info);
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeModelHash(value: unknown): string | undefined {
	const hash = typeof value === "string" ? value.trim() : "";
	return hash || undefined;
}

function loadProviderCacheEntry(providerId: string, value: unknown): void {
	if (Array.isArray(value)) {
		cachedModelsByProvider.set(
			providerId,
			normalizeModels(value as Array<Record<string, unknown>>),
		);
		return;
	}
	if (!isRecord(value)) return;
	const rawModels = Array.isArray(value.models) ? value.models : [];
	cachedModelsByProvider.set(
		providerId,
		normalizeModels(rawModels as Array<Record<string, unknown>>),
	);
	const modelHash = normalizeModelHash(value.modelHash ?? value.hash);
	if (modelHash) cachedModelHashByProvider.set(providerId, modelHash);
	const fetchedAt = typeof value.fetchedAt === "number" ? value.fetchedAt : undefined;
	if (fetchedAt != null) cachedModelsFetchedAtByProvider.set(providerId, fetchedAt);
	const usdRate = typeof value.usdRate === "number" ? value.usdRate : undefined;
	if (usdRate != null) cachedUsdRateByProvider.set(providerId, usdRate);
}

export function loadAllCachedNugModels(): void {
	try {
		if (!existsSync(cachePath)) return;
		const data = JSON.parse(readFileSync(cachePath, "utf-8")) as unknown;
		cachedModelsByProvider.clear();
		cachedModelHashByProvider.clear();
		cachedModelsFetchedAtByProvider.clear();
		cachedUsdRateByProvider.clear();
		const providers = isRecord(data) && isRecord(data.providers) ? data.providers : data;
		if (!isRecord(providers)) return;
		for (const [id, value] of Object.entries(providers)) {
			loadProviderCacheEntry(id, value);
		}
	} catch {
		// Corrupt cache is non-critical.
	}
}

export function saveAllCachedNugModels(): void {
	try {
		mkdirSync(cacheDir, { recursive: true });
		const providers: Record<string, NugModelCacheEntry> = {};
		for (const [id, models] of cachedModelsByProvider) {
			providers[id] = {
				models,
				modelHash: cachedModelHashByProvider.get(id),
				fetchedAt: cachedModelsFetchedAtByProvider.get(id),
				usdRate: cachedUsdRateByProvider.get(id),
			};
		}
		writeFileSync(cachePath, JSON.stringify({ version: 1, providers }));
	} catch {
		// Non-critical.
	}
}

export function setNugCachedModels(
	providerId: string,
	models: Array<Record<string, unknown>>,
	modelHash?: string | null,
	usdRate?: number | null,
): NugModelInfo[] {
	const normalized = normalizeModels(models);
	cachedModelsByProvider.set(providerId, normalized);
	const normalizedHash = normalizeModelHash(modelHash);
	if (normalizedHash) {
		cachedModelHashByProvider.set(providerId, normalizedHash);
		cachedModelsFetchedAtByProvider.set(providerId, Date.now());
	} else {
		cachedModelHashByProvider.delete(providerId);
		cachedModelsFetchedAtByProvider.delete(providerId);
	}
	if (typeof usdRate === "number" && Number.isFinite(usdRate)) {
		cachedUsdRateByProvider.set(providerId, usdRate);
	}
	return normalized;
}

export function deleteNugCachedModels(providerId: string): boolean {
	const deletedModels = cachedModelsByProvider.delete(providerId);
	const deletedHash = cachedModelHashByProvider.delete(providerId);
	const deletedFetchedAt = cachedModelsFetchedAtByProvider.delete(providerId);
	const deletedUsdRate = cachedUsdRateByProvider.delete(providerId);
	return deletedModels || deletedHash || deletedFetchedAt || deletedUsdRate;
}

export function getNugCachedModelsByProvider(providerId: string): NugModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
}

export function getNugCachedModelHash(providerId: string): string | undefined {
	return cachedModelHashByProvider.get(providerId);
}

export function getNugCachedModelsEntry(providerId: string): NugModelCacheEntry {
	return {
		models: getNugCachedModelsByProvider(providerId),
		modelHash: cachedModelHashByProvider.get(providerId),
		fetchedAt: cachedModelsFetchedAtByProvider.get(providerId),
	};
}

export function getNugCachedModels(): NugModelInfo[] {
	const seen = new Set<string>();
	const result: NugModelInfo[] = [];
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

export function getNugCachedModelsGrouped(providers: NUGProviderConfig[] = []): NugModelsGroup[] {
	return providers
		.filter((p) => !p.disabled && cachedModelsByProvider.has(p.id))
		.map((p) => ({
			providerId: p.id,
			providerName: p.name,
			models: cachedModelsByProvider.get(p.id) ?? [],
			modelHash: cachedModelHashByProvider.get(p.id),
			usdRate: cachedUsdRateByProvider.get(p.id),
		}));
}

function stripProviderPrefix(providerPrefix: string, modelValue: string): string {
	const trimmed = modelValue.trim();
	const prefix = `${providerPrefix}:`;
	return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function splitNugModelId(nugModelId: string): { channel: string; bareModel: string } | null {
	const idx = nugModelId.indexOf(":");
	if (idx <= 0 || idx >= nugModelId.length - 1) return null;
	return { channel: nugModelId.slice(0, idx), bareModel: nugModelId.slice(idx + 1) };
}

export function resolveNugModelMeta(
	providerId: string,
	providerPrefix: string,
	modelValue: string,
): ResolvedNugModelMeta {
	const nugModelId = stripProviderPrefix(providerPrefix, modelValue);
	const cached = getNugCachedModelsByProvider(providerId);
	const hit = cached.find((m) => m.id === nugModelId);
	const split = splitNugModelId(hit?.id ?? nugModelId);
	if (!split) {
		throw new Error(`NUG model metadata missing for ${modelValue}; refresh NUG models first`);
	}

	if (hit) {
		const channel = hit.channel || split.channel;
		const bareModel = hit.model || split.bareModel;
		return {
			providerId,
			providerPrefix,
			nugModelId: hit.id,
			routedModel: `${channel}:${bareModel}`,
			channel,
			channelType: hit.channelType || channel,
			bareModel,
			name: hit.name,
			available: hit.available,
			effortLevels: hit.effortLevels,
		};
	}

	if (!knownChannelTypes.has(split.channel)) {
		throw new Error(`NUG model metadata missing for ${modelValue}; refresh NUG models first`);
	}

	return {
		providerId,
		providerPrefix,
		nugModelId,
		routedModel: nugModelId,
		channel: split.channel,
		channelType: split.channel,
		bareModel: split.bareModel,
	};
}

loadAllCachedNugModels();
