import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { ValidationError } from "../lib/errors";
import {
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
	type SubagentModelSelection,
} from "../lib/narrator-custom-traits";
import { FOLLOW_DEFAULT_MODEL, resolveEffectiveModel, settings } from "../lib/settings";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";

interface SubagentModelRef {
	model?: string | null;
	parentNarratorId?: string | null;
	subagentType?: string | null;
}

export interface SubagentRunModel {
	/** Parent reference has been unwrapped and checked against the allowed pool. */
	modelRef: string;
	/** Resolve routing once for this run, including provider/history construction. */
	model: string;
	reasoningEffort?: ReasoningEffort;
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
 * __parent__ is narrator-scoped, not a global model alias. Never send it to a
 * provider. Legacy null rows still follow the global default, not their parent.
 * Only the new sentinel opts into live parent inheritance.
 */
export async function resolveSubagentModelForRun(
	narrator: SubagentModelRef,
	actingUserId?: string | null,
	stickyProvider?: string,
): Promise<SubagentRunModel> {
	if (narrator.model !== FOLLOW_PARENT_MODEL) {
		const modelRef = narrator.model || FOLLOW_DEFAULT_MODEL;
		return { modelRef, model: resolveEffectiveModel(modelRef, stickyProvider) };
	}
	if (!narrator.parentNarratorId) {
		throw new ValidationError("Follow-parent model requires a parent narrator");
	}
	const parent = await db.query.narrators.findFirst({
		where: eq(narrators.id, narrator.parentNarratorId),
		columns: { model: true, traits: true, chapterId: true, contextProjectId: true },
	});
	if (!parent || parent.model === FOLLOW_PARENT_MODEL) {
		throw new ValidationError("Cannot resolve the subagent's parent model");
	}
	const parentTraits = await resolveEffectiveTraits({
		narratorTraits: parent.traits,
		projectId: await resolveNarratorProjectId(parent),
		actingUserId: actingUserId ?? null,
	});
	const policy = resolveEffectiveSubagentModelPolicy(
		parentTraits.traits,
		narrator.subagentType ?? "general",
	);
	// A type preference selected at creation is a pin. Following rows keep following
	// their parent; they do not silently acquire a newly configured type preference.
	const selection = resolveSubagentModelSelectionFromPolicy({
		policy,
		candidates: [parent.model ?? FOLLOW_DEFAULT_MODEL, settings.agent.defaultModel],
	});
	if (!selection) {
		throw new ValidationError(`No models are allowed for "${policy.poolKey}" subagents`);
	}
	return {
		modelRef: selection.model,
		model: resolveEffectiveModel(selection.model, stickyProvider),
		...(selection.poolEntry?.reasoningEffort && {
			reasoningEffort: selection.poolEntry.reasoningEffort,
		}),
	};
}
