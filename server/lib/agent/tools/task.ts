import { z } from "zod/v4";
import { resolvePath } from "../../platform-path";
import { shouldUseNativeSearch } from "../../search/native";
import { getVisibleModels, settings } from "../../settings";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh"] as const;
const REASONING_EFFORT_DESCRIPTION =
	'Reasoning/thinking effort for this subagent. Use "none" to disable thinking where supported. ' +
	'Valid values: "none", "low", "medium", "high", "xhigh". ' +
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

/** When per-type pool restrictions are active, append a note to the model parameter description. */
function getSubagentPoolNote(config?: AgentConfig): string {
	if (config?.subagentModelRestrictionDescription) {
		return `\n\n${config.subagentModelRestrictionDescription}`;
	}
	const pools = settings.agent.subagentAllowedModels;
	if (!pools) return "";
	const parts: string[] = [];
	for (const type of ["explore", "plan", "general"] as const) {
		const pool = pools[type];
		if (pool && pool.length > 0) {
			parts.push(`${type}: ${pool.join(", ")}`);
		}
	}
	if (parts.length === 0) return "";
	return `\n\nNote: Subagent model selection is restricted per type. Allowed models — ${parts.join("; ")}. Models outside the pool for a given type will be ignored.`;
}

function getModelParameterDescription(config?: AgentConfig): string {
	const list = config?.subagentModelRestrictionDescription
		? "see custom restriction below"
		: getAvailableModelsList();
	return `Override the model for this subagent. If omitted, uses the per-type model preference from settings (or the parent narrator's model as fallback). Available models: ${list}${getSubagentPoolNote(config)}`;
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
		// Prefer new name, fall back to legacy name for in-flight conversations
		const run_in_background = raw.run_in_background ?? raw.background;

		// Resolve effective cwd: use workdir if provided, otherwise parent's cwd
		const resolvedWorkdir = workdir ? resolvePath(ctx.cwd, workdir) : ctx.cwd;

		const toolUseId = ctx.currentToolUseId;
		if (!toolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}

		// Lazy import to avoid circular dependency at module load time
		const { runSubagent, registerTaskAlias } = await import("@server/services/narrator-subagent");

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
				locale: ctx.locale,
				model: model || undefined,
				reasoningEffort: reasoning_effort,
				background: run_in_background || false,
				alias: alias || description || undefined,
			});

			// Register alias for ALL subagents (foreground and background)
			// Extract the real subagent ID from the result
			const bgMatch = result.match(/<background_task_id>([^<]+)<\/background_task_id>/);
			const fgMatch = result.match(/<subagent_id>([^<]+)<\/subagent_id>/);
			const realId = bgMatch?.[1] ?? fgMatch?.[1];

			if (realId) {
				const { alias: registeredAlias, conflicted } = registerTaskAlias(
					ctx.narratorId,
					realId,
					alias || description,
				);

				// Replace the raw ID with the alias in the output
				let output = result;
				if (bgMatch) {
					output = output.replace(
						`<background_task_id>${realId}</background_task_id>`,
						`<background_task_id>${registeredAlias}</background_task_id>`,
					);
				}
				if (fgMatch) {
					output = output.replace(
						`<subagent_id>${realId}</subagent_id>`,
						`<subagent_id>${registeredAlias}</subagent_id>`,
					);
				}

				if (conflicted) {
					output +=
						`\n\nNote: The requested alias "${alias || description}" was already taken. ` +
						`This agent was assigned "${registeredAlias}" instead. ` +
						`Use this alias with Await or Send to reference this agent.`;
				}

				return { output };
			}

			return { output: result };
		} catch (err) {
			return {
				output: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
