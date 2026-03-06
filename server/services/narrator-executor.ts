import { type AgentConfig, agentLoop } from "../lib/agent";
import { logger } from "../lib/logger";
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

	for await (const event of agentLoop(config, userText, history, trailingToolResults, images)) {
		if (config.signal.aborted) break;

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
		}

		if (event.type === "assistant_message") {
			finalText = event.text || "";
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

	return { finalText, hasError, shouldUpdateTitle, contextLengthExceeded, retryableError };
}
