import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@shared/reasoning-effort";
import { isSubagentReasoningEffort, SUBAGENT_POOL_TYPES } from "@shared/subagent-model-policy";
import { z } from "zod/v4";
import { resolvePath } from "../../platform-path";
import { shouldUseNativeSearch } from "../../search/native";
import { expandAllowedPoolForDisplay, getSubagentVisibleModels, settings } from "../../settings";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const TAKEOVER_BY_USER_DESCRIPTION =
	"Set to true to create this subagent directly in user takeover mode for further human interaction. " +
	"The Agent call returns immediately without requiring run_in_background. The initial prompt still runs, " +
	"but completion does not notify or wake the parent; the subagent stays taken over until the user explicitly ends takeover. " +
	"Do not automatically Await this agent.";

const REASONING_EFFORT_DESCRIPTION =
	'Reasoning/thinking effort for this subagent. Use "none" to disable thinking where supported. ' +
	'Valid values: "none", "low", "medium", "high", "xhigh", "max" ("max" is only honored by some providers like DeepSeek; other providers clamp it down). ' +
	"If the selected model/provider does not support configurable thinking intensity, this option is ignored. " +
	"A fixed reasoning effort configured in the matching model pool overrides this parameter.";

// Use text import so the bundler inlines the file content at build time
import baseDescription from "./task.txt" with { type: "text" };

/** Build a dynamic model list string from all visible models. */
function getAvailableModelsList(): string {
	const models = getSubagentVisibleModels();
	if (models.length > 0) {
		return models.join(", ");
	}
	return "(no models configured yet)";
}

function filterSubagentModels(models: string[]): string[] {
	const visible = new Set(getSubagentVisibleModels());
	return models.filter((model) => visible.has(model));
}

const MODEL_PARAM_BASE =
	"Override the model for this subagent. Without an explicit model, a configured allowed model pool selects its first entry and pins the child independently. Without a pool, a selected per-type/custom model preference pins the child; otherwise it follows the parent narrator's current model, including later switches when resumed or before the next model request. Explicit models must also be allowed by the pool.";

function getModelParameterDescription(config?: AgentConfig): string {
	// Per-narrator custom restriction trait takes precedence and already describes the pools.
	if (config?.subagentModelRestrictionDescription) {
		return `${MODEL_PARAM_BASE}\n\n${config.subagentModelRestrictionDescription}`;
	}

	// Global per-type pool restriction (settings.agent.subagentAllowedModels).
	const pools = settings.agent.subagentAllowedModels;
	const restrictedParts: string[] = [];
	const unrestrictedTypes: string[] = [];
	if (pools) {
		for (const type of SUBAGENT_POOL_TYPES) {
			const pool = pools[type];
			if (pool && pool.length > 0) {
				const availablePool = filterSubagentModels(pool);
				const efforts = settings.agent.subagentModelReasoningEfforts?.[type];
				// Keep the old compact display untouched when this pool has no fixed tiers.
				const models = availablePool.some((model) => isSubagentReasoningEffort(efforts?.[model]))
					? availablePool.map((model) => {
							const display = expandAllowedPoolForDisplay([model]).join(", ");
							const effort = efforts?.[model];
							return isSubagentReasoningEffort(effort)
								? `${display} [fixed reasoning_effort=${effort}]`
								: display;
						})
					: expandAllowedPoolForDisplay(availablePool);
				restrictedParts.push(`${type}: ${models.join(", ")}`);
			} else {
				unrestrictedTypes.push(type);
			}
		}
	}

	// No restriction configured at all — list every visible model.
	if (restrictedParts.length === 0) {
		return `${MODEL_PARAM_BASE} Available models: ${getAvailableModelsList()}`;
	}

	// At least one type is restricted: describe the allowed pool per type instead of
	// dumping every visible model (which would be misleading).
	let note = `${MODEL_PARAM_BASE}\n\nNote: Subagent model selection is restricted per type. Allowed models — ${restrictedParts.join("; ")}. Models outside the pool for a given type will be ignored.`;
	if (unrestrictedTypes.length > 0) {
		note += ` For ${unrestrictedTypes.join(", ")} (not restricted), any available model may be used: ${getAvailableModelsList()}.`;
	}
	return note;
}

