import { backgroundTaskService } from "@server/services/background-task-service";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;

export const awaitBackgroundTaskTool: ToolDefinition = {
	name: "AwaitBackgroundTask",
	description:
		"Wait for a background task (bash or agent) to complete. " +
		"Returns the task's current status and output. " +
		"If the task finishes before the timeout, returns immediately with the full result. " +
		"If the timeout is reached while the task is still running, returns partial output. " +
		"Use `wait_for_text` to return early when a specific string appears in the output " +
		"(useful for waiting until a server prints 'ready' or a build emits 'success').\n\n" +
		"This tool works with both background bash tasks (started via Bash with run_in_background) " +
		"and background agent tasks (started via Agent with run_in_background).",
	parameters: z.object({
		task_id: z
			.string()
			.describe(
				"The background task ID or alias " +
					"(shown in <background_task_id> when the task was started).",
			),
		timeout: z
			.number()
			.optional()
			.describe(
				"How long to wait in milliseconds before returning (default 30000). " +
					"If the task is still running after this period, partial output is returned.",
			),
		wait_for_text: z
			.string()
			.optional()
			.describe(
				"Return early when this text appears in the task's output. " +
					"The task keeps running; you just get the output so far.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			task_id: rawId,
			timeout,
			wait_for_text,
		} = args as {
			task_id: string;
			timeout?: number;
			wait_for_text?: string;
		};

		if (!rawId) {
			return {
				output:
					"Error: task_id is required. Provide the background task ID or alias " +
					"(shown in <background_task_id> when the task was started).",
				isError: true,
			};
		}

		const { resolveTaskAlias } = await import("@server/services/subagent-alias");
		const taskId = resolveTaskAlias(ctx.narratorId, rawId);
		const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;

		// Check if task exists in background_tasks table
		const task = await backgroundTaskService.getById(taskId);
		if (!task) {
			// Legacy fallback: check narrators table directly
			try {
				const { narratorService } = await import("@server/services/narrator-service");
				const narrator = await narratorService.getById(taskId);
				if (narrator.backgroundStatus) {
					if (narrator.backgroundStatus !== "running") {
						return {
							output: formatResult(taskId, narrator.backgroundStatus, narrator.backgroundResult),
						};
					}
					// For running legacy tasks, use the old event-based waiting
					const { waitForBackgroundTask } = await import("@server/services/subagent-runner");
					const result = await waitForBackgroundTask(taskId, timeoutMs);
					return { output: formatResult(taskId, result.status, result.result) };
				}
			} catch (err) {
				// Legacy narrator lookup failed — log for debugging but don't expose internals
				if (err instanceof Error && err.message !== "Not found") {
					const { logger } = await import("@server/lib/logger");
					logger.debug("Legacy background task lookup failed", {
						taskId,
						error: err.message,
					});
				}
			}
			return {
				output: `Error: "${taskId}" is not a valid background task ID.`,
				isError: true,
			};
		}

		// Use backgroundTaskService for unified waiting
		if (wait_for_text) {
			const result = await backgroundTaskService.waitForText(
				taskId,
				wait_for_text,
				timeoutMs,
				ctx.signal,
			);
			return { output: formatResult(taskId, result.status, result.output) };
		}

		const result = await backgroundTaskService.waitForCompletion(taskId, timeoutMs, ctx.signal);
		return { output: formatResult(taskId, result.status, result.output) };
	},
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResult(taskId: string, status: string, output: string | null): string {
	switch (status) {
		case "running":
		case "timeout":
			return (
				`Background task ${taskId} is still running (timeout reached).` +
				(output ? `\n\nPartial output:\n${output}` : "")
			);
		case "completed":
			return `Background task ${taskId} completed.\n\nOutput:\n${output ?? "(no output)"}`;
		case "failed":
			return `Background task ${taskId} failed.\n\nError:\n${output ?? "Unknown error"}`;
		case "cancelled":
			return `Background task ${taskId} was cancelled.`;
		case "text_matched":
		case "found":
			return (
				`Background task ${taskId} is still running. Matched text found in output.\n\n` +
				`Output so far:\n${output ?? ""}`
			);
		case "aborted":
			return `Background task ${taskId} await was aborted.${output ? `\n\nPartial output:\n${output}` : ""}`;
		default:
			return `Background task ${taskId} status: ${status}`;
	}
}
