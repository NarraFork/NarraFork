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

export interface ReflectionLoopContext {
	/** Kind of reflection loop, e.g. "dangerReflection". */
	kind: string;
	/** Optional request/domain ID for the loop. */
	requestId?: string;
	/** Optional source toolUseId or target toolUseId that triggered the loop. */
	toolUseId?: string;
	/** Extra loop-specific data for reflection tools. */
	data?: Record<string, unknown>;
}

export interface ReflectionLoopConfig {
	/** Tools available inside this bounded reflection loop. */
	allowedTools: readonly string[];
	/** Context passed through to tools as ToolContext.reflectionLoop. */
	context: ReflectionLoopContext;
}

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
	/** Skill scan root — legacy project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Project git path used to resolve project-level skills for this context. */
	projectGitPath?: string | null;
	/** Resolved skill summary cache scope key for this context. */
	skillScopeKey?: string;
	/** Parent narrator ID — set for subagents, used for Team file-change tracking */
	parentNarratorId?: string;
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
	/** Context for bounded reflection loops, such as danger reflection review. */
	reflectionLoop?: ReflectionLoopContext;
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
	/** Optional dynamic schema override for tools that depend on current agent config. */
	getRawJsonSchema?: (config: AgentConfig) => Record<string, unknown>;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
	/** If provided, tool is only included when this returns true */
	isAvailable?: () => boolean;
	/** Hide this tool from normal sessions; reflection loops may opt in via allowedTools. */
	reflectionOnly?: boolean;
	/** Optional metadata for tool provenance (e.g. MCP server origin). */
	metadata?: {
		/** MCP server ID from settings. */
		mcpServerId?: string;
		/** MCP server display name. */
		mcpServerName?: string;
		/** Original MCP tool name (before prefixing). */
		mcpToolName?: string;
	};
}

/** ToolDefinition with description resolved to a plain string (after dynamic evaluation) */
export type ResolvedToolDefinition = ToolDefinition & { description: string };

// === Permission ===

export type DangerSeverity = "low" | "medium" | "high" | "critical";

export interface DangerInfo {
	severity: DangerSeverity;
	summary: string;
	consequences: string[];
	saferAlternatives: string[];
	details?: string[];
}

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
	  }
	| {
			behavior: "dangerReflection";
			requestId: string;
			danger: DangerInfo;
			fingerprint: string;
			/** Effective danger reflection policy level that triggered this pause. */
			reflectionLevel?: "light" | "standard" | "strict";
			/** Effective input that should be reflected on and executed if confirmed. */
			input: Record<string, unknown>;
			decision: Promise<PermissionResult>;
	  };

export type AllowPermissionResult = Extract<PermissionResult, { behavior: "allow" }>;

// === Agent events (yielded by the loop) ===

export type AgentSideCarTarget = "tool_result" | "user_message";

export interface AgentSideCar {
	id?: string;
	target: AgentSideCarTarget;
	source: string;
	content: string;
	orderIndex?: number;
	toolUseId?: string | null;
}

export interface AgentSideCarRequest {
	phase: "tool_result" | "after_tools";
	toolName?: string;
	toolUseId?: string;
	completedToolCount?: number;
}

