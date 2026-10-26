import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { ValidationError } from "../lib/errors";
import {
	type EffectiveSubagentModelPolicy,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
} from "../lib/narrator-custom-traits";
import { modelPoolKeyOf, policySourceIdOf } from "../lib/runtime-source";
import { expandAllowedPoolForDisplay, getSubagentVisibleModels } from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { updateNarratorProfileForPlugin } from "./narrator-session";
import { activeNarrators } from "./narrator-session-state";
import { resolveSubagentModelForRun } from "./subagent-model";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";

type Narrator = Awaited<ReturnType<typeof narratorService.getById>>;

/** Model-facing spellings of "follow my parent's model again". */
const FOLLOW_PARENT_ALIASES = new Set(["parent", "inherit", FOLLOW_PARENT_MODEL]);
const MAX_LISTED_MODELS = 40;

export interface SubagentModelSwitchPlan {
	/** Stored model reference (a concrete model id or `__parent__`). */
	model: string;
	/** Fixed tier of the selected pool entry; it outranks the child's own override. */
	reasoningEffort?: ReasoningEffort;
}

function listForError(models: string[]): string {
	if (models.length === 0) return "(none)";
	const shown = models.slice(0, MAX_LISTED_MODELS).join(", ");
	return models.length > MAX_LISTED_MODELS
		? `${shown}, … (${models.length - MAX_LISTED_MODELS} more)`
		: shown;
}

async function sourcePolicy(
	target: Narrator,
	actingUserId: string | null,
): Promise<EffectiveSubagentModelPolicy> {
	const none: EffectiveSubagentModelPolicy = {
		source: "none",
		poolKey: "general",
		models: [],
		isExplicitEmpty: false,
	};
	const poolKey = modelPoolKeyOf(target);
	const sourceId = policySourceIdOf(target);
	if (!poolKey || !sourceId) return none;
	const source = await narratorService.getById(sourceId);
	const traits = await resolveEffectiveTraits({
		narratorTraits: source.traits,
		projectId: await resolveNarratorProjectId(source),
		actingUserId,
		policySourceId: policySourceIdOf(source),
	});
	return resolveEffectiveSubagentModelPolicy(traits.traits, poolKey);
}

/**
 * Validate a delegator's model switch for a delegated session without writing anything.
 *
 * The same pool that bounded the Agent call bounds the switch: the pool registered on
 * the child at creation, resolved against its policy source's traits for the acting
 * user. Without a pool the model must be one this instance offers to subagents.
 */
export async function planSubagentModelSwitch(
	target: Narrator,
	requested: string,
	actingUserId: string | null,
): Promise<SubagentModelSwitchPlan> {
	const model = requested.trim();
	if (!model) throw new ValidationError("model must not be empty");
	if (FOLLOW_PARENT_ALIASES.has(model)) {
		if (!policySourceIdOf(target))
			throw new ValidationError("This agent has no registered source whose model it could follow");
		await resolveSubagentModelForRun({ ...target, model: FOLLOW_PARENT_MODEL }, actingUserId);
		return { model: FOLLOW_PARENT_MODEL };
	}
	const policy = await sourcePolicy(target, actingUserId);
	if (policy.source === "none") {
		const visible = getSubagentVisibleModels();
		if (!visible.includes(model))
			throw new ValidationError(
				`Model "${model}" is not available to subagents. Available models: ${listForError(visible)}`,
			);
		return { model };
	}
	const selection = resolveSubagentModelSelectionFromPolicy({
		policy,
		explicitModel: model,
		candidates: [],
	});
	if (!selection) {
		const allowed = expandAllowedPoolForDisplay(policy.models.map((entry) => entry.model));
		throw new ValidationError(
			policy.isExplicitEmpty
				? `No models are allowed for "${policy.poolKey}" subagents.`
				: `Model "${model}" is not in the allowed "${policy.poolKey}" subagent model pool. ` +
						`Allowed models: ${listForError(allowed)}`,
		);
	}
	return {
		model: selection.model,
		...(selection.poolEntry?.reasoningEffort && {
			reasoningEffort: selection.poolEntry.reasoningEffort,
		}),
	};
}

/** Persist a validated switch; a live session applies it at its next model request. */
export async function applySubagentModelSwitch(
	narratorId: string,
	plan: SubagentModelSwitchPlan,
): Promise<void> {
	await updateNarratorProfileForPlugin(narratorId, {
		model: plan.model,
		...(plan.reasoningEffort && { reasoningEffort: plan.reasoningEffort }),
	});
	// A live session announces the change itself; an idle page still shows the old pick.
	if (!activeNarrators.get(narratorId)?.alive)
		broadcastToNarrator(narratorId, { type: "model_changed", narratorId, model: plan.model });
}
