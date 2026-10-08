/**
 * Types shared between the protocol layer and the host agent loop.
 *
 * These are the canonical definitions. `server/lib/agent/types.ts` re-exports
 * them so host code keeps its existing import path, while bundled plugin code
 * can reach them without importing anything under `server/`.
 *
 * Only definitions the protocol layer genuinely needs live here. Loop-internal
 * types (tool registry entries, permission state, session bookkeeping) stay in
 * the host's `types.ts`.
 */

import type { ModelMetadata } from "../model-catalog/schema/catalog";

/** Immutable reference-rate snapshot captured when the upstream request starts.
 * null means captured unknown, never permission to consult a later catalog. */
export interface ReferencePricingSnapshot {
	referencePricing: NonNullable<ModelMetadata["referencePricing"]> | null;
	catalogVersion: string;
	localRevision: number;
	modelId?: string;
}

// === API error and bounded diagnostics ===

export type ApiRequestDiagnosticSource =
	| "gateway"
	| "channel"
	| "provider"
	| "transport"
	| "parser";

export interface ApiRequestDiagnostics {
	/** Present only for the first-party TokenDance connection, never inferred from model names. */
	tokendanceRecoveryAction?: import("../tokendance").TokenDanceRecoveryAction;
	schema: "narrafork.error-diagnostics.v1";
	source?: ApiRequestDiagnosticSource | string;
	phase?: string;
	statusCode?: number;
	code?: string | number;
	reason?: string;
	errorType?: string;
	message?: string;
	responseSnippet?: string;
	requestId?: string;
	providerRequestId?: string;
	provider?: string;
	model?: string;
	channelName?: string;
	channelType?: string;
	endpoint?: string;
	transport?: string;
	retryable?: boolean;
	/**
	 * True when client-visible payload was already forwarded before this
	 * error occurred AND the failure is a transient transport/stream issue
	 * (not quota/billing/content-violation). Distinct from `retryable`:
	 * retrying the whole request is not safe once payload was forwarded, but
	 * appending a continuation turn from the partial output is. Mutually
	 * exclusive with `retryable` in practice.
	 */
	resumable?: boolean;
	responseHeaders?: Record<string, string>;
	cause?: string;
}

// === Reasoning continuation metadata ===

/** Provider-specific metadata attached to reasoning blocks for continuation support. */
export interface ReasoningProviderMetadata {
	openai?: {
		/** The reasoning item ID from the Responses API */
		itemId?: string;
		/** Encrypted reasoning content for continuation across turns */
		reasoningEncryptedContent?: string | null;
		/** Native plaintext is replayable; summaries and unmarked legacy text are not. */
		textFormat?: "reasoning_text" | "summary_text" | "mixed";
	};
	anthropic?: {
		/** Provider-native content block index for this thinking block. */
		blockIndex?: number;
		/** Signature for thinking block verification (must be echoed back in subsequent turns) */
		signature?: string;
	};
	gemini?: {
		/** Interactions API thought step ID, used to keep streamed thought blocks separate. */
		stepId?: string;
		/** Interactions API output step index, used when a thought step has no ID. */
		stepIndex?: number;
		/** Opaque thought signature that must be echoed back on subsequent turns. */
		thoughtSignature?: string;
	};
	/**
	 * Stable identity ("provider:channel") of the upstream that minted this
	 * block's reasoning credential — the Anthropic thinking `signature`, the
	 * OpenAI Responses `encrypted_content`, or the Gemini thought signature.
	 * Credentials are only valid against the server that produced them, so on
	 * replay we compare this against the current provider's source and drop the
	 * credential when they differ (see `reasoning-source.ts`). Absent on
	 * messages persisted before this field existed.
	 */
	signatureSource?: string;
}

// === Tool use ===

