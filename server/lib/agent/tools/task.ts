import { z } from "zod/v4";
import { resolvePath } from "../../platform-path";
import {
	getAnthropicProviderConfig,
	getVisibleModels,
	isAnthropicProvider,
	settings,
} from "../../settings";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";

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
function getSubagentPoolNote(): string {
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

function buildParameters() {
	return z.object({
		description: z.string().optional().describe("A short (3-5 word) description of the task"),
		subagent_type: z
			.string()
			.min(1)
			.describe(
				'The type of specialized agent to use for this task. Built-in types: "explore" (read-only codebase exploration), "plan" (architecture planning, only in plan mode), "general" (full write access). You can also use any custom subagent type name defined by the user.',
			),
		model: z
			.string()
			.optional()
			.describe(
				`Override the model for this subagent. If omitted, uses the per-type model preference from settings (or the parent narrator's model as fallback). Available models: ${getAvailableModelsList()}${getSubagentPoolNote()}`,
			),
		workdir: z
			.string()
			.optional()
			.describe(
				"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
			),
		background: z
			.boolean()
			.optional()
			.describe(
				"If true, run the task in the background without blocking the parent narrator. Returns a task ID immediately that can be checked later with TaskOutput. The background task runs independently and its results can be retrieved when complete. Best for long-running exploration or analysis tasks that don't need to block the current conversation.",
			),
		prompt: z.string().describe("The task for the agent to perform"),
	});
}

function usesNativeWebSearch(provider: string): boolean {
	if (provider === "codex") return true;
	if (isAnthropicProvider(provider) && !!getAnthropicProviderConfig(provider)?.officialApi)
		return true;
	return false;
}

export const agentTool: ToolDefinition = {
	name: "Agent",
	description(config: AgentConfig) {
		if (usesNativeWebSearch(config.provider)) {
			return baseDescription.replaceAll("WebSearch", "web_search (native)");
		}
		return baseDescription;
	},
	get parameters() {
		return buildParameters();
	},
	get rawJsonSchema() {
		return {
			type: "object" as const,
			properties: {
				description: {
					description: "A short (3-5 word) description of the task",
					type: "string",
				},
				subagent_type: {
					description:
						'The type of specialized agent to use for this task. Built-in types: "explore", "plan", "general". Custom types are also supported.',
					type: "string",
				},
				resume: {
					description:
						"Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript.",
					type: "string",
				},
				run_in_background: {
					description:
						"Set to true to run this agent in the background. You will be notified when it completes.",
					type: "boolean",
				},
				model: {
					description: `Override the model for this subagent. If omitted, uses the per-type model preference from settings (or the parent narrator's model as fallback). Available models: ${getAvailableModelsList()}${getSubagentPoolNote()}`,
					type: "string",
				},
				workdir: {
					description:
						"Working directory for the subagent. Defaults to the parent narrator's cwd. When set to a different directory, user approval is required before the subagent is created, and the subagent's permission checks will be scoped to this directory.",
					type: "string",
				},
				isolation: {
					description:
						'Isolation mode. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo.',
					type: "string",
					enum: ["worktree"],
				},
				prompt: {
					description: "The task for the agent to perform",
					type: "string",
				},
			},
			required: ["description", "prompt"],
			additionalProperties: false,
		};
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { prompt, description, subagent_type, model, workdir, background } = args as {
			prompt: string;
			description?: string;
			subagent_type: string;
			model?: string;
			workdir?: string;
			background?: boolean;
		};

		// Resolve effective cwd: use workdir if provided, otherwise parent's cwd
		const resolvedWorkdir = workdir ? resolvePath(ctx.cwd, workdir) : ctx.cwd;

		// Lazy import to avoid circular dependency at module load time
		const { runSubagent } = await import("@server/services/narrator-subagent");

		const toolUseId = ctx.currentToolUseId;
		if (!toolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
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
				background: background || false,
			});
			return { output: result };
		} catch (err) {
			return {
				output: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
