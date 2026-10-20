import { readQuery } from "@server/db/worker-read";
import { FOLLOW_PARENT_MODEL, type SubagentModelInheritance } from "@shared/model-inheritance";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { isSubagentReasoningEffort } from "@shared/subagent-model-policy";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import {
	type EffectiveSubagentModelPolicy,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
	type SubagentModelSelection,
} from "../lib/narrator-custom-traits";
import {
	modelPoolKeyOf,
	policySourceIdOf,
	RUNTIME_SOURCE_COLUMNS,
	type RuntimeSourceRow,
} from "../lib/runtime-source";
import { FOLLOW_DEFAULT_MODEL, resolveEffectiveModel, settings } from "../lib/settings";
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

/** A concrete provider:model ID — not empty, not `__default__`, not `__parent__`. */
function hasConcreteModelId(model: string | null | undefined): boolean {
	return Boolean(model) && model !== FOLLOW_DEFAULT_MODEL && model !== FOLLOW_PARENT_MODEL;
}

/** Only explicit pins or a successfully selected type preference stop inheritance. */
export function subagentStoredModelReference(input: {
	explicitModel?: string;
	preferenceSelection?: SubagentModelSelection;
	selection?: SubagentModelSelection;
}): string {
	return input.explicitModel || input.preferenceSelection
		? (input.selection?.model ?? input.explicitModel ?? FOLLOW_DEFAULT_MODEL)
		: FOLLOW_PARENT_MODEL;
}

/**
 * Pool policy decision for a `__parent__` (follow-source) row, WITHOUT resolving routing.
 *
 * Kept separate from `resolveSubagentModelForRun` because `resolveEffectiveModel`
 * advances balanced aggregation round-robin; display paths must not do that.
 *
 * Order is source → first pool entry. The global default is deliberately not a
 * middle step: once a pool exists, a fallback must be something the pool author
 * chose, not whatever the instance default happens to be. The pool is the one
 * registered at creation (`modelPool`); without one the source's model is used as is.
 */
export async function resolveSubagentModelInheritance(
	narrator: SourceModelRef,
	actingUserId?: string | null,
): Promise<{ selection: SubagentModelSelection; inheritance: SubagentModelInheritance }> {
	const sourceId = policySourceIdOf(narrator);
	if (!sourceId) {
		throw new ValidationError("Following a model requires a registered source narrator");
	}
	const source = await readQuery(
		db.query.narrators.findFirst({
			where: eq(narrators.id, sourceId),
			columns: {
				...RUNTIME_SOURCE_COLUMNS,
				model: true,
				reasoningEffort: true,
				traits: true,
				chapterId: true,
				contextProjectId: true,
			},
		}),
	);
	if (!source || source.model === FOLLOW_PARENT_MODEL) {
		throw new ValidationError("Cannot resolve the source narrator's model");
	}
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
	const sourceModel = source.model || FOLLOW_DEFAULT_MODEL;
	// When the source has no concrete model ID, following it would only reach the
	// global default. A configured preference for the pool is the right source instead.
	const typePref = poolKey ? resolveSubagentTypePreference(poolKey) : undefined;
	if (!hasConcreteModelId(source.model) && typePref) {
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
					...(source.reasoningEffort && { parentReasoningEffort: source.reasoningEffort }),
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
	const selection = followed ?? resolveSubagentModelSelectionFromPolicy({ policy, candidates: [] });
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
			...(source.reasoningEffort && { parentReasoningEffort: source.reasoningEffort }),
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
): Promise<SubagentRunModel> {
	if (narrator.model !== FOLLOW_PARENT_MODEL) {
		const modelRef = narrator.model || FOLLOW_DEFAULT_MODEL;
		return { modelRef, model: resolveEffectiveModel(modelRef, stickyProvider) };
	}
	const { selection, inheritance } = await resolveSubagentModelInheritance(narrator, actingUserId);
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
