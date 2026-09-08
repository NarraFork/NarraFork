import { type AgentConfig, agentLoop } from "../lib/agent";
import type { AgentEvent, ApiRequestDiagnostics } from "../lib/agent/types";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { getAgentFileReferenceContext } from "./file-reference-context";
import {
	CriticalEventPersistenceError,
	type EventHandlerContext,
	type EventHooks,
	processEvent,
} from "./narrator-event-handler";

export interface ExecuteLoopOptions {
	config: AgentConfig;
	userText: string;
	history: unknown[];
	trailingToolResults?: unknown[];
	images?: Array<{ format: string; base64: string }>;
	eventContext: EventHandlerContext;
	hooks?: EventHooks;
}

export interface ExecuteLoopResult {
	finalText: string;
	hasError: boolean;
	errorCode?: string;
	errorDiagnostics?: ApiRequestDiagnostics;
	shouldUpdateTitle: boolean;
	/** Set when the API rejected the request because the context was too long. */
	contextLengthExceeded?: boolean;
	/** Set when the error is transient and the caller should retry after a delay. */
	retryableError?: string;
	retryableErrorCode?: string;
	retryableDiagnostics?: ApiRequestDiagnostics;
	/** Set when the provider rejected the request because the user's NUG balance is exhausted. */
	paymentRequired?: {
		message: string;
		providerId?: string;
		providerPrefix?: string;
		balance?: number;
		required?: number;
		resumeAction: "retry" | "continue";
	};
	/**
	 * Set when the requested NUG model is temporarily unavailable (its whole
	 * credential pool is disabled). The caller should suspend the turn and wait
	 * for the model to recover via the shared availability poller, then resume.
	 */
	modelUnavailable?: {
		message: string;
		provider: string;
		model: string;
		providerId?: string;
		providerPrefix?: string;
		nugModelId?: string;
		diagnostics?: ApiRequestDiagnostics;
	};
	/** Retry without applying the normal transient retry limit (e.g. Codex account failover). */
	bypassRetryLimit?: boolean;
	/** Upstream socket closed quietly and the turn should end without recovery/error UI. */
	silentDisconnect?: boolean;
	/** Set when the agent loop was aborted before the turn completed normally. */
	aborted?: boolean;
	/** Whether the completed turn included any tool call. */
	hadToolUses?: boolean;
	/** Stable fingerprint(s) for protected-task mutations rejected by taskReflection this pass. */
	taskReflectionDenialFingerprint?: string;
	/** Whether at least one provider assistant turn completed before this pass ended. */
	completedAssistantTurn?: boolean;
	/**
	 * Set when the agent loop ended because the model stopped calling tools — the
	 * loop's single `done` event. This is the authoritative "the work is finished"
	 * signal, and it is strictly stronger than `completedAssistantTurn` (which is
	 * true for any completed turn, including ones that ended mid-work with tool
	 * calls still pending).
	 *
	 * Callers that decide whether to drive another pass must consult this: an
	 * out-of-band event that landed during the final turn (e.g. a background
	 * compact completing) otherwise looks indistinguishable from "there is more
	 * work to do", and would produce an extra no-op request.
	 */
	completedNaturally?: boolean;
	/**
	 * Set when the provider explicitly reports output was cut off — either by
	 * completion token limits (`output_truncated`) or by a transient failure
	 * that occurred after partial output was already produced
	 * (`resumable_error`). See `interruptedReason` for which one.
	 */
	interrupted?: boolean;
	/**
	 * Distinguishes why `interrupted` was set, so the caller (narrator-session)
	 * can pick the right continuation prompt. Defaults to "completion_limit"
	 * for backward compatibility with existing callers that only checked
	 * `interrupted`.
	 */
	interruptedReason?: "completion_limit" | "resumable_error";
	/** Set when the agent loop exhausted its configured max-turn budget. */
	maxTurnsExceeded?: boolean;
	/** Replay the tool-result request packet instead of sending a textual continue prompt. */
	shouldReplayInterruptedToolResultTurn?: boolean;
}

interface ExecuteLoopSourceOptions {
	eventSource: AsyncIterable<AgentEvent>;
	processEventFn?: typeof processEvent;
}

