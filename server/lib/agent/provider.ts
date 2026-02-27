import { getOpenaiProviderConfig } from "../settings";
import { OpenAIProvider } from "./openai-provider";
import type { AgentToolUse } from "./types";

// === Provider-agnostic DB types (used by buildHistory) ===

export interface DbMessage {
	id: string;
	role: "user" | "assistant" | "system";
	contentJson: unknown;
	contentText: string | null;
	parentToolUseId: string | null;
	messageUuid: string | null;
	toolCalls?: DbToolCall[];
}

export interface DbToolCall {
	toolUseId: string;
	toolName: string;
	inputJson: unknown;
	outputJson: unknown;
	status: string;
}

// === Stream event emitted by provider.chat() ===

export interface ParsedStreamEvent {
	text?: string;
	toolUses?: AgentToolUse[];
	messageId?: string;
	conversationId?: string;
	reasoning?: string;
	contextUsagePercentage?: number;
	metering?: { unit: string; unitPlural: string; usage: number };
	invalidState?: { reason: string; message: string };
	/** Streaming tool use chunk — accumulated by the loop */
	toolUseChunk?: {
		toolUseId: string;
		name?: string;
		input?: string;
		stop?: boolean;
	};
	/** Token usage info from OpenAI-compatible APIs (used to compute context usage %) */
	usage?: { promptTokens: number; completionTokens?: number };
	/** Internal: set when Responses API format is detected from the gateway */
	_responsesApi?: boolean;
}

// === Chat parameters passed to provider.chat() ===

export interface ChatParams {
	conversationId: string;
	content: string;
	model: string;
	cwd: string;
	history: unknown[];
	tools: unknown[];
	toolResults: unknown[];
	signal: AbortSignal;
	/** Base64-encoded images to attach to the current user message */
	images?: Array<{ format: string; base64: string }>;
}

// === The adapter interface ===

export interface ProviderAdapter {
	/** Convert ToolDefinition[] to provider-specific tool format */
	formatTools(tools: import("./types").ToolDefinition[]): unknown[];

	/** Convert DB messages to provider history + trailing tool results */
	buildHistory(
		dbMessages: DbMessage[],
		model: string,
		narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }>;

	/** Inject system prompt into the history array (mutates in place) */
	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		model: string,
		locale?: string,
	): void;

	/** Stream a chat completion, yielding parsed events */
	chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent>;

	/** Format a single tool result for the provider protocol */
	formatToolResult(toolUseId: string, output: string, isError: boolean): unknown;

	/** Append a user turn to history (mutates in place) */
	pushUserTurn(history: unknown[], content: string, model: string, toolResults: unknown[]): void;

	/** Append an assistant turn to history (mutates in place) */
	pushAssistantTurn(history: unknown[], text: string, toolUses: AgentToolUse[]): void;

	/** Simple text generation — no tools, no loop. Returns generated text. */
	generate(text: string, model: string): Promise<string>;

	/** Like generate() but also returns contextUsagePercentage if available. */
	generateWithMeta(text: string, model: string): Promise<{ text: string; contextPercent?: number }>;

	/**
	 * Generate text using a history-based conversation (system instruction + user content).
	 * Used for title generation where we need to separate instruction from content.
	 */
	generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string>;
}

// === Provider resolution ===

export function getProvider(provider: string): ProviderAdapter {
		const config = getOpenaiProviderConfig(provider);
		if (config) {
			return new OpenAIProvider(config);
		}
	}
}
