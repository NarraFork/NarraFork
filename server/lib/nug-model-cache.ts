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
}

export interface NugModelsGroup {
	providerId: string;
	providerName: string;
	models: NugModelInfo[];
}

const cachedModelsByProvider = new Map<string, NugModelInfo[]>();


function toNugModelInfo(raw: Record<string, unknown>): NugModelInfo | null {
	const id = String(raw.id ?? "").trim();
	if (!id) return null;
	const info: NugModelInfo = { ...raw, id };
	if (raw.model != null) info.model = String(raw.model);
	if (raw.name != null) info.name = String(raw.name);
	if (raw.channel != null) info.channel = String(raw.channel);
	if (raw.channelType != null) info.channelType = String(raw.channelType);
	if (typeof raw.available === "boolean") info.available = raw.available;
	return info;
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

export function loadAllCachedNugModels(): void {
	try {
		if (!existsSync(cachePath)) return;
		const data = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<
			string,
			Array<Record<string, unknown>>
		>;
		cachedModelsByProvider.clear();
		for (const [id, models] of Object.entries(data)) {
			cachedModelsByProvider.set(id, normalizeModels(models));
		}
	} catch {
		// Corrupt cache is non-critical.
	}
}

export function saveAllCachedNugModels(): void {
	try {
		mkdirSync(cacheDir, { recursive: true });
		const data: Record<string, NugModelInfo[]> = {};
		for (const [id, models] of cachedModelsByProvider) {
			data[id] = models;
		}
		writeFileSync(cachePath, JSON.stringify(data));
	} catch {
		// Non-critical.
	}
}

export function setNugCachedModels(
	providerId: string,
	models: Array<Record<string, unknown>>,
): NugModelInfo[] {
	const normalized = normalizeModels(models);
	cachedModelsByProvider.set(providerId, normalized);
	return normalized;
}

export function deleteNugCachedModels(providerId: string): boolean {
	return cachedModelsByProvider.delete(providerId);
}

export function getNugCachedModelsByProvider(providerId: string): NugModelInfo[] {
	return cachedModelsByProvider.get(providerId) ?? [];
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
