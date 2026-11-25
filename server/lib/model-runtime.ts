import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import { MODEL_RUNTIME_MAX_BYTES, type RuntimeModelSummary } from "@shared/model-runtime";
import { getCustomApiCachedQuota } from "./custom-api-quota-cache";
import {
	isDeepSeekCustomApiProvider,
	peekDeepSeekBalanceGeneration,
} from "./deepseek-balance-cache";
import { ValidationError } from "./errors";
import { isKimiCustomApiProvider } from "./kimi-usage-cache";
import {
	catalogModelName,
	getEffectiveModelProfile,
	getModelOptionsCatalogSource,
	getModelOverridesRevision,
	withModelMetadataSnapshot,
} from "./model-catalog";
import { resolveNugModelMeta } from "./nug-model-cache";
import { isOpencodeCustomApiProvider, peekOpencodeUsageGeneration } from "./opencode-usage-cache";
import { providerBalanceCache } from "./provider-balance-cache";
import {
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	getSettingsRevision,
	parseAggModelValue,
	settings,
} from "./settings";
import { getTokenDanceRuntimeConfig } from "./tokendance-runtime";

export interface RuntimeObservation {
	requestedModel: string;
	provider: string;
	model: string;
	concreteValue?: string;
	resolvedAt: number;
	settingsRevision?: number;
}

/** Unwrap configuration references only. Never invoke the execution routing resolver. */
export function configuredConcreteModel(value: string, seen = new Set<string>()): string | null {
	if (!value || seen.has(value) || seen.size >= 8) return null;
	seen.add(value);
	if (value === FOLLOW_DEFAULT_MODEL)
		return configuredConcreteModel(settings.agent.defaultModel, seen);
	if (value === FOLLOW_SUMMARY_MODEL)
		return configuredConcreteModel(settings.agent.summaryModel, seen);
	if (value === FOLLOW_PARENT_MODEL || value.startsWith("auto:")) return null;
	const aggregation = parseAggModelValue(value);
	if (aggregation)
		return aggregation.pinnedModel ? configuredConcreteModel(aggregation.pinnedModel, seen) : null;
	const colon = value.indexOf(":");
	return colon > 0 && colon < value.length - 1 ? value : null;
}

export function runtimeProvider(prefix: string): RuntimeModelSummary["provider"] {
	const nug = settings.nugProviders?.find(
		(entry) => entry.prefix === prefix || entry.id === prefix,
	);
	if (nug)
		return {
			id: nug.id,
			prefix: nug.prefix,
			name: nug.name,
			quotaKind: "nug",
			generation: getSettingsRevision(),
		};
	const custom = settings.customApiProviders?.find(
		(entry) => entry.prefix === prefix || entry.id === prefix,
	);
	if (custom) {
		const quotaKind = isKimiCustomApiProvider(custom)
			? "kimi"
			: isOpencodeCustomApiProvider(custom)
				? "opencode"
				: isDeepSeekCustomApiProvider(custom)
					? "deepseek"
					: "provider";
		const generation =
			quotaKind === "opencode"
				? peekOpencodeUsageGeneration(custom.id)
				: quotaKind === "deepseek"
					? peekDeepSeekBalanceGeneration(custom.id)
					: providerBalanceCache.peekGeneration(custom.id);
		const pushed = getCustomApiCachedQuota(custom.id);
		return {
			id: custom.id,
			prefix: custom.prefix,
			name: custom.name,
			quotaKind,
			generation,
			...(pushed && {
				pushedQuota: {
					quotaBalance: pushed.quotaBalance,
					detailedQuotaBalance: pushed.detailedQuotaBalance,
				},
			}),
		};
	}
	for (const entries of [
		settings.openaiProviders,
		settings.anthropicProviders,
		settings.geminiProviders,
	]) {
		const entry = entries?.find((item) => item.prefix === prefix || item.id === prefix);
		if (entry) return { id: entry.id, prefix: entry.prefix, name: entry.name };
	}
	if (prefix === "tokendance") {
		const connection = getTokenDanceRuntimeConfig();
		return {
			id: prefix,
			prefix,
			name: "TokenDance",
			quotaKind: "tokendance",
			generation: connection?.disabled ? undefined : connection?.generation,
		};
	}
	return { id: prefix, prefix, name: prefix };
}

