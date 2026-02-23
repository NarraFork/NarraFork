import { z } from "zod/v4";
import { settings } from "../../settings";
import type { ToolDefinition, ToolResult } from "../types";

// Use text import so the bundler inlines the file content at build time
import baseDescription from "./task.txt" with { type: "text" };

const BUILTIN_MODELS = ["claude-haiku", "claude-sonnet", "claude-opus"];

/** Build a dynamic model list string from builtins + custom models. */
function getAvailableModelsList(): string {
	const custom = (settings.agent.customModels ?? []).map((m) => m.value);
	return [...BUILTIN_MODELS, ...custom].join(", ");
}

function buildParameters() {
	return z.object({
		description: z.string().optional().describe("A short (3-5 word) description of the task"),
		prompt: z.string().describe("The task for the agent to perform"),
		subagent_type: z
			.enum(["explore", "plan", "general"])
			.describe("The type of specialized agent to use for this task"),
		model: z
			.string()
			.optional()
			.describe(
				`Override the model for this subagent. If omitted, uses the per-type model preference from settings (or the parent narrator's model as fallback). Available models: ${getAvailableModelsList()}`,
			),
	});
}

export const taskTool: ToolDefinition = {
	name: "Task",
	get description() {
		return baseDescription;
	},
	get parameters() {
		return buildParameters();
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { prompt, subagent_type, model } = args as {
			prompt: string;
			description?: string;
			subagent_type: "explore" | "plan" | "general";
			model?: string;
		};

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
				subagentType: subagent_type,
				prompt,
				cwd: ctx.cwd,
				signal: ctx.signal,
				locale: ctx.locale,
				model: model || undefined,
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
