import { randomUUID } from "node:crypto";
import { computeFingerprint } from "../fingerprint";
import { generateId } from "../id";
import { logger } from "../logger";
import { resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import { shouldUseNativeSearch } from "../search/native";
import type { AnthropicProviderConfig } from "../settings";
import { getModelContextWindow, getSettingsRevision, parseModelId, settings } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import { extractAnthropicUsage } from "../usage-tracking";
import { getHttpClaudeCliUserAgent, getHttpUserAgent, resolveHttpUserAgent } from "../user-agent";
import { isConnectionClosedError } from "./error-handling";
import { isGatewayEventType, parseGatewayDataEvent, parseGatewaySSEEvent } from "./gateway-events";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import { signatureSourcesCompatible } from "./reasoning-source";
import { sanitizeHeaders } from "./request-dump";
import { recordRequestUrl } from "./request-url-tracker";
import {
	appendSideCarsForApi,
	outputToText,
	sideCarsForToolResult,
	sideCarsForUserMessage,
} from "./sidecar";
import { resolveToolJsonSchema } from "./tool-registry";
import {
	type AgentToolUse,
	ApiError,
	isDeepSeekModel,
	mapDeepSeekEffort,
	type ResolvedToolDefinition,
} from "./types";

// === Claude Code protocol constants ===

/** Maximum number of server-side web searches per API call. */
const WEB_SEARCH_MAX_USES = 8;

/**
 * Beta flags matching Claude Code CLI protocol exactly.
 * Matches getMergedBetas() output for firstParty agentic queries.
 * Synced with Claude Code CLI v2.1.88.
 */
const ANTHROPIC_BETA_FLAGS =
	"claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07,adaptive-thinking-2026-01-28,prompt-caching-scope-2026-01-05,effort-2025-11-24,redact-thinking-2026-02-12,context-management-2025-06-27";

/**
 * Minimal beta flags for non-official Anthropic-compatible relays.
 * Only the flags required for the effort parameter to be honored — we avoid
 * sending the full Claude-Code-specific flag set (claude-code-*, context-1m,
 * context-management, etc.) to generic relays that may reject unknown betas.
 */
const ANTHROPIC_EFFORT_BETA_FLAGS = "adaptive-thinking-2026-01-28,effort-2025-11-24";

/** Claude Code CLI version used for billing header fingerprint. */
const CC_CLI_VERSION = "2.1.88";

/** Base beta flag for non-chat requests (model listing, generate). */
const ANTHROPIC_BASE_BETA = "claude-code-20250219";

/** Cache control marker for ephemeral prompt caching. */
const CACHE_CONTROL = { cache_control: { type: "ephemeral" as const } };

/** Cache control marker with global scope (for system prompt prefix blocks). */
const CACHE_CONTROL_GLOBAL = {
	cache_control: { type: "ephemeral" as const, scope: "global" as const },
};

/** Default Anthropic API base URL (includes /v1 path). */
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Process-wide cache of base URLs that have been resolved to need a `/v1`
 * suffix. Keyed by the normalized (trailing-slash-stripped) base URL.
 *
 * AnthropicProvider instances are created fresh per chat turn (see
 * createProviderByName), so an instance-level cache would be lost between
 * messages — every message in a long session would pay the fallback cost
 * (e.g. a multi-second connection RST against the wrong path) again. This
 * module-level cache ensures each base URL only pays that cost once per
 * process. The stored settings revision invalidates the entry if the user
 * later edits provider settings.
 */
const v1FallbackCache = new Map<string, { revision: number }>();

/** Debounce window for the base-URL fix suggestion broadcast (per base URL). */
const BASEURL_FIX_BROADCAST_DEBOUNCE_MS = 30_000;
/** Last broadcast timestamp keyed by normalized base URL. */
const lastBaseUrlFixBroadcast = new Map<string, number>();

/**
 * Broadcast a `provider_baseurl_fix_suggested` event to all WS clients
 * (debounced per base URL). Fired whenever a `/v1` fallback succeeds for a
 * base URL that lacks `/v1`, so the frontend can offer to persist the fix.
 * Lazy-imports narrator-ws to avoid a circular dependency.
 */
async function broadcastBaseUrlFixSuggested(info: {
	providerId: string;
	providerPrefix: string;
	providerName: string;
	currentBaseUrl: string;
	suggestedBaseUrl: string;
}): Promise<void> {
	const now = Date.now();
	const last = lastBaseUrlFixBroadcast.get(info.currentBaseUrl) ?? 0;
	if (now - last < BASEURL_FIX_BROADCAST_DEBOUNCE_MS) return;
	lastBaseUrlFixBroadcast.set(info.currentBaseUrl, now);
	try {
		const { broadcastToAll } = await import("../../websocket/narrator-ws");
		broadcastToAll({ type: "provider_baseurl_fix_suggested", ...info });
	} catch {
		// WS module not loaded yet — ignore
	}
}

/**
 * Stable device ID — generated once per process lifetime.
 * Real Claude Code CLI persists this to disk; we keep it per-process which is
 * sufficient for rate-limit / session-tracking purposes.
 */
const DEVICE_ID = generateId();

/** xxHash64 seed for cch attestation (from Bun's Attestation.zig). */
const CCH_SEED = 0x6e52736ac806831en;

/** Placeholder for cch in billing header — replaced after body serialization. */
const CCH_PLACEHOLDER = "cch=00000";

/**
 * Compute cch attestation hash from serialized request body.
 * Algorithm: xxHash64(body, seed=0x6E52736AC806831E) & 0xFFFFF → 5-char hex.
 *
 * The body must contain the "cch=00000" placeholder when hashed — the hash is
 * computed over the body bytes including the placeholder, then the placeholder
 * is replaced with the computed value (same-length replacement).
 */
function computeCch(bodyStr: string): string {
	// Bun.hash supports a 3-arg overload (algo, data, seed) at runtime but
	// the TypeScript declarations don't expose it — cast via unknown to bypass.
	// biome-ignore lint/suspicious/noExplicitAny: Bun runtime API not fully typed
	const h = (Bun.hash as any)("xxhash64", bodyStr, CCH_SEED);
	if (typeof h !== "bigint") return "00000";
	return (h & 0xfffffn).toString(16).padStart(5, "0");
}

/**
 * Build billing header with dynamic fingerprint computation.
 * Format: cc_version={version}.{fingerprint}; cc_entrypoint=cli; cch=00000; cc_workload=interactive;
 *
 * The cch=00000 is a placeholder that gets replaced after body serialization
 * with the actual xxHash64-based attestation value.
 *
 * @param messages - Message history to compute fingerprint from
 * @returns Billing header string with cch placeholder
 */
function buildBillingHeader(messages: AnthropicMessage[]): string {
	// Extract first user message text for fingerprint computation
	let firstUserMessageText = "";
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (firstUserMsg) {
		const content = firstUserMsg.content;
		if (typeof content === "string") {
			firstUserMessageText = content;
		} else if (Array.isArray(content)) {
			const textBlock = content.find((block) => block.type === "text");
			if (textBlock && "text" in textBlock) {
				firstUserMessageText = textBlock.text as string;
			}
		}
	}

	// Compute fingerprint using Claude CLI version
	const fingerprint = computeFingerprint(firstUserMessageText, CC_CLI_VERSION);
	return `x-anthropic-billing-header: cc_version=${CC_CLI_VERSION}.${fingerprint}; cc_entrypoint=cli; ${CCH_PLACEHOLDER}; cc_workload=interactive;`;
}

/** Identity block injected as the second system block (matches Claude Code). */
const IDENTITY_BLOCK = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Apply cache_control breakpoints to maximize Anthropic prompt caching.
 *
 * System blocks already have cache_control set during construction (blocks 1 & 2).
 * We place additional breakpoints at:
 *   1. The last tool definition (tool list rarely changes)
 *   2–3. The last 2 content blocks in the message history (stable prefix)
 *
 * Total cache_control blocks: 2 (system) + 1 (tools) + up to 1 (messages) = 4 max.
 * Anthropic allows a maximum of 4 blocks with cache_control.
 */
function applyCacheBreakpoints(
	messages: AnthropicMessage[],
	tools: Array<Record<string, unknown>> | undefined,
): void {
	// First, strip any existing cache_control from all message content blocks.
	for (const msg of messages) {
		if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block && typeof block === "object" && "cache_control" in block) {
					delete (block as Record<string, unknown>).cache_control;
				}
			}
		}
	}

	// Breakpoint 1: last tool definition
	if (tools && tools.length > 0) {
		Object.assign(tools[tools.length - 1], CACHE_CONTROL);
	}

	// Breakpoint 2: last content block in message history (skip the current user turn).
	// We only place 1 message breakpoint (not 2) to stay within the 4-block limit
	// since system already uses 2 cache_control blocks.
	let placed = 0;
	for (let i = messages.length - 2; i >= 0 && placed < 1; i--) {
		const content = messages[i].content;
		if (Array.isArray(content) && content.length > 0) {
			let targetIdx = -1;
			for (let j = content.length - 1; j >= 0; j--) {
				const blockType = (content[j] as { type?: string }).type;
				if (blockType !== "thinking" && blockType !== "redacted_thinking") {
					targetIdx = j;
					break;
				}
			}
			if (targetIdx >= 0) {
				Object.assign(content[targetIdx], CACHE_CONTROL);
				placed++;
			}
		} else if (typeof content === "string") {
			messages[i].content = [{ type: "text", text: content, ...CACHE_CONTROL }];
			placed++;
		}
	}
}

// === Anthropic message types ===

type CacheControl = { type: "ephemeral" };