/** A single concrete profile, under the existing metadata snapshot, projected by whitelist. */
export function buildRuntimeModelSummary(input: {
	selection: string;
	inheritance?: SubagentModelInheritance;
	observation?: RuntimeObservation | null;
}): RuntimeModelSummary {
	return withModelMetadataSnapshot(() => {
		const { selection, inheritance } = input;
		if (selection.length > 1024)
			throw new ValidationError("Model selection exceeds summary budget");
		// The record describes the last real execution for this selection, not a promise
		// about future routing. Unrelated settings revisions must not erase that observation.
		const observation = input.observation?.requestedModel === selection ? input.observation : null;
		const observedValue = observation?.concreteValue;
		const concreteValue =
			observedValue && configuredConcreteModel(observedValue) === observedValue
				? observedValue
				: configuredConcreteModel(
						selection === FOLLOW_PARENT_MODEL ? (inheritance?.model ?? selection) : selection,
					);
		const colon = concreteValue?.indexOf(":") ?? -1;
		const provider = concreteValue && colon > 0 ? concreteValue.slice(0, colon) : null;
		const bareModel = concreteValue && colon > 0 ? concreteValue.slice(colon + 1) : null;
		const aggregation = parseAggModelValue(selection);
		const selectionLabel = aggregation
			? (settings.agent.modelAggregations?.find((entry) => entry.id === aggregation.aggId)?.name ??
				selection)
			: selection.startsWith("auto:")
				? (catalogModelName(selection.slice(5)) ?? selection.slice(5))
				: selection;
		const summary: RuntimeModelSummary = {
			selection: { value: selection, label: selectionLabel },
			state:
				observedValue && concreteValue === observedValue
					? "observed"
					: concreteValue
						? "configured"
						: "not-observed",
			concreteValue,
			settingsRevision: getSettingsRevision(),
			resolvedProvider: provider,
			resolvedBareModel: bareModel,
			revision: `${getSettingsRevision()}:${getModelOptionsCatalogSource().version}:${getModelOverridesRevision()}:${observation?.resolvedAt ?? 0}`,
			reasoning: {},
		};
		if (summary.state === "observed" && observation) summary.observedAt = observation.resolvedAt;
		if (provider) summary.provider = runtimeProvider(provider);
		if (concreteValue) {
			const profile = getEffectiveModelProfile(concreteValue);
			if (selection === concreteValue)
				summary.selection.label =
					catalogModelName(profile.card.modelId ?? bareModel ?? "") ?? bareModel ?? selection;
			summary.reasoning = profile.reasoning;
			if (Object.hasOwn(profile.reasoning, "levels"))
				summary.effortLevels = profile.reasoning.levels;
			summary.capabilities = {
				channelType:
					provider === "codex" ||
					settings.openaiProviders?.some(
						(entry) => !entry.disabled && entry.prefix === provider && entry.apiMode === "codex",
					)
						? "codex"
						: undefined,
				bareModel: bareModel ?? undefined,
				contextWindow: profile.contextWindow,
				maxOutputTokens: profile.maxOutputTokens,
				nativeSearch: profile.nativeSearch,
				inputModalities: profile.inputModalities,
				toolLoadingModes: profile.toolLoadingModes,
			};
			const nug = summary.provider?.quotaKind === "nug" ? summary.provider : undefined;
			if (nug) {
				try {
					const gateway = resolveNugModelMeta(nug.id, nug.prefix, concreteValue);
					summary.capabilities.channelType = gateway.channelType;
					summary.capabilities.bareModel = gateway.bareModel;
					// Local metadata overrides remain authoritative; retain gateway's absent/[]/tiers.
					if (gateway.effortLevels !== undefined && !Object.hasOwn(summary.reasoning, "levels"))
						summary.effortLevels = gateway.effortLevels;
				} catch {
					/* Unknown gateway channel: keep the concrete source without guessing capabilities. */
				}
			}
			summary.provenance = {
				reasoning: profile.card.provenance.reasoning_effort_levels?.layer,
				contextWindow: profile.contextWindowSource?.layer,
			};
		}
		let scalarBudget = MODEL_RUNTIME_MAX_BYTES;
		const serialized = JSON.stringify(summary, (key, value) => {
			scalarBudget -= key.length + 3 + (typeof value === "string" ? value.length : 0);
			if (scalarBudget < 0)
				throw new ValidationError(
					"Model summary exceeds scalar budget; use the model detail endpoint",
				);
			return value;
		});
		if (new TextEncoder().encode(serialized).byteLength > MODEL_RUNTIME_MAX_BYTES)
			throw new ValidationError("Model summary exceeds byte budget; use the model detail endpoint");
		return summary;
	});
}
