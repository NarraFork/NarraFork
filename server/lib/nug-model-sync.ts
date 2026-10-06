import { type NugModelInfo, saveAllCachedNugModels, setNugCachedModels } from "./nug-model-cache";
import type { NUGProviderConfig } from "./settings/types";

export interface NugModelCatalogApplyResult {
	models: NugModelInfo[];
	modelHash?: string;
	changedContextWindows: boolean;
}
export function nugModelContextLength(model: Record<string, unknown>): number | undefined {
	for (const key of ["contextLength", "contextWindow", "context_length", "context_window"]) {
		const n = Number(model[key]);
		if (Number.isFinite(n) && n > 0) return Math.trunc(n);
	}
	return undefined;
}
/** Deprecated compatibility export. Discovery never writes user settings. */
export function mergeNugModelContextWindows(
	_config: NUGProviderConfig,
	_models: Array<Record<string, unknown>>,
): boolean {
	return false;
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
	const hash = typeof modelHash === "string" ? modelHash.trim() || undefined : undefined;
	const normalized = setNugCachedModels(config.id, models, hash ?? null, options.usdRate ?? null);
	if (options.saveCache !== false) saveAllCachedNugModels();
	return { models: normalized, modelHash: hash, changedContextWindows: false };
}
