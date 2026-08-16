/**
 * Layered trait resolution over the three storage layers.
 *
 * `trait-layers.ts` owns the merge algebra; this module binds it to the actual
 * encoded traits (`custom-disabled-tools:`, `custom-blocked-skills:`,
 * `custom-subagent-models:`) and produces a *flattened* traits array.
 *
 * The flattened array is what makes the rollout safe: all 13 existing call sites
 * take `narrator.traits` and call `getDisabledToolSet(...)` / `getBlockedSkills(...)`
 * / `resolveEffectiveSubagentModelPolicy(...)`. Passing them `resolved.traits`
 * instead keeps their signatures untouched, and when the upper layers are empty
 * the output is byte-identical to the narrator's own traits — so single-layer
 * behaviour is provably unchanged.
 *
 * Enforcement metadata cannot survive flattening, so it is returned alongside in
 * `enforced`. Write paths use that to reject an edit up front rather than letting
 * resolution silently discard it.
 */
import {
	type DeviceInjectionTrait,
	mergeDeviceInjection,
	parseDeviceInjectionTrait,
	type ResolvedDeviceInjection,
} from "./device-injection-trait";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	type BlockedSkillsTrait,
	DISABLED_TOOLS_TRAIT_PREFIX,
	type DisabledToolsTrait,
	normalizeBlockedSkills,
	normalizeDisabledTools,
	normalizeSubagentModelRestriction,
	parseBlockedSkillsTrait,
	parseDisabledToolsTrait,
	parseSubagentModelRestrictionTrait,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	type SubagentModelRestrictionTrait,
	upsertEncodedTrait,
} from "./narrator-custom-traits";
import { parseTraits } from "./narrator-utils";
import {
	mergeGrantTrait,
	mergeRestrictionTrait,
	TRAIT_LAYERS,
	type TraitLayer,
	type TraitLayerInput,
	type TraitSetEntry,
} from "./trait-layers";

/** Marks a layer's entry as an enforced boundary rather than a default. */
export const ENFORCED_TRAIT_PREFIX = "custom-enforced:";

/** Trait keys that participate in layered resolution. */
export type LayeredTraitKey = "disabledTools" | "blockedSkills" | "subagentModels";

/** Which trait keys a layer declared as enforced. */
export type EnforcedTraitKeys = Partial<Record<LayeredTraitKey, boolean>>;

export interface TraitLayerSource {
	/** Raw traits array as stored for this layer. */
	traits: unknown;
}

export interface ResolvedTraitsResult {
	/**
	 * Flattened traits array, drop-in replacement for `narrator.traits` at every
	 * existing consumption point.
	 */
	traits: string[];
	/** Items no higher layer may remove, per trait key. */
	enforced: {
		disabledTools: Set<string>;
		blockedSkills: { all: boolean; names: Set<string> };
		subagentModels: Set<string>;
	};
	/** Resolved device injection policy (preference-kind, so nearest layer wins). */
	deviceInjection: ResolvedDeviceInjection;
	/** Layers that contributed an explicit declaration for any trait. */
	sources: TraitLayer[];
}

/**
 * Decode the enforced-keys marker for one layer.
 *
 * Stored as a separate bare-ish trait so the three payload shapes stay exactly as
 * they are today (no version bump, no migration of existing narrator rows).
 */
export function parseEnforcedKeys(traits: unknown): EnforcedTraitKeys {
	for (const trait of parseTraits(traits)) {
		if (!trait.startsWith(ENFORCED_TRAIT_PREFIX)) continue;
		try {
			const json = Buffer.from(trait.slice(ENFORCED_TRAIT_PREFIX.length), "base64url").toString(
				"utf-8",
			);
			const parsed = JSON.parse(json) as Record<string, unknown>;
			return {
				disabledTools: parsed.disabledTools === true,
				blockedSkills: parsed.blockedSkills === true,
				subagentModels: parsed.subagentModels === true,
			};
		} catch {
			return {};
		}
	}
	return {};
}

/** Encode enforced keys into a layer's traits array. */
export function withEnforcedKeys(traits: unknown, keys: EnforcedTraitKeys): string[] {
	const active = Object.entries(keys).filter(([, value]) => value === true);
	if (active.length === 0) {
		return parseTraits(traits).filter((trait) => !trait.startsWith(ENFORCED_TRAIT_PREFIX));
	}
	return upsertEncodedTrait(traits, ENFORCED_TRAIT_PREFIX, Object.fromEntries(active));
}