function buildParameters() {
	return z.object({
		description: z
			.string()
			.optional()
			.describe("A short (3-5 word) description of the task (required when launching a new agent)"),
		subagent_type: z
			.string()
			.optional()
			.describe(
				'The type of specialized agent to use for this task. Built-in types: "explore" (read-only codebase exploration), "plan" (architecture planning, only in plan mode), "general" (full write access). You can also use any custom subagent type name defined by the user.',
			),
		run_in_background: z
			.boolean()
			.optional()
			.describe(
				"Set to true to run this agent in the background. You will be notified when it completes.",
			),
		takeover_by_user: z.boolean().optional().describe(TAKEOVER_BY_USER_DESCRIPTION),
		timeout: looseNumber(
			"Optional execution timeout for this subagent in milliseconds. Background runs default to 5 hours when omitted; use 0 for no wall-clock limit or provide any positive safe integer. This controls the Agent run itself, not Await waiting.",
		),
		model: z.string().optional().describe(getModelParameterDescription()),
		reasoning_effort: z
			.enum(REASONING_EFFORT_VALUES)
			.optional()
			.describe(REASONING_EFFORT_DESCRIPTION),
		workdir: z
			.string()
			.optional()
			.describe(
				"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
			),
		prompt: z
			.string()
			.optional()
			.describe("The task for the agent to perform (required when launching a new agent)"),
		alias: z
			.string()
			.optional()
			.describe(
				'A short human-readable alias for this background task (e.g. "run-tests", "build-frontend"). ' +
					"Must be unique within the current session. If omitted, an alias is auto-generated from the description. " +
					"Use this alias with Await or Send to reference the task later.",
			),
		stop: z
			.string()
			.optional()
			.describe(
				"Stop a running background agent task by its ID or alias. When provided, no new agent is launched.",
			),
		archive: z
			.string()
			.optional()
			.describe(
				"Archive a subagent by its ID or alias. When provided, no new agent is launched. " +
					"Running work is stopped first. Archived subagents are excluded from TeamStatus " +
					"broadcast (@all members) and will not be woken by broadcasts; direct Send to them is also rejected.",
			),
		unarchive: z
			.string()
			.optional()
			.describe(
				"Restore an archived subagent by its ID or alias so it can receive messages and " +
					"broadcasts again. When provided, no new agent is launched.",
			),
	});
}

function usesNativeWebSearch(config: AgentConfig): boolean {
	return shouldUseNativeSearch(config.provider, config.model);
}

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	return {
		type: "object" as const,
		properties: {
			description: {
				description:
					"A short (3-5 word) description of the task (required when launching a new agent)",
				type: "string",
			},
			subagent_type: {
				description:
					'The type of specialized agent to use for this task. Built-in types: "explore", "plan", "search", "general". Custom types are also supported.',
				type: "string",
			},
			run_in_background: {
				description:
					"Set to true to run this agent in the background. You will be notified when it completes.",
				type: "boolean",
			},
			takeover_by_user: {
				description: TAKEOVER_BY_USER_DESCRIPTION,
				type: "boolean",
			},
			timeout: {
				description:
					"Optional execution timeout in milliseconds. Background runs default to 5 hours when omitted; use 0 for no wall-clock limit or provide any positive safe integer. This controls the Agent run, not Await waiting.",
				type: "number",
			},
			model: {
				description: getModelParameterDescription(config),
				type: "string",
			},
			reasoning_effort: {
				description: REASONING_EFFORT_DESCRIPTION,
				type: "string",
				enum: REASONING_EFFORT_VALUES,
			},
			workdir: {
				description:
					"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
				type: "string",
			},
			alias: {
				description:
					'A short human-readable alias for this background task (e.g. "run-tests", "build-frontend"). ' +
					"Must be unique within the current session. If omitted, an alias is auto-generated from the description. " +
					"Use this alias with Await or Send to reference the task later.",
				type: "string",
			},
			stop: {
				description:
					"Stop a running background agent task by its ID or alias. When provided, no new agent is launched.",
				type: "string",
			},
			archive: {
				description:
					"Archive a subagent by its ID or alias. When provided, no new agent is launched. " +
					"Running work is stopped first. Archived subagents are excluded from TeamStatus " +
					"broadcast (@all members) and will not be woken by broadcasts; direct Send to them is also rejected.",
				type: "string",
			},
			unarchive: {
				description:
					"Restore an archived subagent by its ID or alias so it can receive messages and " +
					"broadcasts again. When provided, no new agent is launched.",
				type: "string",
			},
			prompt: {
				description: "The task for the agent to perform (required when launching a new agent)",
				type: "string",
			},
		},
		required: [] as string[],
		additionalProperties: false,
	};
}

/**
 * Resolve an Agent archive/unarchive selector to a narrator id.
 *
 * Order mirrors stop mode, then falls through to the shared Send/Await selector
 * grammar so a title or slug printed by TeamStatus can be archived directly.
 */
