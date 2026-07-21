import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_AWAIT_TIMEOUT_MS = 86_400_000; // 24h — matches the update_timeout WS validator cap
const AWAIT_TIMEOUT_DESCRIPTION =
	"How long to wait in milliseconds before returning. Defaults to 600000 (10 minutes). For agent tasks, " +
	"prefer 600000 (10 minutes) for general exploration work and 1800000 (30 minutes) for " +
	"implementation work; avoid repeated short waits.";

export { DEFAULT_TIMEOUT_MS as DEFAULT_AWAIT_TIMEOUT_MS };

// --- Live timeout management ---
// Tracks running Await waits so the UI can extend their timeout mid-wait, mirroring
// the Bash tool's runningBashProcesses map. Pinned to globalThis via hotSafe so hot
// reloads don't lose references to in-flight timers.

interface RunningAwaitEntry {
	startedAt: number;
	timeoutMs: number;
	awaitType: "agent" | "bash";
	targetId: string;
	narratorId: string;
	/** Reschedule the timeout to fire `newMs` after the wait started. */
	reschedule: (newMs: number) => void;
}

export interface RunningAwaitSnapshot {
	toolUseId: string;
	startedAt: number;
	timeoutMs: number;
	deadlineAt: string;
	awaitType: "agent" | "bash";
	targetId: string;
	narratorId: string;
}

export function listRunningAwaits(): RunningAwaitSnapshot[] {
	return [...runningAwaits.entries()].map(([toolUseId, entry]) => ({
		toolUseId,
		startedAt: entry.startedAt,
		timeoutMs: entry.timeoutMs,
		deadlineAt: new Date(entry.startedAt + entry.timeoutMs).toISOString(),
		awaitType: entry.awaitType,
		targetId: entry.targetId,
		narratorId: entry.narratorId,
	}));
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

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	const subagent = Boolean(config?.parentNarratorId);
	return {
		type: "object",
		properties: {
			type: {
				description: subagent
					? 'What to await: "bash" (subagents cannot await other agents).'
					: 'What to await: "agent" (primary narrator only) or "bash" (also available to subagents).',
				type: "string",
				enum: subagent ? ["bash"] : ["agent", "bash"],
			},
			id: {
				description: "The task/subagent ID, alias, or accessible subagent name.",
				type: "string",
			},
			timeout: {
				description: AWAIT_TIMEOUT_DESCRIPTION,
				type: "number",
			},
			wait_for_text: {
				description: 'For type="bash" only: return early when this text appears in output.',
				type: "string",
			},
		},
		required: ["type", "id"],
		additionalProperties: false,
	};
}

export const awaitTool: ToolDefinition = {
	name: "Await",
	description:
		"Wait for an asynchronous task to complete and return its current status and output.\n\n" +
		'Use `type: "agent"` to await a background or running subagent from a primary narrator. ' +
		'Subagents cannot use `type: "agent"` to wait for other agents; use asynchronous Send instead. ' +
		'Use `type: "bash"` to await a background bash task. ' +
		"If an agent wait times out, the result includes its recent timestamped tool activity. " +
		"A timeout ends only the current wait, not the task: if activity is recent, keep waiting with " +
		"Await and a meaningful timeout instead of sending status checks or interrupting the agent. " +
		"Prefer one meaningful wait over repeated short polling. Await defaults to `timeout: 600000` " +
		"(10 minutes), suitable for general exploration tasks; use `timeout: 1800000` (30 minutes) for implementation " +
		"tasks. For bash tasks, `wait_for_text` returns early once matching output appears.",
	parameters: z.object({
		type: z
			.enum(["agent", "bash"])
			.describe(
				'What to await: "agent" (primary narrator only) or "bash" (also available to subagents).',
			),
		id: z.string().describe("The task/subagent ID, alias, or accessible subagent name."),
		timeout: looseNumber(AWAIT_TIMEOUT_DESCRIPTION),
		wait_for_text: z
			.string()
			.optional()
			.describe('For type="bash" only: return early when this text appears in output.'),
	}),
	get rawJsonSchema() {
		return buildRawJsonSchema();
	},
	getRawJsonSchema(config?: AgentConfig) {
		return buildRawJsonSchema(config);
	},
	async execute(args, ctx): Promise<ToolResult> {
		const { type, id, wait_for_text } = args as {
			type: "agent" | "bash";
			id: string;
			wait_for_text?: string;
		};
		const timeout = normalizeNumber((args as { timeout?: unknown }).timeout, {
			min: 1000,
			max: MAX_AWAIT_TIMEOUT_MS,
		});

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
		const runningEntry: RunningAwaitEntry = {
			startedAt,
			timeoutMs,
			awaitType: type,
			targetId: id,
			narratorId: ctx.narratorId,
			reschedule: (newMs) => {
				clearTimeout(timer);
				const remaining = Math.max(newMs - (Date.now() - startedAt), 0);
				timer = setTimeout(() => timeoutController.abort(), remaining);
			},
		};
		if (toolUseId) runningAwaits.set(toolUseId, runningEntry);

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
			if (toolUseId && runningAwaits.get(toolUseId) === runningEntry) {
				runningAwaits.delete(toolUseId);
			}
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
		case "timed_out":
			return `Background task ${taskId} exceeded its execution time limit and was stopped.\n\nDetails:\n${output ?? "Task timed out"}`;
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
