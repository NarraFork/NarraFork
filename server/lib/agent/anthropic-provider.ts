import { logger } from "../logger";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { AnthropicProviderConfig } from "../settings";
import { parseModelId } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import { resolveToolJsonSchema } from "./tool-registry";
import { type AgentToolUse, ApiError, type ResolvedToolDefinition } from "./types";

// === Claude Code protocol constants ===

/** Maximum number of server-side web searches per API call. */
const WEB_SEARCH_MAX_USES = 8;

/**
 * Beta flags matching Claude Code CLI protocol exactly.
 * All flags are always included — no conditional logic.
 */
const ANTHROPIC_BETA_FLAGS =
	"claude-code-20250219,adaptive-thinking-2026-01-28,prompt-caching-scope-2026-01-05,effort-2025-11-24";

/** Base beta flag for non-chat requests (model listing, generate). */
const ANTHROPIC_BASE_BETA = "claude-code-20250219";

/** Cache control marker for ephemeral prompt caching. */
const CACHE_CONTROL = { cache_control: { type: "ephemeral" as const } };

/** Default Anthropic API base URL (includes /v1 path). */
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/** User-Agent string matching Claude Code CLI. */
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.71 (external, cli)";

/** Billing header injected as the first system block (matches Claude Code). */
const BILLING_HEADER =
	"x-anthropic-billing-header: cc_version=2.1.71.752; cc_entrypoint=cli; cch=9a771;";

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
		parts.push({ type: "text", text: "" });
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

