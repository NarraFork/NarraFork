import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import type { ReasoningEffort } from "@shared/reasoning-effort";
import { ValidationError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import {
	type EffectiveSubagentModelPolicy,
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
} from "../lib/narrator-custom-traits";
import { modelPoolKeyOf, policySourceIdOf } from "../lib/runtime-source";
import {
	expandAllowedPoolForDisplay,
	FOLLOW_DEFAULT_MODEL,
	getSubagentVisibleModels,
	normalizeAutoModelValueForSave,
} from "../lib/settings";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { narratorService } from "./narrator-service";
import { updateNarratorProfileForPlugin } from "./narrator-session";
import { activeNarrators } from "./narrator-session-state";
import {
	resolveParentNarratorProvider,
	resolveSubagentModelForRun,
	resolveSubagentTypePreference,
	selectSubagentModel,
} from "./subagent-model";
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
	// `auto:<alias>` is written the catalog's way before the pool check compares it.
	const model = normalizeAutoModelValueForSave(requested.trim());
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

// Explicit per-request model switches (Send `model`) that the next new run must keep.
// In memory only: a restart drops them, and the next run then re-selects normally.
const EXPLICIT_PIN_TTL_MS = 10 * 60 * 1000;
const explicitModelPins = hotSafe<Map<string, { model: string; expiresAt: number }>>(
	"narrafork.subagentExplicitModelPins",
	() => new Map(),
);

/** Record that `model` was explicitly requested for the session's next run. */
export function markExplicitSubagentModelPin(narratorId: string, model: string): void {
	explicitModelPins.set(narratorId, { model, expiresAt: Date.now() + EXPLICIT_PIN_TTL_MS });
}

/** One-shot: true when a still-valid explicit pin for exactly `currentModel` existed. */
function consumeExplicitSubagentModelPin(narratorId: string, currentModel: string): boolean {
	const pin = explicitModelPins.get(narratorId);
	if (!pin) return false;
	explicitModelPins.delete(narratorId);
	return pin.expiresAt > Date.now() && pin.model === currentModel;
}

async function typePreferenceOf(
	subagentType: string | null | undefined,
): Promise<string | undefined> {
	const type = subagentType || "general";
	const { BUILTIN_DELEGATION_TEMPLATES } = await import("./agent-runtime/policy");
	if (BUILTIN_DELEGATION_TEMPLATES.has(type)) return resolveSubagentTypePreference(type);
	const { customSubagentService } = await import("./custom-subagent-service");
	const def = await customSubagentService.loadByName(type);
	return def?.defaultModel || undefined;
}

/**
 * Whether a run start is a NEW logical run that may re-select the model. Recovery
 * (`recovered`, or a token-scoped recovery `admission`), an adopted already
 * registered run (`resumeRunId`) and a caller that just chose the model keep it.
 * Later passes of the same run never reach a run start.
 */
export function isNewSubagentModelSelectionRun(req: {
	recovered?: boolean;
	resumeRunId?: string;
	admission?: unknown;
	skipModelReselect?: boolean;
}): boolean {
	return !req.recovered && !req.resumeRunId && !req.admission && !req.skipModelReselect;
}

/**
 * At the start of a NEW logical run of a delegated session: when the child's pinned
 * model is on a different provider than its source's current one, choose again with
 * the creation rule (`selectSubagentModel`) and persist through the ordinary switch.
 *
 * Kept as is: `__parent__` rows (they follow live), same provider, a provider that
 * cannot be determined on either side, a missing source, and a model explicitly
 * requested for this run. Returns whether the stored model changed. Never throws.
 */
export async function reselectSubagentModelForNewRun(
	narratorId: string,
	actingUserId: string | null,
): Promise<boolean> {
	try {
		const child = await narratorService.getById(narratorId);
		if (child.type !== "subagent") return false;
		const currentModel = child.model || FOLLOW_DEFAULT_MODEL;
		if (consumeExplicitSubagentModelPin(narratorId, currentModel)) return false;
		if (currentModel === FOLLOW_PARENT_MODEL) return false;
		const sourceId = policySourceIdOf(child);
		if (!sourceId) return false;
		const source = await narratorService.getById(sourceId).catch(() => null);
		if (!source) {
			logger.debug("Subagent model kept: source narrator unavailable", { narratorId, sourceId });
			return false;
		}
		const parentProvider = resolveParentNarratorProvider(source.id, source.model);
		const childProvider = resolveParentNarratorProvider(narratorId, currentModel);
		if (!parentProvider || !childProvider || parentProvider === childProvider) return false;

		const poolKey = modelPoolKeyOf(child) ?? child.subagentType ?? "general";
		const traits = await resolveEffectiveTraits({
			narratorTraits: source.traits,
			projectId: await resolveNarratorProjectId(source),
			actingUserId,
			policySourceId: policySourceIdOf(source),
		});
		const choice = selectSubagentModel({
			policy: resolveEffectiveSubagentModelPolicy(traits.traits, poolKey),
			parentId: source.id,
			parentModel: source.model,
			typePreference: await typePreferenceOf(child.subagentType),
		});
		if (!choice) {
			logger.warn("Subagent model kept: no pool entry can be selected", { narratorId, poolKey });
			return false;
		}
		if (choice.storedModel === currentModel) return false;
		await applySubagentModelSwitch(narratorId, {
			model: choice.storedModel,
			...(choice.selection?.poolEntry?.reasoningEffort && {
				reasoningEffort: choice.selection.poolEntry.reasoningEffort,
			}),
		});
		logger.info("Subagent model re-selected for a new run", {
			narratorId,
			from: currentModel,
			to: choice.storedModel,
			parentProvider,
			childProvider,
		});
		return true;
	} catch (error) {
		logger.warn("Subagent model re-selection skipped", { narratorId, error: String(error) });
		return false;
	}
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