function setEntry(items: readonly string[], enforced: boolean): TraitSetEntry {
	return { items, enforced };
}

/**
 * Blocked skills carry a boolean `all` alongside the name list. `all` is a
 * monotonic escalation (a stricter state), so it merges with OR under restriction
 * semantics; the names merge as an ordinary restriction set.
 */
function mergeBlockedSkills(
	layers: TraitLayerInput<{ trait: BlockedSkillsTrait; enforced: boolean }>,
): { all: boolean; names: Set<string>; enforcedAll: boolean; enforcedNames: Set<string> } {
	const nameLayers: TraitLayerInput<TraitSetEntry> = {};
	let all = false;
	let enforcedAll = false;

	for (const layer of TRAIT_LAYERS) {
		const entry = layers[layer];
		if (!entry) continue;
		nameLayers[layer] = setEntry(entry.trait.names, entry.enforced);
		if (entry.trait.all) {
			if (entry.enforced) enforcedAll = true;
			all = true;
		} else if (!entry.enforced) {
			// A non-enforced layer stating all:false may relax a lower default, but
			// never an enforced escalation.
			all = enforcedAll;
		}
	}
	if (enforcedAll) all = true;

	const names = mergeRestrictionTrait(nameLayers);
	return { all, names: names.items, enforcedAll, enforcedNames: names.enforced };
}

/**
 * Merge subagent model pools.
 *
 * Pools are allowlists, so each pool key merges under grant semantics: a higher
 * layer may narrow a pool but never widen it beyond what a lower layer allowed.
 * A pool key absent from a layer is inherited rather than emptied — an explicit
 * empty array is how a layer says "no models here", which `isExplicitEmpty`
 * already distinguishes downstream.
 */
function mergeSubagentModels(
	layers: TraitLayerInput<{ trait: SubagentModelRestrictionTrait; enforced: boolean }>,
): { trait: SubagentModelRestrictionTrait | null; enforcedPools: Set<string> } {
	const poolKeys = new Set<string>();
	let anyDeclared = false;
	for (const layer of TRAIT_LAYERS) {
		const entry = layers[layer];
		if (!entry) continue;
		anyDeclared = true;
		for (const key of Object.keys(entry.trait.pools)) poolKeys.add(key);
	}
	if (!anyDeclared) return { trait: null, enforcedPools: new Set() };

	const pools: SubagentModelRestrictionTrait["pools"] = {};
	const enforcedPools = new Set<string>();

	for (const key of poolKeys) {
		// Preserve each model's `purpose` while merging on model id only.
		const byModel = new Map<string, { model: string; purpose?: string }>();
		const perLayer: TraitLayerInput<TraitSetEntry> = {};
		for (const layer of TRAIT_LAYERS) {
			const entry = layers[layer];
			if (!entry) continue;
			const uses = entry.trait.pools[key];
			if (uses === undefined) continue;
			for (const use of uses) {
				// Keep the richest description of a model: a higher layer usually
				// re-lists it as a bare id just to narrow the pool, which must not
				// erase a `purpose` a lower layer supplied.
				const existing = byModel.get(use.model);
				if (existing?.purpose && !use.purpose) continue;
				byModel.set(use.model, use);
			}
			perLayer[layer] = setEntry(
				uses.map((use) => use.model),
				entry.enforced,
			);
		}
		const merged = mergeGrantTrait(perLayer);
		pools[key] = [...merged.items].map((model) => byModel.get(model) ?? { model });
		if (merged.enforced.size > 0) enforcedPools.add(key);
	}

	return { trait: { version: 1, pools }, enforcedPools };
}

/**
 * Resolve the three layers into a flattened traits array plus enforcement info.
 *
 * `narrator` is required; the upper layers are optional so callers that have no
 * project or acting user resolve to exactly today's behaviour.
 */
