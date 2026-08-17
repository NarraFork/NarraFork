import { z } from "zod/v4";
import { resolvePath } from "../../platform-path";
import { shouldUseNativeSearch } from "../../search/native";
import { expandAllowedPoolForDisplay, getVisibleModels, settings } from "../../settings";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_DESCRIPTION =
	'Reasoning/thinking effort for this subagent. Use "none" to disable thinking where supported. ' +
	"If the selected model/provider does not support configurable thinking intensity, this option is ignored.";

// Use text import so the bundler inlines the file content at build time
import baseDescription from "./task.txt" with { type: "text" };

/** Build a dynamic model list string from all visible models. */
function getAvailableModelsList(): string {
	const models = getVisibleModels();
	if (models.length > 0) {
		return models.join(", ");
	}
	return "(no models configured yet)";
}

const MODEL_PARAM_BASE =
	"Override the model for this subagent. If omitted, uses the per-type model preference from settings (or the parent narrator's model as fallback).";

const SUBAGENT_POOL_TYPES = ["explore", "plan", "search", "general"] as const;

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
				restrictedParts.push(`${type}: ${expandAllowedPoolForDisplay(pool).join(", ")}`);
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
			prompt: {
				description: "The task for the agent to perform (required when launching a new agent)",
				type: "string",
			},
		},
		required: [] as string[],
		additionalProperties: false,
	};
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
			timeout?: number;
			model?: string;
			reasoning_effort?: ReasoningEffort;
			workdir?: string;
			alias?: string;
			stop?: string;
			// Legacy parameter name (pre-rename compat)
			background?: boolean;
		};

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