type AnthropicContentPart =
	| { type: "text"; text: string; cache_control?: CacheControl }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
			cache_control?: CacheControl;
	  }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
			cache_control?: CacheControl;
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			content:
				| string
				| Array<
						| { type: "text"; text: string }
						| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				  >;
			is_error?: boolean;
			cache_control?: CacheControl;
	  }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string };

/** Ensure content parts have at least one text or tool_use block (some APIs reject thinking-only messages). */
function ensureTextOrToolBlock(parts: AnthropicContentPart[]): void {
	const hasTextOrTool = parts.some((p) => p.type === "text" || p.type === "tool_use");
	if (!hasTextOrTool) {
		// Use "…" instead of "" — the API requires non-whitespace text content.
		parts.push({ type: "text", text: "…" });
	}
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentPart[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	cache_control?: { type: string };
}

// === Model capability detection ===

/** Whether a model supports extended thinking (Claude 3.7 Sonnet, Haiku 4.5+, Opus 4+, Sonnet 4+, DeepSeek). */
function supportsThinking(model: string): boolean {
	const lower = model.toLowerCase();
	// DeepSeek models support thinking mode via Anthropic-compatible API
	if (lower.includes("deepseek")) return true;
	// Claude 3.7 Sonnet
	if (lower.includes("3-7") || lower.includes("3.7")) return true;
	// Claude 4+ families (opus-4, sonnet-4, haiku-4)
	if (lower.includes("opus-4") || lower.includes("sonnet-4") || lower.includes("haiku-4")) {
		return true;
	}
	return false;
}

/**
 * Whether a model supports adaptive thinking (Opus 4.6 / Sonnet 4.6).
 * Adaptive thinking lets the model dynamically decide how much to think.
 */
function supportsAdaptiveThinking(model: string): boolean {
	const lower = model.toLowerCase();
	return (
		lower.includes("opus-4-6") ||
		lower.includes("opus-4.6") ||
		lower.includes("sonnet-4-6") ||
		lower.includes("sonnet-4.6")
	);
}

/** Whether a model supports the effort parameter (Opus 4.6 / Sonnet 4.6). */
function supportsEffort(model: string): boolean {
	return supportsAdaptiveThinking(model);
}

/**
 * Get max_tokens limits for a model.
 * Returns { default, upperLimit } matching Claude Code behavior.
 */
function getTokenLimits(model: string): { default: number; upperLimit: number } {
	const lower = model.toLowerCase();
	// Opus 4.5/4.6, Sonnet 4/4.6, Haiku 4
	if (lower.includes("opus-4") || lower.includes("sonnet-4") || lower.includes("haiku-4")) {
		return { default: 32_000, upperLimit: 64_000 };
	}
	// Default for older models
	return { default: 32_000, upperLimit: 32_000 };
}

/**
 * Map reasoning effort to Anthropic thinking configuration.
 *
 * Matching Claude Code behavior (v2.1.71):
 *   - All supported models use `{ type: "adaptive" }` by default
 *   - `reasoningEffort === "none"` → `{ type: "disabled" }` (thinking off)
 *   - Any other value (or undefined) → `{ type: "adaptive" }`
 *
 * The old `{ type: "enabled", budget_tokens: N }` is deprecated by Anthropic
 * in favor of adaptive thinking for all models.
 *
 * DeepSeek (via Anthropic-compatible API) does not support `adaptive` —
 * use `{ type: "enabled", budget_tokens: N }` instead (budget_tokens is
 * ignored by DeepSeek but required by the schema). Effort is controlled
 * via `output_config.effort` (see chat method).
 */
function buildThinkingConfig(
	model: string,
	reasoningEffort: string | undefined,
):
	| { type: "adaptive" }
	| { type: "enabled"; budget_tokens: number }
	| { type: "disabled" }
	| undefined {
	if (!supportsThinking(model)) return undefined;

	// "none" explicitly disables thinking
	if (reasoningEffort === "none") {
		return { type: "disabled" };
	}

	// DeepSeek doesn't support adaptive thinking — use enabled with a
	// placeholder budget_tokens (DeepSeek ignores the value).
	if (isDeepSeekModel(model)) {
		return { type: "enabled", budget_tokens: 10000 };
	}

	// All supported models use adaptive thinking (matching Claude Code)
	return { type: "adaptive" };
}

/**
 * Map reasoning effort to Anthropic effort parameter value.
 * Only for models that support the effort API (Opus 4.6, Sonnet 4.6).
 *
 * Mapping: low → low, medium → medium, high → high, xhigh → high, max → max
 * "none" is not mapped (thinking is disabled, effort is irrelevant).
 * Anthropic does not expose an xhigh tier (only low/medium/high/max), so xhigh
 * clamps to high; max is sent through as the highest tier.
 */
function mapEffortParam(
	reasoningEffort: string | undefined,
): "low" | "medium" | "high" | "max" | undefined {
	if (!reasoningEffort || reasoningEffort === "none") return undefined;
	const map: Record<string, "low" | "medium" | "high" | "max"> = {
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: "max",
	};
	return map[reasoningEffort];
}

// === SSE event types ===

type AnthropicUsagePayload = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number | null;
		ephemeral_1h_input_tokens?: number | null;
	};
};

interface AnthropicStreamEvent {
	type: string;
	index?: number;
	message?: {
		id?: string;
		model?: string;
		usage?: AnthropicUsagePayload;
	};
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		text?: string;
		input?: Record<string, unknown>;
		thinking?: string;
		reasoning_content?: string;
		signature?: string;
		data?: string;
		// server_tool_use / web_search_tool_result fields
		tool_use_id?: string;
		content?:
			| Array<{
					title: string;
					url: string;
					snippet?: string;
					encrypted_content?: string;
					page_age?: string;
			  }>
			| { type: string; error_code: string };
	};
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
		stop_reason?: string;
		thinking?: string;
		reasoning_content?: string;
		signature?: string;
	};
	usage?: AnthropicUsagePayload;
	error?: { type?: string; message?: string; code?: number | string };
	/** Gateway-style top-level error code (e.g. writeSSEError emits {code, message, error}). */
	code?: number | string;
}

// === Tool call accumulator ===

interface ToolAccumEntry {
	id: string;
	name: string;
	args: string;
	emitted: boolean;
}

/** Accumulator for server-side tool calls (web_search). */
interface ServerToolAccumEntry {
	id: string;
	name: string;
	args: string;
	/** Extracted query from accumulated JSON */
	query?: string;
}

/** Cumulative Anthropic usage snapshot, mirroring Claude Code's updateUsage semantics. */
interface AnthropicUsageAccum {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationInputTokens: number;
	cacheCreation5mTokens: number;
	cacheCreation1hTokens: number;
}

function createAnthropicUsageAccum(): AnthropicUsageAccum {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
	};
}

function isPositiveTokenCount(value: number | null | undefined): value is number {
	return value != null && value > 0;
}

/**
 * Update cumulative usage from Anthropic streaming events.
 *
 * Anthropic sends cumulative totals, not deltas. Claude Code also guards input/cache
 * fields with `> 0` because `message_delta` may explicitly send zeroes for those
 * fields; those zeroes must not erase the real values from `message_start`.
 */
function updateAnthropicUsageAccum(
	usage: AnthropicUsageAccum,
	partUsage: AnthropicUsagePayload | undefined,
): void {
	if (!partUsage) return;
	if (isPositiveTokenCount(partUsage.input_tokens)) usage.inputTokens = partUsage.input_tokens;
	if (isPositiveTokenCount(partUsage.cache_read_input_tokens)) {
		usage.cachedInputTokens = partUsage.cache_read_input_tokens;
	}
	if (isPositiveTokenCount(partUsage.cache_creation_input_tokens)) {
		usage.cacheCreationInputTokens = partUsage.cache_creation_input_tokens;
	}
	if (partUsage.output_tokens != null) usage.outputTokens = partUsage.output_tokens;

	const cacheCreation = partUsage.cache_creation;
	if (cacheCreation?.ephemeral_5m_input_tokens != null) {
		usage.cacheCreation5mTokens = cacheCreation.ephemeral_5m_input_tokens;
	}
	if (cacheCreation?.ephemeral_1h_input_tokens != null) {
		usage.cacheCreation1hTokens = cacheCreation.ephemeral_1h_input_tokens;
	}
	if (
		partUsage.cache_creation_input_tokens == null &&
		(cacheCreation?.ephemeral_5m_input_tokens != null ||
			cacheCreation?.ephemeral_1h_input_tokens != null)
	) {
		usage.cacheCreationInputTokens = usage.cacheCreation5mTokens + usage.cacheCreation1hTokens;
	}
}

function anthropicPromptFootprintTokens(usage: AnthropicUsageAccum): number {
	return usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens;
}

function parsedUsageFromAnthropicAccum(
	usage: AnthropicUsageAccum,
	contextWindow?: number | null,
): ParsedStreamEvent {
	return {
		usage: {
			promptTokens: anthropicPromptFootprintTokens(usage),
			inputTokens: usage.inputTokens,
			completionTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens,
			cacheCreationInputTokens: usage.cacheCreationInputTokens,
			cacheCreation5mTokens: usage.cacheCreation5mTokens,
			cacheCreation1hTokens: usage.cacheCreation1hTokens,
			...(contextWindow != null && { contextWindow }),
		},
	};
}

