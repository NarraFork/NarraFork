import type { RuntimePolicy } from "@server/services/agent-runtime/policy";
import type {
	AgentToolUse,
	ApiRequestDiagnosticSource,
	ApiRequestDiagnostics,
	KnowledgeInjectionRecord,
	ReasoningProviderMetadata,
	ReferencePricingSnapshot,
} from "@shared/agent-protocol/types";
import type { StreamingEditOrigin } from "@shared/streaming-edit-origin";
import type { ToolProgressPayload } from "@shared/tool-progress";
import type { z } from "zod/v4";
import type { PathFlavor } from "./execution/backend";

// === API error and bounded diagnostics ===

/**
 * Types shared with the protocol layer live in
 * `@shared/agent-protocol/types` so bundled plugin code can use them without
 * importing anything under `server/`. Re-exported here so existing host import
 * paths keep working.
 */
export type {
	AgentToolUse,
	ApiRequestDiagnosticSource,
	ApiRequestDiagnostics,
	ReasoningProviderMetadata,
};

/**
 * Error thrown by provider adapters when the upstream API returns a non-OK
 * HTTP response. Carries the numeric `status` so that `isRetryableError()`
 * in the agent loop can inspect it without parsing the message string.
 */
export class ApiError extends Error {
	readonly status: number;
	readonly diagnostics?: ApiRequestDiagnostics;
	constructor(status: number, message: string, diagnostics?: ApiRequestDiagnostics) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.diagnostics = diagnostics;
	}
}

// === Tool system ===

