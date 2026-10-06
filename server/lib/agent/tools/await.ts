import { logger } from "@server/lib/logger";
import {
	type RuntimeAwaitTarget,
	runtimeAwaitTargets,
	runtimePolicyForContext,
} from "@server/services/agent-runtime/policy";
import {
	getRuntimePublicationService,
	type PublicationRun,
} from "@server/services/agent-runtime/publication";
import { SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR } from "@server/services/subagent-communication-policy";
import { z } from "zod/v4";
import { hotSafe } from "../../hot-safe";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

async function consumeTerminalResult(result: {
	status: string;
	terminalResultReceived?: boolean;
	publicationRun?: PublicationRun;
	sourceResultRef?: string;
}): Promise<void> {
	if (
		!result.terminalResultReceived ||
		!result.publicationRun ||
		["timeout", "aborted", "running", "taken_over"].includes(result.status)
	)
		return;
	try {
		const publication = await getRuntimePublicationService();
		if (result.sourceResultRef !== undefined) {
			await publication.consumeAwaitedTerminal(result.publicationRun, {
				sourceResultRef: result.sourceResultRef,
			});
		} else {
			await publication.consumeAwaitedTerminal(result.publicationRun);
		}
	} catch (error) {
		logger.warn("Failed to consume Await terminal notification; preserving result", {
			run: result.publicationRun,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

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

/** What an Await call is waiting on. */
export type AwaitTargetType = RuntimeAwaitTarget;

interface RunningAwaitEntry {
	startedAt: number;
	timeoutMs: number;
	awaitType: AwaitTargetType;
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
	awaitType: AwaitTargetType;
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

/**
 * Tell the narrator's subscribers which child an in-flight Await is waiting on.
 *
 * Imported lazily and never awaited by the caller: this is a UI affordance, so it
 * must not add latency to the wait or fail it. `type: "agent"` is rejected for
 * subagents (see `buildRawJsonSchema`), so the owning narrator is always the
 * top-level one and no `parentToolUseId` routing is needed.
 */
export async function broadcastAwaitAgentResolved(
	narratorId: string,
	toolUseId: string,
	subagentNarratorId: string,
): Promise<void> {
	try {
		const { broadcastToNarrator } = await import("@server/websocket/narrator-ws");
		broadcastToNarrator(narratorId, {
			type: "await_agent_resolved",
			narratorId,
			toolUseId,
			subagentNarratorId,
		});
	} catch {
		// Best-effort only; a reload picks the same fact up from the message loader.
	}
}

function buildRawJsonSchema(config?: AgentConfig): Record<string, unknown> {
	const policy = runtimePolicyForContext(config);
	const targets = runtimeAwaitTargets(policy);
	const questionHint =
		policy.capabilities.askUserQuestion === "disabled"
			? "question waits only on an existing own question; AskUserQuestion is unavailable."
			: "question waits on an async AskUserQuestion belonging to this session.";
	return {
		type: "object",
		properties: {
			type: {
				description: `What to await: ${targets.join(", ")}. ${questionHint}${
					policy.capabilities.awaitAgent ? "" : " Subagents cannot await other agents."
				}`,
				type: "string",
				// Legacy own-question waits remain available independently of question creation.
				enum: targets,
			},
			id: {
				description: "The task/subagent ID, alias, accessible subagent name, or async question id.",
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
		'Use `type: "transfer"` to await a background device file transfer; a paused transfer ' +
		"returns immediately as paused rather than waiting, so you can decide whether to resume it. " +
		'Use `type: "question"` with a question id to wait for an answer to a question you submitted ' +
		"via `AskUserQuestion({ async: true })`. Do this when you have reached the point where the answer " +
		"actually decides your next step: awaiting notifies the user that you are now blocked on them, so " +
		"only await when you genuinely cannot continue. If the wait times out the question stays open and " +
		"you may await again, or proceed with your default. An already-answered question returns immediately. " +
		"If an agent wait times out, the result includes its recent timestamped tool activity. " +
		"A timeout ends only the current wait, not the task: if activity is recent, keep waiting with " +
		"Await and a meaningful timeout instead of sending status checks or interrupting the agent. " +
		"Prefer one meaningful wait over repeated short polling. Await defaults to `timeout: 600000` " +
		"(10 minutes), suitable for general exploration tasks; use `timeout: 1800000` (30 minutes) for implementation " +
		"tasks. For bash tasks, `wait_for_text` returns early once matching output appears.",
	parameters: z.object({
		type: z
			.enum(["agent", "bash", "transfer", "question"])
			.describe(
				'What to await: "agent" (primary narrator only), "bash", "transfer" (a background device file transfer), or "question" (an async AskUserQuestion).',
			),
		id: z
			.string()
			.describe("The task/subagent ID, alias, accessible subagent name, or async question id."),
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
			type: AwaitTargetType;
			id: string;
			wait_for_text?: string;
		};
		const timeout = normalizeNumber((args as { timeout?: unknown }).timeout, {
			min: 1000,
			max: MAX_AWAIT_TIMEOUT_MS,
		});

		if (!runtimeAwaitTargets(runtimePolicyForContext(ctx)).includes(type)) {
			return {
				output:
					type === "agent"
						? `Await error: ${SUBAGENT_AGENT_AWAIT_FORBIDDEN_ERROR}`
						: `Await error: unsupported wait type "${type}".`,
				isError: true,
			};
		}
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
					// The wait can last for the whole timeout, and the returned metadata
					// (which is what normally carries `subagentId`) only lands when it
					// ends. Publishing the id here is what lets the card offer "open
					// session" while the child is still working.
					onTargetResolved: (subagentNarratorId) => {
						if (!toolUseId) return;
						void broadcastAwaitAgentResolved(ctx.narratorId, toolUseId, subagentNarratorId);
					},
				});
				if (!combinedSignal.aborted) await consumeTerminalResult(result);
				return {
					output: result.formatted,
					metadata: {
						kind: "await",
						awaitType: "agent",
						targetId: id,
						// Readable name for the header/badges; `subagentId` stays the real
						// narrator id so the card can still open its session.
						targetLabel: result.label,
						resolvedId: result.id,
						subagentId: result.id,
						status: result.status,
					},
				};
			}

			if (type === "question") {
				const { awaitAsyncQuestion } = await import("@server/services/narrator-question-service");
				const result = await awaitAsyncQuestion({
					questionId: id,
					narratorId: ctx.narratorId,
					// The reschedulable timeoutController owns the deadline (so the UI can
					// extend the wait mid-flight); the primitive's own timer is left unarmed.
					timeoutMs: 0,
					signal: ctx.signal,
					timeoutSignal: timeoutController.signal,
				});
				if (result.status === "not_found") {
					return {
						output:
							`Error: "${id}" is not an async question belonging to this session. ` +
							`Use the id returned by AskUserQuestion({ async: true }).`,
						isError: true,
					};
				}
				const { isQuestionAnswerDeliveryReady, registerQuestionAnswerFallback } = await import(
					"@server/services/narrator-session"
				);
				const receiptReady =
					!!result.record.answerMessageId &&
					isQuestionAnswerDeliveryReady(ctx.narratorId, result.record.answerMessageId);
				let output = formatQuestionResult(id, result.status, result.record, receiptReady);
				if (result.status === "answered" && !receiptReady && result.record.answerMessageId) {
					const { getQuestionAnswerFallbackText } = await import(
						"@server/services/narrator-session"
					);
					const receipt = await getQuestionAnswerFallbackText(
						ctx.narratorId,
						result.record.answerMessageId,
					);
					if (receipt) {
						registerQuestionAnswerFallback(ctx.narratorId, result.record.answerMessageId);
						output = `<question_answer_fallback event="${result.record.answerMessageId}">\n${receipt}\n</question_answer_fallback>`;
					}
				}
				return {
					output,
					metadata: {
						kind: "await",
						awaitType: "question",
						targetId: id,
						targetLabel: result.record.questions[0]?.header ?? id,
						resolvedId: result.record.id,
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
			if (!task) {
				// A background transfer's alias is registered against the OWNING
				// `device_transfer_tasks` row, because that row is all the tool has when it
				// hands the work off (the `background_tasks` projection is created later, by
				// the runner, once the claim succeeds). So the id the model was handed lives
				// in a different id space than this table's primary key, and looking it up
				// as a projection id can only miss.
				//
				// Resolving through `transferTaskId` is what closes that gap. Without it
				// every `Await({type:"transfer"})` answers "not a valid background task ID"
				// for an id the tool itself told the model to use.
				task = await backgroundTaskService.getByTransferTaskId(taskId);
				if (task) taskId = task.id;
			}
			if (!task && taskId === id) {
				task = await backgroundTaskService.getByAlias(id, ctx.narratorId);
				if (task) taskId = task.id;
			}
			if (!task)
				return { output: `Error: "${id}" is not a valid background task ID.`, isError: true };
			// The requested type must match the row's. Both kinds wait on the same
			// mechanism (the lifecycle events are type-agnostic), but silently accepting
			// a mismatch would let `type: "bash"` "succeed" on a transfer and report a
			// bash-shaped result for it.
			if (task.type !== type) {
				return { output: `Error: "${id}" is a ${task.type} task, not ${type}.`, isError: true };
			}
			if (task.parentNarratorId !== ctx.narratorId) {
				return { output: `Error: "${id}" does not belong to this narrator.`, isError: true };
			}
			if (task.alias && task.id !== id) registerTaskAlias(ctx.narratorId, task.id, task.alias);

			// A PAUSED transfer answers immediately instead of waiting. Nothing is
			// running, so no lifecycle event is coming and the wait could only end in a
			// timeout — leaving the model with no idea why. Telling it the transfer is
			// paused lets it resume or give up.
			if (task.status === "paused") {
				const label = task.alias ?? taskId;
				return {
					output:
						`Task ${label} is PAUSED, not running: ${task.output ?? "no reason recorded"}\n\n` +
						`Resume it before awaiting again, or cancel it if it is no longer wanted.`,
					metadata: {
						kind: "await",
						awaitType: type,
						targetId: id,
						targetLabel: label,
						resolvedId: taskId,
						status: "paused",
					},
				};
			}

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
			if (type === "bash" && !combinedSignal.aborted) await consumeTerminalResult(result);
			// A bash task id is a nanoid too, so the alias is the readable handle. Bash
			// always registers one; if a row somehow lacks it, keep the full id rather
			// than inventing a prefix — unlike a subagent id, a task id is looked up by
			// exact match (`getById`/`getByAlias`), so a prefix would not resolve.
			const taskLabel = task.alias ?? taskId;
			return {
				output: formatResult(taskLabel, status, result.output),
				metadata: {
					kind: "await",
					awaitType: type,
					targetId: id,
					targetLabel: taskLabel,
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

/**
 * Wording for a `type: "question"` Await.
 *
 * A reliable inbox receipt is supplied at the next safe model turn, so Await returns
 * its reference rather than a second answer body. Legacy or failed scheduling keeps
 * the bounded answer fallback until that delivery contract has been established.
 */
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
				// Model-facing key is header; internal id / legacy question still appear
				// in older stored rows.
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
			return (
				`The wait for question ${questionId} timed out — only the wait ended, the question is ` +
				`still open and the user may still answer it. Use Question action=get for its current context; ` +
				`call Await again with the same id when that answer actually blocks your next step.`
			);
		case "aborted":
			return (
				`The wait for question ${questionId} was interrupted; the question remains stored. ` +
				`Use Question action=get to inspect its current status before deciding the next step.`
			);
		default:
			return `Question ${questionId} status: ${status}`;
	}
}

/**
 * Wording for a bash Await. `taskId` is the readable handle the model should
 * reuse as a selector (the task's alias when it has one), not the raw nanoid.
 */
export function formatResult(taskId: string, status: string, output: string | null): string {
	switch (status) {
		case "running":
		case "timeout":
			return (
				`Background task ${taskId} is still running — this wait timed out, not the task. ` +
				`Await again with the same id.` +
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
				`Wait interrupted; background task ${taskId} is still running. Await again with the same id.` +
				(output ? `\n\nPartial output so far:\n${output}` : "")
			);
		default:
			return `Background task ${taskId} status: ${status}`;
	}
}
