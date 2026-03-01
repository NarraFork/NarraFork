import { logger } from "../logger";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { OpenAIProviderConfig } from "../settings";
import { parseModelId } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import { zodToJsonSchema } from "./tool-registry";
import type { AgentToolUse, ResolvedToolDefinition } from "./types";

export type OpenAIApiMode = "responses" | "completions" | "codex";

/** Resolve apiMode from provider config, with backward compat for the old `responsesApi` boolean. */
function resolveApiMode(config?: OpenAIProviderConfig): OpenAIApiMode {
	if (config?.apiMode) return config.apiMode;
	// Legacy: responsesApi === false → completions
	if (config?.responsesApi === false) return "completions";
	return "responses";
}

/** Whether this mode uses Responses API message format (responses & codex both do). */
function usesResponsesFormat(mode: OpenAIApiMode): boolean {
	return mode === "responses" || mode === "codex";
}

/** Whether this mode uses the /responses endpoint (responses & codex both do). */
function usesResponsesEndpoint(mode: OpenAIApiMode): boolean {
	return mode === "responses" || mode === "codex";
}

/** Default base URL per mode. */
function defaultBaseUrl(mode: OpenAIApiMode): string {
	if (mode === "codex") return "https://chatgpt.com/backend-api/codex";
	return "https://api.openai.com/v1";
}

// === OpenAI identity prompt ===
// OpenAI models need an explicit identity and tool-use instruction in the system prompt.
// OpenAI models benefit from system-level guidance to actively use their tools.

const OPENAI_IDENTITY: Record<string, string> = {
	en: `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools. For example, use Read to examine files, Write/Edit to modify them, Bash to run commands, Glob/Grep to search, etc.`,
	"zh-CN": `你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。例如，使用 Read 查看文件，Write/Edit 修改文件，Bash 运行命令，Glob/Grep 搜索等。`,
};

// === OpenAI message types ===

type OAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

interface OAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | OAIContentPart[] | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
}

interface OAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OAITool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

// === SSE delta types ===

