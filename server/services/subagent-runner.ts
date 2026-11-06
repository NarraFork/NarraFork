/**
 * Delegation: create a narrator from a template, register how it relates to its
 * caller, and start it through the single run service. Nothing here executes,
 * controls or finalizes a run — `agent-runtime/run.ts` does that for every session.
 */
import type { SubagentModelInheritance } from "@shared/model-inheritance";
import {
	normalizeOptionalExecutionTimeout,
	resolveOptionalExecutionTimeout,
} from "../lib/agent/execution-timeout";
import type { ToolCallBinding, ToolUpdateExecutionLease } from "../lib/agent/types";
import { ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import {
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelSelectionFromPolicy,
} from "../lib/narrator-custom-traits";
import type { Locale } from "../lib/prompt-i18n";
import { policySourceIdOf } from "../lib/runtime-source";
import { expandAllowedPoolForDisplay, FOLLOW_DEFAULT_MODEL, settings } from "../lib/settings";
import { type RunBindingInput, runDeadlineAt } from "../lib/validators/runtime-registration";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { BUILTIN_DELEGATION_TEMPLATES, compileDelegationPolicy } from "./agent-runtime/policy";
import { controlRun, startNarratorRun } from "./agent-runtime/run";
import { backgroundTaskService } from "./background-task-service";
import { customSubagentService } from "./custom-subagent-service";
import { narratorService } from "./narrator-service";
import { withNarratorWorkAdmission } from "./narrator-session-state";
import { registerAndPersistSubagentAlias, registerTaskAlias } from "./subagent-alias";
import {
	formatSubagentModelFallbackNote,
	resolveSubagentModelForRun,
	subagentStoredModelReference,
} from "./subagent-model";
import { broadcastSubagentTakeoverChanged } from "./subagent-takeover-broadcast";
import { buildDelegationBasePrompt } from "./subagent-tools";
import { resolveEffectiveTraits, resolveNarratorProjectId } from "./trait-layer-service";
import { tryAcquireFinalUpdateExecution, type UpdateExecutionLease } from "./update-coordinator";

/** Default wall-clock execution time for background Agent tasks (5 hours). */
export const BACKGROUND_TASK_TIMEOUT_MS = 5 * 60 * 60 * 1000;

/** Initial tool-result text returned when a background Agent task starts. */
export function buildBackgroundAgentStartOutput(taskIdOrAlias: string): string {
	return (
		`<background_task_id>${taskIdOrAlias}</background_task_id>\n\n` +
		`Background task started. Await({ type: "agent", id: "${taskIdOrAlias}" })`
	);
}

export type SubagentUpdateExecutionLease = UpdateExecutionLease | ToolUpdateExecutionLease;

export function claimSubagentUpdateExecutionLease(
	existingLease: SubagentUpdateExecutionLease | undefined,
	kind: "ordinary" | "resumable",
	narratorId: string,
): UpdateExecutionLease | null {
	if (!existingLease) {
		return tryAcquireFinalUpdateExecution(kind, narratorId);
	}

	if ("transfer" in existingLease && !existingLease.transfer()) {
		throw new ValidationError("Agent could not transfer its update execution lease");
	}
	existingLease.setNarratorId(narratorId);
	if ("token" in existingLease) return existingLease;

	return {
		kind: existingLease.kind,
		token: `transferred:${narratorId}`,
		setNarratorId: (id) => existingLease.setNarratorId(id),
		release: () => existingLease.release(),
	};
}

/** Broadcast subagent_started event (display adapter for the caller's tool card). */
export function broadcastSubagentStarted(
	subagentId: string,
	parentNarratorId: string,
	toolUseId: string,
	subagentType: string,
	model?: string,
	reasoningEffort?: string | null,
	inheritance?: SubagentModelInheritance,
): void {
	eventBus.emit({
		type: "narrator:subagent_started",
		narratorId: subagentId,
		parentNarratorId,
		toolUseId,
		subagentType,
		...(model && { model }),
		...(reasoningEffort && { reasoningEffort }),
	});
	broadcastToNarrator(parentNarratorId, {
		type: "subagent_started",
		narratorId: parentNarratorId,
		subagentNarratorId: subagentId,
		toolUseId,
		subagentType,
		...(model && { model }),
		...(reasoningEffort && { reasoningEffort }),
		...(inheritance && { modelInheritance: inheritance }),
	});
	backgroundTaskService.notifyDerivedStatusChanged(parentNarratorId, subagentId);
}

/**
 * Cancel a running background task: the same run cancellation any controller uses.
 * Returns whether a running task was found.
 */
export async function cancelBackgroundTask(taskNarratorId: string): Promise<boolean> {
	return (
		(await backgroundTaskService.cancel(taskNarratorId).catch(() => false)) ||
		controlRun(taskNarratorId, { kind: "cancel", reason: "Cancelled by user" })
	);
}

export interface RunSubagentInput {
	/** Exact spawning Agent attempt, supplied by executeTool, never resolved by provider id. */
	toolCallBinding?: ToolCallBinding;
	parentNarratorId: string;
	toolUseId: string;
	subagentType: string;
	prompt: string;
	cwd: string;
	title?: string;
	signal: AbortSignal;
	locale: string;
	/** Optional wall-clock deadline; 0/undefined means no deadline. */
	timeoutMs?: number;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	background?: boolean;
	/** Launch non-blocking, with the result held for further user interaction. */
	takeoverByUser?: boolean;
	alias?: string;
	/**
	 * Execution principal of the calling run. Registered on the delegated run as its
	 * own principal; the delegated session never borrows the caller's at runtime.
	 */
	userId?: string | null;
	/** Existing tool/coordinator lease; tool leases are transferred into the run lifecycle. */
	updateExecutionLease?: SubagentUpdateExecutionLease;
	/**
	 * An outline task to hand to the subagent (`Agent({ task })`, outline P2 PR 9a), checked and
	 * written into `prompt` already (`prepareOutlineDelegation`). Its claim passes to the subagent
	 * once it exists, before it runs.
	 */
	delegation?: import("./outline/delegation").PreparedOutlineDelegation;
}

/**
 * Delegate: create the narrator, register the run's relations to the calling tool
 * attempt, and start it through the run service. Foreground waits for the result
 * (or a detach handoff); background returns the task id at once.
 */
export async function runSubagent(input: RunSubagentInput): Promise<string> {
	return withNarratorWorkAdmission(input.parentNarratorId, () => runSubagentUnlocked(input));
}

async function runSubagentUnlocked(input: RunSubagentInput): Promise<string> {
	const {
		parentNarratorId,
		toolUseId,
		subagentType,
		prompt,
		cwd,
		title,
		locale,
		model: explicitModel,
		reasoningEffort,
		alias,
		userId,
	} = input;
	const background = input.background === true || input.takeoverByUser === true;
	const timeoutMs = background
		? resolveOptionalExecutionTimeout(input.timeoutMs, BACKGROUND_TASK_TIMEOUT_MS)
		: input.timeoutMs === 0
			? 0
			: normalizeOptionalExecutionTimeout(input.timeoutMs);

	// The template compiles into ordinary data on the created narrator: a capability
	// ceiling trait and a base prompt. Neither is read from the template again.
	const customDef = BUILTIN_DELEGATION_TEMPLATES.has(subagentType)
		? null
		: await customSubagentService.loadByName(subagentType);
	const systemPrompt = await buildDelegationBasePrompt(
		subagentType,
		locale as Locale,
		customDef?.prompt ?? null,
	);

	// Resolve model: explicit param > configured pool > per-type/custom preference > parent/default.
	let subagentPref: string | undefined;
	if (
		subagentType === "explore" ||
		subagentType === "plan" ||
		subagentType === "search" ||
		subagentType === "review"
	) {
		subagentPref = settings.agent.subagentModels?.[subagentType] || undefined;
	} else if (customDef) {
		subagentPref = customDef.defaultModel || undefined;
	}
	const parent = await narratorService.getById(parentNarratorId);
	const templatePolicy = compileDelegationPolicy({
		template: subagentType,
		customDefinition: customDef,
		// An outline session's subagents get no outline tools by default (R16).
		outlineSession: parent.taskBackend === "outline",
	});
	// Model pools are a grant, so layering can only narrow them.
	const parentTraits = await resolveEffectiveTraits({
		narratorTraits: parent.traits,
		projectId: await resolveNarratorProjectId(parent),
		actingUserId: userId ?? null,
		policySourceId: policySourceIdOf(parent),
	});
	const modelPolicy = resolveEffectiveSubagentModelPolicy(parentTraits.traits, subagentType);
	const candidateModels =
		modelPolicy.source === "none" ? [subagentPref, parent.model || FOLLOW_DEFAULT_MODEL] : [];
	const modelSelection = resolveSubagentModelSelectionFromPolicy({
		policy: modelPolicy,
		explicitModel,
		candidates: candidateModels,
	});
	const resolvedModelInput = modelSelection?.model;
	const preferenceSelection =
		modelPolicy.source === "none" && !explicitModel && subagentPref
			? resolveSubagentModelSelectionFromPolicy({
					policy: modelPolicy,
					explicitModel: subagentPref,
					candidates: [],
				})
			: undefined;
	const storedModelInput = subagentStoredModelReference({
		explicitModel: modelPolicy.source !== "none" ? resolvedModelInput : explicitModel,
		preferenceSelection,
		selection: modelSelection,
	});
	const configuredReasoningEffort = modelSelection?.poolEntry?.reasoningEffort ?? reasoningEffort;
	if (modelPolicy.source !== "none" && !resolvedModelInput) {
		const allowedModels = expandAllowedPoolForDisplay(
			modelPolicy.models.map((entry) => entry.model),
		);
		throw new ValidationError(
			modelPolicy.isExplicitEmpty
				? `No models are allowed for "${modelPolicy.poolKey}" subagents by this narrator's custom trait.`
				: `No candidate model is in the allowed pool for "${modelPolicy.poolKey}" subagents. ` +
						`Allowed models: ${allowedModels.join(", ")}. Please specify one of these models explicitly.`,
		);
	}

	const updateLease = claimSubagentUpdateExecutionLease(
		input.updateExecutionLease,
		"resumable",
		parentNarratorId,
	);
	if (!updateLease) {
		throw new ValidationError(
			"Subagent execution deferred because a NarraFork update is scheduled.",
		);
	}
	/** The subagent holds its delegated task and has not run yet: a failure gives the task back. */
	let delegatedBeforeRun: string | null = null;
	try {
		if (input.toolCallBinding) {
			const { narratorPersistence } = await import("./narrator-persistence");
			await narratorPersistence.validateToolCallBinding(
				parentNarratorId,
				toolUseId,
				input.toolCallBinding,
			);
		}
		const subagent = await narratorService.createSubagent({
			parentNarratorId,
			originToolCallId: input.toolCallBinding?.toolCallId,
			subagentType,
			title,
			cwd,
			systemPrompt,
			model: storedModelInput,
			reasoningEffort: configuredReasoningEffort,
			runtimePolicy: templatePolicy,
		});
		const subagentId = subagent.id;
		updateLease.setNarratorId(subagentId);
		// Validates the pool now (a refused model fails the call before any run starts).
		const { inheritance } = await resolveSubagentModelForRun(subagent, userId);
		let aliasRegistration: { alias: string; conflicted: boolean };
		try {
			aliasRegistration = await registerAndPersistSubagentAlias(
				parentNarratorId,
				subagentId,
				alias || title,
			);
		} catch (err) {
			aliasRegistration = registerTaskAlias(parentNarratorId, subagentId, alias || title);
			logger.warn("Failed to persist subagent alias", {
				subagentId,
				alias: aliasRegistration.alias,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// An outline task: the subagent's registration records it and the task's claim passes to
		// it. Refused (the task changed hands since it was checked): the subagent never ran.
		let delegationNote = "";
		if (input.delegation) {
			try {
				if (!input.toolCallBinding) throw new ValidationError("Agent call binding missing");
				const [{ delegateOutlineTask, delegationStartedNote }, { delegationLocale }] =
					await Promise.all([import("./outline/delegation"), import("./outline/delegation-text")]);
				await delegateOutlineTask({
					delegation: input.delegation,
					subagentId,
					toolCallId: input.toolCallBinding.toolCallId,
					userId: userId ?? null,
					locale: delegationLocale(locale),
				});
				delegatedBeforeRun = subagentId;
				delegationNote = `\n\n${delegationStartedNote(input.delegation)}`;
			} catch (error) {
				const { interruptAndArchiveSubagent } = await import("./subagent-lifecycle");
				await interruptAndArchiveSubagent(subagentId).catch(() => {});
				throw error;
			}
		}

		// The run's relations to the exact calling attempt.
		const exact = input.toolCallBinding && {
			toolCallId: input.toolCallBinding.toolCallId,
			attempt: input.toolCallBinding.attempt,
		};
		const binding = {
			deliverTo: { narratorId: parentNarratorId, toolUseId, ...exact },
			...(exact && !background ? { cancelWith: { narratorId: parentNarratorId, ...exact } } : {}),
			principal: { userId: userId ?? null },
			deadlineAt: runDeadlineAt(timeoutMs),
		} satisfies RunBindingInput;

		// The caller's prompt is this session's first user turn, placed under the call.
		await narratorService.persistSubagentUserMessage(subagentId, prompt, toolUseId, {
			createdBy: userId,
			sender: {
				id: parentNarratorId,
				title: parent.title,
				label: parent.title || "parent",
				isParent: true,
			},
		});
		// The tool card is announced by the run itself, with the model each run uses.

		const conflictNote = aliasRegistration.conflicted
			? `\n\nNote: The requested alias "${alias || title || subagentId}" was already taken. ` +
				`This agent was assigned "${aliasRegistration.alias}" instead.` +
				(background ? "" : " Use this alias with Await or Send to reference this agent.")
			: "";

		if (background) {
			await backgroundTaskService.markNarratorRunning(subagentId);
			// The task projection registers this run (and its relations) in one start.
			const task = await backgroundTaskService.createAgentTask({
				id: subagentId,
				subagentNarratorId: subagentId,
				subagentType,
				alias: aliasRegistration.alias,
				title,
				binding,
			});
			eventBus.emit({
				type: "narrator:background_task_started",
				narratorId: parentNarratorId,
				parentNarratorId,
				taskNarratorId: subagentId,
				toolUseId,
				subagentType,
			});
			broadcastToNarrator(parentNarratorId, {
				type: "background_task_started",
				narratorId: parentNarratorId,
				taskNarratorId: subagentId,
				toolUseId,
				subagentType,
			});
			// A user takeover is a hold established before the run starts: even an
			// immediately completed first turn never delivers to the caller.
			if (input.takeoverByUser) {
				try {
					await controlRun(subagentId, { kind: "hold" });
				} catch (error) {
					// The task never mounted a run: settle it so nothing waits on it.
					await backgroundTaskService.cancel(subagentId).catch(() => false);
					throw error;
				}
				await broadcastSubagentTakeoverChanged({
					parentNarratorId,
					subagentNarratorId: subagentId,
					takenOver: true,
					toolUseId,
				});
			}
			// The task projection already registered the run; the run service adopts it.
			const handle = await startNarratorRun({
				narratorId: subagentId,
				locale: locale as Locale,
				text: "",
				resumeRunId: task.logicalRunId ?? undefined,
			});
			delegatedBeforeRun = null;
			void handle.terminal.finally(() => updateLease.release());
			return (
				(input.takeoverByUser
					? `<background_task_id>${aliasRegistration.alias}</background_task_id>\n\n` +
						"Background task started. User takeover is already active. The initial prompt runs independently; " +
						"turn completion will not notify or wake the parent. " +
						"The user can continue interacting until they explicitly end takeover. Do not automatically Await this agent."
					: buildBackgroundAgentStartOutput(aliasRegistration.alias)) +
				delegationNote +
				formatSubagentModelFallbackNote(inheritance) +
				conflictNote
			);
		}

		const { getSearchExecutionScope } = await import("../lib/search/execution-scope");
		const handle = await startNarratorRun({
			narratorId: subagentId,
			locale: locale as Locale,
			text: "",
			binding,
			cancelSignal: input.signal,
			foreground: true,
		});
		delegatedBeforeRun = null;
		void handle.terminal.finally(() => updateLease.release());
		if (getSearchExecutionScope()) {
			// A channel failure must reach the search router so the next channel can run.
			const terminal = await handle.terminal;
			if (terminal.hasError || terminal.interrupted || terminal.timedOut)
				throw new Error(terminal.finalText || "Search subagent failed");
			return terminal.output;
		}
		const result = await handle.foreground;
		return result.output + formatSubagentModelFallbackNote(inheritance) + conflictNote;
	} catch (error) {
		updateLease.release();
		if (delegatedBeforeRun) await giveBackDelegatedTask(delegatedBeforeRun);
		throw error;
	}
}

/**
 * A subagent that took its delegated task but never ran: the task goes back to the session (as a
 * run's end hands it back), then the subagent is archived, holding nothing.
 */
async function giveBackDelegatedTask(subagentId: string): Promise<void> {
	try {
		const { idleOutlineTaskClaims } = await import("./outline/tasks");
		await idleOutlineTaskClaims(subagentId);
	} catch (error) {
		logger.warn("Delegated task could not be given back", {
			subagentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const { interruptAndArchiveSubagent } = await import("./subagent-lifecycle");
	await interruptAndArchiveSubagent(subagentId).catch(() => {});
}