async function resolveArchiveTargetId(callerNarratorId: string, selector: string): Promise<string> {
	const trimmed = selector.trim();
	const { resolveTaskAlias } = await import("@server/services/narrator-subagent");
	const fromAlias = resolveTaskAlias(callerNarratorId, trimmed);
	if (fromAlias !== trimmed) return fromAlias;

	const { backgroundTaskService } = await import("@server/services/background-task-service");
	const task = await backgroundTaskService.getByAlias(trimmed, callerNarratorId);
	if (task?.subagentNarratorId) return task.subagentNarratorId;
	if (task) return task.id;

	const { resolveSubagentTargets } = await import("@server/services/agent-communication");
	const targets = await resolveSubagentTargets({
		callerNarratorId,
		id: trimmed,
	}).catch(() => []);
	if (targets.length === 1) return targets[0].id;
	return trimmed;
}

export const agentTool: ToolDefinition = {
	name: "Agent",
	description(config: AgentConfig) {
		if (usesNativeWebSearch(config)) {
			return baseDescription.replaceAll("WebSearch", "web_search (native)");
		}
		return baseDescription;
	},
	get parameters() {
		return buildParameters();
	},
	get rawJsonSchema() {
		return buildRawJsonSchema();
	},
	getRawJsonSchema(config?: AgentConfig) {
		return buildRawJsonSchema(config);
	},
	async execute(args, ctx): Promise<ToolResult> {
		const raw = args as {
			prompt?: string;
			description?: string;
			subagent_type?: string;
			run_in_background?: boolean;
			takeover_by_user?: boolean;
			timeout?: number;
			model?: string;
			reasoning_effort?: ReasoningEffort;
			workdir?: string;
			alias?: string;
			stop?: string;
			archive?: string;
			unarchive?: string;
			// Legacy parameter name (pre-rename compat)
			background?: boolean;
		};

		// Lifecycle commands are mutually exclusive with each other and with launch.
		const lifecycleModes = [raw.stop, raw.archive, raw.unarchive].filter(Boolean);
		if (lifecycleModes.length > 1) {
			return {
				output:
					"Agent tool error: stop, archive, and unarchive are mutually exclusive — provide only one.",
				isError: true,
			};
		}

		// --- Archive mode: retire a subagent so broadcasts stop waking it ---
		if (raw.archive) {
			try {
				const targetId = await resolveArchiveTargetId(ctx.narratorId, raw.archive);
				const { narratorService } = await import("@server/services/narrator-service");
				const { isSubagentVariant } = await import("@server/lib/narrator-utils");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");

				const narrator = await narratorService.getById(targetId).catch(() => null);
				if (!narrator) {
					return {
						output: `Agent archive error: no subagent found for "${raw.archive}".`,
						isError: true,
					};
				}
				if (!isSubagentVariant(narrator.variant)) {
					return {
						output: `Agent archive error: "${raw.archive}" is not a subagent.`,
						isError: true,
					};
				}
				if (narrator.parentNarratorId !== ctx.narratorId) {
					return {
						output: `Agent archive error: "${raw.archive}" is not a direct child subagent of this narrator.`,
						isError: true,
					};
				}
				const label = agentLabelFromNarrator(narrator, ctx.narratorId);
				if (narrator.status === "archived") {
					return {
						output: `Agent ${label} (${narrator.id}) is already archived. It remains excluded from TeamStatus broadcast (@all members) until unarchived.`,
					};
				}

				const { interruptAndArchiveSubagent } = await import("@server/services/subagent-lifecycle");
				const archived = await interruptAndArchiveSubagent(narrator.id, {
					parentNarratorId: ctx.narratorId,
				});
				if (!archived.ok) {
					return {
						output: `Agent archive error: failed to archive "${raw.archive}" (${archived.error ?? "unknown"}).`,
						isError: true,
					};
				}

				return {
					output:
						`Agent ${label} (${narrator.id}) has been archived.\n` +
						"It will not receive TeamStatus broadcast (@all members) messages or wake-ups. " +
						"Direct Send to an archived subagent is also rejected. " +
						"Use unarchive to restore it, or a user page interaction (which auto-unarchives).",
				};
			} catch (err) {
				return {
					output: `Agent archive error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		// --- Unarchive mode: restore an archived subagent ---
		if (raw.unarchive) {
			try {
				const targetId = await resolveArchiveTargetId(ctx.narratorId, raw.unarchive);
				const { narratorService } = await import("@server/services/narrator-service");
				const { isSubagentVariant } = await import("@server/lib/narrator-utils");
				const { agentLabelFromNarrator } = await import("@server/services/subagent-label");

				const narrator = await narratorService.getById(targetId).catch(() => null);
				if (!narrator) {
					return {
						output: `Agent unarchive error: no subagent found for "${raw.unarchive}".`,
						isError: true,
					};
				}
				if (!isSubagentVariant(narrator.variant)) {
					return {
						output: `Agent unarchive error: "${raw.unarchive}" is not a subagent.`,
						isError: true,
					};
				}
				if (narrator.parentNarratorId !== ctx.narratorId) {
					return {
						output: `Agent unarchive error: "${raw.unarchive}" is not a direct child subagent of this narrator.`,
						isError: true,
					};
				}
				const label = agentLabelFromNarrator(narrator, ctx.narratorId);
				if (narrator.status !== "archived") {
					return {
						output: `Agent ${label} (${narrator.id}) is not archived (current status: ${narrator.status}).`,
					};
				}
				await narratorService.updateStatus(narrator.id, "idle");
				return {
					output:
						`Agent ${label} (${narrator.id}) has been unarchived. ` +
						"It can receive messages and TeamStatus broadcast (@all members) again.",
				};
			} catch (err) {
				return {
					output: `Agent unarchive error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		// --- Stop mode: cancel a running background agent task ---
		if (raw.stop) {
			try {
				const { resolveTaskAlias, cancelBackgroundTask } = await import(
					"@server/services/narrator-subagent"
				);
				let taskId = resolveTaskAlias(ctx.narratorId, raw.stop);

				// If alias registry didn't resolve (returned raw input), try DB lookup
				if (taskId === raw.stop) {
					const { backgroundTaskService } = await import(
						"@server/services/background-task-service"
					);
					const task = await backgroundTaskService.getByAlias(raw.stop, ctx.narratorId);
					if (task) taskId = task.id;
				}

				const cancelled = await cancelBackgroundTask(taskId);
				if (cancelled) {
					return { output: `Background agent task ${raw.stop} has been cancelled.` };
				}
				return {
					output: `Background agent task ${raw.stop} is not running (may have already completed or does not exist).`,
					isError: true,
				};
			} catch (err) {
				return {
					output: `Agent stop error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		const { prompt, description, subagent_type, model, reasoning_effort, workdir, alias } = raw;
		// Normalize timeout leniently: floats/strings/negatives → sane non-negative int
		// (0 = no wall-clock limit).
		const timeout = normalizeNumber(raw.timeout, { min: 0, max: Number.MAX_SAFE_INTEGER });
		// Prefer new name, fall back to legacy name for in-flight conversations
		const run_in_background = raw.run_in_background ?? raw.background;

		// Resolve effective cwd: use workdir if provided, otherwise parent's cwd
		const resolvedWorkdir = workdir ? resolvePath(ctx.cwd, workdir) : ctx.cwd;

		const toolUseId = ctx.currentToolUseId;
		if (!toolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}
		const toolCallBinding = ctx.toolCallBinding;
		if (!toolCallBinding) {
			return { output: "Internal error: missing persisted Agent tool-call binding", isError: true };
		}
		const updateExecutionLease = ctx.updateExecutionLease;
		if (!updateExecutionLease) {
			return { output: "Internal error: missing Agent update execution lease", isError: true };
		}

		// Lazy import to avoid circular dependency at module load time
		const { runSubagent } = await import("@server/services/narrator-subagent");

		if (!prompt) {
			return {
				output: "Missing required parameter: prompt (the task for the agent to perform)",
				isError: true,
			};
		}

		try {
			const result = await runSubagent({
				parentNarratorId: ctx.narratorId,
				toolUseId,
				toolCallBinding,
				subagentType: subagent_type || "general",
				prompt,
				title: description || undefined,
				cwd: resolvedWorkdir,
				signal: ctx.signal,
				updateExecutionLease,
				locale: ctx.locale,
				model: model || undefined,
				reasoningEffort: reasoning_effort,
				background: run_in_background || false,
				takeoverByUser: raw.takeover_by_user === true,
				timeoutMs: timeout,
				alias: alias || description || undefined,
				// The subagent acts on behalf of whoever triggered this parent turn:
				// knowledge ACL and fast-mode "inherit" both resolve against them.
				userId: ctx.userId ?? null,
			});

			// The runner already writes the alias into the `<subagent_id>` /
			// `<background_task_id>` tag and registers it, so no string surgery is
			// needed here. Conflicts are reported by the runner too.
			return { output: result };
		} catch (err) {
			return {
				output: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
