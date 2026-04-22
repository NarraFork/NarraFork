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
	/** Chapter ID the narrator belongs to (cached to avoid repeated DB lookups) */
	chapterId?: string;
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
	/** Base64-encoded images to include in the tool result (for multimodal providers). */
	images?: Array<{ format: string; base64: string }>;
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
	| {
			behavior: "allow";
			updatedInput?: Record<string, unknown>;
			/** Optional notice appended to the tool output (e.g. plan-mode file redirect). */
			notice?: string;
	  }
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
			credentialId?: string;
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
			durationMs?: number;
			brokenInputOverride?: Record<string, unknown>;
			updatedInput?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	| { type: "tool_progress"; toolUseId: string; elapsed: number }
	| { type: "tool_output"; toolUseId: string; output: string }
	// Watchdog notification: tool has been running for ≥60s
	| { type: "tool_long_running"; toolUseId: string; elapsed: number }
	| {
			type: "tool_use_chunk";
			toolUseId: string;
			toolName: string;
			inputCharsTotal: number;
			extractedFilePath?: string;
			contentCharsReceived?: number;
			extractedFields?: Record<string, string>;
			/** Incremental delta of the large streaming field (content, command, prompt, etc.) */
			streamingField?: { name: string; delta: string };
	  }
	| {
			type: "block_complete";
			block: ContentBlock;
	  }
	| { type: "turn_complete"; turnIndex: number }
	| { type: "error"; message: string }
	| { type: "retryable_error"; message: string }
	| {
			type: "retrying";
			message: string;
			attempt: number;
			maxRetries: number;
			delayMs: number;
	  }
	| { type: "context_length_exceeded"; message: string }
	| {
			type: "stream_reasoning";
			text: string;
			providerMetadata?: ReasoningProviderMetadata;
			outputIndex?: number;
	  }
	| {
			type: "context_usage";
			percentage: number;
			promptTokens?: number;
			inputTokens?: number;
			completionTokens?: number;
			reasoningTokens?: number;
			cachedInputTokens?: number;
			cacheCreationInputTokens?: number;
			cacheCreation5mTokens?: number;
			cacheCreation1hTokens?: number;
			contextWindow?: number;
			isEstimated?: boolean;
	  }
	| { type: "metering"; unit: string; unitPlural: string; usage: number; credentialId?: string }
	| { type: "queue_status"; position: number; queueDepth: number }
	| { type: "quota_balance"; quotaBalance: string | null }
	| { type: "invalid_state"; reason: string; message: string }
	| { type: "output_truncated"; message: string }
	| {
			type: "web_search";
			id: string;
			status: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
	  }
	| { type: "model_switched"; model: string; provider: string }
	| {
			type: "api_request_start";
			requestId: string;
			provider: string;
			model: string;
			credentialId?: string;
	  }
	| {
			type: "api_request_end";
			requestId: string;
			credentialId?: string;
			usage?: {
				promptTokens?: number;
				inputTokens?: number;
				completionTokens?: number;
				reasoningTokens?: number;
				cachedInputTokens?: number;
				cacheCreationInputTokens?: number;
				cacheCreation5mTokens?: number;
				cacheCreation1hTokens?: number;
			};
			ttftMs?: number;
			durationMs?: number;
			contextPercent?: number;
			meterUsage?: number;
			meterUnit?: string;
			rawDump?: unknown;
	  }
	| { type: "silent_disconnect" }
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
	anthropic?: {
		/** Signature for thinking block verification (must be echoed back in subsequent turns) */
		signature?: string;
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
			outputIndex?: number;
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
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
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
	"WebFetch",
	"TaskCreate",
	"EnterPlanMode",
	"ExitPlanMode",
	"Bash",
	"Shell",
	"Agent",
	"ContinueTask",
	"TaskOutput",
	"TaskStop",
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
	/** Chapter ID the narrator belongs to (passed through to ToolContext) */
	chapterId?: string;
	maxTurns?: number;
	planMode?: boolean;
	/** When true, plan mode does NOT disable tool descriptions — tools remain fully available */
	relaxedPlan?: boolean;
	/** Plan file ID — set during plan mode for Write/Edit validation and ExitPlanMode */
	planFileId?: string;
	/** Skill scan root — project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Reasoning effort — maps to thinking config (Anthropic) or reasoning config (Codex) */
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
	/** Service tier for Codex-mode providers — "priority" enables fast mode */
	serviceTier?: string;
	/** Metadata sent with API requests (e.g. Anthropic metadata.user_id) */
	metadata?: { user_id: string };
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
		systemPrompt?: string;
	} | null>;
	/**
	 * Called after tool execution to check if external code (e.g. onExitPlanMode)
	 * wants to inject text into the next user turn alongside tool results.
	 * The returned string is used as the user-text portion of pushUserTurn.
	 * Consumed once per call (caller should clear after returning).
	 */
	getInjectedUserText?: () => string | null;
	/**
	 * Called before each non-first turn to check if the model should be switched.
	 * When a new model is returned, the loop re-resolves the provider and rebuilds
	 * history/tools if the provider changed.
	 */
	getModelOverride?: () => string | null;
	/**
	 * Called after all tools in a turn complete. If returns true, the loop
	 * exits gracefully without aborting running processes — used by feedback
	 * injection to stop after the current tool finishes.
	 */
	shouldStop?: () => boolean;
	/**
	 * Maximum number of transient-error retries within a single provider.chat()
	 * call.  When exceeded the loop yields `retryable_error` and returns.
	 * Defaults to 0 (no in-loop retry — caller handles it).
	 */
	maxTransientRetries?: number;
	/**
	 * Maximum backoff delay (ms) for transient-error retries.
	 * Exponential backoff is capped at this value.  Defaults to 20_000 (20s).
	 */
	retryBackoffCeilMs?: number;
	/**
	 * Hook handler — called before/after tool execution and at other lifecycle points.
	 * Returns a HookResult; if outcome is "blocked", the tool call is denied.
	 */
	hookHandler?: (
		event: string,
		payload: Record<string, unknown>,
	) => Promise<{ outcome: "success" | "blocked" | "error"; reason?: string }>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Base delay for transient-error retries (ms). Used by both the agent loop
 *  (in-loop retry) and the outer narrator session retry. */
export const TRANSIENT_RETRY_BASE_MS = 5_000;
