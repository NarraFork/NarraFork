import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const taskOutputTool: ToolDefinition = {
	name: "TaskOutput",
	description:
		"- Retrieves output from a running or completed task (background shell, agent, or remote session)\n" +
		"- Takes a task_id parameter identifying the task\n" +
		"- Returns the task output along with status information\n" +
		"- Use block=true (default) to wait for task completion\n" +
		"- Use block=false for non-blocking check of current status\n" +
		"- Task IDs can be found using the /tasks command\n" +
		"- Works with all task types: background shells, async agents, and remote sessions",
	parameters: z.object({
		task_id: z
			.string()
			.describe(
				"The background task ID returned by a previous Agent call with background=true (from <background_task_id>)",
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
	rawJsonSchema: {
		type: "object",
		properties: {
			task_id: { description: "The task ID to get output from", type: "string" },
			block: {
				description: "Whether to wait for completion",
				default: true,
				type: "boolean",
			},
			timeout: {
				description: "Max wait time in ms",
				default: 30000,
				type: "number",
				minimum: 0,
				maximum: 600000,
			},
		},
		required: ["task_id", "block", "timeout"],
		additionalProperties: false,
	},
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
				output: `TaskOutput error: ${err instanceof Error ? err.message : String(err)}`,
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