export interface ReflectionLoopContext {
	/** Kind of reflection loop, e.g. "dangerReflection". */
	kind: string;
	/** Dedicated authorization workflow: no cached confirm or text fallback. */
	purpose?: "permissionRuleRequest";
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

export interface ToolUpdateExecutionLease {
	readonly kind: import("@server/services/update-coordinator").UpdateExecutionKind;
	/** Rebind the lease to the real long-running runner after tool-level admission. */
	setNarratorId(narratorId: string): void;
	/** Transfer release responsibility from the synchronous executor to the tool lifecycle. */
	transfer(): boolean;
	/** Idempotently release the coordinator execution lease. */
	release(): void;
}

/** One actual persisted tool-call attempt, never a provider id or a COW display clone. */
export interface ToolCallBinding {
	readonly toolCallId: string;
	readonly attempt: number;
	/** Stable provenance segment for all file-changing calls in this execution lineage. */
	readonly executionSegmentId?: string;
}

/** Awaited execution boundary, after authorization and final admission (not UI events). */
export interface ToolExecutionLifecycleContext {
	toolUse: AgentToolUse;
	effectiveInput: Record<string, unknown>;
	executionTarget?: ToolExecutionTarget;
	binding?: ToolCallBinding;
}

/** Final authorization uses the immutable admitted input/target, never a live cwd hint. */
export interface ToolFinalStartAuthorizationContext extends ToolExecutionLifecycleContext {
	executionBackend?: import("./execution/backend").ExecutionBackend;
	executionPlan?: ToolExecutionPlan;
	approvedPermission: AllowPermissionResult;
}

/** Async policy preparation followed by a synchronous fence at the actual call boundary. */
export interface ToolFinalStartAuthorizationTicket {
	assertStillCurrent: () => void;
}

export interface ToolContext {
	/** Eval-only audited Read bridge; never exposes the runner configuration. */
	executeRead?: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>;
	recheckAuthorization?: () => Promise<void>;
	narratorId: string;
	cwd: string;
	signal: AbortSignal;
	/** Provider prefix of the session driving this tool call (e.g. "anthropic"). */
	provider?: string;
	/** Model ID of the session driving this tool call (may carry a provider prefix). */
	model?: string;
	/** Global default for Pipeline capture auto-cleanup; -1 disables it. */
	pipelineUnusedToolCallThreshold?: number;
	/** Locale for i18n of tool outputs */
	locale: string;
	/** Chapter ID the narrator belongs to (cached to avoid repeated DB lookups) */
	chapterId?: string;
	/** Plan file ID — set during plan mode, used by ExitPlanMode to locate the plan file */
	planFileId?: string;
	/** Plan file path — set during plan mode, passed to EnterPlanMode tool for the result prompt */
	planFilePath?: string;
	/** Skill scan root — legacy project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Project git path used to resolve project-level skills for this context. */
	projectGitPath?: string | null;
	/** Active chapter worktree root, used for cwd recovery suggestions. */
	worktreePath?: string | null;
	/** Resolved skill summary cache scope key for this context. */
	skillScopeKey?: string;
	/** Skills blocked by narrator custom traits. `all` blocks every skill. */
	blockedSkills?: { all: boolean; names: string[] } | null;
	/** Server-resolved capability ceiling, copied from AgentConfig, never tool input. */
	runtimePolicy?: RuntimePolicy;
	/** Parent narrator ID — set for subagents, used for Team file-change tracking */
	parentNarratorId?: string;
	/**
	 * The user who triggered the current agent-loop turn (sent the message / continued the task).
	 * Used to resolve knowledge-base ACL caps for this turn. null/undefined → anonymous (public only).
	 * NarraFork narrators have no fixed owner, so authority is per-trigger, not per-narrator.
	 */
	userId?: string | null;
	/**
	 * Project the narrator belongs to. Scopes knowledge search/read to this
	 * project's collections + global ones (cross-project isolation).
	 */
	projectId?: string | null;
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
	/**
	 * Emit a live DETERMINATE progress measurement for a tool that knows how much
	 * work remains (currently TransferFile).
	 *
	 * Separate from `emitOutput` because the two answer different questions and
	 * are consumed differently. `emitOutput` is a text stream whose meaning is
	 * whatever the tool prints; this is a measurement the UI renders as an actual
	 * progress bar. Sending a bar as text (an ASCII `[███░░]`) would make the
	 * client's only option to re-parse the tool's own formatting.
	 *
	 * Callers should ALSO emit a text form via `emitOutput` — the text is what the
	 * model reads and what surfaces with no progress support fall back to, so this
	 * channel stays purely additive.
	 */
	emitStructuredProgress?: (progress: ToolProgressPayload) => void;
	/** Emit a long-running process notification (≥60s). UI can show a terminate button. */
	emitLongRunning?: (toolUseId: string, elapsed: number) => void;
	/** The toolUseId of the current tool execution (set by executeTool) */
	currentToolUseId?: string;
	/** Durable identity of this execution; also retained by background tool closures. */
	toolCallBinding?: ToolCallBinding;
	/** Stable file-change provenance segment for this call and descendants. */
	executionSegmentId?: string;
	/** Context for bounded reflection loops, such as danger reflection review. */
	reflectionLoop?: ReflectionLoopContext;
	/**
	 * Resolve the execution backend for a tool call. Injected by executeTool.
	 * `device` is the optional per-call device parameter; when omitted the
	 * session default (or local) is used. When this function is absent, bare or
	 * legacy callers still use the canonical registry; unavailable remote
	 * targets fail closed rather than falling back to local execution.
	 */
	resolveBackend?: (device?: string) => import("./execution/backend").ExecutionBackend;
	/** Immutable target selected for the current routed tool call. */
	executionTarget?: ToolExecutionTarget;
	/** Update-coordinator lease held for this tool's final execution. */
	updateExecutionLease?: ToolUpdateExecutionLease;
	/** Immutable endpoint plan for multi-target tools. */
	executionPlan?: ToolExecutionPlan;
	/** Devices this session may route to (empty/undefined → only local). */
	availableDevices?: import("./execution/backend").DeviceSummary[];
	/** The session's default execution device id (undefined/null → local). */
	defaultDeviceId?: string | null;
	/** Whether this runtime may select the NarraFork server as an execution target. */
	allowLocalExecution?: boolean;
	/**
	 * Set the session's default execution device (SwitchDevice tool). Persists to
	 * the narrator record and updates the live session. Returns false when the
	 * session cannot be found. Absent for callers without a live session.
	 */
	setDefaultDevice?: (deviceId: string | null) => Promise<boolean>;
	/** Checks at both permission and final execution admission; stale passes fail closed. */
	assertWorkspaceCurrent?: () => void;
	/** Frozen workspace identity for this pass; background closures retain it. */
	workspaceContext?: import("@shared/workspace-context").WorkspaceContext;
	/** Commit a strict-serial switch without waiting for the invoking loop. */
	switchWorkingDirectory?: (
		request: import("@shared/workspace-context").SwitchWorkingDirectoryRequest,
	) => Promise<import("@shared/workspace-context").SwitchWorkingDirectoryResult>;
}

/** Immutable execution identity captured before a routed tool enters permission handling. */
export interface ToolExecutionTarget {
	/** "local" for the NarraFork server, otherwise remote_devices.id. */
	deviceId: string;
	backendKind: "local" | "remote";
	/** Effective working directory on the target device. */
	cwd: string;
	/** Path grammar used to interpret cwd and path fields. Optional for persisted legacy targets. */
	pathFlavor?: PathFlavor;
	/** Lexically normalized absolute path for the primary path argument. */
	lexicalPath?: string;
	/** Canonical filesystem identity, including a canonical create path when missing. */
	canonicalPath?: string;
	/** Backend runtime generation that produced the canonical identity. */
	runtimeGeneration?: number;
	/**
	 * Compatibility alias for legacy persistence and callers. New code should use
	 * canonicalPath when available, then lexicalPath.
	 */
	resolvedFilePath?: string;
	selectionSource: "explicit" | "session_default" | "local_default";
}

export type ToolExecutionOperation = "read" | "write" | "search" | "execute" | "control";

/** Declarative endpoint request produced by a tool definition before routing. */
export interface ToolExecutionEndpointRequest {
	key: string;
	operation: ToolExecutionOperation;
	/** Explicit device id. Omit to use the session default. */
	deviceId?: string;
	/** Force execution on the NarraFork host, independent of the session default. */
	hostOnly?: boolean;
	/** Optional target-relative cwd override. */
	workdir?: string;
	/** Optional primary path to freeze and canonicalize on this endpoint. */
	path?: string;
	/** Virtual path grammar override, currently used by Dynamic Spec. */
	pathFlavor?: PathFlavor;
}

export interface ToolExecutionEndpoint {
	key: string;
	operation: ToolExecutionOperation;
	target: ToolExecutionTarget;
}

/** Immutable, serializable execution plan for single- and multi-endpoint tools. */
export interface ToolExecutionPlan {
	kind: "single" | "multi";
	primaryKey: string;
	endpoints: ToolExecutionEndpoint[];
}

export type ToolExecutionRouting =
	| {
			kind: "single";
			resolve: (
				input: Record<string, unknown>,
				config: AgentConfig,
			) => ToolExecutionEndpointRequest | null;
	  }
	| {
			kind: "multi";
			resolve: (
				input: Record<string, unknown>,
				config: AgentConfig,
			) => { primaryKey: string; endpoints: ToolExecutionEndpointRequest[] } | null;
	  };

export interface PermissionHandlerOptions {
	/** Per-call preparation cancellation; prefer this over the whole-run signal. */
	signal?: AbortSignal;
	/** Exact execution row; never resolve a different row by provider toolUseId. */
	toolCallBinding?: ToolCallBinding;
	/** Suppress user-facing attention for an internally resumed permission flow. */
	suppressAttention?: boolean;
	/** Frozen execution backend selected before permission handling. */
	executionBackend?: import("./execution/backend").ExecutionBackend;
	/** Frozen execution identity selected before permission handling. */
	executionTarget?: ToolExecutionTarget;
	/** Frozen single- or multi-endpoint execution plan. */
	executionPlan?: ToolExecutionPlan;
	/**
	 * Report permission-time input canonicalization before any approval decision or prompt.
	 * Routed tools use this to refine and persist their frozen cwd/path while the tool-call row
	 * is still initializing; later input changes must match this identity exactly.
	 */
	onInputResolved?: (input: Record<string, unknown>) => Promise<void>;
	/**
	 * Signal that this request is now durably pending and about to suspend until a human answers.
	 *
	 * Called exactly once, AFTER the tool-call row is persisted as `pending` and the request is
	 * registered, and only on the path that truly waits for a person. Auto-allow/auto-deny
	 * decisions never call it.
	 *
	 * The executor uses this to drop its update start grant for the duration of the wait, so an
	 * unanswered permission request cannot block a planned restart. The ordering matters: the row
	 * must already be durable when this fires, otherwise a checkpoint racing the release would
	 * observe the tool as neither in-flight nor recoverable.
	 */
	onAwaitingUserDecision?: () => void;
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
	/** Declarative execution routing; absent means the tool is not filesystem/device routed. */
	executionRouting?: ToolExecutionRouting;
	execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
	/** If provided, tool is only included when this returns true */
	isAvailable?: () => boolean;
	/** Always declared, but executable only in an active reflection loop's allowedTools. */
	reflectionOnly?: boolean;
	/** Optional metadata for tool provenance (e.g. MCP server origin). */
	metadata?: {
		/** MCP server ID from settings. */
		mcpServerId?: string;
		/** MCP server display name. */
		mcpServerName?: string;
		/** Original MCP tool name (before prefixing). */
		mcpToolName?: string;
		/** Explicitly declares that executing this tool cannot mutate runtime or project state. */
		readOnly?: boolean;
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
			/** Dedicated rule-request gate; never cached or approved via text fallback. */
			purpose?: "permissionRuleRequest";
			requestId: string;
			danger: DangerInfo;
			fingerprint: string;
			/** Effective danger reflection policy level that triggered this pause. */
			reflectionLevel?: "light" | "standard" | "strict";
			/**
			 * Extra business context appended to the reflection prompt (currently supplied by an
			 * OAuth client at provision time). Advisory only: it cannot relax the requirement to
			 * settle the pause with DangerConfirm or DangerCancel.
			 */
			appendPrompt?: string;
			/** Effective input that should be reflected on and executed if confirmed. */
			input: Record<string, unknown>;
			decision: Promise<PermissionResult>;
	  };

export type AllowPermissionResult = Extract<PermissionResult, { behavior: "allow" }>;

// === Agent events (yielded by the loop) ===

export type AgentEvent =
	| {
			type: "assistant_message";
			text: string;
			toolUses: AgentToolUse[];
			/** Internal persistence receipt for tools missing an incremental block. */
			onToolPersisted?: (toolUseId: string, binding: ToolCallBinding) => void;
			messageId?: string;
			credentialId?: string;
			/** Source citations for `text`, when the provider reported any. */
			citations?: import("@shared/citations").TextCitation[];
	  }
	| {
			type: "stream_text";
			text: string;
			outputIndex?: number;
			/** Attempt-scoped identity and revision shared with persisted content. */
			blockId?: string;
			blockRevision?: number;
			/** Raw text characters preceding this delta (metadata may also advance revision). */
			blockTextOffset?: number;
	  }
	| {
			type: "tool_call";
			toolUseId: string;
			toolName: string;
			input: Record<string, unknown>;
			/** Server pre-match evidence, never taken from model input. */
			streamingEditOrigin?: StreamingEditOrigin;
			streamStartedAt?: number;
			streamCompletedAt?: number;
	  }
	| {
			type: "tool_result";
			toolCallBinding?: ToolCallBinding;
			toolUseId: string;
			toolName: string;
			/** Actual input used by the completed tool attempt, after any permission redirect. */
			input?: Record<string, unknown>;
			output: string;
			isError: boolean;
			durationMs?: number;
			permissionStartedAt?: number;
			executionStartedAt?: number;
			completedAt?: number;
			brokenInputOverride?: Record<string, unknown>;
			updatedInput?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
	  }
	/**
	 * The tool passed its permission gate and final admission — execution begins NOW.
	 *
	 * ⚠️ Distinct from `tool_call`, and the distinction is the whole point. `tool_call`
	 * fires when the tool's INPUT finished parsing; the permission prompt, any danger /
	 * plan reflection gate, and the final admission wait all sit between the two. A
	 * client that treats `tool_call` as "executing" therefore claims work has started
	 * while the narrator may in fact be waiting on a human.
	 *
	 * Emitted exactly once per execution attempt. A tool that is denied never reaches
	 * this point, and a tool resumed after a transparent update wait re-stamps
	 * `executionStartedAt` so paused time is not counted as execution time.
	 */
	| { type: "tool_executing"; toolUseId: string; executionStartedAt: number }
	| { type: "tool_progress"; toolUseId: string; elapsed: number }
	| { type: "tool_output"; toolUseId: string; output: string }
	/**
	 * A DETERMINATE progress measurement from a tool that knows its total work.
	 *
	 * Deliberately not folded into `tool_progress`, which carries only elapsed
	 * seconds and means "still alive" — an indeterminate heartbeat every tool gets.
	 * This one means "N of M done" and only a tool that can actually measure that
	 * emits it, so a client can tell a real bar from a spinner by which frame
	 * arrived rather than by inspecting fields for plausibility.
	 */
	| { type: "tool_structured_progress"; toolUseId: string; progress: ToolProgressPayload }
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
			streamingField?: {
				name: string;
				delta: string;
				/** True at the JSON string's start, false for a continuation; absent means unknown. */
				startsField?: boolean;
				/** Decoded raw UTF-16 offset before this delta (CRLF is not normalized). */
				offset?: number;
				/** True when the JSON string closed, including an empty final delta. */
				complete?: boolean;
			};
	  }
	| {
			type: "block_complete";
			block: ContentBlock;
			/** Called only after the current message's real tool row is durable. */
			onToolPersisted?: (binding: ToolCallBinding) => void;
	  }
	| { type: "turn_complete"; turnIndex: number }
	| { type: "max_turns_exceeded"; maxTurns: number }
	| { type: "stream_reset" }
	| {
			/**
			 * Tool cards published by `tool_use_chunk` that will never complete.
			 *
			 * A tool becomes visible while its arguments are still streaming, before any
			 * row exists in the database. If the stream breaks mid-arguments and the turn
			 * is replayed, those ids are abandoned: no `tool_result` follows and no
			 * persisted message ever carries them, so nothing would ever retire the card
			 * and it stays "running" forever with a live elapsed timer.
			 *
			 * This names the abandoned ids so the client can drop exactly those cards.
			 * Ids whose input completed are never included — they are already executing
			 * or already persisted.
			 */
			type: "tool_use_discarded";
			toolUseIds: string[];
	  }
	| {
			/**
			 * An attempt is being abandoned and the identical request replayed in place.
			 *
			 * Blocks are persisted the moment they complete (`block_complete` writes into
			 * the partial assistant message and inserts a `narrator_tool_calls` row), so an
			 * abandoned attempt leaves its reasoning/text/tool_use behind. Without this
			 * signal those remnants accumulate across every replay: one assistant message
			 * ends up carrying several attempts' worth of near-identical reasoning and tool
			 * calls, which is exactly the "the transcript keeps growing but the request
			 * never changes" symptom.
			 *
			 * Consumers must drop everything this attempt persisted, back to the state at
			 * the matching `api_request_start`. Emitted immediately before the request
			 * teardown of every in-place replay.
			 */
			type: "attempt_discarded";
			/**
			 * The attempt being discarded, matching its `api_request_start`.
			 *
			 * Consumers key their truncation baseline on this rather than on "whatever
			 * the last api_request_start set", because `api_request_start` is emitted
			 * LAZILY: the loop only flushes it once the provider stream yields its first
			 * event, or during request teardown. An attempt that dies before producing
			 * anything therefore emits `attempt_discarded` first and `api_request_start`
			 * second, so an order-dependent baseline would be stale on exactly the paths
			 * that need it. A baseline recorded per requestId cannot be mismatched.
			 */
			requestId: string;
	  }
	| {
			/**
			 * Diagnostic signal for leaked XML tool calls (NUG gateway).
			 * - `stream_captured`: the streaming accumulator lifted a `<invoke>` block out of
			 *   the text deltas successfully (xml_* tool calls were produced).
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
	| { type: "error"; message: string; diagnostics?: ApiRequestDiagnostics }
	| {
			type: "retryable_error";
			message: string;
			code?: string;
			bypassRetryLimit?: boolean;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/**
			 * A transient error occurred after client-visible partial output
			 * (assistant text/reasoning/tool_use) was already produced this
			 * turn. Unlike `retryable_error` (retry the whole request from
			 * scratch) or `invalid_state` (terminal failure), the partial
			 * output has already been flushed via `block_complete` and this
			 * turn should be finalized normally — the caller (narrator-session)
			 * is expected to append a continuation user turn so the model picks
			 * up where it left off instead of surfacing a visible failure.
			 */
			type: "resumable_error";
			message: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			/**
			 * A resumable interruption was recovered inside the agent loop itself,
			 * without ending the turn or surfacing a failure. Purely informational:
			 * consumers may surface a notice but must not change the run state.
			 *
			 * - `tool_continuation`: the stream broke after a complete tool call had
			 *   already been produced. The turn finishes normally — tools execute and
			 *   their results are carried into the next turn — so no continuation
			 *   prompt and no request replay is needed.
			 * - `truncated_tool_input`: the stream broke while the model was still
			 *   writing a tool call's arguments, so no tool completed. The turn finishes
			 *   normally too, but nothing executes: the loop injects the skeleton-first
			 *   reminder instead, because an identical replay would most likely hit the
			 *   same output-size ceiling again.
			 */
			type: "resumable_recovered";
			strategy: "tool_continuation" | "truncated_tool_input";
			message: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			type: "retrying";
			message: string;
			attempt: number;
			maxRetries: number;
			delayMs: number;
			diagnostics?: ApiRequestDiagnostics;
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
			/**
			 * The turn cannot proceed, but the condition clears on its own, so the
			 * caller must SUSPEND the turn rather than replay the full request (which
			 * re-uploads the whole history every attempt) or fail it.
			 *
			 * Two causes share this event; `waitKind` separates them because only the
			 * caller can act on either — the agent loop has no suspension of its own.
			 *
			 *  - `credentials` (default): a NUG model's entire credential pool is
			 *    disabled. When it comes back is unknowable, so the caller parks on the
			 *    shared availability poller and resumes when the model reports available.
			 *  - `quota`: a Kimi coding-plan allowance is used up. The reset instant is
			 *    published upstream, so `resumeAt` carries it and the caller sleeps to
			 *    it instead of polling — unless the reset lies beyond the wait budget,
			 *    in which case `resumeAt` is absent while `quotaResetAt` is not, and the
			 *    caller reports the wall with that instant attached.
			 */
			type: "model_unavailable";
			message: string;
			provider: string;
			model: string;
			providerId?: string;
			providerPrefix?: string;
			/** `channel:bareModel` id used to match this model in `/v1/models`. */
			nugModelId?: string;
			/** How recovery is awaited; `credentials` when omitted. */
			waitKind?: "credentials" | "quota";
			/**
			 * Epoch ms at which the turn may be replayed. Present for a `quota` wait
			 * whose reset is inside the wait budget — its ABSENCE on a `quota` wall
			 * means the reset is known but too far out, and the caller must report the
			 * wall instead of parking on it.
			 */
			resumeAt?: number;
			/**
			 * Epoch ms the quota window resets at, whenever upstream published one —
			 * including when the wall is too far out to wait for, so the caller can
			 * tell the user when the allowance returns.
			 */
			quotaResetAt?: number;
			diagnostics?: ApiRequestDiagnostics;
	  }
	| {
			type: "stream_reasoning";
			text: string;
			providerMetadata?: ReasoningProviderMetadata;
			outputIndex?: number;
			blockId?: string;
			blockRevision?: number;
			/** Raw text characters preceding this delta (metadata may also advance revision). */
			blockTextOffset?: number;
	  }
	| {
			type: "context_usage";
			source?: import("@shared/context-usage").ContextUsageSource;
			snapshot?: import("@shared/context-usage").ContextUsageSnapshot;
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
	| {
			type: "invalid_state";
			reason: string;
			message: string;
			diagnostics?: ApiRequestDiagnostics;
	  }
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
			userId?: string | null;
			provider: string;
			model: string;
			credentialId?: string;
			referencePricingSnapshot?: ReferencePricingSnapshot;
	  }
	| {
			type: "api_request_end";
			contextSnapshot?: import("@shared/context-usage").ContextUsageSnapshot;
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
			diagnostics?: ApiRequestDiagnostics;
			/** Force raw-dump persistence regardless of the errors-only setting. */
			forceDumpPersist?: boolean;
			/**
			 * Turn-scoped key marking several attempts as re-sends of ONE request, so their
			 * identical dumps share a single spilled file instead of filling the newest-N
			 * dump directory with multi-MB near-duplicates.
			 */
			dumpSpillReuseToken?: string;
	  }
	| { type: "silent_disconnect" }
	| { type: "done" };

/** A fully-streamed content block within an assistant message. */
export type ContentBlock =
	| {
			type: "text";
			text: string;
			outputIndex?: number;
			/** Display/persistence identity, never an upstream replay credential. */
			id?: string;
			revision?: number;
			/** Raw stream length before citation-marker cleanup. */
			rawTextLength?: number;
			/**
			 * Source citations for this text, indexed against `text`.
			 * Present only when the provider reported sources (native search).
			 */
			citations?: import("@shared/citations").TextCitation[];
	  }
	| {
			type: "reasoning";
			text: string;
			translatedText?: string;
			providerMetadata?: ReasoningProviderMetadata;
			outputIndex?: number;
			id?: string;
			revision?: number;
			/** Raw stream length before citation-marker cleanup. */
			rawTextLength?: number;
	  }
	| { type: "redacted_thinking"; data: string; outputIndex?: number; signatureSource?: string }
	| {
			type: "tool_use";
			toolUseId: string;
			name: string;
			input: Record<string, unknown>;
			streamStartedAt?: number;
			streamCompletedAt?: number;
			outputIndex?: number;
			/** Gemini 3 thought signature for this functionCall part (echoed back on replay). */
			thoughtSignature?: string;
			/** Upstream identity that minted the thought signature. */
			thoughtSignatureSource?: string;
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
	"StructView",
	"WebSearch",
	"WebFetch",
	"EnterPlanMode",
	"ExitPlanMode",
	"StartPipeline",
	"ExtractPipeline",
	"Bash",
	"Agent",
	"Await",
	"Send",
	"TeamStatus",
	"AskUserQuestion",
	"Skill",
	"LearningGuide",
]);