export type AgentEvent =
	| {
			type: "assistant_message";
			text: string;
			toolUses: AgentToolUse[];
			messageId?: string;
			credentialId?: string;
	  }
	| { type: "stream_text"; text: string; outputIndex?: number }
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
			permissionStartedAt?: number;
			executionStartedAt?: number;
			completedAt?: number;
			brokenInputOverride?: Record<string, unknown>;
			updatedInput?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
			sideCars?: AgentSideCar[];
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
			/** Metadata derived while tool input is still streaming (e.g. Edit match line). */
			metadata?: Record<string, unknown>;
			/** Incremental delta of the large streaming field (content, command, prompt, etc.) */
			streamingField?: { name: string; delta: string };
	  }
	| {
			type: "block_complete";
			block: ContentBlock;
	  }
	| { type: "sidecars"; sideCars: AgentSideCar[] }
	| { type: "turn_complete"; turnIndex: number }
	| { type: "max_turns_exceeded"; maxTurns: number }
	| { type: "stream_reset" }
	| {
			/**
			 * - `stream_captured`: the streaming accumulator lifted a `<invoke>` block out of
			 * - `recovered`: the streaming layer missed it, but the post-turn stateless safety
			 *   net extracted a complete block from the finished assistant text.
			 * - `unrecovered`: leaked `<invoke` text remained that could not be parsed into a
			 *   tool call (a closing tag may be missing or the block was malformed).
			 * `requestId` is the loop-level request id; the event handler maps it to the
			 * persisted api_requests.id before broadcasting a notice to the frontend.
			 */
			type: "leaked_tool_call";
			phase: "stream_captured" | "recovered" | "unrecovered";
			requestId: string;
			toolUseIds?: string[];
			toolNames?: string[];
			/** For `unrecovered`: a truncated snippet of the leaked `<invoke` text. */
			snippet?: string;
	  }
	| { type: "error"; message: string }
	| { type: "retryable_error"; message: string; code?: string; bypassRetryLimit?: boolean }
	| {
			type: "retrying";
			message: string;
			attempt: number;
			maxRetries: number;
			delayMs: number;
	  }
	| { type: "context_length_exceeded"; message: string }
	| {
			type: "payment_required";
			message: string;
			providerId?: string;
			providerPrefix?: string;
			balance?: number;
			required?: number;
			resumeAction: "retry" | "continue";
	  }
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
	| { type: "queue_status"; position?: number; queueDepth?: number; queueMessage?: string }
	| { type: "quota_balance"; quotaBalance: string | null; detailedQuotaBalance?: string | null }
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
	| {
			type: "image_generation";
			id: string;
			status: string;
			revisedPrompt?: string;
			result?: string;
			partialImageIndex?: number;
			partialImageB64?: string;
			partialSavedPath?: string;
			savedPath?: string;
			width?: number;
			height?: number;
			outputIndex?: number;
	  }
	| {
			type: "model_switched";
			model: string;
			provider: string;
			reasoningEffort?: ReasoningEffort | null;
			cause?: "turn" | "retry";
	  }
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
			errorMessage?: string;
			/** Force raw-dump persistence regardless of the errors-only setting. */
			forceDumpPersist?: boolean;
	  }
	| { type: "silent_disconnect" }
	| { type: "done" };

export interface AgentToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
	/** Timestamp (ms) when the first streaming chunk for this tool use arrived */
	streamStartedAt?: number;
	/** Provider-native content block index for interleaved ordering. */
	outputIndex?: number;
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
		/** Provider-native content block index for this thinking block. */
		blockIndex?: number;
		/** Signature for thinking block verification (must be echoed back in subsequent turns) */
		signature?: string;
	};
}

/** A fully-streamed content block within an assistant message. */
export type ContentBlock =
	| { type: "text"; text: string; outputIndex?: number }
	| {
			type: "reasoning";
			text: string;
			translatedText?: string;
			providerMetadata?: ReasoningProviderMetadata;
			outputIndex?: number;
	  }
	| { type: "redacted_thinking"; data: string; outputIndex?: number }
	| {
			type: "tool_use";
			toolUseId: string;
			name: string;
			input: Record<string, unknown>;
			streamStartedAt?: number;
			outputIndex?: number;
	  }
	| {
			type: "web_search";
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
	  }
	| {
			type: "image_generation";
			id: string;
			revisedPrompt?: string;
			result?: string;
			savedPath?: string;
			partialSavedPath?: string;
			partialImageIndex?: number;
			outputIndex?: number;
			width?: number;
			height?: number;
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
	"StartPipeline",
	"EndPipeline",
	"Bash",
	"Shell",
	"Agent",
	"Await",
	"Send",
	"AskUserQuestion",
	"Skill",
	"LearningGuide",
]);