/** Whether a model supports extended thinking (Claude 3.7 Sonnet, Haiku 4.5+, Opus 4+, Sonnet 4+). */
function supportsThinking(model: string): boolean {
	const lower = model.toLowerCase();
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
 */
function buildThinkingConfig(
	model: string,
	reasoningEffort: string | undefined,
): { type: "adaptive" } | { type: "disabled" } | undefined {
	if (!supportsThinking(model)) return undefined;

	// "none" explicitly disables thinking
	if (reasoningEffort === "none") {
		return { type: "disabled" };
	}

	// All supported models use adaptive thinking (matching Claude Code)
	return { type: "adaptive" };
}

/**
 * Map reasoning effort to Anthropic effort parameter value.
 * Only for models that support the effort API (Opus 4.6, Sonnet 4.6).
 *
 * Mapping: low → low, medium → medium, high → high, xhigh → high
 * "none" is not mapped (thinking is disabled, effort is irrelevant).
 * Anthropic does not expose an xhigh tier, so we clamp to high.
 */
function mapEffortParam(
	reasoningEffort: string | undefined,
): "low" | "medium" | "high" | undefined {
	if (!reasoningEffort || reasoningEffort === "none") return undefined;
	const map: Record<string, "low" | "medium" | "high"> = {
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
	};
	return map[reasoningEffort];
}

// === SSE event types ===

interface AnthropicStreamEvent {
	type: string;
	index?: number;
	message?: {
		id?: string;
		model?: string;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		text?: string;
		input?: Record<string, unknown>;
		thinking?: string;
		signature?: string;
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
		signature?: string;
	};
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	error?: { type?: string; message?: string };
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
	/** Optional proxy URL for all requests. */
	private proxy?: string;
	/** Whether to reject unauthorized TLS certs (default true). */
	private tlsRejectUnauthorized: boolean;
	/** Cached base URL after successful /v1 fallback resolution. */
	private resolvedBaseUrl?: string;

	constructor(config: AnthropicProviderConfig) {
		this.config = config;
		this.proxy = config.proxy;
		this.tlsRejectUnauthorized = config.tlsRejectUnauthorized !== false;
	}

	/**
	 * Proxy-aware fetch with optional TLS verification bypass.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const extra: Record<string, unknown> = {};
		if (this.proxy) {
			extra.proxy = this.proxy;
		}
		if (!this.tlsRejectUnauthorized) {
			extra.tls = { rejectUnauthorized: false };
		}
		if (Object.keys(extra).length > 0) {
			// biome-ignore lint/suspicious/noExplicitAny: Bun-specific extensions on RequestInit
			return fetch(input, { ...init, ...extra } as any);
		}
		return fetch(input, init);
	}

	/** Get the effective base URL, using cached resolution if available. */
	private getBaseUrl(): string {
		if (this.resolvedBaseUrl) return this.resolvedBaseUrl;
		return (this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
	}

	/** Whether a base URL already ends with /v1 (case-insensitive). */
	private static hasV1Suffix(url: string): boolean {
		return /\/v1\/?$/i.test(url);
	}

	/**
	 * Fetch with automatic /v1 suffix fallback.
	 * If the initial request fails and the base URL doesn't already end with /v1,
	 * retries with /v1 appended. Caches the successful base URL for future calls.
	 */
	private async fetchWithV1Fallback(
		path: string,
		init: RequestInit,
		useProxy = false,
	): Promise<Response> {
		const baseUrl = this.getBaseUrl();
		const url = `${baseUrl}${path}`;
		const doFetch = useProxy ? this.pfetch.bind(this) : fetch;
		const response = await doFetch(url, init);

		if (!response.ok && !AnthropicProvider.hasV1Suffix(baseUrl)) {
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
				this.resolvedBaseUrl = retryBase;
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
		return buildAnthropicHistory(dbMessages);
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

		// Determine max_tokens based on model capabilities
		const tokenLimits = getTokenLimits(model);
		const maxTokens = tokenLimits.default;

		// Build thinking configuration
		const thinkingConfig = buildThinkingConfig(model, params.reasoningEffort);
		const thinkingEnabled = !!thinkingConfig && thinkingConfig.type !== "disabled";

		const isOfficial = !!this.config.officialApi;

		// Build system blocks — official API uses Claude Code 3-block structure,
		// proxy mode uses a simple text block.
		const systemBlocks: Array<Record<string, unknown>> = [];
		if (isOfficial) {
			systemBlocks.push(
				{ type: "text", text: BILLING_HEADER },
				{ type: "text", text: IDENTITY_BLOCK, ...CACHE_CONTROL },
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

		// Effort parameter: official API only (proxies may not support output_config)
		if (isOfficial && supportsEffort(model) && thinkingEnabled) {
			const effort = mapEffortParam(params.reasoningEffort);
			body.output_config = { effort: effort ?? "medium" };
		}

		body.system = systemBlocks;

		// Tools: official API injects server-side web_search; proxy mode uses function tools only.
		if (isOfficial) {
			const serverTools: Record<string, unknown>[] = [
				{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES },
			];
			body.tools = cachedTools ? [...cachedTools, ...serverTools] : serverTools;
		} else {
			if (cachedTools) {
				body.tools = cachedTools;
			}
		}

		// Add metadata if provided
		if (params.metadata) {
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
			reqHeaders["user-agent"] = CLAUDE_CLI_USER_AGENT;
			reqHeaders["x-app"] = "cli";
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
		}

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

		const response = await this.fetchWithV1Fallback(
			reqPath,
			{
				method: "POST",
				headers: reqHeaders,
				body: JSON.stringify(body),
				signal: params.signal,
			},
			true,
		);

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Anthropic API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("Anthropic API returned no body");
		}

		yield* parseAnthropicSSEStream(response.body);
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

	pushUserTurn(history: unknown[], content: string, _model: string, toolResults: unknown[]): void {
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

		if (content && content !== ".") {
			parts.push({ type: "text", text: content });
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
		}>,
	): void {
		const h = history as AnthropicMessage[];
		const parts: AnthropicContentPart[] = [];

		// Thinking blocks go first (matching Claude Code ordering)
		if (reasoningBlocks) {
			for (const rb of reasoningBlocks) {
				const sig = rb.providerMetadata?.anthropic?.signature ?? "";
				parts.push({ type: "thinking", thinking: rb.text, signature: sig });
			}
		}

		if (text) {
			parts.push({ type: "text", text });
		}

		for (const tu of toolUses) {
			parts.push({
				type: "tool_use",
				id: tu.toolUseId,
				name: tu.name,
				input: tu.input,
			});
		}

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
	): Promise<{ text: string; contextPercent?: number }> {
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

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (isOfficial) {
			headers.Authorization = `Bearer ${apiKey}`;
			headers["anthropic-beta"] = ANTHROPIC_BASE_BETA;
			headers["user-agent"] = CLAUDE_CLI_USER_AGENT;
		} else {
			headers["x-api-key"] = apiKey;
		}

		const response = await this.fetchWithV1Fallback("/messages", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Anthropic API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			content?: Array<{ type?: string; text?: string }>;
			usage?: {
				input_tokens?: number;
				output_tokens?: number;
				cache_read_input_tokens?: number;
				cache_creation_input_tokens?: number;
			};
		};

		const resultText =
			json.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("") ?? "";

		return { text: resultText, contextPercent: undefined };
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string> {
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
			genHeaders["user-agent"] = CLAUDE_CLI_USER_AGENT;
		} else {
			genHeaders["x-api-key"] = apiKey;
		}

		const response = await this.fetchWithV1Fallback("/messages", {
			method: "POST",
			headers: genHeaders,
			body: JSON.stringify({
				model: bareModel,
				max_tokens: 4096,
				system: isOfficial
					? [{ type: "text", text: systemInstruction, ...CACHE_CONTROL }]
					: [{ type: "text", text: systemInstruction }],
				messages: [{ role: "user", content: `${reminder}\n\n${content}` }],
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Anthropic API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			content?: Array<{ type?: string; text?: string }>;
		};

		return (
			json.content
				?.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("") ?? ""
		);
	}
}

// === SSE stream parser ===

async function* parseAnthropicSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let lineCount = 0;

	// Tool call accumulators keyed by content block index
	const toolAccum = new Map<number, ToolAccumEntry>();
	const thinkingAccum = new Map<number, ThinkingAccumEntry>();
	const serverToolAccum = new Map<number, ServerToolAccumEntry>();

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
				if (!trimmed || trimmed.startsWith("event:")) continue;
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

				let event: AnthropicStreamEvent;
				try {
					event = JSON.parse(jsonStr);
				} catch {
					continue;
				}

				const events = parseAnthropicEvent(event, toolAccum, thinkingAccum, serverToolAccum);
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
				const events = parseAnthropicEvent(event, toolAccum, thinkingAccum, serverToolAccum);
				for (const evt of events) {
					yield evt;
				}
			} catch {
				// ignore
			}
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
type ThinkingAccumEntry = { signature: string };

function parseAnthropicEvent(
	event: AnthropicStreamEvent,
	toolAccum: Map<number, ToolAccumEntry>,
	thinkingAccum: Map<number, ThinkingAccumEntry>,
	serverToolAccum: Map<number, ServerToolAccumEntry>,
): ParsedStreamEvent[] {
	const type = event.type;
	if (!type) return [];

	// ── Message start — extract message ID and usage ──
	if (type === "message_start" && event.message) {
		const results: ParsedStreamEvent[] = [];
		if (event.message.id) {
			results.push({ messageId: event.message.id });
		}
		if (event.message.usage?.input_tokens != null) {
			const cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
			const cacheCreation = event.message.usage.cache_creation_input_tokens ?? 0;
			results.push({
				usage: {
					// Total input tokens occupying the context window (uncached + cached)
					promptTokens: event.message.usage.input_tokens + cacheRead + cacheCreation,
					completionTokens: event.message.usage.output_tokens,
					cachedInputTokens: cacheRead + cacheCreation,
				},
			});
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
		// Thinking block start — initialize signature accumulator
		if (block.type === "thinking") {
			thinkingAccum.set(idx, { signature: "" });
			return [];
		}
		return [];
	}

	// ── Content block delta ──
	if (type === "content_block_delta" && event.delta) {
		const idx = event.index ?? 0;

		// Text delta
		if (event.delta.type === "text_delta" && event.delta.text) {
			return [{ text: event.delta.text }];
		}

		// Thinking delta (extended thinking)
		if (event.delta.type === "thinking_delta" && event.delta.thinking) {
			return [{ reasoning: event.delta.thinking }];
		}

		// Signature delta — accumulate for thinking block verification
		if (event.delta.type === "signature_delta" && event.delta.signature) {
			const acc = thinkingAccum.get(idx);
			if (acc) {
				acc.signature += event.delta.signature;
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
							anthropic: { signature: thinkAcc.signature },
						},
					},
				];
			}
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

		// Usage update
		if (event.usage?.output_tokens != null) {
			const cacheRead = event.usage.cache_read_input_tokens ?? 0;
			const cacheCreation = event.usage.cache_creation_input_tokens ?? 0;
			// message_delta typically only carries output_tokens — input_tokens is absent.
			// Only include promptTokens when input_tokens is actually present to avoid
			// overwriting the accurate value from message_start with 0.
			const inputTokens = event.usage.input_tokens;
			results.push({
				usage: {
					...(inputTokens != null && {
						promptTokens: inputTokens + cacheRead + cacheCreation,
						cachedInputTokens: cacheRead + cacheCreation,
					}),
					completionTokens: event.usage.output_tokens,
				},
			});
		}

		// Stop reason
		const stopReason = event.delta?.stop_reason;
		if (stopReason === "max_tokens") {
			results.push({
				invalidState: {
					reason: "max_tokens",
					message: "Response truncated: model reached maximum token limit.",
				},
			});
		}

		return results;
	}

	// ── Error ──
	if (type === "error") {
		const errMsg = event.error?.message ?? "Anthropic API error";
		return [{ invalidState: { reason: event.error?.type ?? "api_error", message: errMsg } }];
	}

	return [];
}

// === History builder ===

function buildAnthropicHistory(dbMessages: DbMessage[]): {
	history: AnthropicMessage[];
	trailingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
} {
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant"),
	);

	// Drop the last user message — it's sent as the current message
	if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
		topLevel.pop();
	}

	const history: AnthropicMessage[] = [];
	let pendingToolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

	for (const msg of topLevel) {
		if (msg.role === "assistant") {
			// Flush pending tool results as a user message
			if (pendingToolResults.length > 0) {
				history.push({
					role: "user",
					content: pendingToolResults.map((tr) => ({
						type: "tool_result" as const,
						tool_use_id: tr.tool_use_id,
						content: tr.content,
						is_error: tr.is_error,
					})),
				});
				pendingToolResults = [];
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

			// Thinking / redacted_thinking blocks go first (matching Claude Code ordering)
			for (const b of content) {
				const block = b as {
					type: string;
					thinking?: string;
					text?: string;
					signature?: string;
					data?: string;
					providerMetadata?: { anthropic?: { signature?: string } };
				};
				if (block.type === "thinking" && block.thinking) {
					parts.push({
						type: "thinking",
						thinking: block.thinking,
						signature: block.signature ?? "",
					});
				} else if (block.type === "reasoning" && block.text) {
					// DB stores thinking as "reasoning" blocks with signature in providerMetadata
					const sig = block.providerMetadata?.anthropic?.signature ?? "";
					parts.push({
						type: "thinking",
						thinking: block.text,
						signature: sig,
					});
				} else if (block.type === "redacted_thinking" && block.data) {
					parts.push({ type: "redacted_thinking", data: block.data });
				}
			}

			// Text blocks
			const textParts = content
				.filter((b: { type: string }) => b.type === "text")
				.map((b: { text: string }) => b.text);
			const text = textParts.join("\n") || msg.contentText || "";
			if (text) {
				parts.push({ type: "text", text });
			}

			// Tool use blocks
			const completedToolUseIds = new Set(
				msg.toolCalls
					?.filter((tc) => tc.status === "success" || tc.status === "fail")
					.map((tc) => tc.toolUseId) ?? [],
			);

			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.toolName && tc.toolUseId && completedToolUseIds.has(tc.toolUseId)) {
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
			}

			if (parts.length > 0) {
				ensureTextOrToolBlock(parts);
				history.push({ role: "assistant", content: parts });
			}

			// Collect tool results for next turn
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === "success" || tc.status === "fail") {
						const outputText =
							typeof tc.outputJson === "string"
								? tc.outputJson
								: tc.outputJson != null
									? JSON.stringify(tc.outputJson)
									: "";
						pendingToolResults.push({
							tool_use_id: tc.toolUseId,
							content: outputText,
							is_error: tc.status === "fail" || undefined,
						});
					}
				}
			}
		} else if (msg.role === "user") {
			// Flush pending tool results before user message
			if (pendingToolResults.length > 0) {
				history.push({
					role: "user",
					content: pendingToolResults.map((tr) => ({
						type: "tool_result" as const,
						tool_use_id: tr.tool_use_id,
						content: tr.content,
						is_error: tr.is_error,
					})),
				});
				pendingToolResults = [];
			}

			const text = msg.contentText || "";
			if (text) {
				history.push({ role: "user", content: text });
			}
		}
	}

	return { history, trailingToolResults: pendingToolResults };
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
		filtered.unshift({ role: "user", content: [{ type: "text", text: "." }] });
	}

	return filtered;
}

function toContentParts(content: string | AnthropicContentPart[]): AnthropicContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content;
}