// === Agent config ===

// Single source of truth for the reasoning-effort tier union (shared with the
// frontend). Re-exported here so existing importers keep their import path.
import { clampReasoningEffort, type ReasoningEffort } from "@shared/reasoning-effort";

export type { ReasoningEffort };

export interface RuntimeSettingsOverride {
	model?: string | null;
	reasoningEffort?: ReasoningEffort | null;
}

export interface AgentHistoryReplacement {
	history: unknown[];
	pendingToolResults: unknown[];
	systemPrompt?: string;
}

export interface AgentConfig {
	/** Freeze an already-recorded numeric cache at input preparation; never rebuild on this path. */
	freezeContextComposition?: (
		counts: import("@shared/context-usage").ContextInputCharacters | null,
		requestId: string,
		startedAt: string,
	) => import("@shared/context-composition").ContextCharCache | null;
	narratorId: string;
	conversationId: string;
	model: string;
	provider: string;
	cwd: string;
	systemPrompt?: string;
	/** Host telemetry for the actual provider-formatted tool payload; failures are non-fatal. */
	onToolsCharacters?: (toolsChars: number) => void | Promise<void>;
	locale?: string;
	signal: AbortSignal;
	/** Chapter ID the narrator belongs to (passed through to ToolContext) */
	chapterId?: string;
	/** Resolved by server runtime assembly; DB authorization remains the final authority. */
	runtimePolicy?: RuntimePolicy;
	/** Parent narrator ID — set for subagents, passed through to ToolContext for Team tracking */
	parentNarratorId?: string;
	/** Parent Agent/Task/Send tool_use that spawned this subagent. */
	parentToolUseId?: string;
	/** Stable file-change provenance segment inherited by this run. */
	executionSegmentId?: string;
	maxTurns?: number;
	planMode?: boolean;
	/** Current narrator permission mode; used for relaxed-plan safety checks. */
	permissionMode?: string;
	/** Review follow-up subagents may run only the constrained read-only Git Bash policy. */
	reviewReadOnlyBash?: boolean;
	/** Legacy permission mode snapshot from before entering plan mode; retained for migration/UI context. */
	previousPermissionMode?: string;
	/** When true, plan mode does NOT disable tool descriptions — tools remain fully available */
	relaxedPlan?: boolean;
	/**
	 * Whether plan mode accepts inline plans (the `inline_plan` parameter of ExitPlanMode).
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
	/** Plan file path — set during plan mode, passed to EnterPlanMode tool for the result prompt */
	planFilePath?: string;
	/** Resolve an ephemeral prepared plan path for a specific EnterPlanMode tool call. */
	getPlanFilePathForTool?: (toolUseId: string) => string | undefined;
	/** Skill scan root — legacy project gitPath or git root resolved from cwd */
	skillRoot?: string;
	/** Project git path used to resolve project-level skills for this context. */
	projectGitPath?: string | null;
	/** Active chapter worktree root, used for cwd recovery suggestions. */
	worktreePath?: string | null;
	/** Resolved skill summary cache scope key for this context. */
	skillScopeKey?: string;
	/** User who triggered this loop turn — flows into ToolContext.userId for knowledge ACL. */
	userId?: string | null;
	/** Project this narrator belongs to — scopes knowledge injection to this project + global. */
	projectId?: string | null;
	/**
	 * Default execution device for this session (from SwitchDevice or the global
	 * default). undefined/null → local server. Flows into ToolContext so file/
	 * command tools route their IO to the right backend.
	 */
	defaultDeviceId?: string | null;
	/**
	 * Devices this session may route to (online + authorized). Empty/undefined →
	 * only local, and tools hide the `device` parameter + SwitchDevice entirely.
	 */
	availableDevices?: import("./execution/backend").DeviceSummary[];
	/** Frozen backend/target supplied to preflight gates such as ExitPlanMode reflection. */
	executionBackend?: import("./execution/backend").ExecutionBackend;
	executionTarget?: ToolExecutionTarget;
	/**
	 * Persist + apply a new session default device (SwitchDevice tool). Flows
	 * into ToolContext.setDefaultDevice. Absent → SwitchDevice reports failure.
	 */
	setDefaultDevice?: (deviceId: string | null) => Promise<boolean>;
	/** Checks at both permission and final execution admission; stale passes fail closed. */
	assertWorkspaceCurrent?: () => void;
	/** Frozen workspace identity for this pass; background closures retain it. */
	workspaceContext?: import("@shared/workspace-context").WorkspaceContext;
	/** Commit a strict-serial switch without waiting for the invoking loop. */
	switchWorkingDirectory?: (
		request: import("@shared/workspace-context").SwitchWorkingDirectoryRequest,
	) => Promise<import("@shared/workspace-context").SwitchWorkingDirectoryResult>;
	/**
	 * Persist the immutable primary execution identity before a routed tool enters permission handling.
	 * Rejecting this callback prevents execution so audit state cannot silently diverge.
	 */
	onExecutionTargetResolved?: (
		toolUseId: string,
		target: ToolExecutionTarget,
		binding?: ToolCallBinding,
	) => Promise<void>;
	/** Persist the complete endpoint plan for multi-target audit and retry. */
	onExecutionPlanResolved?: (
		toolUseId: string,
		plan: ToolExecutionPlan,
		binding?: ToolCallBinding,
	) => Promise<void>;
	/** Required on production runners; bare legacy/reflection callers remain compatible. */
	requireToolCallBinding?: boolean;
	/** Object-keyed receipts populated by this loop's persistence barriers, not provider ids. */
	toolExecutionBindings?: WeakMap<AgentToolUse, ToolCallBinding>;
	onInternalReadAuthorization?: (
		parentToolUseId: string,
		binding: ToolCallBinding,
	) => Promise<void>;
	/** Internal Read rows share the parent's message without adding model history blocks. */
	onInternalReadCreated?: (
		parentToolUseId: string,
		parentBinding: ToolCallBinding,
		input: Record<string, unknown>,
		sequence: number,
	) => Promise<{ toolUseId: string; binding: ToolCallBinding }>;
	onInternalReadCompleted?: (
		toolUseId: string,
		binding: ToolCallBinding,
		result: ToolResult & { durationMs?: number },
	) => Promise<void>;
	/** Fail-open observation after authorization/final admission, before the durable start claim. */
	onToolExecutionBefore?: (context: ToolExecutionLifecycleContext) => Promise<void> | void;
	/** Paired cleanup, including thrown/aborted execution; awaited before executeTool settles. */
	onToolExecutionAfter?: (
		context: ToolExecutionLifecycleContext & { result?: ToolResult; error?: unknown },
	) => Promise<void> | void;
	/**
	 * Persist an already-started tool's final result after the bounded abort drain
	 * closed its event consumer. Never routes through a newer run's streaming state
	 * or runs model/context hooks. The host must fence writes by toolCallBinding.
	 */
	onDetachedToolResult?: (event: Extract<AgentEvent, { type: "tool_result" }>) => Promise<void>;
	/** Durable single-start claim immediately before tool.execute, after authorization. */
	onToolExecutionStarting?: (
		toolUseId: string,
		binding: ToolCallBinding,
		startedAt: number,
	) => Promise<ToolCallBinding>;
	/**
	 * Shared de-dup set of knowledge-base entry ids already injected in the current compact
	 * cycle. Passed in by the session runner so passive injection at the user-message point
	 * (point A) and the tool-output scan point (point B) share one set across loop passes, and
	 * so it can be cleared when a compact boundary is crossed. When omitted, the loop falls back
	 * to a fresh per-call set (legacy behaviour for standalone/test callers).
	 */
	knowledgeInjectedEntryIds?: Set<string>;
	/** Compact cycle seq used when persisting knowledge-injection ledger events. */
	knowledgeInjectionCompactSeq?: number;
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
	/** Optional hard allow-list. Unlike toolFilter, this is enforced again at execution time. */
	allowedTools?: Set<string> | string[];
	/** Whether routed tools may execute on the NarraFork server itself. Defaults to true. */
	allowLocalExecution?: boolean;
	/** Live authorization check performed immediately before every tool call. */
	runtimeAuthorizationGuard?: () => Promise<void>;
	/** Real policy rejudgment after all preparation/slot waits; its synchronous fence
	 *  is checked immediately before tool.execute, not as an observer. */
	onToolExecutionFinalAuthorization?: (
		context: ToolFinalStartAuthorizationContext,
	) => Promise<ToolFinalStartAuthorizationTicket>;
	/** Skills blocked by narrator custom traits. `all` hides the Skill tool entirely. */
	blockedSkills?: { all: boolean; names: string[] } | null;
	/** Custom description appended to Agent.model schema when narrator traits restrict subagent models. */
	subagentModelRestrictionDescription?: string | null;
	/** Internal bounded reflection loop context. */
	reflectionLoop?: ReflectionLoopConfig;
	permissionHandler: (
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
		options?: PermissionHandlerOptions,
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
	) => Promise<AgentHistoryReplacement | null>;
	/** Latest context-window occupancy observed by the caller. */
	getContextUsagePercentage?: () => number | undefined;
	/**
	 * Called once for a consecutive reasoning-only dead-turn sequence when context
	 * occupancy is above 95%. The caller should wait for blocking compact, then
	 * return rebuilt history so the retry cannot reuse stale pre-compact context.
	 */
	onReasoningOnlyHighContext?: (
		contextUsagePercentage: number,
		signal: AbortSignal,
	) => Promise<AgentHistoryReplacement | null>;
	/**
	 * Text to fold into the next turn from producers that persist their own message row.
	 *
	 * The successor to the retired side-car channel. A producer using this has ALREADY
	 * written what it has to say into the conversation (see `narrator-injection.ts`), so
	 * the loop only needs the words for the turn that is about to be sent — it must not
	 * persist anything, or the same content would appear twice.
	 *
	 * Called once per turn, after tool results are settled.
	 */
	getAfterToolsInjections?: () =>
		| Promise<string | { text: string; onConsumed?: () => void }>
		| string
		| { text: string; onConsumed?: () => void };
	/** Exact source history adopted at the provider-input boundary, never during preparation. */
	onModelInputConsumed?: (sourceHistory: unknown[], content: string) => void;
	/**
	 * Persist a reminder the LOOP itself produced as its own message row.
	 *
	 * The loop cannot reach `narrator-injection` directly — it sits under `lib/` and must
	 * not depend on `services/` — so the host injects this. Reminders raised here
	 * (silent-progress, plan-mode, knowledge hints, pipeline checks) are the last
	 * producers that still appended their text INSIDE a tool result's string; with this
	 * they become rows like every other injection.
	 *
	 * Returns the text to fold into the current turn, or "" when the host declined
	 * (missing hook, write failure). Callers must treat a failure as "not delivered"
	 * rather than falling back to a side-car, or the content would arrive twice.
	 */
	deliverInjectionRow?: (injection: {
		source: string;
		content: string;
		body?: import("@shared/sidecar-body").SideCarBody;
		/** Tool call this reminder was raised about, when it was about one. */
		toolUseId?: string;
		/**
		 * Knowledge-base hits to record once the row is durable.
		 *
		 * Recorded by the host rather than here because the de-dup key lives in the
		 * database: writing the record before the content lands would permanently suppress
		 * re-injecting those entries after a compact reloads the set from that table.
		 */
		knowledgeInjection?: KnowledgeInjectionRecord;
		/**
		 * Pipeline state to acknowledge once the row is durable.
		 *
		 * Same ordering requirement as `knowledgeInjection`, and the same reason it is the
		 * host's job: acknowledging before the reminder is stored would clear the pending
		 * flag for a warning the model never received.
		 */
		pipelineExitConfirmationStateId?: string;
	}) => Promise<string> | string;
	/**
	 * Completed-tool count to resume from, persisted by the caller across loop runs.
	 *
	 * Cadence-driven injections are measured against this counter, so starting from zero on
	 * a resumed session would read its whole history as one overdue interval.
	 */
	initialCompletedToolCount?: number;
	/** Called whenever the completed-tool counter advances, so the caller can persist it. */
	onCompletedToolCount?: (completedToolCount: number) => void;
	/**
	 * Called at request boundaries (including the first request and retries) to check
	 * whether runtime settings should switch. May await policy/model inheritance
	 * resolution; synchronous callers remain supported. Never aborts in-flight work.
	 */
	getRuntimeSettingsOverride?: () =>
		| RuntimeSettingsOverride
		| null
		| Promise<RuntimeSettingsOverride | null>;
	/**
	 * Legacy model-only override hook. Prefer getRuntimeSettingsOverride for new callers.
	 * Returns the new model string (e.g. "nug:claude-opus-4.6") or null to keep current.
	 */
	getModelOverride?: () => string | null;
	/**
	 * Called after each serial tool or complete parallel-safe group. If true,
	 * the loop exits gracefully and marks later tool calls in the turn as skipped.
	 */
	shouldStop?: () => boolean;
	/** Event-driven immediate guidance: cancel the provider and unstarted preparation,
	 * but drain actual running tools. Supply a fresh signal for each loop invocation. */
	guidanceSignal?: AbortSignal;
	/** Urgent guidance: cancel provider and tool IO, then persist results and soft-stop.
	 * Unlike signal, this does not mark the whole narrator run as user-interrupted. */
	urgentGuidanceSignal?: AbortSignal;
	/** Internal synchronous boundary after the final fences, immediately before tool.execute. */
	onToolExecutionInvoking?: (toolUse: AgentToolUse) => void;
	/**
	 * Disable streaming-time eager tool execution so shouldStop boundaries can
	 * guarantee that later serial tools have not already started.
	 */
	deferEagerToolsForSafeStop?: boolean;
	/**
	 * Maximum number of transient-error retries within a single provider.chat()
	 * call.  When exceeded the loop yields `retryable_error` and returns.
	 * Defaults to 0 (no in-loop retry — caller handles it).
	 */
	maxTransientRetries?: number;
	/** Maximum distinct tool calls in one provider response (default 32, range 1–128). */
	maxToolCallsPerResponse?: number;
	/** Interrupt the owning narrator when a response exceeds its tool-call limit. */
	onToolCallLimitExceeded?: (limit: number) => void;
	/**
	 * Number of completed tool calls without visible text before a progress sidecar is injected.
	 * -1 disables the reminder. Defaults to 20.
	 */
	silentToolCallThreshold?: number;
	/** Number of unused Pipeline tool calls before the next non-control call auto-clears captures. */
	pipelineUnusedToolCallThreshold?: number;
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
 * DeepSeek's reasoning_effort param only accepts "high" and "max". Uses the
 * shared clamp (就近、并列偏高): low/medium → high, xhigh/max → max.
 */
export function mapDeepSeekEffort(reasoningEffort: string | undefined): "high" | "max" | undefined {
	if (!reasoningEffort || reasoningEffort === "none") return undefined;
	return clampReasoningEffort(reasoningEffort as ReasoningEffort, ["high", "max"]) as
		| "high"
		| "max";
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Base delay for transient-error retries (ms). Used by both the agent loop
 *  (in-loop retry) and the outer narrator session retry. */
export const TRANSIENT_RETRY_BASE_MS = 5_000;
