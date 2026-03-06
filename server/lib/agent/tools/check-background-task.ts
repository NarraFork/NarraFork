import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const checkBackgroundTaskTool: ToolDefinition = {
	name: "CheckBackgroundTask",
	description:
		"Check the status of a background task or retrieve its results. Use this after launching a Task with background=true to poll for completion or get the final output.",
	parameters: z.object({
		task_id: z
			.string()
			.describe(
				"The background task ID returned by a previous Task call with background=true (from <background_task_id>)",
			),
		wait: z
			.boolean()
			.optional()
			.describe(
				"If true, wait for the task to complete before returning (with timeout). Default: false",
			),
		timeout_ms: z
			.number()
			.optional()
			.describe("Maximum time to wait in milliseconds when wait=true. Default: 30000"),
	}),
	async execute(args, _ctx): Promise<ToolResult> {
		const { task_id, wait, timeout_ms } = args as {
			task_id: string;
			wait?: boolean;
			timeout_ms?: number;
		};

		const { getBackgroundTaskStatus, waitForBackgroundTask } = await import(
			"@server/services/narrator-subagent"
		);

		try {
			if (wait) {
				const result = await waitForBackgroundTask(task_id, timeout_ms ?? 30000);
				return { output: formatResult(task_id, result.status, result.result) };
			}

			const status = await getBackgroundTaskStatus(task_id);
			if (!status) {
				return {
					output: `Error: "${task_id}" is not a valid background task ID.`,
					isError: true,
				};
			}

			return { output: formatResult(task_id, status.status, status.result) };
		} catch (err) {
			return {
				output: `CheckBackgroundTask error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

function formatResult(taskId: string, status: string, result: string | null): string {
	switch (status) {
		case "running":
			return `Background task ${taskId} is still running.`;
		case "completed":
			return `Background task ${taskId} completed.\n\nResult:\n${result ?? "(no output)"}`;
		case "failed":
			return `Background task ${taskId} failed.\n\nError:\n${result ?? "Unknown error"}`;
		case "cancelled":
			return `Background task ${taskId} was cancelled.`;
		default:
			return `Background task ${taskId} status: ${status}`;
	}
}
