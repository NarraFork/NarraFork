import { type AgentConfig, agentGenerateWithMeta, agentLoop } from "../lib/agent";
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
	let interrupted = false;
	const skipInterruptionCheck =
		lastToolNames.length > 0 && lastToolNames.every((n) => n === "TodoWrite");
	if (
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
async function checkOutputInterruption(text: string, narratorId: string): Promise<boolean> {
	if (!text.trim()) {
		logger.info("Smart interruption check: empty output, marking as interrupted", {
			narratorId,
		});
		return true;
	}

	try {
		const systemPrompt =
			"You are an output completeness checker. " +
			"The user will provide the final assistant message from an AI coding session. " +
			"Determine if the message appears to have been cut off mid-sentence, mid-code-block, " +
			"or mid-thought (i.e. the output was interrupted/truncated before the assistant finished). " +
			"Reply with EXACTLY one word: pass (if the output looks complete) or retry (if it looks interrupted). " +
			"No explanation.";

		const snippet = text.length > 2000 ? text.slice(-2000) : text;
		const result = await agentGenerateWithMeta(snippet, settings.agent.summaryModel, systemPrompt);
		const verdict = result.text.trim().toLowerCase();

		if (verdict === "retry") {
			logger.info("Smart interruption check: summary model flagged as interrupted", {
				narratorId,
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