export interface AgentToolUse {
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
	/** Timestamp (ms) when the first streaming chunk for this tool use arrived */
	streamStartedAt?: number;
	/** Timestamp (ms) when the provider finished streaming this tool input. */
	streamCompletedAt?: number;
	/** Provider-native content block index for interleaved ordering. */
	outputIndex?: number;
	/**
	 * Gemini 3 thought signature attached to this functionCall part. Must be
	 * echoed back on the functionCall part in stateless history replay, or the
	 * API rejects the next turn with a 400 (missing thought_signature).
	 */
	thoughtSignature?: string;
	/** Upstream identity that minted thoughtSignature; required for safe replay. */
	thoughtSignatureSource?: string;
}

// === Knowledge-injection bookkeeping ===

/**
 * Knowledge-base hits an injection surfaced, carried alongside the content so the host
 * can record them ONCE the content is durable.
 *
 * Recorded by the host rather than the producer because the de-dup key lives in the
 * database: writing the record before the row lands would permanently suppress
 * re-injecting those entries after a compact reloads the set from that table.
 */
export interface KnowledgeInjectionRecord {
	narratorId: string;
	compactSeq: number;
	triggerToolCallId?: string | null;
	hits: Array<{
		entryId: string;
		entryRevisionId?: string | null;
		summary?: string | null;
	}>;
}

// === Provider stream protocol ===
//
// The canonical definitions of the events and message shapes exchanged between
// a provider adapter and the agent loop. `server/lib/agent/provider.ts`
// re-exports these so host code keeps its existing import path.

// === Web search action types (matches OpenAI Responses API web_search_call action) ===

export interface WebSearchAction {
	type: string;
	query?: string;
	queries?: string[];
	url?: string;
	pattern?: string;
}

// === Provider-agnostic DB types (used by buildHistory) ===

