import { type AgentConfig, agentLoop } from "../lib/agent";
import type { AgentEvent } from "../lib/agent/types";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { type EventHandlerContext, type EventHooks, processEvent } from "./narrator-event-handler";

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
	shouldUpdateTitle: boolean;
	/** Set when the API rejected the request because the context was too long. */
	contextLengthExceeded?: boolean;
	/** Set when the error is transient and the caller should retry after a delay. */
	retryableError?: string;
	retryableErrorCode?: string;
	/** Set when the provider rejected the request because the user's NUG balance is exhausted. */
	paymentRequired?: {
		message: string;
		providerId?: string;
		providerPrefix?: string;
		balance?: number;
		required?: number;
		resumeAction: "retry" | "continue";
	};
	/** Retry without applying the normal transient retry limit (e.g. Codex account failover). */
	bypassRetryLimit?: boolean;
	/** Upstream socket closed quietly and the turn should end without recovery/error UI. */
	silentDisconnect?: boolean;
	/** Set when the agent loop was aborted before the turn completed normally. */
	aborted?: boolean;
	/** Whether the completed turn included any tool call. */
	hadToolUses?: boolean;
	/** Set when the provider explicitly reports output was cut off by completion token limits. */
	interrupted?: boolean;
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
	const eventSource =
		sourceOptions?.eventSource ?? agentLoop(config, userText, history, trailingToolResults, images);
	const processEventFn = sourceOptions?.processEventFn ?? processEvent;

	let finalText = "";
	let hasError = false;
	let shouldUpdateTitle = false;
	let errorCode: string | undefined;
	let contextLengthExceeded = false;
	let retryableError: string | undefined;
	let retryableErrorCode: string | undefined;
	let paymentRequired: ExecuteLoopResult["paymentRequired"];
	let bypassRetryLimit = false;
	let silentDisconnect = false;
	let aborted = false;
	let interrupted = false;
	let maxTurnsExceeded = false;
	const startedWithToolResults = (trailingToolResults?.length ?? 0) > 0;
	let sawAssistantMessage = false;
	let lastAssistantHadToolUses = false;
	let hadToolUses = false;

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
		if (event.type === "context_length_exceeded") {
			contextLengthExceeded = true;
			break;
		}
		if (event.type === "retryable_error") {
			retryableError = event.message;
			retryableErrorCode = event.code;
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
		if (event.type === "output_truncated") {
			interrupted = true;
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
			}
			break;
		}
		if (event.type === "invalid_state") {
			finalText = `Error: ${event.message}`;
			hasError = true;
			errorCode = event.reason;
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
		shouldUpdateTitle,
		contextLengthExceeded,
		retryableError,
		retryableErrorCode,
		paymentRequired,
		bypassRetryLimit,
		silentDisconnect,
		aborted,
		hadToolUses,
		interrupted,
		maxTurnsExceeded,
		shouldReplayInterruptedToolResultTurn:
			lastAssistantHadToolUses || (startedWithToolResults && !sawAssistantMessage),
	};
}
