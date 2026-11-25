import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import { getCodexManager } from "../codex-manager";
import { canonicalCatalogModelId } from "../model-catalog";
import { FOLLOW_DEFAULT_MODEL, FOLLOW_SUMMARY_MODEL, parseAggModelValue } from "./provider";
import type { NarraForkSettings } from "./types";

/** true/false are proven cached configuration facts; null is unknown, never execution routing. */
export function runtimeModelReadiness(
	source: NarraForkSettings,
	value: string,
	seen = new Set<string>(),
): boolean | null {
	if (!value?.trim() || seen.has(value) || seen.size >= 8) return false;
	seen.add(value);
	if (value === FOLLOW_DEFAULT_MODEL)
		return runtimeModelReadiness(source, source.agent.defaultModel, seen);
	if (value === FOLLOW_SUMMARY_MODEL)
		return runtimeModelReadiness(source, source.agent.summaryModel, seen);
	if (value === FOLLOW_PARENT_MODEL) return null;
	if (value.startsWith("auto:")) return canonicalCatalogModelId(value.slice(5)) ? null : false;
	const aggregation = parseAggModelValue(value);
	if (aggregation) {
		// A pinned value is explicit even when its former aggregation was removed.
		if (aggregation.pinnedModel)
			return runtimeModelReadiness(source, aggregation.pinnedModel, seen);
		const configured = source.agent.modelAggregations?.find(
			(entry) => entry.id === aggregation.aggId,
		);
		if (!configured || configured.models.length === 0) return false;
		return null;
	}
	const colon = value.indexOf(":");
	// Bare model aliases need the execution resolver. Do not infer a provider on this read path.
	if (colon < 1) return null;
	const prefix = value.slice(0, colon);
	if (!value.slice(colon + 1)) return false;
	if (source.agent.disabledProviders?.includes(prefix)) return false;
	if (prefix === "codex") return getCodexManager().availableCount > 0;
	if (prefix === "tokendance") return !source.tokendance?.disabled && !!source.tokendance?.apiKey;
	if (prefix === "CommandCode" || prefix === "commandcode" || prefix === "command-code")
		return source.commandCode?.disabled ? false : source.commandCode?.apiKey ? true : null;
	for (const providers of [
		source.customApiProviders,
		source.nugProviders,
		source.openaiProviders,
		source.anthropicProviders,
		source.geminiProviders,
	]) {
		const provider = providers?.find((entry) => entry.prefix === prefix || entry.id === prefix);
		if (provider) return !provider.disabled && !!provider.apiKey;
	}
	// Plugins own their readiness; factory existence alone cannot prove its credentials valid.
	try {
		return pluginProviderRegistry.hasAdapterFactory(prefix) ? null : false;
	} catch {
		return false; // Prefix is not registered. No plugin factory or routing is invoked.
	}
}