function promptTokensFromAnthropicPayload(
	usage: AnthropicUsagePayload | undefined,
): number | undefined {
	if (!usage) return undefined;
	const inputTokens = usage.input_tokens ?? 0;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheCreation =
		usage.cache_creation_input_tokens ??
		(usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
			(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
	const total = inputTokens + cacheRead + cacheCreation;
	return total > 0 ? total : undefined;
}

function supportsOfficialAnthropic1mContext(model: string): boolean {
	const lower = parseModelId(model).model.toLowerCase();
	return (
		lower.includes("claude-sonnet-4") || lower.includes("opus-4-6") || lower.includes("opus-4.6")
	);
}

function getAnthropicEffectiveContextWindow(
	model: string,
	config: AnthropicProviderConfig,
): number | null {
	const configuredWindow = getModelContextWindow(model, config.prefix);
	if (config.officialApi && supportsOfficialAnthropic1mContext(model)) {
		return Math.max(configuredWindow ?? 0, 1_000_000);
	}
	return configuredWindow;
}

function calculateAnthropicContextPercent(
	usage: AnthropicUsagePayload | undefined,
	model: string,
	config: AnthropicProviderConfig,
): number | undefined {
	const promptTokens = promptTokensFromAnthropicPayload(usage);
	if (promptTokens == null) return undefined;
	const contextWindow = getAnthropicEffectiveContextWindow(model, config);
	if (!contextWindow) return undefined;
	return Math.min((promptTokens / contextWindow) * 100, 100);
}

/**
 * Anthropic native Messages API provider.
 *
 * Uses the Anthropic Messages API directly:
 *   POST /v1/messages with streaming via SSE
 *
 * Key differences from OpenAI:
 *   - System prompt is a top-level `system` field, not a message
 *   - Tool results are sent as user messages with tool_result content blocks
 *   - Streaming uses content_block_start/delta/stop events
 *   - Messages must strictly alternate user/assistant
 */
export class AnthropicProvider implements ProviderAdapter {
	private config: AnthropicProviderConfig;
	/** Whether to reject unauthorized TLS certs (default true). */
	private tlsRejectUnauthorized: boolean;
	/** Cached base URL after successful /v1 fallback resolution. */
	private resolvedBaseUrl?: string;
	/** Stable session ID — one per provider instance (≈ per narrator session). */
	private readonly sessionId = generateId();
	/**
	 * Reasoning-signature source identity to report instead of the configured
	 * prefix. Set by NUG when this provider is used as an `anthropic`-channel
	 * delegate so signatures are tagged with the NUG channel (e.g.
	 * `nug:anthropic`) rather than a bare `anthropic`.
	 */
	private reasoningSourceOverride?: string;

	constructor(config: AnthropicProviderConfig) {
		this.config = config;
		this.tlsRejectUnauthorized = config.tlsRejectUnauthorized !== false;
	}

	/** Override the reasoning-signature source identity (used by NUG delegates). */
	setReasoningSourceOverride(source: string | undefined): void {
		this.reasoningSourceOverride = source;
	}

	/**
	 * Proxy-aware fetch with optional TLS verification bypass. Resolves the
	 * proxy per target URL, honouring this provider's own proxy override
	 * (absent/"default" → global policy). Covers streaming and auxiliary
	 * summary/title calls alike.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const target = input instanceof Request ? input.url : input;
		recordRequestUrl(String(target), init?.method);
		const proxy = resolveProxyForUrl(target, this.config.proxy);
		const extra: Record<string, unknown> = {};
		if (proxy) {
			extra.proxy = proxy;
		}
		if (this.tlsRejectUnauthorized === false) {
			extra.tls = { rejectUnauthorized: false };
		}
		if (Object.keys(extra).length > 0) {
			// biome-ignore lint/suspicious/noExplicitAny: Bun-specific extensions on RequestInit
			return fetch(input, { ...init, ...extra } as any);
		}
		return fetch(input, init);
	}

	private applyExtraHeaders(headers: Record<string, string>): Record<string, string> {
		for (const [key, value] of Object.entries(this.config.extraHeaders ?? {})) {
			if (value) headers[key] = value;
		}
		return headers;
	}

	/**
	 * Resolve the User-Agent for this provider. Defaults follow the previous
	 * behaviour (Claude CLI UA for official API, narrafork UA otherwise) and can
	 * be overridden per provider via userAgentMode/customUserAgent.
	 */
	private resolveUserAgent(isOfficial: boolean): string {
		return resolveHttpUserAgent({
			mode: this.config.userAgentMode,
			custom: this.config.customUserAgent,
			fallback: isOfficial ? getHttpClaudeCliUserAgent() : getHttpUserAgent(),
		});
	}

	/** Get the effective base URL, using cached resolution if available. */

	private getBaseUrl(): string {
		if (this.resolvedBaseUrl) return this.resolvedBaseUrl;
		const normalized = (this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		// Honor a prior process-wide /v1 resolution for this base URL (unless the
		// user changed settings since, which bumps the revision).
		if (!AnthropicProvider.hasV1Suffix(normalized)) {
			const cached = v1FallbackCache.get(normalized);
			if (cached && cached.revision === getSettingsRevision()) {
				this.resolvedBaseUrl = `${normalized}/v1`;
				return this.resolvedBaseUrl;
			}
		}
		return normalized;
	}

	/** Whether a base URL already ends with /v1 (case-insensitive). */
	private static hasV1Suffix(url: string): boolean {
		return /\/v1\/?$/i.test(url);
	}

	/**
	 * Record a successful `/v1` fallback: cache it both on this instance and
	 * process-wide, and suggest the user persist the fix.
	 *
	 * @param originalBaseUrl - The normalized base URL that lacked `/v1`.
	 * @param retryBase - The working base URL (originalBaseUrl + "/v1").
	 */
	private recordV1Fallback(originalBaseUrl: string, retryBase: string): void {
		this.resolvedBaseUrl = retryBase;
		v1FallbackCache.set(originalBaseUrl, { revision: getSettingsRevision() });
		const suggestedBaseUrl = retryBase;
		void broadcastBaseUrlFixSuggested({
			providerId: this.config.id,
			providerPrefix: this.config.prefix,
			providerName: this.config.name || this.config.prefix,
			currentBaseUrl: this.config.baseUrl || originalBaseUrl,
			suggestedBaseUrl,
		});
	}

	/**
	 * Fetch with automatic /v1 suffix fallback.
	 *
	 * Triggers the `/v1` retry in two cases when the base URL lacks `/v1`:
	 *   1. The initial request returns a non-ok HTTP response (e.g. 404). This
	 *      is what small requests hit — the gateway answers quickly.
	 *   2. The initial request THROWS a connection-closed error (ECONNRESET /
	 *      "socket connection was closed unexpectedly"). Large request bodies on
	 *      a wrong path can make the gateway RST the connection before sending
	 *      any response, so case 1 never fires. Without this branch the error
	 *      propagates as a retryable error and the agent loop retries forever
	 *      against the same wrong path (observed as 0% success on long sessions).
	 *
	 * On a successful fallback the resolved base URL is cached (instance- and
	 * process-wide) and a fix suggestion is broadcast to clients.
	 */
	private async fetchWithV1Fallback(path: string, init: RequestInit): Promise<Response> {
		const baseUrl = this.getBaseUrl();
		const url = `${baseUrl}${path}`;
		// All requests go through the proxy-aware fetch so streaming and auxiliary
		// calls uniformly follow the global outbound proxy policy.
		const doFetch = this.pfetch.bind(this);
		const canFallback = !AnthropicProvider.hasV1Suffix(baseUrl);

		let response: Response;
		try {
			response = await doFetch(url, init);
		} catch (err) {
			// Connection reset before any response — retry with /v1 if possible.
			if (canFallback && isConnectionClosedError(err)) {
				const retryBase = `${baseUrl}/v1`;
				logger.debug("Anthropic request connection closed, retrying with /v1 suffix", {
					originalUrl: url,
					retryUrl: `${retryBase}${path}`,
					error: err instanceof Error ? err.message : String(err),
				});
				const retryResponse = await doFetch(`${retryBase}${path}`, init);
				if (retryResponse.ok) {
					this.recordV1Fallback(baseUrl, retryBase);
				}
				return retryResponse;
			}
			throw err;
		}

		if (!response.ok && canFallback) {
			const retryBase = `${baseUrl}/v1`;
			const retryUrl = `${retryBase}${path}`;
			logger.debug("Anthropic request failed, retrying with /v1 suffix", {
				originalUrl: url,
				retryUrl,
				status: response.status,
			});
			// Drain the failed response body to free the connection
			await response.text().catch(() => {});
			const retryResponse = await doFetch(retryUrl, init);
			if (retryResponse.ok) {
				this.recordV1Fallback(baseUrl, retryBase);
			}
			return retryResponse;
		}

		return response;
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		return tools.map(
			(tool): AnthropicTool => ({
				name: tool.name,
				description: tool.description,
				input_schema: {
					$schema: "https://json-schema.org/draft/2020-12/schema",
					...resolveToolJsonSchema(tool),
				},
			}),
		);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		_model: string,
		_narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		return buildAnthropicHistory(dbMessages, this.getActiveReasoningSource());
	}

	getActiveReasoningSource(): string | undefined {
		// A direct Anthropic-family provider is one upstream server, identified
		// by its configured prefix. Reasoning-signature source override lets NUG
		// reuse this provider as a delegate while tagging signatures with the NUG
		// channel identity instead.
		return this.reasoningSourceOverride ?? this.config.prefix;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		// Anthropic uses a top-level `system` field as an array of text blocks with cache_control.
		// We store it as a special marker at index 0 that chat() will extract.
		const h = history as AnthropicMessage[];
		h.unshift({
			role: "user",
			content: `__SYSTEM__:${systemPrompt}`,
		} as AnthropicMessage);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = this.config.apiKey;

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const history = [...(params.history as AnthropicMessage[])];
		const tools = params.tools as AnthropicTool[];

		// Extract system prompt from the marker message
		let systemPrompt: string | undefined;
		if (
			history.length > 0 &&
			typeof history[0].content === "string" &&
			history[0].content.startsWith("__SYSTEM__:")
		) {
			systemPrompt = history[0].content.slice("__SYSTEM__:".length);
			history.shift();
		}

		// Append tool results as user message with tool_result content blocks
		const toolResultParts: AnthropicContentPart[] = [];
		for (const tr of params.toolResults as Array<{
			tool_use_id: string;
			content:
				| string
				| Array<
						| { type: "text"; text: string }
						| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				  >;
			is_error?: boolean;
		}>) {
			toolResultParts.push({
				type: "tool_result",
				tool_use_id: tr.tool_use_id,
				content: tr.content,
				is_error: tr.is_error,
			});
		}

		// Append current user message
		if (params.content && params.content !== ".") {
			if (toolResultParts.length > 0) {
				const parts: AnthropicContentPart[] = [...toolResultParts];
				if (params.images?.length) {
					for (const img of params.images) {
						parts.push({
							type: "image",
							source: {
								type: "base64",
								media_type: `image/${img.format}`,
								data: img.base64,
							},
						});
					}
				}
				parts.push({ type: "text", text: params.content });
				history.push({ role: "user", content: parts });
			} else {
				const parts: AnthropicContentPart[] = [];
				if (params.images?.length) {
					for (const img of params.images) {
						parts.push({
							type: "image",
							source: {
								type: "base64",
								media_type: `image/${img.format}`,
								data: img.base64,
							},
						});
					}
				}
				parts.push({ type: "text", text: params.content });
				history.push({ role: "user", content: parts });
			}
		} else if (toolResultParts.length > 0) {
			history.push({ role: "user", content: toolResultParts });
		} else if (params.content) {
			history.push({ role: "user", content: [{ type: "text", text: params.content }] });
		}

		// Ensure messages alternate user/assistant
		const messages = ensureAlternating(history);

		// Final safety net: drop any assistant messages with empty/null content
		// before sending to the API. This catches edge cases where messages with
		// empty contentJson (e.g. interrupted streaming) slip through buildHistory.
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant") {
				const c = m.content;
				if (
					c == null ||
					(typeof c === "string" && c === "") ||
					(Array.isArray(c) && c.length === 0)
				) {
					logger.warn("Dropping empty assistant message before API call", {
						index: i,
						contentType: typeof c,
					});
					messages.splice(i, 1);
				}
			}
		}

		const model = parseModelId(params.model).model;
		const isDeepSeek = isDeepSeekModel(model);

		// Determine max_tokens based on model capabilities
		const tokenLimits = getTokenLimits(model);
		const maxTokens = tokenLimits.default;

		// Build thinking configuration
		const thinkingConfig = buildThinkingConfig(model, params.reasoningEffort);
		const thinkingEnabled = !!thinkingConfig && thinkingConfig.type !== "disabled";

		// When thinking is not enabled, strip thinking/redacted_thinking blocks from
		// history messages. Third-party Anthropic-compatible APIs (e.g. DeepSeek) may
		// return thinking blocks in their responses, which get persisted and replayed
		// in subsequent turns. If the model isn't recognized as supporting thinking,
		// sending these blocks back without a `thinking` config triggers a 400 error.
		if (!thinkingEnabled) {
			stripThinkingBlocks(messages);
		}

		// Even when thinking IS enabled, we must sanitize the history:
		// 1. Remove assistant messages that contain ONLY thinking blocks (orphaned
		//    from interrupted streaming). These cause "thinking blocks cannot be
		//    modified" API errors.
		// 2. Strip trailing thinking blocks from the last assistant message — the
		//    API requires assistant messages to end with text or tool_use, not
		//    thinking/redacted_thinking.
		if (thinkingEnabled) {
			filterThinkingOnlyAssistantMessages(messages);
			stripTrailingThinkingFromLastAssistant(messages);

			// DeepSeek Anthropic-compatible API doesn't support redacted_thinking,
			// and thinking mode requires thinking blocks on assistant messages.
			// Sanitize replayed Claude/Anthropic history before sending it.
			if (isDeepSeek) {
				sanitizeDeepSeekThinkingBlocks(messages);
			}
		}

		const isOfficial = !!this.config.officialApi;

		// Build system blocks — official API uses Claude Code 3-block structure,
		// proxy mode uses a simple text block.
		const systemBlocks: Array<Record<string, unknown>> = [];
		if (isOfficial) {
			systemBlocks.push(
				{ type: "text", text: buildBillingHeader(messages), ...CACHE_CONTROL_GLOBAL },
				{ type: "text", text: IDENTITY_BLOCK, ...CACHE_CONTROL_GLOBAL },
			);
			if (systemPrompt) {
				systemBlocks.push({ type: "text", text: systemPrompt, ...CACHE_CONTROL });
			}
		} else {
			if (systemPrompt) {
				systemBlocks.push({ type: "text", text: systemPrompt });
			}
		}

		// Build tool definitions (without cache_control yet)
		const cachedTools = tools.length > 0 ? tools.map((t) => ({ ...t })) : undefined;

		// Apply cache_control breakpoints (official API only — proxies don't support it)
		if (isOfficial) {
			applyCacheBreakpoints(messages, cachedTools);
		}

		const body: Record<string, unknown> = {
			model,
			messages,
			max_tokens: maxTokens,
			stream: true,
		};

		// Add thinking configuration
		if (thinkingConfig) {
			body.thinking = thinkingConfig;
		}

		// Temperature: only set when thinking is disabled (API requirement)
		if (!thinkingEnabled) {
			body.temperature = 1;
		}

		// Effort parameter: official Anthropic API and Anthropic-compatible relays
		// (e.g. Claude Code proxies) both accept output_config.effort. Sent for any
		// effort-capable model regardless of officialApi.
		if (supportsEffort(model) && thinkingEnabled) {
			const effort = mapEffortParam(params.reasoningEffort);
			body.output_config = { effort: effort ?? "medium" };
		}

		// DeepSeek effort: output_config.effort controls thinking intensity
		// (DeepSeek supports "high" and "max"; low/medium map to high)
		if (isDeepSeek && thinkingEnabled) {
			const effort = mapDeepSeekEffort(params.reasoningEffort);
			if (effort) {
				body.output_config = { effort };
			}
		}

		body.system = systemBlocks;

		// Tools: official API appends server-side web_search only when the unified
		// native-search channel is enabled for this provider/model; proxy mode uses
		// function tools only.
		if (isOfficial && shouldUseNativeSearch(this.config.prefix, model)) {
			const serverTools: Record<string, unknown>[] = [
				{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES },
			];
			body.tools = cachedTools ? [...cachedTools, ...serverTools] : serverTools;
			body.tool_choice = { type: "auto" };
		} else {
			if (cachedTools) {
				body.tools = cachedTools;
			}
		}

		// Add metadata — official API always sends user_id for attribution;
		// proxy mode only sends if explicitly provided.
		if (isOfficial) {
			body.metadata = {
				user_id: JSON.stringify({
					device_id: DEVICE_ID,
					account_uuid: "",
					session_id: this.sessionId,
				}),
				...(params.metadata ?? {}),
			};
		} else if (params.metadata) {
			body.metadata = params.metadata;
		}

		// Request path: official API uses ?beta=true, proxy mode uses plain path.
		const reqPath = isOfficial ? "/messages?beta=true" : "/messages";

		// Headers: official API uses Claude Code CLI protocol, proxy mode uses standard headers.
		const reqHeaders: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (isOfficial) {
			reqHeaders.Authorization = `Bearer ${apiKey}`;
			reqHeaders["anthropic-beta"] = ANTHROPIC_BETA_FLAGS;
			reqHeaders["anthropic-dangerous-direct-browser-access"] = "true";
			reqHeaders["user-agent"] = this.resolveUserAgent(true);
			reqHeaders["x-app"] = "cli";
			reqHeaders["X-Claude-Code-Session-Id"] = this.sessionId;
			reqHeaders["x-client-request-id"] = randomUUID();
			reqHeaders["X-Stainless-Arch"] = "x64";
			reqHeaders["X-Stainless-Lang"] = "js";
			reqHeaders["X-Stainless-OS"] = "Linux";
			reqHeaders["X-Stainless-Package-Version"] = "0.74.0";
			reqHeaders["X-Stainless-Retry-Count"] = "0";
			reqHeaders["X-Stainless-Runtime"] = "node";
			reqHeaders["X-Stainless-Runtime-Version"] = "v24.3.0";
			reqHeaders["X-Stainless-Timeout"] = "600";
		} else {
			reqHeaders["x-api-key"] = apiKey;
			reqHeaders["user-agent"] = this.resolveUserAgent(false);
			// Anthropic-compatible relays (Claude Code proxies) accept the CC beta
			// flags; declare effort/adaptive-thinking so output_config.effort is honored.
			// Only send these when the model actually supports effort — generic
			// Anthropic-compatible relays may reject unknown beta flags, so we avoid
			// sending the full CC flag set and only opt in the minimal effort betas.
			if (supportsEffort(model)) {
				reqHeaders["anthropic-beta"] = ANTHROPIC_EFFORT_BETA_FLAGS;
			}
		}
		this.applyExtraHeaders(reqHeaders);

		params.requestDump?.setRequest({
			transport: "http",
			url: `${this.getBaseUrl()}${reqPath}`,
			headers: sanitizeHeaders(reqHeaders),
			body,
		});

		logger.debug("Anthropic chat request", {
			model,
			endpoint: `${this.getBaseUrl()}${reqPath}`,
			toolCount: tools.length,
			messageCount: messages.length,
			hasSystem: !!systemPrompt,
			maxTokens,
			thinkingType: thinkingConfig?.type,
			reasoningEffort: params.reasoningEffort,
		});

		// Serialize body, then compute cch attestation and replace placeholder.
		// The hash is computed over the body bytes including the "cch=00000" placeholder,
		// then the placeholder is replaced with the computed 5-char hex value.
		// We use indexOf on the billing header (always the first system block text)
		// to avoid accidentally replacing a user-message that happens to contain
		// the same literal.
		let bodyStr = JSON.stringify(body);
		if (isOfficial) {
			const cch = computeCch(bodyStr);
			const idx = bodyStr.indexOf(CCH_PLACEHOLDER);
			if (idx !== -1) {
				const replacement = `cch=${cch}`;
				bodyStr = bodyStr.slice(0, idx) + replacement + bodyStr.slice(idx + CCH_PLACEHOLDER.length);
			}
		}

		params.onRequestStart?.();
		const response = await this.fetchWithV1Fallback(reqPath, {
			method: "POST",
			headers: reqHeaders,
			body: bodyStr,
			signal: params.signal,
		});
		const responseTextPromise = params.requestDump
			? response
					.clone()
					.text()
					.catch((error) => {
						params.requestDump?.setResponseError(error);
						return "";
					})
			: undefined;
		params.requestDump?.setResponseMeta({
			status: response.status,
			headers: sanitizeHeaders(response.headers),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			params.requestDump?.setResponseBodyText(errText);
			throw new ApiError(response.status, `Anthropic API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("Anthropic API returned no body");
		}

		yield* parseAnthropicSSEStream(
			response.body,
			getAnthropicEffectiveContextWindow(model, this.config),
		);
		if (responseTextPromise) {
			const bodyText = await responseTextPromise;
			const maxSize = settings.agent?.requestDumpMaxSize ?? 1024 * 1024;
			params.requestDump?.setResponseBodyTextWithLimit(bodyText, maxSize);
		}
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
	): unknown {
		if (images?.length) {
			const content: Array<
				| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				| { type: "text"; text: string }
			> = [];
			for (const img of images) {
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: `image/${img.format}`,
						data: img.base64,
					},
				});
			}
			content.push({ type: "text", text: output });
			return { tool_use_id: toolUseId, content, is_error: isError || undefined };
		}
		return { tool_use_id: toolUseId, content: output, is_error: isError || undefined };
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		_model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const h = history as AnthropicMessage[];
		const parts: AnthropicContentPart[] = [];

		for (const tr of toolResults as Array<{
			tool_use_id: string;
			content:
				| string
				| Array<
						| { type: "text"; text: string }
						| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				  >;
			is_error?: boolean;
		}>) {
			parts.push({
				type: "tool_result",
				tool_use_id: tr.tool_use_id,
				content: tr.content,
				is_error: tr.is_error,
			});
		}

		for (const img of images ?? []) {
			parts.push({
				type: "image",
				source: {
					type: "base64",
					media_type: `image/${img.format}`,
					data: img.base64,
				},
			});
		}

		const hasText = !!content && content !== ".";
		if (hasText) {
			parts.push({ type: "text", text: content });
		} else if (images?.length) {
			parts.push({ type: "text", text: "[user sent image(s)]" });
		}

		if (parts.length > 0) {
			h.push({ role: "user", content: parts });
		}
	}

	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: AgentToolUse[],
		reasoningBlocks?: Array<{
			text: string;
			providerMetadata?: import("./types").ReasoningProviderMetadata;
			outputIndex?: number;
		}>,
		_webSearches?: Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
		}>,
		_messageId?: string,
		_imageGenerations?: Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
		}>,
		textOutputIndex?: number,
		redactedThinkingBlocks?: Array<{
			data: string;
			outputIndex?: number;
			signatureSource?: string;
		}>,
	): void {
		const h = history as AnthropicMessage[];

		// Collect all blocks with their outputIndex and sort by position.
		// When no block has an explicit outputIndex (legacy messages), fall back
		// to the fixed ordering: reasoning → text → tool_use.
		const indexed: Array<{ part: AnthropicContentPart; outputIndex: number }> = [];

		if (reasoningBlocks) {
			for (let i = 0; i < reasoningBlocks.length; i++) {
				const rb = reasoningBlocks[i];
				const sig = rb.providerMetadata?.anthropic?.signature ?? "";
				indexed.push({
					part: { type: "thinking", thinking: rb.text, signature: sig },
					outputIndex: rb.outputIndex ?? i,
				});
			}
		}

		if (redactedThinkingBlocks) {
			for (const rb of redactedThinkingBlocks) {
				indexed.push({
					part: { type: "redacted_thinking", data: rb.data },
					outputIndex: rb.outputIndex ?? indexed.length,
				});
			}
		}

		if (text) {
			// Use the real textOutputIndex when available; otherwise place text
			// after reasoning blocks but before tool_use blocks.
			const fallbackIdx = indexed.length;
			indexed.push({
				part: { type: "text", text },
				outputIndex: textOutputIndex ?? fallbackIdx,
			});
		}

		for (let i = 0; i < toolUses.length; i++) {
			const tu = toolUses[i];
			const fallbackIdx = indexed.length;
			indexed.push({
				part: {
					type: "tool_use",
					id: tu.toolUseId,
					name: tu.name,
					input: tu.input,
				},
				outputIndex: tu.outputIndex ?? fallbackIdx,
			});
		}

		indexed.sort((a, b) => a.outputIndex - b.outputIndex);
		const parts = indexed.map((e) => e.part);

		if (parts.length > 0) {
			ensureTextOrToolBlock(parts);
			h.push({ role: "assistant", content: parts });
		}
	}

	async generate(text: string, model: string): Promise<string> {
		const result = await this.generateWithMeta(text, model);
		return result.text;
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = this.config.apiKey;

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const bareModel = parseModelId(model).model;
		const isOfficial = !!this.config.officialApi;
		const body: {
			model: string;
			max_tokens: number;
			messages: Array<{ role: "user"; content: string }>;
			system?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
			thinking?: ReturnType<typeof buildThinkingConfig>;
		} = {
			model: bareModel,
			max_tokens: 4096,
			messages: [{ role: "user", content: text }],
		};
		if (systemInstruction) {
			body.system = isOfficial
				? [{ type: "text", text: systemInstruction, ...CACHE_CONTROL }]
				: [{ type: "text", text: systemInstruction }];
		}
		if (options?.reasoningEffort !== undefined) {
			const thinkingConfig = buildThinkingConfig(bareModel, options.reasoningEffort);
			if (thinkingConfig) body.thinking = thinkingConfig;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (isOfficial) {
			headers.Authorization = `Bearer ${apiKey}`;
			headers["anthropic-beta"] = ANTHROPIC_BASE_BETA;
			headers["user-agent"] = this.resolveUserAgent(true);
		} else {
			headers["x-api-key"] = apiKey;
			headers["user-agent"] = this.resolveUserAgent(false);
		}
		this.applyExtraHeaders(headers);

		const response = await this.fetchWithV1Fallback("/messages", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options?.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Anthropic API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			content?: Array<{ type?: string; text?: string }>;
			usage?: AnthropicUsagePayload;
		};

		const resultText =
			json.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("") ?? "";

		return {
			text: resultText,
			contextPercent: calculateAnthropicContextPercent(json.usage, bareModel, this.config),
			usage: json.usage ? extractAnthropicUsage(json.usage) : null,
		};
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string> {
		const result = await this.generateWithHistoryWithMeta(
			systemInstruction,
			content,
			model,
			locale,
			options,
		);
		return result.text;
	}

	async generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = this.config.apiKey;

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const isOfficial = !!this.config.officialApi;
		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		const bareModel = parseModelId(model).model;

		const genHeaders: Record<string, string> = {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (isOfficial) {
			genHeaders.Authorization = `Bearer ${apiKey}`;
			genHeaders["anthropic-beta"] = ANTHROPIC_BASE_BETA;
			genHeaders["user-agent"] = this.resolveUserAgent(true);
		} else {
			genHeaders["x-api-key"] = apiKey;
			genHeaders["user-agent"] = this.resolveUserAgent(false);
		}
		this.applyExtraHeaders(genHeaders);

		const body: {
			model: string;
			max_tokens: number;
			system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
			messages: Array<{ role: "user"; content: string }>;
			thinking?: ReturnType<typeof buildThinkingConfig>;
		} = {
			model: bareModel,
			max_tokens: 4096,
			system: isOfficial
				? [{ type: "text", text: systemInstruction, ...CACHE_CONTROL }]
				: [{ type: "text", text: systemInstruction }],
			messages: [{ role: "user", content: `${reminder}\n\n${content}` }],
		};
		if (options?.reasoningEffort !== undefined) {
			const thinkingConfig = buildThinkingConfig(bareModel, options.reasoningEffort);
			if (thinkingConfig) body.thinking = thinkingConfig;
		}

		const response = await this.fetchWithV1Fallback("/messages", {
			method: "POST",
			headers: genHeaders,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Anthropic API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			content?: Array<{ type?: string; text?: string }>;
			usage?: AnthropicUsagePayload;
		};

		return {
			text:
				json.content
					?.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("") ?? "",
			contextPercent: calculateAnthropicContextPercent(json.usage, bareModel, this.config),
			usage: json.usage ? extractAnthropicUsage(json.usage) : null,
		};
	}
}

// === SSE stream parser ===

export async function* parseAnthropicSSEStream(
	body: ReadableStream<Uint8Array>,
	contextWindow?: number | null,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let lineCount = 0;

	// Tool call accumulators keyed by content block index
	const toolAccum = new Map<number, ToolAccumEntry>();
	const thinkingAccum = new Map<number, ThinkingAccumEntry>();
	const redactedThinkingAccum = new Map<number, string>();
	const serverToolAccum = new Map<number, ServerToolAccumEntry>();
	const usageAccum = createAnthropicUsageAccum();

	// Stream integrity tracking
	let receivedMessageStart = false;
	let receivedAnyContentBlock = false;
	// Track SSE event: type for gateway-injected events
	let currentEventType = "";

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				// Track SSE event: lines for gateway-injected events
				if (trimmed.startsWith("event:")) {
					currentEventType = trimmed.slice(6).trim();
					continue;
				}
				// Support both "data: {...}" (standard SSE) and "data:{...}" (no space)
				if (!trimmed.startsWith("data:")) continue;

				if (lineCount < 5) {
					logger.debug("Anthropic SSE line", {
						lineIndex: lineCount,
						preview: trimmed.slice(0, 300),
					});
				}
				lineCount++;

				// Extract JSON payload: skip "data: " or "data:"
				const jsonStr = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

				let data: Record<string, unknown>;
				try {
					data = JSON.parse(jsonStr);
				} catch {
					currentEventType = "";
					continue;
				}

				// Gateway-injected events: check SSE event: type first, then data-embedded type
				if (currentEventType && isGatewayEventType(currentEventType)) {
					const gwEvt = parseGatewaySSEEvent(currentEventType, data);
					currentEventType = "";
					if (gwEvt) {
						yield gwEvt;
						continue;
					}
				}
				const sseEventName = currentEventType;
				currentEventType = "";
				const gwEvt = parseGatewayDataEvent(data);
				if (gwEvt) {
					yield gwEvt;
					continue;
				}

				// Some relays/gateways send an error as `event: error` whose data
				// payload lacks a `type` field. Backfill it so extractAnthropicStreamError
				// recognizes the error instead of dropping it (which would surface to the
				// user as a misleading empty response). Mirrors the Responses parser.
				if (sseEventName === "error" && typeof data.type !== "string") {
					data.type = "error";
				}

				const event = data as unknown as AnthropicStreamEvent;

				// Track stream integrity
				if (event.type === "message_start") receivedMessageStart = true;
				if (event.type === "content_block_start") receivedAnyContentBlock = true;

				const events = parseAnthropicEvent(
					event,
					toolAccum,
					thinkingAccum,
					redactedThinkingAccum,
					serverToolAccum,
					usageAccum,
					contextWindow,
				);
				for (const evt of events) {
					yield evt;
				}
			}
		}

		// Process remaining buffer
		const remaining = buffer.trim();
		if (remaining.startsWith("data:")) {
			try {
				const jsonStr = remaining.startsWith("data: ") ? remaining.slice(6) : remaining.slice(5);
				const event = JSON.parse(jsonStr);

				if (event.type === "message_start") receivedMessageStart = true;
				if (event.type === "content_block_start") receivedAnyContentBlock = true;

				const events = parseAnthropicEvent(
					event,
					toolAccum,
					thinkingAccum,
					redactedThinkingAccum,
					serverToolAccum,
					usageAccum,
					contextWindow,
				);
				for (const evt of events) {
					yield evt;
				}
			} catch {
				// ignore
			}
		}

		// Stream integrity checks
		if (!receivedMessageStart) {
			logger.warn("Anthropic SSE stream ended without message_start event");
		} else if (!receivedAnyContentBlock) {
			logger.warn("Anthropic SSE stream had message_start but no content blocks");
		}

		// Flush un-emitted tool calls
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				acc.emitted = true;
				yield { toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } };
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Try to parse a string as JSON. Returns true if valid. */
function isParsableJson(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

/** Accumulator for thinking block signature (keyed by content_block index). */
type ThinkingAccumEntry = { signature: string; blockIndex: number };

/**
 * Robustly detect an error envelope in an Anthropic-protocol SSE event and, if
 * present, extract a `{ reason, message }` for an invalidState event.
 *
 * The native Anthropic API sends `{ type: "error", error: { type, message } }`.
 * But intermediaries (notably the narrafork unified gateway's writeSSEError, and
 * other Anthropic-compatible relays) emit different shapes such as
 * `{ code, message, error: { code, message } }` — sometimes WITHOUT a top-level
 * `type: "error"`. The original parser only matched `type === "error"` with a
 * nested `error.message`, so those gateway-style errors were silently dropped and
 * surfaced to the user as a misleading "empty response". This helper recognizes
 * all of those shapes.
 *
 * It reads fields off an untyped view of the event so a string `message` (error
 * envelope) does not collide with the object `message` used by `message_start`.
 * Normal streaming events (message_start/delta, content_block_*, ping,
 * message_delta, …) carry neither a top-level `error` object nor a top-level
 * `code` paired with a string `message`, so they are never misclassified.
 */
export function extractAnthropicStreamError(
	event: AnthropicStreamEvent,
): { reason: string; message: string } | null {
	const raw = event as unknown as Record<string, unknown>;
	const nested =
		raw.error && typeof raw.error === "object" ? (raw.error as Record<string, unknown>) : undefined;
	const topMessageIsString = typeof raw.message === "string";
	const hasTopCode = raw.code != null;

	const isError = raw.type === "error" || nested != null || (hasTopCode && topMessageIsString);
	if (!isError) return null;

	const nestedType = nested && nested.type != null ? nested.type : undefined;
	const nestedCode = nested && nested.code != null ? nested.code : undefined;
	const reasonCandidate =
		nestedType ?? nestedCode ?? raw.code ?? (raw.type !== "error" ? raw.type : undefined);
	const reason = reasonCandidate != null ? String(reasonCandidate) : "api_error";

	const nestedMessage =
		nested && typeof nested.message === "string" ? (nested.message as string) : undefined;
	const message =
		nestedMessage ??
		(topMessageIsString ? (raw.message as string) : undefined) ??
		"Anthropic API error";

	return { reason: reason || "api_error", message };
}

export function parseAnthropicEvent(
	event: AnthropicStreamEvent,
	toolAccum: Map<number, ToolAccumEntry>,
	thinkingAccum: Map<number, ThinkingAccumEntry>,
	redactedThinkingAccum: Map<number, string>,
	serverToolAccum: Map<number, ServerToolAccumEntry>,
	usageAccum: AnthropicUsageAccum,
	contextWindow?: number | null,
): ParsedStreamEvent[] {
	// ── Error (checked first, before the `type` guard) ──
	// Error envelopes may lack a top-level `type` (gateway/relay shapes), so detect
	// them up front rather than relying on `type === "error"`. Without this, a
	// type-less error event falls through the `if (!type) return []` guard below and
	// is silently dropped, surfacing to the user as a misleading empty response.
	const streamError = extractAnthropicStreamError(event);
	if (streamError) {
		return [{ invalidState: streamError }];
	}

	const type = event.type;
	if (!type) return [];

	// ── Message start — extract message ID and usage ──
	if (type === "message_start" && event.message) {
		const results: ParsedStreamEvent[] = [];
		if (event.message.id) {
			results.push({ messageId: event.message.id });
		}
		if (event.message.usage) {
			updateAnthropicUsageAccum(usageAccum, event.message.usage);
			results.push(parsedUsageFromAnthropicAccum(usageAccum, contextWindow));
		}
		return results;
	}

	// ── Content block start ──
	if (type === "content_block_start" && event.content_block) {
		const idx = event.index ?? 0;
		const block = event.content_block;

		if (block.type === "tool_use" && block.id && block.name) {
			toolAccum.set(idx, { id: block.id, name: block.name, args: "", emitted: false });
			logger.debug("Anthropic tool call started", {
				index: idx,
				toolUseId: block.id,
				toolName: block.name,
			});
			return [
				{
					toolUseChunk: {
						toolUseId: block.id,
						name: block.name,
						input: undefined,
						stop: false,
						outputIndex: idx,
					},
				},
			];
		}
		// Server-side tool use (web_search) — track but don't emit as local tool call
		if (block.type === "server_tool_use" && block.id && block.name) {
			serverToolAccum.set(idx, { id: block.id, name: block.name, args: "" });
			logger.debug("Anthropic server tool use started", {
				index: idx,
				id: block.id,
				name: block.name,
			});
			return [{ webSearch: { id: block.id, status: "in_progress" } }];
		}
		// Web search result — emit completion event
		if (block.type === "web_search_tool_result") {
			const toolUseId = block.tool_use_id ?? "";
			// Find the matching server tool entry to get the query
			let query: string | undefined;
			for (const [, acc] of serverToolAccum) {
				if (acc.id === toolUseId) {
					query = acc.query;
					break;
				}
			}
			// Check for error response
			if (block.content && !Array.isArray(block.content)) {
				const errContent = block.content as { type: string; error_code: string };
				logger.warn("Anthropic web search error", { error_code: errContent.error_code });
				return [{ webSearch: { id: toolUseId, status: "completed", query } }];
			}
			return [{ webSearch: { id: toolUseId, status: "completed", query } }];
		}
		// Thinking block start — initialize signature accumulator.
		// Some Anthropic-compatible APIs (notably DeepSeek relays) put the
		// first/full thinking text directly on content_block_start instead of
		// emitting Anthropic's standard thinking_delta events. Treat it as
		// reasoning so it is persisted and replayed as a thinking block on the
		// next request.
		if (block.type === "thinking") {
			thinkingAccum.set(idx, { signature: "", blockIndex: idx });
			const initialThinking = block.thinking ?? block.reasoning_content ?? block.text;
			if (initialThinking) {
				return [
					{
						reasoning: initialThinking,
						reasoningMetadata: { anthropic: { blockIndex: idx } },
						reasoningOutputIndex: idx,
					},
				];
			}
			return [];
		}
		// Redacted thinking arrives as a complete content block. Match Claude Code's
		// contentBlocks[index] flow by waiting for content_block_stop before emitting
		// the completed block for persistence/replay.
		if (block.type === "redacted_thinking" && block.data) {
			redactedThinkingAccum.set(idx, block.data);
			return [];
		}
		return [];
	}

	// ── Content block delta ──
	if (type === "content_block_delta" && event.delta) {
		const idx = event.index ?? 0;

		// Thinking delta (extended thinking).
		// Official Anthropic streams use `thinking_delta.thinking`; a few
		// Anthropic-compatible relays stream a thinking content block using
		// `text_delta.text` or `reasoning_content` instead. If the current block
		// index was introduced as `type: "thinking"`, route those deltas to the
		// reasoning channel rather than visible assistant text.
		const isThinkingBlockDelta = event.delta.type === "thinking_delta" || thinkingAccum.has(idx);
		const thinkingDelta = event.delta.thinking ?? event.delta.reasoning_content ?? event.delta.text;
		if (isThinkingBlockDelta && thinkingDelta != null) {
			return [
				{
					reasoning: thinkingDelta,
					reasoningMetadata: { anthropic: { blockIndex: idx } },
					reasoningOutputIndex: idx,
				},
			];
		}

		// Text delta
		if (event.delta.type === "text_delta" && event.delta.text != null) {
			return [{ text: event.delta.text, textOutputIndex: idx }];
		}

		// Signature delta — assign (Anthropic sends one per thinking block)
		if (event.delta.type === "signature_delta" && event.delta.signature) {
			const acc = thinkingAccum.get(idx);
			if (acc) {
				acc.signature = event.delta.signature;
			}
			return [];
		}

		// Tool use input delta
		if (event.delta.type === "input_json_delta" && event.delta.partial_json != null) {
			// Server tool accumulator — extract query for web search progress
			const serverAcc = serverToolAccum.get(idx);
			if (serverAcc) {
				serverAcc.args += event.delta.partial_json;
				try {
					const match = serverAcc.args.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
					if (match?.[1]) {
						serverAcc.query = JSON.parse(`"${match[1]}"`);
						return [
							{ webSearch: { id: serverAcc.id, status: "searching", query: serverAcc.query } },
						];
					}
				} catch {
					// ignore partial JSON parse errors
				}
				return [];
			}

			const acc = toolAccum.get(idx);
			if (acc && !acc.emitted) {
				acc.args += event.delta.partial_json;
				const results: ParsedStreamEvent[] = [
					{
						toolUseChunk: {
							toolUseId: acc.id,
							name: acc.name,
							input: event.delta.partial_json,
							stop: false,
						},
					},
				];
				// Early completion if args form valid JSON
				if (isParsableJson(acc.args)) {
					results.push({
						toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
					});
					acc.emitted = true;
				}
				return results;
			}
		}
		// Unknown delta type — log for diagnostics
		logger.debug("Unknown Anthropic content_block_delta type", {
			deltaType: event.delta.type,
			index: idx,
		});
		return [];
	}

	// ── Content block stop ──
	if (type === "content_block_stop") {
		const idx = event.index ?? 0;
		const acc = toolAccum.get(idx);
		if (acc && !acc.emitted) {
			acc.emitted = true;
			return [{ toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } }];
		}
		// Thinking block stop — emit signature as reasoning metadata
		const thinkAcc = thinkingAccum.get(idx);
		if (thinkAcc) {
			thinkingAccum.delete(idx);
			if (thinkAcc.signature) {
				return [
					{
						reasoningMetadata: {
							anthropic: { blockIndex: thinkAcc.blockIndex, signature: thinkAcc.signature },
						},
						reasoningOutputIndex: thinkAcc.blockIndex,
					},
				];
			}
		}

		const redactedData = redactedThinkingAccum.get(idx);
		if (redactedData) {
			redactedThinkingAccum.delete(idx);
			return [{ redactedThinking: { data: redactedData, outputIndex: idx } }];
		}
		return [];
	}

	// ── Message delta (stop reason, usage) ──
	if (type === "message_delta") {
		const results: ParsedStreamEvent[] = [];

		// Flush un-emitted tool calls
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({ toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } });
				acc.emitted = true;
			}
		}

		// Usage update. Anthropic streaming usage is cumulative; preserve input/cache
		// values from message_start while applying the final output_tokens from delta.
		if (event.usage) {
			updateAnthropicUsageAccum(usageAccum, event.usage);
			results.push(parsedUsageFromAnthropicAccum(usageAccum, contextWindow));
		}

		// Stop reason — always propagate to loop layer
		const stopReason = event.delta?.stop_reason;
		if (stopReason) {
			results.push({ stopReason });

			// Critical stop reasons → invalidState for special handling
			if (stopReason === "max_tokens") {
				results.push({
					invalidState: {
						reason: "max_tokens",
						message: "Response truncated: model reached maximum token limit.",
					},
				});
			} else if (stopReason === "model_context_window_exceeded") {
				results.push({
					invalidState: {
						reason: "model_context_window_exceeded",
						message: "The model has reached its context window limit.",
					},
				});
			} else if (stopReason === "refusal") {
				results.push({
					invalidState: {
						reason: "refusal",
						message:
							"Claude is unable to respond to this request, which appears to violate the Usage Policy.",
					},
				});
			}
		}

		return results;
	}

	// Error events are handled up front by extractAnthropicStreamError above.

	return [];
}

// === History builder ===

function buildAnthropicHistory(
	dbMessages: DbMessage[],
	currentReasoningSource?: string,
): {
	history: AnthropicMessage[];
	trailingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
	trailingUserText?: string;
} {
	// Filter model-visible messages: user, assistant, sys (system context)
	// Exclude: system (legacy, kept for backward compatibility), disp (UI-only display messages)
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant" || m.role === "sys"),
	);

	// Drop the last user message — it's sent as the current message
	if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
		topLevel.pop();
	}

	const history: AnthropicMessage[] = [];
	let pendingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
	let pendingUserSideCars: NonNullable<DbMessage["sideCars"]> = [];

	for (const msg of topLevel) {
		if (msg.role === "assistant") {
			// Flush pending tool results as a user message
			if (pendingToolResults.length > 0) {
				const sideCarText = appendSideCarsForApi("", pendingUserSideCars);
				history.push({
					role: "user",
					content: [
						...pendingToolResults.map((tr) => ({
							type: "tool_result" as const,
							tool_use_id: tr.tool_use_id,
							content: tr.content,
							is_error: tr.is_error,
						})),
						...(sideCarText ? [{ type: "text" as const, text: sideCarText }] : []),
					],
				});
				pendingToolResults = [];
				pendingUserSideCars = [];
			}

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const parts: AnthropicContentPart[] = [];

			// Web search blocks — inject as user context before the assistant message
			const webSearchBlocks = content.filter(
				(b: { type: string }) => b.type === "web_search",
			) as Array<{ type: "web_search"; query?: string; queries?: string[] }>;
			if (webSearchBlocks.length > 0) {
				const searchSummary = webSearchBlocks
					.map((ws) => {
						const q = ws.query || ws.queries?.join(", ") || "unknown";
						return `[Web search: ${q}]`;
					})
					.join("\n");
				history.push({ role: "user", content: searchSummary });
			}

			// Build a set of completed tool call IDs for filtering
			const completedToolUseIds = new Set(
				msg.toolCalls
					?.filter((tc) => tc.status === "success" || tc.status === "fail")
					.map((tc) => tc.toolUseId) ?? [],
			);

			// Build a map of tool call data for quick lookup
			const toolCallMap = new Map<
				string,
				{ toolName: string; toolUseId: string; inputJson: unknown }
			>();
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.toolName && tc.toolUseId && completedToolUseIds.has(tc.toolUseId)) {
						toolCallMap.set(tc.toolUseId, tc);
					}
				}
			}

			// Track which tool_use IDs have been emitted via contentJson blocks
			const emittedToolUseIds = new Set<string>();

			// Single-pass: iterate contentJson in original order to preserve
			// interleaved thinking block positions (required by interleaved-thinking beta).
			for (const b of content) {
				const block = b as {
					type: string;
					thinking?: string;
					text?: string;
					signature?: string;
					data?: string;
					id?: string;
					name?: string;
					input?: Record<string, unknown>;
					signatureSource?: string;
					providerMetadata?: { anthropic?: { signature?: string }; signatureSource?: string };
				};
				if (block.type === "thinking" && block.thinking) {
					// Legacy shape: signature stored on the block directly, with the
					// source (if any) on providerMetadata. Only echo the signature
					// back when it was minted by the current upstream.
					const sig = signatureSourcesCompatible(
						block.providerMetadata?.signatureSource,
						currentReasoningSource,
					)
						? (block.signature ?? "")
						: "";
					parts.push({
						type: "thinking",
						thinking: block.thinking,
						signature: sig,
					});
				} else if (block.type === "reasoning" && block.text) {
					// DB stores thinking as "reasoning" blocks with signature in providerMetadata.
					// Drop the signature when it belongs to a different upstream server
					// (e.g. a different NUG channel), since replaying it would fail
					// signature verification. The thinking text is still preserved.
					const sig = signatureSourcesCompatible(
						block.providerMetadata?.signatureSource,
						currentReasoningSource,
					)
						? (block.providerMetadata?.anthropic?.signature ?? "")
						: "";
					parts.push({
						type: "thinking",
						thinking: block.text,
						signature: sig,
					});
				} else if (block.type === "redacted_thinking" && block.data) {
					// Encrypted thinking is server-specific — only replay it to the
					// upstream that produced it. When the source does not match (or is
					// unknown on legacy messages), drop the block entirely rather than
					// echo an opaque payload the current server cannot validate.
					if (signatureSourcesCompatible(block.signatureSource, currentReasoningSource)) {
						parts.push({ type: "redacted_thinking", data: block.data });
					}
				} else if (block.type === "text" && block.text) {
					parts.push({ type: "text", text: block.text });
				} else if (block.type === "tool_use" && block.id) {
					// contentJson may store tool_use blocks directly; use them if
					// the tool call is completed, otherwise look up from toolCalls.
					const tc = toolCallMap.get(block.id);
					if (tc) {
						let input: Record<string, unknown> = {};
						try {
							input =
								typeof tc.inputJson === "string"
									? JSON.parse(tc.inputJson)
									: ((tc.inputJson as Record<string, unknown>) ?? {});
						} catch {
							input = {};
						}
						parts.push({
							type: "tool_use",
							id: tc.toolUseId,
							name: tc.toolName,
							input,
						});
						emittedToolUseIds.add(tc.toolUseId);
					}
				}
				// Skip web_search, image_generation, and other non-API block types
			}

			// Append any completed tool calls not already emitted via contentJson
			// (backward compat: older messages may not have tool_use in contentJson)
			for (const [toolUseId, tc] of toolCallMap) {
				if (!emittedToolUseIds.has(toolUseId)) {
					let input: Record<string, unknown> = {};
					try {
						input =
							typeof tc.inputJson === "string"
								? JSON.parse(tc.inputJson)
								: ((tc.inputJson as Record<string, unknown>) ?? {});
					} catch {
						input = {};
					}
					parts.push({
						type: "tool_use",
						id: tc.toolUseId,
						name: tc.toolName,
						input,
					});
				}
			}

			// If no text block was found in contentJson, fall back to contentText
			if (!parts.some((p) => p.type === "text") && msg.contentText) {
				// Insert text before the first tool_use block
				const firstToolIdx = parts.findIndex((p) => p.type === "tool_use");
				const textPart: AnthropicContentPart = { type: "text", text: msg.contentText };
				if (firstToolIdx >= 0) {
					parts.splice(firstToolIdx, 0, textPart);
				} else {
					parts.push(textPart);
				}
			}

			if (parts.length > 0) {
				ensureTextOrToolBlock(parts);
				history.push({ role: "assistant", content: parts });
			}

			// Collect tool results for next turn
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === "success" || tc.status === "fail") {
						const outputText = appendSideCarsForApi(
							outputToText(tc.outputJson),
							sideCarsForToolResult(msg.sideCars, tc.toolUseId),
						);
						pendingToolResults.push({
							tool_use_id: tc.toolUseId,
							content: outputText,
							is_error: tc.status === "fail" || undefined,
						});
					}
				}
			}
			pendingUserSideCars = sideCarsForUserMessage(msg.sideCars);
		} else if (msg.role === "user" || msg.role === "sys") {
			// Flush pending tool results before the next model-visible context message
			if (pendingToolResults.length > 0) {
				const sideCarText = appendSideCarsForApi("", pendingUserSideCars);
				history.push({
					role: "user",
					content: [
						...pendingToolResults.map((tr) => ({
							type: "tool_result" as const,
							tool_use_id: tr.tool_use_id,
							content: tr.content,
							is_error: tr.is_error,
						})),
						...(sideCarText ? [{ type: "text" as const, text: sideCarText }] : []),
					],
				});
				pendingToolResults = [];
				pendingUserSideCars = [];
			}

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const textParts = content
				.filter((b: { type: string }) => b.type === "text")
				.map((b: { text: string }) => b.text);
			const text = appendSideCarsForApi(
				textParts.join("\n") || msg.contentText || "",
				pendingUserSideCars,
			);
			if (text) {
				history.push({ role: "user", content: text });
			}
			pendingUserSideCars = [];
		}
	}

	return {
		history,
		trailingToolResults: pendingToolResults,
		trailingUserText: appendSideCarsForApi("", pendingUserSideCars) || undefined,
	};
}

// === Helpers ===

/**
 * Ensure messages strictly alternate user/assistant.
 * Anthropic requires this — merge consecutive same-role messages.
 * Also normalizes string content to array format (matching opencode).
 */
function ensureAlternating(messages: AnthropicMessage[]): AnthropicMessage[] {
	if (messages.length === 0) return messages;

	/** Check if a message has usable content (non-empty string or non-empty array). */
	function hasContent(m: AnthropicMessage): boolean {
		if (typeof m.content === "string") return m.content.length > 0;
		if (Array.isArray(m.content)) return m.content.length > 0;
		return false; // null, undefined, etc.
	}

	const result: AnthropicMessage[] = [];
	for (const msg of messages) {
		// Normalize string content to array format
		const normalized: AnthropicMessage = {
			role: msg.role,
			content:
				typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content,
		};

		// Skip messages with no usable content — the API rejects them
		// (e.g. "assistant must provide content or tool_calls").
		// This can happen when contentJson was saved empty (interrupted streaming).
		// Note: messages with tool_use blocks are safe — tool_use is part of the
		// content array, so content.length > 0 when tool calls exist.
		if (!hasContent(normalized)) {
			continue;
		}

		const last = result[result.length - 1];
		if (last && last.role === normalized.role) {
			// Merge into previous message
			const prevParts = toContentParts(last.content);
			const currParts = toContentParts(normalized.content);
			last.content = [...prevParts, ...currParts];
		} else {
			result.push(normalized);
		}
	}

	// Safety: drop any messages that became empty after merging
	const filtered = result.filter(hasContent);

	// Anthropic requires the first message to be from user
	if (filtered.length > 0 && filtered[0].role === "assistant") {
		filtered.unshift({ role: "user", content: [{ type: "text", text: "…" }] });
	}

	return filtered;
}

function toContentParts(content: string | AnthropicContentPart[]): AnthropicContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content;
}

/**
 * Remove thinking / redacted_thinking content blocks from all assistant messages.
 * Mutates the messages array in place. This is needed when sending history to
 * Anthropic-compatible APIs that don't support thinking mode — if thinking blocks
 * are present in the history but the request doesn't enable thinking, the API
 * returns a 400 error.
 */
function stripThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const filtered = (msg.content as AnthropicContentPart[]).filter(
			(b) => b.type !== "thinking" && b.type !== "redacted_thinking",
		);
		if (filtered.length !== (msg.content as AnthropicContentPart[]).length) {
			// Ensure at least one text block remains (API requires non-empty content)
			if (!filtered.some((b) => b.type === "text" || b.type === "tool_use")) {
				filtered.push({ type: "text", text: "…" });
			}
			msg.content = filtered;
		}
	}
}

/**
 * DeepSeek's Anthropic-compatible API doesn't support redacted_thinking blocks.
 * Remove them before replay, then patch assistant messages with a regular
 * thinking block if needed.
 */
function sanitizeDeepSeekThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts = msg.content as AnthropicContentPart[];
		const filtered = parts.filter((b) => b.type !== "redacted_thinking");
		if (filtered.length !== parts.length) {
			// Preserve a non-empty assistant message if this was not already filtered out.
			if (
				!filtered.some((b) => b.type === "thinking" || b.type === "text" || b.type === "tool_use")
			) {
				filtered.push({ type: "text", text: "…" });
			}
			msg.content = filtered;
		}
	}
	patchMissingThinkingBlocks(messages);
}

/**
 * Patch assistant messages that lack a thinking block.
 * DeepSeek thinking mode (via Anthropic-compatible API) requires a thinking
 * block on ALL assistant messages, not just those with tool_use. When switching
 * from a non-thinking model, historical messages lack this — prepend an
 * empty thinking block so the API doesn't reject the request.
 */
function patchMissingThinkingBlocks(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts = msg.content as AnthropicContentPart[];
		const hasThinking = parts.some((b) => b.type === "thinking");
		if (hasThinking) continue;
		// Prepend an empty thinking block
		parts.unshift({ type: "thinking", thinking: "", signature: "" });
	}
}

function isThinkingBlock(block: AnthropicContentPart): boolean {
	return block.type === "thinking" || block.type === "redacted_thinking";
}

/**
 * Strip trailing thinking/redacted_thinking blocks from the last assistant message.
 * The Anthropic API doesn't allow assistant messages to end with thinking blocks —
 * they must end with text or tool_use. This typically happens when a streaming
 * response is interrupted after emitting thinking but before emitting text/tool_use.
 *
 * Ref: Claude Code (un) filterTrailingThinkingFromLastAssistant
 */
function stripTrailingThinkingFromLastAssistant(messages: AnthropicMessage[]): void {
	if (messages.length === 0) return;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant" || !Array.isArray(last.content)) return;

	const content = last.content as AnthropicContentPart[];
	if (content.length === 0) return;

	const lastBlock = content[content.length - 1];
	if (!isThinkingBlock(lastBlock)) return;

	// Find last non-thinking block
	let lastValidIndex = content.length - 1;
	while (lastValidIndex >= 0 && isThinkingBlock(content[lastValidIndex])) {
		lastValidIndex--;
	}

	if (lastValidIndex < 0) {
		// All blocks were thinking — replace with placeholder
		last.content = [{ type: "text", text: "…" }];
	} else {
		last.content = content.slice(0, lastValidIndex + 1);
	}
}

/**
 * Filter out assistant messages that contain ONLY thinking/redacted_thinking blocks
 * (no text, tool_use, or other content). These "orphaned" thinking-only messages
 * can appear when:
 * - A streaming response is interrupted after emitting thinking but before text/tool_use
 * - Messages are compacted and intervening messages are removed
 *
 * Such messages cause "thinking blocks cannot be modified" API errors when replayed.
 * When removed, we must ensure the remaining messages still alternate user/assistant.
 *
 * Ref: Claude Code (un) filterOrphanedThinkingOnlyMessages
 */
function filterThinkingOnlyAssistantMessages(messages: AnthropicMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const content = msg.content as AnthropicContentPart[];
		if (content.length === 0) continue;

		const allThinking = content.every((b) => isThinkingBlock(b));
		if (allThinking) {
			logger.warn("Dropping thinking-only assistant message before API call", {
				index: i,
				blockCount: content.length,
			});
			messages.splice(i, 1);
		}
	}
}
