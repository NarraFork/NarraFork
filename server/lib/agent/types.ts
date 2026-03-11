import type { z } from "zod/v4";

// === API error with HTTP status ===

/**
 * Error thrown by provider adapters when the upstream API returns a non-OK
 * HTTP response.  Carries the numeric `status` so that `isRetryableError()`
 * in the agent loop can inspect it without parsing the message string.
 */
export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

// === Tool system ===

export interface ToolContext {
	narratorId: string;
	cwd: string;
	signal: AbortSignal;
	/** Locale for i18n of tool outputs */
	locale: string;
	/** Plan file ID — set during plan mode, used by ExitPlanMode to locate the plan file */
	planFileId?: string;
	/** Skill scan root — project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Request permission from the user. Returns true if allowed. */
	requestPermission: (
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
	) => Promise<PermissionResult>;
	/** Emit progress updates for long-running tools */
	emitProgress?: (toolUseId: string, elapsed: number) => void;
	/** Emit real-time output for streaming tool results (e.g. bash). Receives cumulative output. */
	emitOutput?: (output: string) => void;
	/** Emit a long-running process notification (≥60s). UI can show a terminate button. */
	emitLongRunning?: (toolUseId: string, elapsed: number) => void;
	/** The toolUseId of the current tool execution (set by executeTool) */
	currentToolUseId?: string;
}

export interface ToolResult {
	output: string;
	isError?: boolean;
	title?: string;
	metadata?: Record<string, unknown>;
	/** When true the output was already truncated by the tool itself — loop layer should skip re-truncation. */
	truncated?: boolean;
	/** When true the error is unrecoverable — the agent loop should stop immediately without further tool calls. */
	fatal?: boolean;
}

export interface ToolDefinition {
	name: string;
	description: string | ((config: AgentConfig) => string);
	parameters: z.ZodType;
	/** Pre-built JSON Schema to send to providers, bypassing zodToJsonSchema conversion.
	 *  Used by MCP tools to preserve the original inputSchema without lossy Zod round-tripping. */
	rawJsonSchema?: Record<string, unknown>;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
	/** If provided, tool is only included when this returns true */
	isAvailable?: () => boolean;
}

/** ToolDefinition with description resolved to a plain string (after dynamic evaluation) */
export type ResolvedToolDefinition = ToolDefinition & { description: string };

// === Permission ===

export type PermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown> }
	| {
			behavior: "deny";
			message?: string;
			fatal?: boolean;
			/** When true, `message` is already a complete user-facing string — skip wrapping. */
			rawMessage?: boolean;
	  };

// === Agent events (yielded by the loop) ===

export type AgentEvent =
	| {
			type: "assistant_message";
			text: string;
			toolUses: AgentToolUse[];
			messageId?: string;
	  }
	| { type: "stream_text"; text: string }
	| {
			type: "tool_call";
			toolUseId: string;
			toolName: string;
			input: Record<string, unknown>;
			streamStartedAt?: number;
	  }
	| {
			type: "tool_result";
			toolUseId: string;
			toolName: string;
			output: string;
			isError: boolean;
			durationMs: number;
			/** When set, the tool call input was broken (output truncated mid-stream).
			 *  The event handler should overwrite the persisted inputJson with this value. */
			brokenInputOverride?: Record<string, unknown>;
			/** Updated input to display in the UI (for broken calls, the sanitized version). */
			updatedInput?: Record<string, unknown>;
			/** Optional metadata from the tool (e.g. line numbers for Edit). */
			metadata?: Record<string, unknown>;
	  }
	| { type: "tool_progress"; toolUseId: string; elapsed: number }
	| { type: "tool_output"; toolUseId: string; output: string }
	// 由 bash 工具看门狗在进程运行 ≥60s 时触发，经 event-handler → WS 推送到前端显示终止按钮
	| { type: "tool_long_running"; toolUseId: string; elapsed: number }
	| {
			type: "tool_use_chunk";
			toolUseId: string;
			toolName: string;
			inputCharsTotal: number;
			/** For Write/Edit tools: extracted file path from the JSON */
			extractedFilePath?: string;
			/** For Write/Edit tools: content chars received (excluding file_path field) */
			contentCharsReceived?: number;
	  }
	| {
			/** A single content block has been fully streamed and is ready for persistence / execution. */
			type: "block_complete";
			block: ContentBlock;
	  }
	| { type: "turn_complete"; turnIndex: number }
	| { type: "error"; message: string }
	| { type: "retryable_error"; message: string }
	| { type: "context_length_exceeded"; message: string }
	| { type: "stream_reasoning"; text: string; providerMetadata?: ReasoningProviderMetadata }
	| {
			type: "context_usage";
			percentage: number;
			promptTokens?: number;
			completionTokens?: number;
			reasoningTokens?: number;
			cachedInputTokens?: number;
			contextWindow?: number;
	  }
	| { type: "metering"; unit: string; unitPlural: string; usage: number; credentialId?: string }
	| { type: "invalid_state"; reason: string; message: string }
	| {
			type: "web_search";
			id: string;
			status: "in_progress" | "searching" | "completed";
			query?: string;
			queries?: string[];
	  }
	| { type: "done" };