interface OAIDelta {
	role?: string;
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface OAIStreamChunk {
	id?: string;
	choices?: Array<{ index: number; delta: OAIDelta; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	error?: { message?: string; type?: string; code?: string | number };
	// --- Responses API fields (used by some gateways/proxies) ---
	/** Responses API: top-level argument delta string for function calls */
	delta?: string;
	/** Responses API: item object containing function call metadata */
	item?: {
		call_id?: string;
		name?: string;
		arguments?: string;
		status?: string;
		type?: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic gateway response
		[key: string]: any;
	};
	/** Responses API: response metadata (instructions, status, etc.) */
	response?: {
		status?: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic gateway response
		[key: string]: any;
	};
}

/**
 * OpenAI-compatible API provider.
 *
 * Supports three API modes:
 *   - "responses"   — Native OpenAI Responses API (/responses endpoint)
 *   - "completions"  — Standard Chat Completions API (/chat/completions)
 *   - "codex"        — Codex gateway: Responses API message format sent to
 *                       /chat/completions, with SSE auto-detection for the
 *                       response stream format.
 */
export class OpenAIProvider implements ProviderAdapter {
	/**
	 * Which API variant to use. Resolved from config on construction.
	 * For "codex" mode, may be upgraded to "responses" if the SSE stream
	 * reveals native Responses API events.
	 */
	apiMode: OpenAIApiMode;

	/** The provider config this instance operates with. */
	private config: OpenAIProviderConfig;

	constructor(config: OpenAIProviderConfig) {
		this.config = config;
		this.apiMode = resolveApiMode(config);
	}

	/** Convenience: does the current mode use Responses API message format? */
	private get responsesFormat(): boolean {
		return usesResponsesFormat(this.apiMode);
	}
	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		if (this.responsesFormat) {
			// Responses API & Codex: flat format { type: "function", name, description, parameters }
			return tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: zodToJsonSchema(tool.parameters),
			}));
		}
		// Completions: nested format { type: "function", function: { ... } }
		return tools.map(
			(tool): OAITool => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: zodToJsonSchema(tool.parameters),
				},
			}),
		);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		_model: string,
		_narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		const result = buildOAIHistory(dbMessages);
		if (this.responsesFormat) {
			// Convert standard format to Responses API format upfront
			return {
				history: convertHistoryToResponsesApi(result.history),
				trailingToolResults: result.trailingToolResults.map((tr) => ({
					type: "function_call_output" as const,
					call_id: tr.tool_call_id,
					output: tr.content,
				})),
			};
		}
		return result;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		const h = history as OAIMessage[];
		const locale = (_locale ?? "en") as Locale;
		const identity = OPENAI_IDENTITY[locale] ?? OPENAI_IDENTITY.en;
		const content = `${identity}\n\n${systemPrompt}`;
		const role = this.responsesFormat ? "developer" : "system";
		h.unshift({ role, content } as unknown as OAIMessage);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = this.config.apiKey;
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const history = params.history as OAIMessage[];
		const tools = params.tools as OAITool[];

		// Build messages: history + pending tool results + current user message
		const messages: OAIMessage[] = [...history];

		// Append tool results
		if (this.responsesFormat) {
			for (const tr of params.toolResults as Array<{
				type: string;
				call_id: string;
				output: string;
			}>) {
				logger.debug("OpenAI appending Responses API tool result", {
					type: tr.type,
					call_id: tr.call_id,
					outputLength: tr.output?.length,
				});
				// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				messages.push(tr as any);
			}
		} else {
			for (const tr of params.toolResults as OAIToolResult[]) {
				messages.push({
					role: "tool",
					tool_call_id: tr.tool_call_id,
					content: tr.content,
				});
			}
		}

		// Append current user message (skip "." continuation markers)
		if (params.content && params.content !== ".") {
			if (params.images?.length) {
				const parts: OAIContentPart[] = [{ type: "text", text: params.content }];
				for (const img of params.images) {
					parts.push({
						type: "image_url",
						image_url: { url: `data:image/${img.format};base64,${img.base64}` },
					});
				}
				messages.push({ role: "user", content: parts });
			} else {
				messages.push({ role: "user", content: params.content });
			}
		} else if (params.toolResults.length === 0) {
			messages.push({ role: "user", content: params.content });
		}

		// ── Build request body & endpoint based on apiMode ──
		const model = parseModelId(params.model).model;
		let endpoint: string;
		let body: Record<string, unknown>;

		if (usesResponsesEndpoint(this.apiMode)) {
			// Responses API & Codex: POST /responses
			endpoint = `${baseUrl}/responses`;
			body = { model, input: messages, stream: true, store: false };
			if (tools.length > 0) body.tools = tools;
		} else {
			// Completions: POST /chat/completions
			endpoint = `${baseUrl}/chat/completions`;
			body = {
				model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools.length > 0) body.tools = tools;
		}

		logger.debug("OpenAI chat request", {
			model,
			apiMode: this.apiMode,
			endpoint,
			toolCount: tools.length,
			messageCount: messages.length,
			hasToolResults: (params.toolResults as unknown[]).length > 0,
			messageStructure: messages.map((m, i) => {
				// biome-ignore lint/suspicious/noExplicitAny: debug logging
				const msg = m as any;
				const role = msg.role ?? msg.type ?? "?";
				const extra =
					msg.type === "function_call"
						? `:${msg.name}`
						: msg.type === "function_call_output"
							? `:${msg.call_id?.slice(0, 12)}`
							: msg.tool_calls
								? `:tc=${msg.tool_calls.length}`
								: "";
				return `[${i}]${role}${extra}`;
			}),
		});

		const response = await fetch(endpoint, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify(body),
			signal: params.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`OpenAI API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("OpenAI API returned no body");
		}

		if (usesResponsesEndpoint(this.apiMode)) {
			// Responses API & Codex both use the native Responses SSE format
			yield* _parseResponsesAPIStream(response.body);
		} else {
			yield* this.parseSSEStreamWithDetection(response.body);
		}
	}

	/**
	 * Wrap parseSSEStream to detect Responses API format from Codex gateways.
	 * Only relevant for "codex" mode — completions mode ignores the marker.
	 */
	private async *parseSSEStreamWithDetection(
		body: ReadableStream<Uint8Array>,
	): AsyncGenerator<ParsedStreamEvent> {
		for await (const evt of parseSSEStream(body)) {
			if (evt._responsesApi && this.apiMode === "codex") {
				logger.debug("Codex gateway confirmed Responses API format");
			}
			yield evt;
		}
	}

	formatToolResult(toolUseId: string, output: string, _isError: boolean): unknown {
		logger.debug("OpenAI formatToolResult", {
			apiMode: this.apiMode,
			toolUseId,
			outputLength: output.length,
		});
		if (this.responsesFormat) {
			return { type: "function_call_output", call_id: toolUseId, output };
		}
		return { tool_call_id: toolUseId, content: output } satisfies OAIToolResult;
	}

	pushUserTurn(history: unknown[], content: string, _model: string, toolResults: unknown[]): void {
		const h = history as OAIMessage[];
		if (this.responsesFormat) {
			for (const tr of toolResults as Array<{ type: string; call_id: string; output: string }>) {
				// biome-ignore lint/suspicious/noExplicitAny: Responses API uses different message shape
				h.push(tr as any);
			}
		} else {
			for (const tr of toolResults as OAIToolResult[]) {
				h.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
		}
		if (content && content !== ".") {
			h.push({ role: "user", content });
		}
	}

	pushAssistantTurn(history: unknown[], text: string, toolUses: AgentToolUse[]): void {
		const h = history as OAIMessage[];
		if (this.responsesFormat) {
			if (text) {
				// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				h.push({ role: "assistant", content: text } as any);
			}
			for (const tu of toolUses) {
				logger.debug("OpenAI pushAssistantTurn function_call", {
					call_id: tu.toolUseId,
					name: tu.name,
				});
				h.push({
					type: "function_call",
					call_id: tu.toolUseId,
					name: tu.name,
					arguments: JSON.stringify(tu.input),
					// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				} as any);
			}
		} else {
			const msg: OAIMessage = { role: "assistant", content: text || null };
			if (toolUses.length > 0) {
				msg.tool_calls = toolUses.map((tu) => ({
					id: tu.toolUseId,
					type: "function" as const,
					function: { name: tu.name, arguments: JSON.stringify(tu.input) },
				}));
			}
			h.push(msg);
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
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const bareModel = parseModelId(model).model;

		if (usesResponsesEndpoint(this.apiMode)) {
			// Responses API & Codex: POST /responses (non-streaming)
			const response = await fetch(`${baseUrl}/responses`, {
				method: "POST",
				headers: this.buildHeaders(apiKey),
				body: JSON.stringify({
					model: bareModel,
					input: [{ role: "user", content: text }],
					store: false,
				}),
			});
			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				throw new Error(`OpenAI API error ${response.status}: ${errText}`);
			}
			const json = (await response.json()) as {
				output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
			};
			return { text: extractResponsesText(json.output), contextPercent: undefined };
		}

		// Completions: POST /chat/completions
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify({
				model: bareModel,
				messages: [{ role: "user", content: text }],
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`OpenAI API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
		};

		return {
			text: json.choices?.[0]?.message?.content ?? "",
			contextPercent: undefined,
		};
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string> {
		const apiKey = this.config.apiKey;
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		const bareModel = parseModelId(model).model;

		if (usesResponsesEndpoint(this.apiMode)) {
			// Responses API & Codex
			const response = await fetch(`${baseUrl}/responses`, {
				method: "POST",
				headers: this.buildHeaders(apiKey),
				body: JSON.stringify({
					model: bareModel,
					instructions: systemInstruction,
					input: [{ role: "user", content: `${reminder}\n\n${content}` }],
					store: false,
				}),
			});
			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				throw new Error(`OpenAI API error ${response.status}: ${errText}`);
			}
			const json = (await response.json()) as {
				output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
			};
			return extractResponsesText(json.output);
		}

		// Completions
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify({
				model: bareModel,
				messages: [
					{ role: "system", content: systemInstruction },
					{ role: "user", content: `${reminder}\n\n${content}` },
				],
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`OpenAI API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		return json.choices?.[0]?.message?.content ?? "";
	}

	/** Build common request headers, with Codex-specific extras. */
	private buildHeaders(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		};
		if (this.apiMode === "codex") {
			headers.originator = "narrafork";
			const accountId = this.config.codexAccountId;
			// Only send ChatGPT-Account-Id to official ChatGPT domains to avoid
			// leaking the account identifier to third-party proxies.
			if (accountId && isOfficialChatGPTDomain(this.config.baseUrl)) {
				headers["ChatGPT-Account-Id"] = accountId;
			}
		}
		return headers;
	}
}

/** Extract text from a Responses API output array. */
function extractResponsesText(
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>,
): string {
	return (
		output
			?.filter((o) => o.type === "message")
			.flatMap((o) => o.content ?? [])
			.filter((c) => c.type === "output_text")
			.map((c) => c.text ?? "")
			.join("") ?? ""
	);
}

// === Internal types ===

interface OAIToolResult {
	tool_call_id: string;
	content: string;
}

// === Helpers ===

/** Try to parse a string as JSON. Returns true if valid. */
function isParsableJson(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

// === Responses API SSE stream parser ===

/**
 * Parse native OpenAI Responses API SSE stream.
 *
 * Event types we handle:
 *   response.output_text.delta      → text streaming
 *   response.output_text.done       → (ignored, text already accumulated)
 *   response.output_item.added      → detect function_call items (tool call start)
 *   response.function_call_arguments.delta → tool call argument streaming
 *   response.function_call_arguments.done  → tool call complete
 *   response.output_item.done       → finalize tool call if not yet emitted
 *   response.completed              → flush remaining
 *   response.failed / response.incomplete → error states
 *   response.reasoning_summary_text.delta → reasoning content
 */
async function* _parseResponsesAPIStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let lineCount = 0;

	// Tool call accumulators keyed by output_index (matches OpenAI SSE structure)
	const toolAccum = new Map<number, ResponsesToolAccum>();

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
				if (!trimmed.startsWith("data: ")) continue;

				if (lineCount < 5) {
					logger.debug("Responses API SSE line", {
						lineIndex: lineCount,
						preview: trimmed.slice(0, 300),
					});
				}
				lineCount++;

				let chunk: ResponsesAPIChunk;
				try {
					chunk = JSON.parse(trimmed.slice(6));
				} catch {
					continue;
				}

				const events = parseResponsesAPIEvent(chunk, toolAccum);
				for (const evt of events) {
					yield evt;
				}
			}
		}
		// Process remaining buffer
		if (buffer.trim()?.startsWith("data: ")) {
			try {
				const chunk = JSON.parse(buffer.trim().slice(6));
				const events = parseResponsesAPIEvent(chunk, toolAccum);
				for (const evt of events) {
					yield evt;
				}
			} catch (err) {
				logger.debug("Responses API: failed to parse remaining buffer", {
					bufferLength: buffer.length,
					error: String(err),
				});
			}
		}
		// Flush any un-emitted tool calls
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				acc.emitted = true;
				yield { toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } };
			}
		}
	} finally {
		reader.releaseLock();
	}
}

interface ResponsesAPIChunk {
	type?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	item?: any;
	/** Present on delta/done events to identify the item */
	item_id?: string;
	delta?: string;
	output_index?: number;
	content_index?: number;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	response?: any;
}

/** Accumulator for a single Responses API tool call, keyed by output_index. */
interface ResponsesToolAccum {
	callId: string;
	name: string;
	args: string;
	emitted: boolean;
}

function parseResponsesAPIEvent(
	chunk: ResponsesAPIChunk,
	toolAccum: Map<number, ResponsesToolAccum>,
): ParsedStreamEvent[] {
	const type = chunk.type;
	if (!type) return [];

	// ── Text streaming ──
	if (type === "response.output_text.delta" && typeof chunk.delta === "string") {
		return [{ text: chunk.delta }];
	}

	// ── Reasoning content ──
	if (type === "response.reasoning_summary_text.delta" && typeof chunk.delta === "string") {
		return [{ reasoning: chunk.delta }];
	}

	// ── Function call: output_item.added ──
	// { type, output_index, item: { type: "function_call", id, call_id, name, arguments } }
	if (type === "response.output_item.added" && chunk.item?.type === "function_call") {
		const idx = chunk.output_index;
		const callId = chunk.item.call_id;
		const name = chunk.item.name;
		if (idx != null && callId && name) {
			toolAccum.set(idx, { callId, name, args: "", emitted: false });
			logger.debug("Responses API tool call started", { outputIndex: idx, callId, toolName: name });
			return [
				{
					toolUseChunk: { toolUseId: callId, name, input: undefined, stop: false },
					_responsesApi: true,
				},
			];
		}
	}

	// ── Function call: arguments delta ──
	// { type, item_id, output_index, delta: "..." }
	// NOTE: This event does NOT have item.call_id — use output_index to find the accumulator.
	if (type === "response.function_call_arguments.delta" && typeof chunk.delta === "string") {
		const idx = chunk.output_index;
		const acc = idx != null ? toolAccum.get(idx) : undefined;
		if (acc && !acc.emitted) {
			acc.args += chunk.delta;
			const results: ParsedStreamEvent[] = [
				{
					toolUseChunk: {
						toolUseId: acc.callId,
						name: acc.name,
						input: chunk.delta,
						stop: false,
					},
				},
			];
			// Early completion if args form valid JSON
			if (isParsableJson(acc.args)) {
				results.push({
					toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true },
				});
				acc.emitted = true;
			}
			return results;
		}
	}

	// ── Function call: arguments done ──
	// Some API versions send this; use output_index to find accumulator.
	if (type === "response.function_call_arguments.done") {
		const idx = chunk.output_index;
		const acc = idx != null ? toolAccum.get(idx) : undefined;
		if (acc && !acc.emitted) {
			if (typeof chunk.item?.arguments === "string") {
				acc.args = chunk.item.arguments;
			}
			acc.emitted = true;
			return [{ toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } }];
		}
	}

	// ── Output item done (finalizes function_call) ──
	// { type, output_index, item: { type: "function_call", id, call_id, name, arguments, status: "completed" } }
	if (type === "response.output_item.done" && chunk.item?.type === "function_call") {
		const idx = chunk.output_index;
		const acc = idx != null ? toolAccum.get(idx) : undefined;
		if (acc && !acc.emitted) {
			if (typeof chunk.item.arguments === "string") {
				acc.args = chunk.item.arguments;
			}
			acc.emitted = true;
			return [{ toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } }];
		}
	}

	// ── Response completed ──
	if (type === "response.completed") {
		const results: ParsedStreamEvent[] = [];
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({ toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } });
				acc.emitted = true;
			}
		}
		// Extract usage info for context window tracking
		const usage = chunk.response?.usage;
		if (usage?.input_tokens != null) {
			results.push({
				usage: { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens },
			});
		}
		return results;
	}

	// ── Error states ──
	if (type === "response.failed") {
		const errMsg = chunk.response?.error?.message ?? "Response failed";
		return [{ invalidState: { reason: "api_error", message: errMsg } }];
	}
	if (type === "response.incomplete") {
		const reason = chunk.response?.incomplete_details?.reason ?? "unknown";
		return [{ invalidState: { reason, message: `Response incomplete: ${reason}` } }];
	}

	return [];
}

// === SSE stream parser ===

/**
 * Tool call accumulator entry.
 * `emitted` tracks whether a toolUseChunk with stop=true has already been
 * yielded for this tool call (via the isParsableJson early-emit path).
 */
interface ToolAccumEntry {
	id: string;
	name: string;
	args: string;
	emitted: boolean;
}

async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	// Accumulate tool call chunks by index
	const toolAccum = new Map<number, ToolAccumEntry>();
	let lineCount = 0;

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				// Log first few SSE lines for debugging
				if (lineCount < 5 && line.trim() && line.startsWith("data: ")) {
					logger.debug("OpenAI SSE line", {
						lineIndex: lineCount,
						preview: line.slice(0, 300),
					});
				}
				lineCount++;
				const events = parseSSELine(line, toolAccum);
				for (const evt of events) {
					yield evt;
				}
			}
		}
		// Process any remaining data in the buffer after stream ends
		if (buffer.trim()) {
			const events = parseSSELine(buffer, toolAccum);
			for (const evt of events) {
				yield evt;
			}
		}
		// Flush any remaining accumulated tool calls that weren't emitted
		// (e.g. stream ended without a finish_reason chunk)
		const remaining = flushToolAccum(toolAccum);
		if (remaining) yield remaining;
	} finally {
		reader.releaseLock();
	}
}

/** Drain un-emitted tool calls from the accumulator into a ParsedStreamEvent. */
function flushToolAccum(toolAccum: Map<number, ToolAccumEntry>): ParsedStreamEvent | null {
	const toolUses: AgentToolUse[] = [];
	for (const [, acc] of toolAccum) {
		if (acc.emitted) continue; // already yielded via toolUseChunk
		if (!acc.id) {
			logger.error("OpenAI tool call missing ID from stream", { toolName: acc.name });
			continue;
		}
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(acc.args);
		} catch {
			logger.warn("Failed to parse OpenAI tool arguments", {
				toolName: acc.name,
				argsLength: acc.args.length,
			});
			input = { _raw: acc.args };
		}
		toolUses.push({
			toolUseId: acc.id,
			name: acc.name,
			input,
		});
	}
	toolAccum.clear();
	return toolUses.length > 0 ? { toolUses } : null;
}

function parseSSELine(line: string, toolAccum: Map<number, ToolAccumEntry>): ParsedStreamEvent[] {
	const trimmed = line.trim();
	if (!trimmed || trimmed === "data: [DONE]") return [];
	if (!trimmed.startsWith("data: ")) return [];

	let chunk: OAIStreamChunk;
	try {
		chunk = JSON.parse(trimmed.slice(6));
	} catch {
		return [];
	}

	// Handle error objects embedded in stream chunks
	// (some providers send errors as {error: {message, type, code}} inside the SSE stream)
	if (chunk.error) {
		const msg = chunk.error.message || "Unknown OpenAI API error";
		return [
			{
				invalidState: {
					reason: String(chunk.error.code ?? chunk.error.type ?? "api_error"),
					message: msg,
				},
			},
		];
	}

	// Usage-only chunk (sent when stream_options.include_usage is true).
	// This arrives as a separate chunk with no choices.
	// Convert to usage event for context window tracking.
	if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
		const promptTokens = chunk.usage.prompt_tokens;
		if (promptTokens != null) {
			return [{ usage: { promptTokens, completionTokens: chunk.usage.completion_tokens } }];
		}
		return [];
	}

	// ── Responses API: function call start (item with call_id + name) ──
	// Some gateways (e.g. Codex-compatible proxies) wrap the OpenAI Responses API
	// in a Chat Completions–like SSE envelope. Tool calls arrive as:
	//   { item: { call_id, name, status: "in_progress" }, ... }
	// followed by argument deltas as:
	//   { delta: "<json-fragment>", id: "fc_..." }
	// and completion as:
	//   { item: { call_id, status: "completed" } }
	if (chunk.item?.call_id && chunk.item?.name && chunk.item?.status === "in_progress") {
		const id = chunk.item.call_id;
		const name = chunk.item.name;
		// Use a fixed index slot (keyed by call_id hash) since Responses API doesn't use index
		const idx = responsesApiSlot(id, toolAccum);
		if (!toolAccum.has(idx)) {
			toolAccum.set(idx, { id, name, args: chunk.item.arguments ?? "", emitted: false });
			logger.debug("OpenAI Responses API tool call started", { callId: id, toolName: name });
			return [
				{
					toolUseChunk: { toolUseId: id, name, input: undefined, stop: false },
					_responsesApi: true,
				},
			];
		}
		return [];
	}

	// ── Responses API: function call argument delta ──
	// Identified by: top-level `delta` string + `id` starting with "fc_"
	if (typeof chunk.delta === "string" && chunk.id?.startsWith("fc_")) {
		// Find the active (non-emitted) tool call accumulator
		const acc = findActiveResponsesAcc(toolAccum);
		if (acc && !acc.emitted) {
			acc.args += chunk.delta;
			const results: ParsedStreamEvent[] = [
				{
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						input: chunk.delta,
						stop: false,
					},
				},
			];
			if (isParsableJson(acc.args)) {
				results.push({
					toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
				});
				acc.emitted = true;
			}
			return results;
		}
		return [];
	}

	// ── Responses API: function call completed ──
	if (chunk.item?.call_id && chunk.item?.status === "completed") {
		const acc = findAccByCallId(toolAccum, chunk.item.call_id);
		if (acc && !acc.emitted) {
			acc.emitted = true;
			return [{ toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } }];
		}
		return [];
	}

	// ── Responses API: response completed ──
	if (chunk.response?.status === "completed") {
		// Flush any remaining un-emitted tool calls
		const results: ParsedStreamEvent[] = [];
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({ toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } });
				acc.emitted = true;
			}
		}
		return results;
	}

	// ── Standard Chat Completions format below ──

	const choice = chunk.choices?.[0];
	if (!choice) return [];

	const delta = choice.delta;
	const results: ParsedStreamEvent[] = [];
	const result: ParsedStreamEvent = {};

	// Text content
	if (delta.content) {
		result.text = delta.content;
	}

	// Reasoning content (extended thinking / reasoning_content)
	// biome-ignore lint/suspicious/noExplicitAny: gateway-specific field
	const reasoning = (delta as any).reasoning_content;
	if (typeof reasoning === "string" && reasoning) {
		result.reasoning = reasoning;
	}

	// Tool call deltas — emit as toolUseChunk for early execution support
	if (delta.tool_calls) {
		for (const tc of delta.tool_calls) {
			const idx = tc.index;

			// First chunk for this tool call — initialize accumulator
			if (tc.id && !toolAccum.has(idx)) {
				const id = tc.id;
				const name = tc.function?.name ?? "";
				toolAccum.set(idx, { id, name, args: "", emitted: false });
				logger.debug("OpenAI tool call started", { toolCallId: id, toolName: name, index: idx });
				// Emit initial chunk so the loop knows the tool name early
				results.push({
					toolUseChunk: { toolUseId: id, name, input: undefined, stop: false },
				});
			}

			const acc = toolAccum.get(idx);
			if (acc && !acc.emitted) {
				if (tc.function?.arguments) {
					acc.args += tc.function.arguments;
					// Emit argument delta (include name for consumer convenience)
					results.push({
						toolUseChunk: {
							toolUseId: acc.id,
							name: acc.name,
							input: tc.function.arguments,
							stop: false,
						},
					});

					// Early completion: if accumulated args form valid JSON, emit stop
					// immediately so the agent loop can start executing the tool while
					// the rest of the stream (other tool calls / text) is still arriving.
					if (isParsableJson(acc.args)) {
						results.push({
							toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
						});
						acc.emitted = true;
					}
				}
			}
		}
	}

	// On any finish_reason, finalize
	if (choice.finish_reason) {
		logger.debug("OpenAI stream finish", {
			finishReason: choice.finish_reason,
			accumulatedToolCalls: toolAccum.size,
		});
		// Emit stop for any tool calls that haven't been early-emitted yet
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({
					toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
				});
				acc.emitted = true;
			}
		}

		// Also emit as flat toolUses for consumers that don't handle toolUseChunk
		const flushed = flushToolAccum(toolAccum);
		if (flushed) {
			Object.assign(result, flushed);
		}

		// Map non-normal finish reasons to invalidState
		switch (choice.finish_reason) {
			case "stop":
			case "tool_calls":
				// Normal completion — no action needed
				break;
			case "length":
				result.invalidState = {
					reason: "max_tokens",
					message: "Response truncated: model reached maximum token limit.",
				};
				break;
			case "content_filter":
				result.invalidState = {
					reason: "content_filter",
					message: "Response blocked by content filter.",
				};
				break;
			default:
				logger.warn("Unknown OpenAI finish reason", { finishReason: choice.finish_reason });
		}
	}

	if (result.text || result.toolUses || result.invalidState || result.reasoning) {
		results.push(result);
	}
	return results;
}

// ── Responses API helpers ──

/** Allocate a stable numeric slot for a Responses API call_id. */
function responsesApiSlot(callId: string, toolAccum: Map<number, ToolAccumEntry>): number {
	// Check if this call_id already has a slot
	for (const [idx, acc] of toolAccum) {
		if (acc.id === callId) return idx;
	}
	// Assign next available slot starting from 10000 to avoid collision with standard indices
	let slot = 10000;
	while (toolAccum.has(slot)) slot++;
	return slot;
}

/** Find the most recently added non-emitted accumulator (for Responses API argument deltas). */
function findActiveResponsesAcc(
	toolAccum: Map<number, ToolAccumEntry>,
): ToolAccumEntry | undefined {
	let latest: ToolAccumEntry | undefined;
	for (const [, acc] of toolAccum) {
		if (!acc.emitted) latest = acc;
	}
	return latest;
}

/** Find accumulator by call_id. */
function findAccByCallId(
	toolAccum: Map<number, ToolAccumEntry>,
	callId: string,
): ToolAccumEntry | undefined {
	for (const [, acc] of toolAccum) {
		if (acc.id === callId) return acc;
	}
	return undefined;
}

// === History builder ===

function buildOAIHistory(dbMessages: DbMessage[]): {
	history: OAIMessage[];
	trailingToolResults: OAIToolResult[];
} {
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant"),
	);

	// Drop the last user message — it's sent as the current message
	if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
		topLevel.pop();
	}

	const history: OAIMessage[] = [];
	let pendingToolResults: OAIToolResult[] = [];

	for (const msg of topLevel) {
		if (msg.role === "assistant") {
			// Flush pending tool results as role: "tool" messages
			for (const tr of pendingToolResults) {
				history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
			pendingToolResults = [];

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const textParts = content
				.filter((b: { type: string }) => b.type === "text")
				.map((b: { text: string }) => b.text);
			const text = textParts.join("\n") || msg.contentText || "";

			const completedToolUseIds = new Set(
				msg.toolCalls
					?.filter((tc) => tc.status === "success" || tc.status === "fail")
					.map((tc) => tc.toolUseId) ?? [],
			);

			const toolCalls: OAIToolCall[] =
				msg.toolCalls
					?.filter((tc) => tc.toolName && tc.toolUseId && completedToolUseIds.has(tc.toolUseId))
					.map((tc) => ({
						id: tc.toolUseId,
						type: "function" as const,
						function: {
							name: tc.toolName,
							arguments: JSON.stringify(tc.inputJson ?? {}),
						},
					})) ?? [];

			// OpenAI requires assistant messages to have content (string|null) or tool_calls.
			// Always set content explicitly to avoid sending {role:"assistant"} with no fields.
			const assistantMsg: OAIMessage = { role: "assistant", content: text || null };
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			history.push(assistantMsg);

			// Collect tool results
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
							tool_call_id: tc.toolUseId,
							content: outputText,
						});
					}
				}
			}
		} else if (msg.role === "user") {
			// Flush pending tool results before user message
			for (const tr of pendingToolResults) {
				history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
			pendingToolResults = [];

			const text = msg.contentText || "";
			if (text) {
				history.push({ role: "user", content: text });
			}
		}
	}

	return { history, trailingToolResults: pendingToolResults };
}

// === Responses API history converter ===

/**
 * Convert standard Chat Completions history to Responses API format.
 * Transforms:
 *   - { role: "system" }  → { role: "developer" }
 *   - { role: "tool" }    → { type: "function_call_output", call_id, output }
 *   - { role: "assistant", tool_calls } → separate { type: "function_call" } items + text
 */
function convertHistoryToResponsesApi(messages: OAIMessage[]): OAIMessage[] {
	const result: OAIMessage[] = [];
	for (const msg of messages) {
		// biome-ignore lint/suspicious/noExplicitAny: Responses API uses different message shapes
		const m = msg as any;

		if (m.role === "system") {
			result.push({ role: "developer", content: m.content } as unknown as OAIMessage);
		} else if (m.role === "tool") {
			result.push({
				type: "function_call_output",
				call_id: m.tool_call_id,
				output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
			} as unknown as OAIMessage);
		} else if (m.role === "assistant" && m.tool_calls?.length) {
			// Split assistant message with tool_calls into text + separate function_call items
			if (m.content) {
				result.push({ role: "assistant", content: m.content } as OAIMessage);
			}
			for (const tc of m.tool_calls as OAIToolCall[]) {
				result.push({
					type: "function_call",
					call_id: tc.id,
					name: tc.function.name,
					arguments: tc.function.arguments,
				} as unknown as OAIMessage);
			}
		} else if (m.type === "function_call_output" || m.type === "function_call") {
			// Already in Responses API format — pass through
			result.push(msg);
		} else {
			result.push(msg);
		}
	}
	return result;
}

/** Check whether a URL points to an official ChatGPT / OpenAI domain. */
function isOfficialChatGPTDomain(baseUrl?: string): boolean {
	if (!baseUrl) return true; // default URL is official
	try {
		const host = new URL(baseUrl).hostname;
		return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com");
	} catch {
		return false;
	}
}
