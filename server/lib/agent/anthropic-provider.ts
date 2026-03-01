import { logger } from "../logger";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { AnthropicProviderConfig } from "../settings";
import { parseModelId } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import { zodToJsonSchema } from "./tool-registry";
import type { AgentToolUse, ResolvedToolDefinition } from "./types";

// === Claude Code protocol constants ===

/**
 * Beta features header matching Claude Code / opencode protocol.
 * - claude-code-20250219: Claude Code agent mode
 * - interleaved-thinking-2025-05-14: interleaved thinking/reasoning
 * - fine-grained-tool-streaming-2025-05-14: streaming tool use deltas
 */
const ANTHROPIC_BETA_FLAGS =
	"claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";

/** Additional beta flag for 1M context window support (sonnet/opus models). */
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

/** OAuth beta flag required for Claude Pro/Max OAuth authentication. */
const OAUTH_BETA = "oauth-2025-04-20";

/** Cache control marker for ephemeral prompt caching. */
const CACHE_CONTROL = { cache_control: { type: "ephemeral" as const } };

/** Default Anthropic API base URL (includes /v1 path). */
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

/** User-Agent string mimicking Claude Code CLI (MAX mode). */
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.2 (external, cli)";

/** Tool name prefix required by Claude Code endpoint (MAX mode). */
const TOOL_PREFIX = "mcp_";

/**
 * Global cache_control counter — matches opencode's `cc()` pattern.
 * The first 4 content blocks (across system, messages, and tools) get ephemeral cache.
 */
function createCacheCounter() {
	let count = 0;
	return () => {
		count++;
		return count <= 4 ? CACHE_CONTROL : {};
	};
}

// === MAX mode helpers ===

/**
 * Build request headers for MAX mode (mimics Claude Code CLI).
 * Uses Bearer token auth instead of x-api-key.
 */
function buildMaxHeaders(apiKey: string, baseBetaFlags: string): Record<string, string> {
	const betaParts = new Set([
		OAUTH_BETA,
		"interleaved-thinking-2025-05-14",
		...baseBetaFlags
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	]);

	return {
		"Content-Type": "application/json",
		authorization: `Bearer ${apiKey}`,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": [...betaParts].join(","),
		"user-agent": CLAUDE_CLI_USER_AGENT,
	};
}

/**
 * Build request URL for MAX mode — appends ?beta=true.
 */
function buildMaxUrl(baseUrl: string): string {
	const url = new URL(`${baseUrl}/messages`);
	url.searchParams.set("beta", "true");
	return url.toString();
}

/**
 * Add mcp_ prefix to tool_use block names in messages (MAX mode).
 */
function prefixMessageToolNames(messages: AnthropicMessage[]): void {
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type === "tool_use") {
				part.name = `${TOOL_PREFIX}${part.name}`;
			}
		}
	}
}

/**
 * Strip mcp_ prefix from tool names in SSE stream text.
 */
function stripToolPrefix(text: string): string {
	return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
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
			content: string;
			is_error?: boolean;
			cache_control?: CacheControl;
	  };

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

/** Whether a model supports 1M context (sonnet or opus-4-6 variants). */
function supports1mContext(model: string): boolean {
	const lower = model.toLowerCase();
	return lower.includes("sonnet") || lower.includes("opus-4-6") || lower.includes("opus-4.6");
}

// === SSE event types ===

interface AnthropicStreamEvent {
	type: string;
	index?: number;
	message?: {
		id?: string;
		model?: string;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		text?: string;
		input?: Record<string, unknown>;
	};
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
		stop_reason?: string;
	};
	usage?: { input_tokens?: number; output_tokens?: number };
	error?: { type?: string; message?: string };
}

// === Tool call accumulator ===

interface ToolAccumEntry {
	id: string;
	name: string;
	args: string;
	emitted: boolean;
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

