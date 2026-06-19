import { type NugModelInfo, saveAllCachedNugModels, setNugCachedModels } from "./nug-model-cache";
import { type NUGProviderConfig, nugProviderPrefix, saveSettings, settings } from "./settings";

export interface NugModelCatalogApplyResult {
	models: NugModelInfo[];
	modelHash?: string;
	changedContextWindows: boolean;
}

function normalizeModelHash(value: unknown): string | undefined {
	const hash = typeof value === "string" ? value.trim() : "";
	return hash || undefined;
}

export function nugModelContextLength(model: Record<string, unknown>): number | undefined {
	for (const key of ["contextLength", "contextWindow", "context_length", "context_window"]) {
		const value = model[key];
		const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
		if (Number.isFinite(n) && n > 0) return Math.trunc(n);
	}
	return undefined;
}

export function mergeNugModelContextWindows(
	config: NUGProviderConfig,
	models: Array<Record<string, unknown>>,
): boolean {
	const prefix = nugProviderPrefix(config);
	const windows = settings.agent.modelContextWindows ?? {};
	settings.agent.modelContextWindows = windows;
	let changed = false;
	for (const model of models) {
		const id = String(model.id ?? "").trim();
		if (!id) continue;
		const contextLength = nugModelContextLength(model);
		if (contextLength == null) continue;
		const key = `${prefix}:${id}`;
		if (windows[key]) continue;
		windows[key] = contextLength;
		changed = true;
	}
	return changed;
}

export function applyNugModelCatalogUpdate(
	config: NUGProviderConfig,
	models: Array<Record<string, unknown>>,
	modelHash?: string | null,
	options: {
		saveCache?: boolean;
		saveSettingsOnContextChange?: boolean;
		usdRate?: number | null;
	} = {},
): NugModelCatalogApplyResult {
	const normalizedHash = normalizeModelHash(modelHash);
	const normalized = setNugCachedModels(
		config.id,
		models,
		normalizedHash ?? null,
		options.usdRate ?? null,
	);
	if (options.saveCache !== false) {
		saveAllCachedNugModels();
	}
	const changedContextWindows = mergeNugModelContextWindows(config, normalized);
	if (changedContextWindows && options.saveSettingsOnContextChange !== false) {
		saveSettings(settings);
	}
	return { models: normalized, modelHash: normalizedHash, changedContextWindows };
}