export function resolveLayeredTraits(input: {
	user?: TraitLayerSource | null;
	project?: TraitLayerSource | null;
	narrator: TraitLayerSource;
}): ResolvedTraitsResult {
	const layerSources: TraitLayerInput<TraitLayerSource> = {
		user: input.user ?? undefined,
		project: input.project ?? undefined,
		narrator: input.narrator,
	};

	const hasUpperLayer =
		parseTraits(input.user?.traits).length > 0 || parseTraits(input.project?.traits).length > 0;

	// Fast path: with no upper layers there is nothing to merge, so return the
	// narrator's traits untouched. This makes single-layer behaviour byte-identical
	// rather than merely equivalent.
	if (!hasUpperLayer) {
		return {
			traits: parseTraits(input.narrator.traits),
			enforced: {
				disabledTools: new Set(),
				blockedSkills: { all: false, names: new Set() },
				subagentModels: new Set(),
			},
			deviceInjection: mergeDeviceInjection({
				narrator: parseDeviceInjectionTrait(input.narrator.traits),
			}),
			sources: ["narrator"],
		};
	}

	const disabledLayers: TraitLayerInput<TraitSetEntry> = {};
	const blockedLayers: TraitLayerInput<{ trait: BlockedSkillsTrait; enforced: boolean }> = {};
	const modelLayers: TraitLayerInput<{
		trait: SubagentModelRestrictionTrait;
		enforced: boolean;
	}> = {};
	const injectionLayers: TraitLayerInput<DeviceInjectionTrait> = {};
	const sources: TraitLayer[] = [];

	for (const layer of TRAIT_LAYERS) {
		const source = layerSources[layer];
		if (!source) continue;
		const raw = source.traits;
		const enforcedKeys = parseEnforcedKeys(raw);
		let declared = false;

		const disabled: DisabledToolsTrait | null = parseDisabledToolsTrait(raw);
		if (disabled) {
			disabledLayers[layer] = setEntry(disabled.tools, enforcedKeys.disabledTools === true);
			declared = true;
		}
		const blocked = parseBlockedSkillsTrait(raw);
		if (blocked) {
			blockedLayers[layer] = {
				trait: blocked,
				enforced: enforcedKeys.blockedSkills === true,
			};
			declared = true;
		}
		const models = parseSubagentModelRestrictionTrait(raw);
		if (models) {
			modelLayers[layer] = { trait: models, enforced: enforcedKeys.subagentModels === true };
			declared = true;
		}
		const injection = parseDeviceInjectionTrait(raw);
		if (injection) {
			injectionLayers[layer] = injection;
			declared = true;
		}
		if (declared) sources.push(layer);
	}

	const disabled = mergeRestrictionTrait(disabledLayers);
	const blocked = mergeBlockedSkills(blockedLayers);
	const models = mergeSubagentModels(modelLayers);

	// Rebuild a flat traits array: keep the narrator's non-layered entries (bare
	// tags like "plan", drafts, "named") and replace the three layered payloads
	// with their merged values.
	let traits = parseTraits(input.narrator.traits).filter(
		(trait) =>
			!trait.startsWith(DISABLED_TOOLS_TRAIT_PREFIX) &&
			!trait.startsWith(BLOCKED_SKILLS_TRAIT_PREFIX) &&
			!trait.startsWith(SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX) &&
			!trait.startsWith(ENFORCED_TRAIT_PREFIX),
	);

	if (disabled.items.size > 0) {
		traits = upsertEncodedTrait(
			traits,
			DISABLED_TOOLS_TRAIT_PREFIX,
			normalizeDisabledTools({ tools: [...disabled.items] }),
		);
	}
	if (blocked.all || blocked.names.size > 0) {
		traits = upsertEncodedTrait(
			traits,
			BLOCKED_SKILLS_TRAIT_PREFIX,
			normalizeBlockedSkills({ all: blocked.all, names: [...blocked.names] }),
		);
	}
	if (models.trait && Object.keys(models.trait.pools).length > 0) {
		traits = upsertEncodedTrait(
			traits,
			SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
			normalizeSubagentModelRestriction(models.trait),
		);
	}

	return {
		traits,
		enforced: {
			disabledTools: disabled.enforced,
			blockedSkills: { all: blocked.enforcedAll, names: blocked.enforcedNames },
			subagentModels: models.enforcedPools,
		},
		deviceInjection: mergeDeviceInjection(injectionLayers),
		sources,
	};
}
