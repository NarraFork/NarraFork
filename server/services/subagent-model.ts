import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { isSubagentReasoningEffort } from "@shared/subagent-model-policy";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { type ReadQueryOptions, readQueryFirst } from "../db/worker-read";
import { ValidationError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import {
	type EffectiveSubagentModelPolicy,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
	type SubagentModelSelection,
} from "../lib/narrator-custom-traits";
import {
	MAX_POLICY_SOURCE_DEPTH,
	modelPoolKeyOf,
	policySourceIdOf,
	RUNTIME_SOURCE_COLUMNS,
	type RuntimeSourceRow,
} from "../lib/runtime-source";
import {
	FOLLOW_DEFAULT_MODEL,
	FOLLOW_SUMMARY_MODEL,
	getAggregation,
	parseAggModelValue,
	parseModelId,
	resolveAggregation,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../lib/settings";
import { listConcreteModelsForReference } from "../lib/settings/provider";
import { activeNarrators, getNarratorRuntimeModel } from "./narrator-session-state";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";

/**
 * The model fields of a narrator plus its explicit source registration. Nothing here
 * reads a parent link or creation template: following is relative to the registered
 * policy source, within the pool chosen at creation (see `lib/runtime-source.ts`).
 */
export type SourceModelRef = RuntimeSourceRow & {
	id?: string;
	model?: string | null;
};

export interface SubagentRunModel {
	/** Parent reference has been unwrapped and checked against the allowed pool. */
	modelRef: string;
	/** Resolve routing once for this run, including provider/history construction. */
	model: string;
	/** Fixed tier from the selected pool entry; outranks the child's own override. */
	reasoningEffort?: ReasoningEffort;
	/**
	 * The parent's override, for `__parent__` rows only. Ranks BELOW the child's
	 * own override: precedence is pool tier > child > parent > global default.
	 */
	parentReasoningEffort?: ReasoningEffort;
	/** Present only for `__parent__` rows: whether the parent was followed or rejected. */
	inheritance?: SubagentModelInheritance;
}

/** Configured default model for a builtin pool key, if any. */
export function resolveSubagentTypePreference(
	poolKey: string | null | undefined,
): string | undefined {
	const type = poolKey ?? "general";
	if (type === "explore" || type === "plan" || type === "search" || type === "review") {
		return settings.agent.subagentModels?.[type] || undefined;
	}
	return undefined;
}

/**
 * Provider the parent narrator is (or would be) using, for preferring same-provider
 * pool entries. Reads in-memory session state and settings only: no DB query and
 * no aggregation round-robin advance. Order: live session provider → runtime
 * record matching the stored model → derivation from the stored model.
 * Returns undefined when it cannot be determined (e.g. balanced aggregation).
 */
export function resolveParentNarratorProvider(
	parentId: string | null | undefined,
	parentModel: string | null | undefined,
	/** What a following parent's stored `__parent__` currently resolves to. */
	resolvedParentModel?: string | null,
): string | undefined {
	const storedModel = parentModel?.trim() || FOLLOW_DEFAULT_MODEL;
	if (parentId) {
		const activeProvider = activeNarrators.get(parentId)?.provider;
		if (activeProvider) return activeProvider;
		const runtimeProvider = getNarratorRuntimeModel(parentId, storedModel)?.provider;
		if (runtimeProvider) return runtimeProvider;
	}
	return deriveProviderFromModelReference(resolvedParentModel?.trim() || storedModel, new Set());
}

/** True for the bare sentinel and for an accidental `provider:<sentinel>` value. */
function isSentinelReference(model: string, sentinel: string): boolean {
	if (model === sentinel) return true;
	const parsed = parseModelId(model);
	return !!parsed.provider && parsed.model === sentinel;
}

function deriveProviderFromModelReference(model: string, seen: Set<string>): string | undefined {
	const ref = model.trim();
	if (!ref || ref === FOLLOW_PARENT_MODEL || seen.has(ref)) return undefined;
	seen.add(ref);
	// Meta references must be recognized before parseModelId, which would read
	// `__agg__` (or a sentinel's prefix) as a provider.
	if (isSentinelReference(ref, FOLLOW_DEFAULT_MODEL)) {
		const configured = settings.agent.defaultModel?.trim();
		return configured ? deriveProviderFromModelReference(configured, seen) : undefined;
	}
	if (isSentinelReference(ref, FOLLOW_SUMMARY_MODEL)) {
		const configured = settings.agent.summaryModel?.trim() || FOLLOW_DEFAULT_MODEL;
		return deriveProviderFromModelReference(configured, seen);
	}
	const agg = parseAggModelValue(ref);
	if (agg) {
		if (agg.pinnedModel) return deriveProviderFromModelReference(agg.pinnedModel, seen);
		const config = getAggregation(agg.aggId);
		// Balanced routing has no stable member without a runtime record.
		if (!config || config.routingMode === "balanced") return undefined;
		// Priority mode returns the first enabled member and keeps no routing state.
		const first = resolveAggregation(agg.aggId);
		return first ? deriveProviderFromModelReference(first, seen) : undefined;
	}
	return resolveProvider(ref);
}

/** A concrete provider:model ID — not empty, not `__default__`, not `__parent__`. */
function hasConcreteModelId(model: string | null | undefined): boolean {
	return Boolean(model) && model !== FOLLOW_DEFAULT_MODEL && model !== FOLLOW_PARENT_MODEL;
}

export interface SubagentModelChoice {
	/** Value stored on the child row: a model reference, or `__parent__` to follow live. */
	storedModel: string;
	/** Absent when the child follows its parent; carries the pool entry metadata otherwise. */
	selection?: SubagentModelSelection;
}

/**
 * The one model choice for a delegated session, shared by creation and by the
 * re-selection at the start of a later run.
 *
 * - Explicit model: used as is (it must be in the pool when one exists).
 * - Pool: the parent's current model when the pool allows it → the first entry on
 *   the parent's provider → the first entry. The pool entry's metadata is kept.
 * - No pool: a per-type/custom preference pins the child; otherwise it follows
 *   the parent live (`__parent__`).
 *
 * Returns undefined only when a pool exists and nothing in it can be selected.
 */
export function selectSubagentModel(input: {
	policy: EffectiveSubagentModelPolicy;
	parentId?: string | null;
	parentModel?: string | null;
	typePreference?: string;
	explicitModel?: string;
}): SubagentModelChoice | undefined {
	const { policy, explicitModel } = input;
	if (policy.source !== "none") {
		let parentModel = input.parentModel || FOLLOW_DEFAULT_MODEL;
		if (parentModel === FOLLOW_PARENT_MODEL && input.parentId) {
			const activeModel = activeNarrators.get(input.parentId)?.model;
			const runtime = getNarratorRuntimeModel(input.parentId, parentModel);
			parentModel = activeModel || (runtime ? `${runtime.provider}:${runtime.model}` : parentModel);
		}
		const preferredProvider = resolveParentNarratorProvider(input.parentId, input.parentModel);
		const parentCandidate =
			listConcreteModelsForReference(parentModel).find(
				(model) => parseModelId(model).provider === preferredProvider,
			) ?? parentModel;
		const selection = resolveSubagentModelSelectionFromPolicy({
			policy,
			explicitModel,
			candidates: parentModel === FOLLOW_PARENT_MODEL ? [] : [parentCandidate],
			...(!explicitModel && {
				preferredProvider,
			}),
		});
		return selection ? { storedModel: selection.model, selection } : undefined;
	}
	const pinned = explicitModel || input.typePreference;
	return pinned
		? { storedModel: pinned, selection: { model: pinned } }
		: { storedModel: FOLLOW_PARENT_MODEL };
}

/**
 * Pool policy decision for a `__parent__` (follow-source) row, WITHOUT resolving routing.
 *
 * Kept separate from `resolveSubagentModelForRun` because `resolveEffectiveModel`
 * advances balanced aggregation round-robin; display paths must not do that.
 *
 * Order is source → first pool entry reaching the source's provider → first pool
 * entry. The global default is deliberately not a
 * middle step: once a pool exists, a fallback must be something the pool author
 * chose, not whatever the instance default happens to be. The pool is the one
 * registered at creation (`modelPool`); without one the source's model is used as is.
 */
export async function resolveSubagentModelInheritance(
	narrator: SourceModelRef,
	actingUserId?: string | null,
	depth = 0,
	options: Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs"> = {},
): Promise<{ selection: SubagentModelSelection; inheritance: SubagentModelInheritance }> {
	const sourceId = policySourceIdOf(narrator);
	if (!sourceId) {
		throw new ValidationError("Following a model requires a registered source narrator");
	}
	if (depth >= MAX_POLICY_SOURCE_DEPTH) {
		throw new ValidationError("Cannot resolve the source narrator's model: source chain too deep");
	}
	const source = await readQueryFirst(
		db.query.narrators.findMany({
			limit: 1,
			where: eq(narrators.id, sourceId),
			columns: {
				...RUNTIME_SOURCE_COLUMNS,
				id: true,
				model: true,
				reasoningEffort: true,
				traits: true,
				contextProjectId: true,
			},
		}),
		{ ...options, executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!source) {
		throw new ValidationError("Cannot resolve the source narrator's model");
	}
	// A source that itself follows its own source (a nested subagent's parent) is
	// followed through to the model it currently resolves to.
	const upstream =
		source.model === FOLLOW_PARENT_MODEL
			? await resolveSubagentModelInheritance(source, actingUserId, depth + 1, options)
			: null;
	const sourceStoredModel = upstream ? upstream.selection.model : source.model;
	// The source's own effective tier (pool tier > own override > its source's).
	const sourceReasoningEffort = upstream
		? (upstream.selection.poolEntry?.reasoningEffort ??
			source.reasoningEffort ??
			upstream.inheritance.parentReasoningEffort)
		: source.reasoningEffort;
	const poolKey = modelPoolKeyOf(narrator);
	const sourceTraits = poolKey
		? await resolveEffectiveTraits({
				narratorTraits: source.traits,
				projectId: await resolveNarratorProjectId(source),
				actingUserId: actingUserId ?? null,
				policySourceId: policySourceIdOf(source),
			})
		: null;
	const policy: EffectiveSubagentModelPolicy =
		poolKey && sourceTraits
			? resolveEffectiveSubagentModelPolicy(sourceTraits.traits, poolKey)
			: { source: "none", poolKey: "general", models: [], isExplicitEmpty: false };
	const sourceModel = sourceStoredModel || FOLLOW_DEFAULT_MODEL;
	// When the source has no concrete model ID, following it would only reach the
	// global default. A configured preference for the pool is the right source instead.
	const typePref = poolKey ? resolveSubagentTypePreference(poolKey) : undefined;
	if (!hasConcreteModelId(sourceStoredModel) && typePref) {
		const preferred = resolveSubagentModelSelectionFromPolicy({
			policy,
			explicitModel: typePref,
			candidates: [],
		});
		if (preferred) {
			return {
				selection: preferred,
				inheritance: {
					source: "preference",
					model: displayModelReference(preferred.model),
					parentModel: displayModelReference(sourceModel),
					...(policy.source !== "none" && { poolKey: policy.poolKey }),
					...(sourceReasoningEffort && { parentReasoningEffort: sourceReasoningEffort }),
				},
			};
		}
	}
	// A preference selected at creation is a pin. Following rows keep following their
	// source; they do not silently acquire a newly configured preference.
	const followed = resolveSubagentModelSelectionFromPolicy({
		policy,
		explicitModel: sourceModel,
		candidates: [],
	});
	const selection =
		followed ??
		resolveSubagentModelSelectionFromPolicy({
			policy,
			candidates: [],
			preferredProvider: resolveParentNarratorProvider(source.id, source.model, sourceStoredModel),
		});
	if (!selection) {
		throw new ValidationError(`No models are allowed for "${policy.poolKey}" subagents`);
	}
	return {
		selection,
		inheritance: {
			source: followed ? "parent" : "pool-fallback",
			// Display fields only; routing uses `selection` untouched. Without a pool the
			// selection is still `__default__`, which the label must not show raw.
			model: displayModelReference(selection.model),
			parentModel: displayModelReference(sourceModel),
			...(policy.source !== "none" && { poolKey: policy.poolKey }),
			...(sourceReasoningEffort && { parentReasoningEffort: sourceReasoningEffort }),
		},
	};
}

/** The configured default for `__default__`; unchanged when it is not configured. */
function displayModelReference(model: string): string {
	if (model !== FOLLOW_DEFAULT_MODEL) return model;
	const configured = settings.agent.defaultModel?.trim();
	return configured && configured !== FOLLOW_DEFAULT_MODEL ? configured : model;
}

// Last run-time decision per subagent, for cheap display on list paths (activity
// snapshots) that must not resolve traits once per card. Lost on restart, which
// only degrades the label back to the plain "follow parent" state.
const MAX_RECENT_INHERITANCES = 2000;
const recentInheritances = hotSafe<Map<string, SubagentModelInheritance>>(
	"narrafork.recentSubagentModelInheritances",
	() => new Map(),
);

function recordInheritance(narratorId: string, inheritance: SubagentModelInheritance): void {
	recentInheritances.delete(narratorId);
	recentInheritances.set(narratorId, inheritance);
	while (recentInheritances.size > MAX_RECENT_INHERITANCES) {
		const oldest = recentInheritances.keys().next().value;
		if (oldest === undefined) break;
		recentInheritances.delete(oldest);
	}
}

export function getRecentSubagentModelInheritance(
	narratorId: string,
): SubagentModelInheritance | undefined {
	return recentInheritances.get(narratorId);
}

/** Model-facing note for the parent when the pool overrode inheritance; empty otherwise. */
export function formatSubagentModelFallbackNote(inheritance?: SubagentModelInheritance): string {
	if (inheritance?.source !== "pool-fallback") return "";
	return (
		`\n\nNote: the parent model "${inheritance.parentModel}" is not in the allowed ` +
		`"${inheritance.poolKey ?? "general"}" subagent model pool, so this subagent ran on ` +
		`"${inheritance.model}" instead.`
	);
}

/**
 * `__parent__` is the stored "follow my source" value, not a global model alias. Never
 * send it to a provider. Legacy null rows still follow the global default. Only the
 * sentinel opts into live following of the registered source.
 */
export async function resolveSubagentModelForRun(
	narrator: SourceModelRef,
	actingUserId?: string | null,
	stickyProvider?: string,
	options: Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs"> = {},
): Promise<SubagentRunModel> {
	if (narrator.model !== FOLLOW_PARENT_MODEL) {
		const modelRef = narrator.model || FOLLOW_DEFAULT_MODEL;
		return { modelRef, model: resolveEffectiveModel(modelRef, stickyProvider) };
	}
	const { selection, inheritance } = await resolveSubagentModelInheritance(
		narrator,
		actingUserId,
		0,
		options,
	);
	if (narrator.id) recordInheritance(narrator.id, inheritance);
	return {
		modelRef: selection.model,
		model: resolveEffectiveModel(selection.model, stickyProvider),
		...(selection.poolEntry?.reasoningEffort && {
			reasoningEffort: selection.poolEntry.reasoningEffort,
		}),
		...(isSubagentReasoningEffort(inheritance.parentReasoningEffort) && {
			parentReasoningEffort: inheritance.parentReasoningEffort,
		}),
		inheritance,
	};
}

/**
 * Effective tier for a run: pool tier > own override > source > default.
 * `defaultEffort` is the provider/global default, computed by the caller.
 */
export function subagentRunReasoningEffort(
	run: Pick<SubagentRunModel, "reasoningEffort" | "parentReasoningEffort">,
	childOverride: ReasoningEffort | null | undefined,
	defaultEffort?: ReasoningEffort | null,
): ReasoningEffort | null | undefined {
	return run.reasoningEffort ?? childOverride ?? run.parentReasoningEffort ?? defaultEffort;
}