// === Agent config ===

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeSettingsOverride {
	model?: string | null;
	reasoningEffort?: ReasoningEffort | null;
}

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
	/** Parent narrator ID — set for subagents, passed through to ToolContext for Team tracking */
	parentNarratorId?: string;
	maxTurns?: number;
	planMode?: boolean;
	/** Current narrator permission mode; used for relaxed-plan safety checks. */
	permissionMode?: string;
	/** Legacy permission mode snapshot from before entering plan mode; retained for migration/UI context. */
	previousPermissionMode?: string;
	/** When true, plan mode does NOT disable tool descriptions — tools remain fully available */
	relaxedPlan?: boolean;
	/**
	 * Whether plan mode accepts inline plans (the `plan` parameter of ExitPlanMode).
	 * When false, the ExitPlanMode schema/description and the plan-mode system reminder
	 * drop the inline option and only the file-based plan flow is supported.
	 * Undefined is treated as true for backward compatibility (subagents/reflection loops).
	 */
	planAllowInlinePlan?: boolean;
	/**
	 * Per-session override for ExitPlanMode reflection auto-approval.
	 * "inherit" follows the current global default at decision time.
	 */
	planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
	/** Effective per-session/global value for ExitPlanMode reflection auto-approval. */
	planReflectionAutoApprove?: boolean;
	/** Allow ExitPlanMode plan reflection to auto-approve and reset context. */
	planReflectionAllowAutoCompact?: boolean;
	/** Plan file ID — set during plan mode for Write/Edit validation and ExitPlanMode */
	planFileId?: string;
	/** Skill scan root — legacy project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Project git path used to resolve project-level skills for this context. */
	projectGitPath?: string | null;
	/** Resolved skill summary cache scope key for this context. */
	skillScopeKey?: string;
	/** Reasoning effort — maps to thinking config (Anthropic) or reasoning config (Codex) */
	reasoningEffort?: ReasoningEffort;
	/** Service tier for Codex-mode providers — "priority" enables fast mode */
	serviceTier?: string;
	/** Metadata sent with API requests (e.g. Anthropic metadata.user_id) */
	metadata?: { user_id: string };
	/**
	 * One-shot reset for reusable upstream transport/session state before the first
	 * provider request in this agent loop. Used after compact/context-clear rebuilt
	 * history outside the inner loop.
	 */
	resetUpstreamSessionOnFirstRequest?: boolean;
	/** Filter tools available to this agent (subagent/tool-trait restriction) */
	toolFilter?: (tool: ToolDefinition) => boolean;
	/** Tool names disabled by narrator custom traits. Enforced again at execution time. */
	disabledTools?: Set<string> | string[];
	/** Custom description appended to Agent.model schema when narrator traits restrict subagent models. */
	subagentModelRestrictionDescription?: string | null;
	/** Internal bounded reflection loop context. */
	reflectionLoop?: ReflectionLoopConfig;
	permissionHandler: (
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
	) => Promise<PermissionResult>;
	onEvent?: (event: AgentEvent) => void;
	/**
	 * Called before each non-first turn in the agent loop.
	 * If it returns a new history + pendingToolResults, the loop replaces its
	 * internal state — used for mid-turn context pruning and forced rebuilds
	 * before model/provider switches.
	 */
	onBeforeTurn?: (
		turnIndex: number,
		reason?: { force?: boolean; cause?: "normal" | "model_switch" },
	) => Promise<{
		history: unknown[];
		pendingToolResults: unknown[];
		systemPrompt?: string;
	} | null>;
	/**
	 * Unified sidecar channel. SideCars are stored separately and assembled into
	 * either tool_result output or the next user message only when calling the API.
	 */
	getSideCars?: (request: AgentSideCarRequest) => Promise<AgentSideCar[]> | AgentSideCar[];
	/** Initial completed-tool count for sidecar cadence, persisted by caller across loop runs. */
	sideCarInitialCompletedToolCount?: number;
	/** Called whenever the sidecar cadence counter advances. */
	onSideCarCompletedToolCount?: (completedToolCount: number) => void;
	/**
	 * Called before each non-first turn/retry to check if runtime settings should be switched.
	 * Changes are applied at the safe point before the next provider API request, so running
	 * tools are not interrupted while the next model request uses fresh settings.
	 */
	getRuntimeSettingsOverride?: () => RuntimeSettingsOverride | null;
	/**
	 * Legacy model-only override hook. Prefer getRuntimeSettingsOverride for new callers.
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
	 * Number of completed tool calls without visible text before a progress sidecar is injected.
	 * -1 disables the reminder. Defaults to 20.
	 */
	silentToolCallThreshold?: number;
	/**
	 * Maximum backoff delay (ms) for transient-error retries.
	 * Exponential backoff is capped at this value.  Defaults to 20_000 (20s).
	 */
	retryBackoffCeilMs?: number;
	/**
	 * Time to wait after request dispatch for the first meaningful stream event.
	 * 0 disables this timeout. Defaults to 60_000 (60s).
	 */
	firstTokenTimeoutMs?: number;
	/**
	 * Hook handler — called before/after tool execution and at other lifecycle points.
	 * Returns a HookResult; if outcome is "blocked", the tool call is denied.
	 */
	hookHandler?: (
		event: string,
		payload: Record<string, unknown>,
	) => Promise<{ outcome: "success" | "blocked" | "error"; reason?: string }>;
}

// ── Model detection helpers ──────────────────────────────────────────────────

/** Whether a model name refers to a DeepSeek model. */
export function isDeepSeekModel(model: string): boolean {
	return model.toLowerCase().includes("deepseek");
}

/**
 * Map reasoning effort to DeepSeek effort value.
 * DeepSeek supports "high" and "max" — low/medium map to high, xhigh/max map to max.
 */
export function mapDeepSeekEffort(reasoningEffort: string | undefined): "high" | "max" | undefined {
	if (!reasoningEffort || reasoningEffort === "none") return undefined;
	if (reasoningEffort === "xhigh" || reasoningEffort === "max") return "max";
	return "high";
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Base delay for transient-error retries (ms). Used by both the agent loop
 *  (in-loop retry) and the outer narrator session retry. */
export const TRANSIENT_RETRY_BASE_MS = 5_000;
