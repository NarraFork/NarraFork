import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

import baseDescription from "./continue-task.txt" with { type: "text" };

export const continueTaskTool: ToolDefinition = {
	name: "ContinueTask",
	get description() {
		return baseDescription;
	},
	parameters: z.object({
		subagent_id: z
			.string()
			.describe("The subagent ID returned by a previous Task call (from <subagent_id>)"),
		prompt: z.string().describe("Follow-up instructions for the subagent"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { subagent_id, prompt } = args as {
			subagent_id: string;
			prompt: string;
		};

		const { continueSubagent } = await import("@server/services/narrator-subagent");

		const toolUseId = ctx.currentToolUseId;
		if (!toolUseId) {
			return { output: "Internal error: missing toolUseId", isError: true };
		}

		try {
			const result = await continueSubagent({
				subagentId: subagent_id,
				parentNarratorId: ctx.narratorId,
				toolUseId,
				prompt,
				signal: ctx.signal,
				locale: ctx.locale,
			});
			return { output: result };
		} catch (err) {
			return {
				output: `ContinueTask error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
