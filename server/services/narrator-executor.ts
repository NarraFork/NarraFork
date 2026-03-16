import { type AgentConfig, agentLoop, summaryGenerate } from "../lib/agent";
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
	shouldUpdateTitle: boolean;
	/** Set when the API rejected the request because the context was too long. */
	contextLengthExceeded?: boolean;
	/** Set when the error is transient and the caller should retry after a delay. */
	retryableError?: string;
	/** Set when smart interruption check detected the output was cut off. */
	interrupted?: boolean;
}

/**
 * Run a single pass of the agent loop, consuming all events through the
 * unified event handler. Used by both main narrators and subagents.
 *
 * The main narrator wraps this in a while-loop for chained messages;
 * subagents call it once.
 */
export async function executeAgentLoop(options: ExecuteLoopOptions): Promise<ExecuteLoopResult> {
	const { config, userText, history, trailingToolResults, images, eventContext, hooks } = options;

	let finalText = "";
	let hasError = false;
	let shouldUpdateTitle = false;
	let contextLengthExceeded = false;
	let retryableError: string | undefined;
	let lastToolNames: string[] = [];
	let interrupted = false;

	for await (const event of agentLoop(config, userText, history, trailingToolResults, images)) {
		// When aborted, still process tool_result and error events so:
		// - tool_result: status is persisted to the DB (running → success/fail)
		// - error("Aborted"): onErrorCleanup is called to clean up orphaned tool calls
		// Without this, tools that finished executing after the abort signal would
		// stay "running" forever, and orphaned tool calls would never be cleaned up.
		if (config.signal.aborted && event.type !== "tool_result" && event.type !== "error") break;

		try {
			const result = await processEvent(event, eventContext, hooks);
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

		// After processing a tool_result or error under abort, stop consuming further events.
		if (config.signal.aborted) break;

		if (event.type === "assistant_message") {
			finalText = event.text || "";
			lastToolNames = event.toolUses.map((tu) => tu.name);
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
		if (event.type === "error") {
			if (event.message !== "Aborted") {
				finalText = `Error: ${event.message}`;
				hasError = true;
			}
			break;
		}
		if (event.type === "invalid_state") {
			finalText = `Error: ${event.message}`;
			hasError = true;
			break;
		}
	}

	// Smart interruption check: detect truncated output and flag for auto-continue.
	// Skip when the previous assistant turn only called TodoWrite — that's a normal
	// end-of-session pattern where the model updates todos and stops.
	// Also skip when already flagged by output_truncated (provider-confirmed truncation).
	const skipInterruptionCheck =
		lastToolNames.length > 0 && lastToolNames.every((n) => n === "TaskCreate");
	if (
		!interrupted &&
		settings.agent.smartInterruptionCheck &&
		!hasError &&
		!contextLengthExceeded &&
		!retryableError &&
		!config.signal.aborted &&
		!skipInterruptionCheck
	) {
		interrupted = await checkOutputInterruption(finalText, config.narratorId);
	}

	return {
		finalText,
		hasError,
		shouldUpdateTitle,
		contextLengthExceeded,
		retryableError,
		interrupted,
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

async function checkOutputInterruption(text: string, narratorId: string): Promise<boolean> {
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
		const result = await summaryGenerate(snippet, systemPrompt);
		const verdict = result.text.trim().toLowerCase();

		if (verdict === "retry") {
			logger.info("Smart interruption check: summary model flagged as interrupted", {
				narratorId,
				tail: text.slice(-100),
			});
			return true;
		}

		return false;
	} catch (err) {
		logger.error("Smart interruption check failed, skipping", {
			narratorId,
			error: String(err),
		});
		return false;
	}
}
