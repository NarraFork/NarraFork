import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const taskStopTool: ToolDefinition = {
	name: "TaskStop",
	description:
		"\n- Stops a running background task by its ID\n" +
		"- Takes a task_id parameter identifying the task to stop\n" +
		"- Returns a success or failure status\n" +
		"- Use this tool when you need to terminate a long-running task",
	parameters: z.object({
		task_id: z
			.string()
			.describe(
				"The background task ID returned by a previous Agent call with background=true (from <background_task_id>)",
			),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			task_id: {
				description: "The ID of the background task to stop",
				type: "string",
			},
			shell_id: {
				description: "Deprecated: use task_id instead",
				type: "string",
			},
		},
		additionalProperties: false,
	},
	async execute(args, _ctx): Promise<ToolResult> {
		const { task_id } = args as { task_id: string };

		const { cancelBackgroundTask } = await import("@server/services/narrator-subagent");

		try {
			const cancelled = await cancelBackgroundTask(task_id);
			if (cancelled) {
				return { output: `Background task ${task_id} has been cancelled.` };
			}
			return {
				output: `Background task ${task_id} is not running (may have already completed or does not exist).`,
				isError: true,
			};
		} catch (err) {
			return {
				output: `TaskStop error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
