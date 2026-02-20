import { OpenAIProvider } from "./openai-provider";
import type { AgentToolUse } from "./types";

// === Provider-agnostic DB types (used by buildHistory) ===

export interface DbMessage {
	id: string;
	role: "user" | "assistant" | "system";
	contentJson: unknown;
	contentText: string | null;
	parentToolUseId: string | null;
	sdkMessageUuid: string | null;
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
}

// === The adapter interface ===

export interface ProviderAdapter {
	/** Convert ToolDefinition[] to provider-specific tool format */
	formatTools(tools: import("./types").ToolDefinition[]): unknown[];

	/** Convert DB messages to provider history + trailing tool results */
	buildHistory(
		dbMessages: DbMessage[],
		model: string,
	): { history: unknown[]; trailingToolResults: unknown[] };

	/** Inject system prompt into the history array (mutates in place) */
	injectSystemPrompt(history: unknown[], systemPrompt: string, model: string): void;

	/** Stream a chat completion, yielding parsed events */
	chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent>;

	/** Format a single tool result for the provider protocol */
	formatToolResult(toolUseId: string, output: string, isError: boolean): unknown;

	/** Append a user turn to history (mutates in place) */
	pushUserTurn(history: unknown[], content: string, model: string, toolResults: unknown[]): void;

	/** Append an assistant turn to history (mutates in place) */
	pushAssistantTurn(history: unknown[], text: string, toolUses: AgentToolUse[]): void;
}

// === Provider resolution ===

export function getProvider(provider: string): ProviderAdapter {
	if (provider === "openai") {
		return new OpenAIProvider();
	}
}
