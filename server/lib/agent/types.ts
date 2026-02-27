import type { z } from "zod/v4";

// === Tool system ===

export interface ToolContext {
	narratorId: string;
	cwd: string;
	signal: AbortSignal;
	/** Locale for i18n of tool outputs */
	locale: string;
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
	description: string;
	parameters: z.ZodType;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
	/** If provided, tool is only included when this returns true */
	isAvailable?: () => boolean;
}

// === Permission ===

export type PermissionResult =
	| { behavior: "allow"; updatedInput?: Record<string, unknown> }
	| { behavior: "deny"; message?: string; fatal?: boolean };

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
	  }
	| { type: "tool_progress"; toolUseId: string; elapsed: number }
	| { type: "tool_output"; toolUseId: string; output: string }
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
	| { type: "stream_reasoning"; text: string }
	| { type: "context_usage"; percentage: number }
	| { type: "metering"; unit: string; unitPlural: string; usage: number }
	| { type: "invalid_state"; reason: string; message: string }
	| { type: "done" };

export interface AgentToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
	/** Timestamp (ms) when the first streaming chunk for this tool use arrived */
	streamStartedAt?: number;
}

/** A fully-streamed content block within an assistant message. */
export type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "tool_use";
			toolUseId: string;
			name: string;
			input: Record<string, unknown>;
			streamStartedAt?: number;
	  };

// === Plan mode constants ===

/** Tools allowed during plan mode. Everything else is auto-denied or description-overridden. */
export const PLAN_MODE_ALLOWED_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"EnterPlanMode",
	"ExitPlanMode",
	"Bash",
	"Task",
	"ContinueTask",
	"AskUserQuestion",
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
