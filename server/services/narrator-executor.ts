import { type AgentConfig, agentLoop, summaryGenerate } from "../lib/agent";
import type { AgentEvent } from "../lib/agent/types";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
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
	/** Set when smart interruption check detected the output was cut off. */
	interrupted?: boolean;
	/** Upstream socket closed quietly and the turn should end without recovery/error UI. */
	silentDisconnect?: boolean;
	/** Set when the agent loop was aborted before the turn completed normally. */
	aborted?: boolean;
	/** Whether the completed turn included any tool call. */
	hadToolUses?: boolean;

	/**
	 * When true, the interrupted turn should be resumed by replaying the
	 * trailing tool-result request packet instead of sending a textual
	 * "continue" prompt.
	 */
	shouldReplayInterruptedToolResultTurn?: boolean;
}

interface ExecuteLoopSourceOptions {
	eventSource: AsyncIterable<AgentEvent>;
	processEventFn?: typeof processEvent;
}

function isMeaningfulAssistantOutputEvent(event: AgentEvent): boolean {
	switch (event.type) {
		case "assistant_message":
			return Boolean(event.text.trim() || event.toolUses.length > 0);
		case "stream_text":
			return Boolean(event.text.trim());
		case "tool_use_chunk":
		case "block_complete":
		case "web_search":
		case "image_generation":
			return true;
		case "stream_reasoning":
			return Boolean(event.text.trim() || event.providerMetadata);
		default:
			return false;
	}
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
	let lastToolNames: string[] = [];
	let interrupted = false;
	let silentDisconnect = false;
	let aborted = false;
	const startedWithToolResults = (trailingToolResults?.length ?? 0) > 0;
	let sawAssistantMessage = false;
	let sawMeaningfulAssistantOutput = false;
	let sawCompletedImageGeneration = false;
	let lastAssistantHadToolUses = false;
	let hadToolUses = false;

	for await (const event of eventSource) {
		if (isMeaningfulAssistantOutputEvent(event)) {
			sawMeaningfulAssistantOutput = true;
		}
		// Only count image generation as "completed" when the final block_complete
		// event arrives with an actual result payload. The lifecycle event
		// (type === "image_generation", status === "completed") fires before the
		// output_item.done that carries the base64 data, so relying on it would
		// skip the interruption check even when the image was never persisted.
		if (
			event.type === "block_complete" &&
			event.block.type === "image_generation" &&
			event.block.result
		) {
			sawCompletedImageGeneration = true;
		}

		const drainingAfterAbort = config.signal.aborted;
		// When aborted, still drain tool_result and error events so:
		// - tool_result: status is persisted to the DB (running → success/fail)
		// - error("Aborted"): onErrorCleanup is called to clean up orphaned tool calls
		// If we stop after the first post-abort event, pending-permission aborts and
		// long-running tools can leave the narrator stuck in thinking/waiting.
		if (drainingAfterAbort && event.type !== "tool_result" && event.type !== "error") {
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
			lastToolNames = event.toolUses.map((tu) => tu.name);
			lastAssistantHadToolUses = event.toolUses.length > 0;
			hadToolUses = hadToolUses || event.toolUses.length > 0;
		}
		if (event.type === "context_length_exceeded") {
			contextLengthExceeded = true;
			break;
		}
		if (event.type === "retryable_error") {
			retryableError = event.message;
			break;
		}
		if (event.type === "output_truncated") {
			// Provider confirmed the output was cut off by max_tokens —
			// mark as interrupted directly, no need for AI judgement.
			interrupted = true;
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

	// Smart interruption check: detect truncated output and flag for auto-continue.
	// Skip when the previous assistant turn only called TodoWrite — that's a normal
	// end-of-session pattern where the model updates todos and stops.
	// Also skip when already flagged by output_truncated (provider-confirmed truncation).
	const skipInterruptionCheck =
		lastToolNames.length > 0 && lastToolNames.every((n) => n === "TaskCreate");
	if (
		!interrupted &&
		!silentDisconnect &&
		settings.agent.smartInterruptionCheck &&
		!hasError &&
		!contextLengthExceeded &&
		!retryableError &&
		!config.signal.aborted &&
		!skipInterruptionCheck &&
		!(sawCompletedImageGeneration && !finalText.trim()) &&
		sawMeaningfulAssistantOutput
	) {
		interrupted = await checkOutputInterruption(finalText, config.narratorId, config.signal);
	}

	return {
		finalText,
		hasError,
		errorCode,
		shouldUpdateTitle,
		contextLengthExceeded,
		retryableError,
		interrupted,
		silentDisconnect,
		aborted,
		hadToolUses,
		shouldReplayInterruptedToolResultTurn:
			lastAssistantHadToolUses || (startedWithToolResults && !sawAssistantMessage),
	};
}

/**
 * Check whether the assistant's final output was interrupted/truncated.
 *
 * 1. No content at all → definitely interrupted.
 * 2. Has content → ask the summary model to judge (reply "pass" or "retry").
 */
/**
 * Heuristic pre-check: if the tail of the text ends in a way that is
 * obviously complete, skip the expensive model call entirely.
 */
function looksCompleteByHeuristic(text: string): boolean {
	const tail = text.trimEnd();
	if (!tail) return false;

	// Ends with sentence-ending punctuation (including CJK)
	if (/[.!?。！？…)）】》」』\]"']$/.test(tail)) return true;

	// Ends with a closed markdown code block
	if (/```\s*$/.test(tail)) return true;

	return false;
}

async function checkOutputInterruption(
	text: string,
	narratorId: string,
	signal: AbortSignal,
): Promise<boolean> {
	if (!text.trim()) {
		logger.info("Smart interruption check: empty output, marking as interrupted", {
			narratorId,
		});
		return true;
	}

	// Fast path: obviously complete endings don't need a model call
	if (looksCompleteByHeuristic(text)) {
		return false;
	}

	// Abort check before expensive model call
	if (signal.aborted) return false;

	// Notify frontend that we're running the interruption check
	broadcastToNarrator(narratorId, { type: "interrupt_checking", narratorId });

	try {
		const systemPrompt =
			"You judge whether an AI assistant's message was CUT OFF mid-stream (network/token limit).\n" +
			"You receive only the last ~500 chars. Focus EXCLUSIVELY on the final line.\n\n" +
			"Reply 'retry' ONLY if the text ends mid-word, mid-sentence without punctuation, " +
			"or inside an unclosed ``` code block.\n" +
			"Reply 'pass' for everything else — including short, abrupt, or incomplete-looking answers " +
			"that still end on a grammatical boundary.\n\n" +
			"One word only: pass or retry.";

		const snippet = text.slice(-500);

		// Race summaryGenerate against a 15 s timeout *and* the abort signal.
		// Without this, a hanging fetch inside the summary model call would
		// permanently block the narrator in "thinking" state — the user could
		// neither send messages nor interrupt.
		const CHECK_TIMEOUT_MS = 15_000;

		const summaryPromise = summaryGenerate(snippet, systemPrompt, {
			narratorId,
			kind: "internal",
		});
		const cancelPromise = new Promise<null>((resolve) => {
			const onAbort = () => resolve(null);
			signal.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(null);
			}, CHECK_TIMEOUT_MS);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
		});

		const raceResult = await Promise.race([summaryPromise, cancelPromise]);

		if (raceResult === null) {
			// Timed out or aborted — treat as "not interrupted" so the outer
			// loop finishes normally (or handles abort on its own).
			broadcastToNarrator(narratorId, { type: "interrupt_check_done", narratorId });
			if (signal.aborted) {
				logger.info("Smart interruption check: aborted by user", { narratorId });
			} else {
				logger.warn("Smart interruption check: timed out, skipping", {
					narratorId,
					timeoutMs: CHECK_TIMEOUT_MS,
				});
			}
			return false;
		}

		const verdict = raceResult.text.trim().toLowerCase();

		broadcastToNarrator(narratorId, { type: "interrupt_check_done", narratorId });

		if (verdict === "retry") {
			logger.info("Smart interruption check: summary model flagged as interrupted", {
				narratorId,
				tail: text.slice(-100),
			});
			return true;
		}

		return false;
	} catch (err) {
		broadcastToNarrator(narratorId, { type: "interrupt_check_done", narratorId });
		logger.error("Smart interruption check failed, skipping", {
			narratorId,
			error: String(err),
		});
		return false;
	}
}