/**
 * Run a single pass of the agent loop, consuming all events through the
 * unified event handler. Used by both main narrators and subagents.
 *
 * The main narrator wraps this in a while-loop for chained messages;
 * subagents call it once.
 */
export async function executeAgentLoop(
	options: ExecuteLoopOptions,
	sourceOptions?: ExecuteLoopSourceOptions,
): Promise<ExecuteLoopResult> {
	const { config, userText, history, trailingToolResults, images, eventContext, hooks } = options;
	config.requireToolCallBinding = true;
	eventContext.requireToolCallBinding = true;
	// Read the active pass's mutable default only when a new text block starts.
	// Rebind per pass: a reused event context must not close over an older config.
	eventContext.getFileReferenceContext = () => getAgentFileReferenceContext(config);
	const eventSource =
		sourceOptions?.eventSource ?? agentLoop(config, userText, history, trailingToolResults, images);
	const processEventFn = sourceOptions?.processEventFn ?? processEvent;

	let finalText = "";
	let hasError = false;
	let shouldUpdateTitle = false;
	let errorCode: string | undefined;
	let errorDiagnostics: ApiRequestDiagnostics | undefined;
	let contextLengthExceeded = false;
	let retryableError: string | undefined;
	let retryableErrorCode: string | undefined;
	let retryableDiagnostics: ApiRequestDiagnostics | undefined;
	let paymentRequired: ExecuteLoopResult["paymentRequired"];
	let modelUnavailable: ExecuteLoopResult["modelUnavailable"];
	let bypassRetryLimit = false;
	let silentDisconnect = false;
	let aborted = false;
	let interrupted = false;
	let interruptedReason: ExecuteLoopResult["interruptedReason"];
	let maxTurnsExceeded = false;
	const startedWithToolResults = (trailingToolResults?.length ?? 0) > 0;
	let sawAssistantMessage = false;
	let lastAssistantHadToolUses = false;
	let hadToolUses = false;
	let completedNaturally = false;
	const taskReflectionDenialFingerprints = new Set<string>();

	for await (const event of eventSource) {
		const drainingAfterAbort = config.signal.aborted;
		// When aborted, still drain the following events so:
		// - tool_result: status is persisted to the DB (running → success/fail)
		// - block_complete: the agent loop flushes accumulated text/reasoning as
		//   block_complete on abort (see loop.ts flushPartialContent). Text blocks
		//   are NOT persisted incrementally during streaming — they only live in
		//   memory until flushed at turn end — so dropping this event would lose any
		//   completed text/reasoning when the user interrupts mid-tool-call.
		// - error("Aborted"): onErrorCleanup is called to clean up orphaned tool calls
		// If we stop after the first post-abort event, pending-permission aborts and
		// long-running tools can leave the narrator stuck in thinking/waiting.
		if (
			drainingAfterAbort &&
			event.type !== "tool_result" &&
			event.type !== "block_complete" &&
			event.type !== "error"
		) {
			continue;
		}

		try {
			const result = await processEventFn(event, eventContext, hooks);
			if (result?.titleUpdate !== undefined) {
				shouldUpdateTitle = result.titleUpdate;
			}
		} catch (err) {
			logger.error("Event processing error", {
				narratorId: config.narratorId,
				eventType: event.type,
				error: String(err),
			});
			if (err instanceof CriticalEventPersistenceError) throw err;
			if (
				(event.type === "block_complete" && event.block.type === "tool_use") ||
				(event.type === "assistant_message" && event.toolUses.length > 0)
			) {
				throw new CriticalEventPersistenceError("Tool execution persistence barrier failed", {
					cause: err,
				});
			}
			// For critical events, notify frontend about persistence issues
			if (event.type === "block_complete" || event.type === "tool_result") {
				broadcastToNarrator(config.narratorId, {
					type: "warning",
					narratorId: config.narratorId,
					message: `Failed to persist ${event.type}: ${String(err)}`,
				});
			}
		}

		if (event.type === "assistant_message") {
			sawAssistantMessage = true;
			finalText = event.text || "";
			lastAssistantHadToolUses = event.toolUses.length > 0;
			hadToolUses = hadToolUses || event.toolUses.length > 0;
		}
		if (event.type === "tool_result") {
			const taskReflection = event.metadata?.taskReflection;
			if (taskReflection && typeof taskReflection === "object") {
				const decision = (taskReflection as { decision?: unknown }).decision;
				const fingerprint = (taskReflection as { fingerprint?: unknown }).fingerprint;
				if (decision === "revise" && typeof fingerprint === "string" && fingerprint) {
					taskReflectionDenialFingerprints.add(fingerprint);
				}
			}
		}
		if (event.type === "done") {
			// The loop emits `done` only when a turn produced no tool calls, i.e. the
			// model has nothing left to do. Recorded rather than `break`-ing so the
			// remaining events of this pass are still drained normally.
			completedNaturally = true;
		}
		if (event.type === "context_length_exceeded") {
			contextLengthExceeded = true;
			break;
		}
		if (event.type === "retryable_error") {
			retryableError = event.message;
			retryableErrorCode = event.code;
			retryableDiagnostics = event.diagnostics;
			bypassRetryLimit = event.bypassRetryLimit === true;
			break;
		}
		if (event.type === "payment_required") {
			paymentRequired = {
				message: event.message,
				providerId: event.providerId,
				providerPrefix: event.providerPrefix,
				balance: event.balance,
				required: event.required,
				resumeAction: event.resumeAction,
			};
			break;
		}
		if (event.type === "model_unavailable") {
			modelUnavailable = {
				message: event.message,
				provider: event.provider,
				model: event.model,
				providerId: event.providerId,
				providerPrefix: event.providerPrefix,
				nugModelId: event.nugModelId,
				diagnostics: event.diagnostics,
			};
			break;
		}
		if (event.type === "output_truncated") {
			interrupted = true;
			interruptedReason = "completion_limit";
		}
		if (event.type === "resumable_error") {
			// The loop already flushed the partial output via block_complete and
			// finalized the api_request record — this pass ends normally (like
			// output_truncated) so the caller can append a continuation turn.
			interrupted = true;
			interruptedReason = "resumable_error";
			break;
		}
		if (event.type === "max_turns_exceeded") {
			maxTurnsExceeded = true;
			finalText = `Error: Max turns (${event.maxTurns}) exceeded`;
			hasError = true;
			break;
		}
		if (event.type === "silent_disconnect") {
			silentDisconnect = true;
			break;
		}
		if (event.type === "error") {
			if (event.message === "Aborted") {
				aborted = true;
			} else {
				finalText = `Error: ${event.message}`;
				hasError = true;
				errorDiagnostics = event.diagnostics;
			}
			break;
		}
		if (event.type === "invalid_state") {
			finalText = `Error: ${event.message}`;
			hasError = true;
			errorCode = event.reason;
			errorDiagnostics = event.diagnostics;
			break;
		}
	}

	// If the stream ended while the abort signal was set, surface that to the caller
	// so narrator-session can force interrupted cleanup instead of incorrectly
	// continuing into buffered-message / done handling.
	if (config.signal.aborted) {
		aborted = true;
	}

	return {
		finalText,
		hasError,
		errorCode,
		errorDiagnostics,
		shouldUpdateTitle,
		contextLengthExceeded,
		retryableError,
		retryableErrorCode,
		retryableDiagnostics,
		paymentRequired,
		modelUnavailable,
		bypassRetryLimit,
		silentDisconnect,
		aborted,
		hadToolUses,
		taskReflectionDenialFingerprint:
			taskReflectionDenialFingerprints.size > 0
				? [...taskReflectionDenialFingerprints].sort().join("\n")
				: undefined,
		completedAssistantTurn: sawAssistantMessage,
		// An aborted pass never counts as a natural completion, even if `done` was
		// observed while draining post-abort events.
		completedNaturally: completedNaturally && !aborted,
		interrupted,
		interruptedReason,
		maxTurnsExceeded,
		shouldReplayInterruptedToolResultTurn:
			lastAssistantHadToolUses || (startedWithToolResults && !sawAssistantMessage),
	};
}
