import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const cancelBackgroundTaskTool: ToolDefinition = {
	name: "CancelBackgroundTask",
	description: "Cancel a running background task. Only works on tasks that are still running.",
	parameters: z.object({
		task_id: z
			.string()
			.describe(
				"The background task ID returned by a previous Task call with background=true (from <background_task_id>)",
			),
	}),
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
				output: `CancelBackgroundTask error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