export interface DbMessage {
	id: string;
	/** Original owner narrator for this persisted message row. */
	narratorId?: string;
	role: "user" | "assistant" | "system" | "sys" | "disp";
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

export interface BuiltHistory {
	history: unknown[];
	trailingToolResults: unknown[];
	trailingUserText?: string;
}

// === Stream event emitted by provider.chat() ===

/**
 * A single source citation reported by a provider for assistant text.
 *
 * Providers report positions in their own text coordinates, which may still
 * contain internal citation markers. The agent loop is responsible for
 * remapping these onto the cleaned text before persisting.
 */
export interface ProviderTextCitation {
	/** Start of the cited range in provider text coordinates. */
	startIndex?: number;
	/** End of the cited range; the reference number renders here. */
	endIndex: number;
	url?: string;
	title?: string;
	/** Provider-internal reference id (never rendered verbatim). */
	sourceRef?: string;
	/** Provider-native content block index this citation belongs to. */
	outputIndex?: number;
}

export interface ParsedStreamEvent {
	text?: string;
	/** Provider-native lane identity, including the content part within an output item. */
	textBlockId?: string;
	/** Provider-native reasoning item identity (not an individual summary fragment). */
	reasoningBlockId?: string;
	/** Native content lifecycle. Checkpoints never finalize credentials or split replay items. */
	contentBoundary?: {
		kind: "text" | "reasoning";
		phase: "start" | "checkpoint" | "complete";
		blockId?: string;
		outputIndex?: number;
	};
	/** Provider-native content block index for the text block (e.g. Anthropic SSE event.index). */
	textOutputIndex?: number;
	toolUses?: AgentToolUse[];
	messageId?: string;
	conversationId?: string;
	reasoning?: string;
	/** Provider metadata for reasoning continuation (Codex encrypted content, item ID) */
	reasoningMetadata?: ReasoningProviderMetadata;
	/** Provider-native ordering index for a reasoning block (e.g. OpenAI Responses output_index). */
	reasoningOutputIndex?: number;
	/** Redacted Anthropic thinking block that must be echoed back with the assistant turn. */
	redactedThinking?: { data: string; outputIndex?: number };
	contextUsagePercentage?: number;
	metering?: { unit: string; unitPlural: string; usage: number };
	invalidState?: { reason: string; message: string; diagnostics?: ApiRequestDiagnostics };
	/** Gateway credential ID that served this request */
	credentialId?: string;
	/** Gateway-injected queue status (generic, for providers via unified gateway) */
	queueStatus?: { position?: number; queueDepth?: number; queueMessage?: string };
	/** Gateway-injected quota balance (generic, for providers via unified gateway).
	 *  Accepts arbitrary string values (e.g. "$12.50", "100 credits") from the gateway. */
	quotaBalance?: string | null;
	/** Optional multiline quota details to show in the quota tooltip. */
	detailedQuotaBalance?: string | null;
	/** NUG model catalog update sent when the client's cached model hash is stale. */
	nugModelCatalog?: { modelHash?: string; models: Array<Record<string, unknown>> };
	/** NUG image-cache confirmation: these refs are cached and can be sent as ref-only later. */
	nugImageCacheAck?: { refs: string[] };
	/** Streaming tool use chunk — accumulated by the loop */
	toolUseChunk?: {
		toolUseId: string;
		name?: string;
		input?: string;
		/** Authoritative arguments at a provider completion boundary, not necessarily an append. */
		finalInput?: string;
		stop?: boolean;
		/** Provider-native content block index (e.g. Anthropic SSE event.index). */
		outputIndex?: number;
		/** Gemini 3 thought signature attached to this functionCall part. */
		thoughtSignature?: string;
		/** Upstream identity that minted the thought signature. */
		thoughtSignatureSource?: string;
	};
	/** Token usage info from OpenAI-compatible APIs (used to compute context usage %) */
	usage?: {
		/** Total prompt footprint occupying context window; may include cache read/write depending on provider. */
		promptTokens?: number;
		/** Raw uncached input tokens billed as normal input. */
		inputTokens?: number;
		completionTokens?: number;
		/** Reasoning tokens (o1/o3 models) */
		reasoningTokens?: number;
		/** Cached input tokens (prompt caching read/hit) */
		cachedInputTokens?: number;
		/** Cache creation / write tokens */
		cacheCreationInputTokens?: number;
		cacheCreation5mTokens?: number;
		cacheCreation1hTokens?: number;
		/** Provider-specific effective context window used for this usage snapshot. */
		contextWindow?: number;
	};
	/** Web search lifecycle event from Responses API (Codex native web_search tool) */
	webSearch?: {
		id: string;
		status: "in_progress" | "searching" | "completed";
		/** Search query (available on completion) */
		query?: string;
		queries?: string[];
		/** Provider-native ordering index for this search block. */
		outputIndex?: number;
		/** True when this event is the final output_item.done payload. */
		final?: boolean;
		/** Full action object from the API (search/open_page/find_in_page). */
		action?: WebSearchAction;
	};
	/** Image generation lifecycle event from Responses API (Codex native image_generation tool) */
	imageGeneration?: {
		id: string;
		status: string;
		/** Revised prompt used by the model (available on completion) */
		revisedPrompt?: string;
		/** Base64-encoded image data (available on completion) */
		result?: string;
		/** 0-based index for a streamed partial image preview. */
		partialImageIndex?: number;
		/** Base64-encoded complete preview image from partial_image events. */
		partialImageB64?: string;
		/** Saved partial image path after event handling. */
		partialSavedPath?: string;
		/** Saved final image path after event handling. */
		savedPath?: string;
		width?: number;
		height?: number;
		/** Provider-native ordering index for this image generation block. */
		outputIndex?: number;
		/** True when this event is the final output_item.done payload. */
		final?: boolean;
	};
	/**
	 * Source citations attached to assistant text (native web search).
	 * Indices address the provider's own accumulated text for `outputIndex`;
	 * the loop remaps them onto the cleaned visible text.
	 */
	textCitations?: ProviderTextCitation[];
	/** Response ID from OpenAI Responses API (resp_...) for previous_response_id chaining */
	responseId?: string;
	/** Internal: set when Responses API format is detected from the gateway */
	_responsesApi?: boolean;
	/** Stop reason from message_delta (Anthropic) or finish_reason (OpenAI) */
	stopReason?: string;
	/** Upstream socket closed and the turn should end quietly without surfacing an error. */
	silentDisconnect?: boolean;
}