	constructor(config: AnthropicProviderConfig) {
		this.config = config;
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		// cache_control is applied later in chat() via the global counter
		return tools.map(
			(tool): AnthropicTool => ({
				name: tool.name,
				description: tool.description,
				input_schema: zodToJsonSchema(tool.parameters),
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
		const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

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
			content: string;
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

		const model = parseModelId(params.model).model;

		// Apply cache_control using a global counter (matching opencode's cc() pattern).
		// The counter is shared across system blocks, message blocks, and tool definitions.
		const cc = createCacheCounter();

		// Build system as array of text blocks with cache_control
		const systemBlocks = systemPrompt
			? [{ type: "text" as const, text: systemPrompt, ...cc() }]
			: undefined;

		// Apply cache_control to message content blocks
		for (const msg of messages) {
			if (typeof msg.content === "string") {
				msg.content = [{ type: "text", text: msg.content, ...cc() }];
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					Object.assign(part, cc());
				}
			}
		}

		// Apply cache_control to tool definitions
		const cachedTools =
			tools.length > 0
				? tools.map((t) => ({
						...t,
						...cc(),
					}))
				: undefined;

		const isMax = !!this.config.maxMode;

		// MAX mode: prefix tool names with mcp_ and prefix tool_use in messages
		if (isMax && cachedTools) {
			for (const t of cachedTools) {
				t.name = `${TOOL_PREFIX}${t.name}`;
			}
		}
		if (isMax) {
			prefixMessageToolNames(messages);
		}

		const body: Record<string, unknown> = {
			model,
			messages,
			max_tokens: 32_000,
			stream: true,
			service_tier: "standard_only",
		};
		if (systemBlocks) {
			body.system = systemBlocks;
		}
		if (cachedTools) {
			body.tools = cachedTools;
		}

		// Build headers matching Claude Code protocol
		const betaFlags = supports1mContext(model)
			? `${ANTHROPIC_BETA_FLAGS},${CONTEXT_1M_BETA}`
			: ANTHROPIC_BETA_FLAGS;

		let reqUrl: string;
		let reqHeaders: Record<string, string>;

		if (isMax) {
			reqUrl = buildMaxUrl(baseUrl);
			reqHeaders = buildMaxHeaders(apiKey, betaFlags);
		} else {
			reqUrl = `${baseUrl}/messages`;
			reqHeaders = {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": betaFlags,
			};
		}

		logger.debug("Anthropic chat request", {
			model,
			endpoint: reqUrl,
			toolCount: tools.length,
			messageCount: messages.length,
			hasSystem: !!systemPrompt,
			maxMode: isMax,
		});

		const response = await fetch(reqUrl, {
			method: "POST",
			headers: reqHeaders,
			body: JSON.stringify(body),
			signal: params.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Anthropic API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("Anthropic API returned no body");
		}

		yield* parseAnthropicSSEStream(response.body, isMax);
	}

	formatToolResult(toolUseId: string, output: string, isError: boolean): unknown {
		return { tool_use_id: toolUseId, content: output, is_error: isError || undefined };
	}

	pushUserTurn(history: unknown[], content: string, _model: string, toolResults: unknown[]): void {
		const h = history as AnthropicMessage[];
		const parts: AnthropicContentPart[] = [];

		for (const tr of toolResults as Array<{
			tool_use_id: string;
			content: string;
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

	pushAssistantTurn(history: unknown[], text: string, toolUses: AgentToolUse[]): void {
		const h = history as AnthropicMessage[];
		const parts: AnthropicContentPart[] = [];

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
	): Promise<{ text: string; contextPercent?: number }> {
		const apiKey = this.config.apiKey;
		const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const bareModel = parseModelId(model).model;
		const betaFlags = supports1mContext(bareModel)
			? `${ANTHROPIC_BETA_FLAGS},${CONTEXT_1M_BETA}`
			: ANTHROPIC_BETA_FLAGS;

		const response = await fetch(`${baseUrl}/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": betaFlags,
			},
			body: JSON.stringify({
				model: bareModel,
				max_tokens: 4096,
				messages: [{ role: "user", content: text }],
				service_tier: "standard_only",
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Anthropic API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			content?: Array<{ type?: string; text?: string }>;
			usage?: { input_tokens?: number; output_tokens?: number };
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
		const baseUrl = (this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`Anthropic API key not configured for provider "${this.config.name}".`);
		}

		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		const bareModel = parseModelId(model).model;
		const betaFlags = supports1mContext(bareModel)
			? `${ANTHROPIC_BETA_FLAGS},${CONTEXT_1M_BETA}`
			: ANTHROPIC_BETA_FLAGS;

		const response = await fetch(`${baseUrl}/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": betaFlags,
			},
			body: JSON.stringify({
				model: bareModel,
				max_tokens: 4096,
				system: [{ type: "text", text: systemInstruction, ...CACHE_CONTROL }],
				messages: [{ role: "user", content: `${reminder}\n\n${content}` }],
				service_tier: "standard_only",
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Anthropic API error ${response.status}: ${errText}`);
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
	stripMcpPrefix = false,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let lineCount = 0;

	// Tool call accumulators keyed by content block index
	const toolAccum = new Map<number, ToolAccumEntry>();

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// MAX mode: strip mcp_ prefix from tool names in the raw stream
			if (stripMcpPrefix) {
				buffer = stripToolPrefix(buffer);
			}

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("event:")) continue;
				if (!trimmed.startsWith("data: ")) continue;

				if (lineCount < 5) {
					logger.debug("Anthropic SSE line", {
						lineIndex: lineCount,
						preview: trimmed.slice(0, 300),
					});
				}
				lineCount++;

				let event: AnthropicStreamEvent;
				try {
					event = JSON.parse(trimmed.slice(6));
				} catch {
					continue;
				}

				const events = parseAnthropicEvent(event, toolAccum);
				for (const evt of events) {
					yield evt;
				}
			}
		}

		// Process remaining buffer
		if (buffer.trim()?.startsWith("data: ")) {
			try {
				const event = JSON.parse(buffer.trim().slice(6));
				const events = parseAnthropicEvent(event, toolAccum);
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

function parseAnthropicEvent(
	event: AnthropicStreamEvent,
	toolAccum: Map<number, ToolAccumEntry>,
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
			results.push({
				usage: {
					promptTokens: event.message.usage.input_tokens,
					completionTokens: event.message.usage.output_tokens,
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
		if (event.delta.type === "thinking_delta" && event.delta.text) {
			return [{ reasoning: event.delta.text }];
		}

		// Tool use input delta
		if (event.delta.type === "input_json_delta" && event.delta.partial_json != null) {
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
			results.push({
				usage: {
					promptTokens: event.usage.input_tokens ?? 0,
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

	const result: AnthropicMessage[] = [];
	for (const msg of messages) {
		// Normalize string content to array format
		const normalized: AnthropicMessage = {
			role: msg.role,
			content:
				typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content,
		};

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

	// Anthropic requires the first message to be from user
	if (result.length > 0 && result[0].role === "assistant") {
		result.unshift({ role: "user", content: [{ type: "text", text: "." }] });
	}

	return result;
}

function toContentParts(content: string | AnthropicContentPart[]): AnthropicContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content;
}
