import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { ToolDefinition, ToolResult } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_AWAIT_TIMEOUT_MS = 86_400_000; // 24h — matches the update_timeout WS validator cap

export { DEFAULT_TIMEOUT_MS as DEFAULT_AWAIT_TIMEOUT_MS };

// --- Live timeout management ---
// Tracks running Await waits so the UI can extend their timeout mid-wait, mirroring
// the Bash tool's runningBashProcesses map. Pinned to globalThis via hotSafe so hot
// reloads don't lose references to in-flight timers.

interface RunningAwaitEntry {
	startedAt: number;
	timeoutMs: number;
	/** Reschedule the timeout to fire `newMs` after the wait started. */
	reschedule: (newMs: number) => void;
}

const runningAwaits = hotSafe(
	"narrafork:runningAwaits",
	() => new Map<string, RunningAwaitEntry>(),
);

/**
 * Update the timeout of a running Await wait.
 * Returns the new effective timeoutMs, or null if the toolUseId is not found.
 */
export function updateAwaitTimeout(toolUseId: string, newTimeoutMs: number): number | null {
	const entry = runningAwaits.get(toolUseId);
	if (!entry) return null;
	const clamped = Math.min(Math.max(newTimeoutMs, 1000), MAX_AWAIT_TIMEOUT_MS);
	entry.timeoutMs = clamped;
	entry.reschedule(clamped);
	return clamped;
}

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

		// Reschedulable timeout: the wait is driven by our own AbortController so the
		// UI can extend it mid-wait (mirrors the Bash tool's runningBashProcesses).
		const toolUseId = ctx.currentToolUseId;
		const startedAt = Date.now();
		const timeoutController = new AbortController();
		let timer: ReturnType<typeof setTimeout> = setTimeout(
			() => timeoutController.abort(),
			timeoutMs,
		);
		if (toolUseId) {
			runningAwaits.set(toolUseId, {
				startedAt,
				timeoutMs,
				reschedule: (newMs) => {
					clearTimeout(timer);
					const remaining = Math.max(newMs - (Date.now() - startedAt), 0);
					timer = setTimeout(() => timeoutController.abort(), remaining);
				},
			});
		}

		// Distinguish a timeout abort from a real parent interrupt so we can label the
		// result correctly: parent abort → "aborted", our timeout → "timeout".
		const combinedSignal = AbortSignal.any([ctx.signal, timeoutController.signal]);
		const relabel = (status: string): string =>
			status === "aborted" && !ctx.signal.aborted && timeoutController.signal.aborted
				? "timeout"
				: status;

		try {
			if (type === "agent") {
				const { awaitAgentResultDetailed } = await import("@server/services/agent-communication");
				const result = await awaitAgentResultDetailed({
					callerNarratorId: ctx.narratorId,
					id,
					// The reschedulable timeoutController drives the deadline; give the inner
					// waits a large cap so their own timers never win first.
					timeoutMs: MAX_AWAIT_TIMEOUT_MS,
					signal: ctx.signal,
					timeoutSignal: timeoutController.signal,
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
				? await backgroundTaskService.waitForText(
						taskId,
						wait_for_text,
						MAX_AWAIT_TIMEOUT_MS,
						combinedSignal,
					)
				: await backgroundTaskService.waitForCompletion(
						taskId,
						MAX_AWAIT_TIMEOUT_MS,
						combinedSignal,
					);
			const status = relabel(result.status);
			return {
				output: formatResult(taskId, status, result.output),
				metadata: {
					kind: "await",
					awaitType: "bash",
					targetId: id,
					resolvedId: taskId,
					status,
					waitForText: wait_for_text,
				},
			};
		} catch (err) {
			return {
				output: `Await error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		} finally {
			clearTimeout(timer);
			if (toolUseId) runningAwaits.delete(toolUseId);
		}
	},
};

export function formatResult(taskId: string, status: string, output: string | null): string {
	switch (status) {
		case "running":
		case "timeout":
			return (
				`Background task ${taskId} is still running — the wait timed out but the task has not stopped. ` +
				`Call Await again with the same id to keep waiting.` +
				(output ? `\n\nPartial output so far:\n${output}` : "")
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
			return (
				`Await on background task ${taskId} was interrupted — only this wait was canceled, not the task. ` +
				`It is still running in the background. Call Await again with the same id to keep waiting.` +
				(output ? `\n\nPartial output so far:\n${output}` : "")
			);
		default:
			return `Background task ${taskId} status: ${status}`;
	}
}