export interface AgentToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
	/** Timestamp (ms) when the first streaming chunk for this tool use arrived */
	streamStartedAt?: number;
}

/** Provider-specific metadata attached to reasoning blocks for continuation support. */
export interface ReasoningProviderMetadata {
	openai?: {
		/** The reasoning item ID from the Responses API */
		itemId?: string;
		/** Encrypted reasoning content for continuation across turns */
		reasoningEncryptedContent?: string | null;
	};
}

/** A fully-streamed content block within an assistant message. */
export type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "reasoning";
			text: string;
			translatedText?: string;
			providerMetadata?: ReasoningProviderMetadata;
	  }
	| {
			type: "tool_use";
			toolUseId: string;
			name: string;
			input: Record<string, unknown>;
			streamStartedAt?: number;
	  }
	| {
			type: "web_search";
			id: string;
			query?: string;
			queries?: string[];
	  };

// === Plan mode constants ===

/** Tools allowed during plan mode. Everything else is auto-denied or description-overridden. */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
	"Read",
	"Write",
	"Edit",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"EnterPlanMode",
	"ExitPlanMode",
	"Bash",
	"Shell",
	"Task",
	"ContinueTask",
	"CheckBackgroundTask",
	"CancelBackgroundTask",
	"AskUserQuestion",
	"Skill",
]);

// === Agent config ===

export interface AgentConfig {
	narratorId: string;
	conversationId: string;
	model: string;
	provider: string;
	cwd: string;
	systemPrompt?: string;
	locale?: string;
	signal: AbortSignal;
	maxTurns?: number;
	planMode?: boolean;
	/** When true, plan mode does NOT disable tool descriptions — tools remain fully available */
	relaxedPlan?: boolean;
	/** Plan file ID — set during plan mode for Write/Edit redirection and ExitPlanMode */
	planFileId?: string;
	/** Skill scan root — project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Reasoning effort for Codex-mode providers (low, medium, high, xhigh) */
	reasoningEffort?: "low" | "medium" | "high" | "xhigh";
	/** Service tier for Codex-mode providers — "priority" enables fast mode */
	serviceTier?: string;
	/** Filter tools available to this agent (subagent tool restriction) */
	toolFilter?: (tool: ToolDefinition) => boolean;
	permissionHandler: (
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
	) => Promise<PermissionResult>;
	onEvent?: (event: AgentEvent) => void;
	/**
	 * Called before each non-first turn in the agent loop.
	 * If it returns a new history + pendingToolResults, the loop replaces its
	 * internal state — used for mid-turn context pruning.
	 */
	onBeforeTurn?: (turnIndex: number) => Promise<{
		history: unknown[];
		pendingToolResults: unknown[];
	} | null>;
	/**
	 * Called after tool execution to check if external code (e.g. onExitPlanMode)
	 * wants to inject text into the next user turn alongside tool results.
	 * The returned string is used as the user-text portion of pushUserTurn.
	 * Consumed once per call (caller should clear after returning).
	 */
	getInjectedUserText?: () => string | null;
}
