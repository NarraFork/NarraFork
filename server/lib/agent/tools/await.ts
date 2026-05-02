import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;

export const awaitTool: ToolDefinition = {
	name: "Await",
	description:
		"Wait for an asynchronous task to complete and return its current status and output.\n\n" +
		'Use `type: "agent"` to await a background or running subagent. ' +
		'Use `type: "bash"` to await a background bash task. ' +
		"If the timeout is reached while the task is still running, returns partial output when available. " +
		"For bash tasks, `wait_for_text` returns early once matching output appears.",
	parameters: z.object({
		type: z.enum(["agent", "bash"]).describe('What to await: "agent" or "bash".'),
		id: z.string().describe("The task/subagent ID, alias, or accessible subagent name."),
		timeout: z
			.number()
			.optional()
			.describe("How long to wait in milliseconds before returning. Defaults to 30000."),
		wait_for_text: z
			.string()
			.optional()
			.describe('For type="bash" only: return early when this text appears in output.'),
	}),
	rawJsonSchema: {
		type: "object",
		properties: {
			type: {
				description: 'What to await: "agent" or "bash".',
				type: "string",
				enum: ["agent", "bash"],
			},
			id: {
				description: "The task/subagent ID, alias, or accessible subagent name.",
				type: "string",
			},
			timeout: {
				description: "How long to wait in milliseconds before returning. Defaults to 30000.",
				type: "number",
			},
			wait_for_text: {
				description: 'For type="bash" only: return early when this text appears in output.',
				type: "string",
			},
		},
		required: ["type", "id"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { type, id, timeout, wait_for_text } = args as {
			type: "agent" | "bash";
			id: string;
			timeout?: number;
			wait_for_text?: string;
		};

		if (!id) return { output: "Error: id is required.", isError: true };
		const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;

		try {
			if (type === "agent") {
				const { awaitAgentResultDetailed } = await import("@server/services/agent-communication");
				const result = await awaitAgentResultDetailed({
					callerNarratorId: ctx.narratorId,
					id,
					timeoutMs,
					signal: ctx.signal,
				});
				return {
					output: result.formatted,
					metadata: {
						kind: "await",
						awaitType: "agent",
						targetId: id,
						resolvedId: result.id,
						subagentId: result.id,
						status: result.status,
					},
				};
			}

			const { backgroundTaskService } = await import("@server/services/background-task-service");
			const { resolveTaskAlias, registerTaskAlias } = await import(
				"@server/services/subagent-alias"
			);
			let taskId = resolveTaskAlias(ctx.narratorId, id);
			let task = await backgroundTaskService.getById(taskId);
			if (!task && taskId === id) {
				task = await backgroundTaskService.getByAlias(id, ctx.narratorId);
				if (task) taskId = task.id;
			}
			if (!task)
				return { output: `Error: "${id}" is not a valid background task ID.`, isError: true };
			if (task.type !== "bash") {
				return { output: `Error: "${id}" is a ${task.type} task, not bash.`, isError: true };
			}
			if (task.parentNarratorId !== ctx.narratorId) {
				return { output: `Error: "${id}" does not belong to this narrator.`, isError: true };
			}
			if (task.alias && task.id !== id) registerTaskAlias(ctx.narratorId, task.id, task.alias);

			const result = wait_for_text
				? await backgroundTaskService.waitForText(taskId, wait_for_text, timeoutMs, ctx.signal)
				: await backgroundTaskService.waitForCompletion(taskId, timeoutMs, ctx.signal);
			return {
				output: formatResult(taskId, result.status, result.output),
				metadata: {
					kind: "await",
					awaitType: "bash",
					targetId: id,
					resolvedId: taskId,
					status: result.status,
					waitForText: wait_for_text,
				},
			};
		} catch (err) {
			return {
				output: `Await error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

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
