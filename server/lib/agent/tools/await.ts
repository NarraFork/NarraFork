import { z } from "zod/v4";
import type { ToolDefinition } from "../types";

/** Historical imports only. Await is not registered and can never dispatch work. */
export const awaitTool: ToolDefinition = {
	name: "Await",
	description: "Retired tool. Use Watch to register a non-blocking observation.",
	parameters: z.object({}).passthrough(),
	async execute() {
		return {
			output:
				"Await is retired and cannot execute. Use Watch for terminal, bash or agent observations. Questions and transfers notify automatically.",
			isError: true,
		};
	},
};

/** No live waits survive retirement; retained for historical diagnostic consumers. */
export function listRunningAwaits(): {
	toolUseId: string;
	narratorId: string;
	awaitType: string;
	targetId: string;
	deadlineAt: string;
}[] {
	return [];
}

/** Pure rendering of legacy results; no waiting, timers or delivery side effects. */
export function formatQuestionResult(
	questionId: string,
	status: string,
	record: {
		questions: { id?: string; question?: string; header: string }[];
		answers: Record<string, string> | null;
		answerMessageId?: string | null;
	},
	receiptReady = false,
): string {
	switch (status) {
		case "answered": {
			if (receiptReady && record.answerMessageId)
				return `Question ${questionId} was answered. Answer event: ${record.answerMessageId}. The complete user receipt is supplied at the next safe model turn; use Question action=get to read it and Question action=resolve to confirm how it applies.`;
			const lines = record.questions.map((q) => {
				const answer =
					record.answers?.[q.header] ??
					(q.id ? record.answers?.[q.id] : undefined) ??
					(q.question ? record.answers?.[q.question] : undefined);
				return `- ${q.header}\n  ${answer ?? "(no answer recorded)"}`;
			});
			return `The user answered question ${questionId}:\n\n${lines.join("\n")}\n\nAnswer event: ${record.answerMessageId ?? "unavailable"}. This is a fallback excerpt, not the complete receipt. Receipt delivery is not confirmed; use Question action=get with id="${questionId}" to read the original context, options and full answer before deciding how it applies, then Question action=resolve to confirm handling.`;
		}
		case "dismissed":
			return `The user skipped question ${questionId} (dismissed). No answer was selected. Use Question action=get to inspect its context and decide the next step for the current task.`;
		case "withdrawn":
			return `Question ${questionId} was withdrawn; no further answer is pending. Use Question action=get to inspect the withdrawal context before deciding the next step.`;
		case "timeout":
			return `The wait for question ${questionId} timed out — only the wait ended, the question is still open and the user may still answer it. Use Question action=get for its current context. Answers notify automatically.`;
		case "aborted":
			return `The wait for question ${questionId} was interrupted; the question remains stored. Use Question action=get to inspect its current status before deciding the next step.`;
		default:
			return `Question ${questionId} status: ${status}`;
	}
}

export function formatResult(taskId: string, status: string, output: string | null): string {
	switch (status) {
		case "running":
		case "timeout":
			return (
				`Background task ${taskId} is still running — this wait timed out, not the task. ` +
				`Use Watch with the same id to register an observation.` +
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
			return `Background task ${taskId} is still running. Matched text found in output.\n\nOutput so far:\n${output ?? ""}`;
		case "aborted":
			return (
				`Observation interrupted; background task ${taskId} is still running. Use Watch with the same id.` +
				(output ? `\n\nPartial output so far:\n${output}` : "")
			);
		default:
			return `Background task ${taskId} status: ${status}`;
	}
}
