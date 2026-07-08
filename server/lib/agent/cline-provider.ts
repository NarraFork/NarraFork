import { buildOpenRouterHeaders, getAccessToken } from "../cline-auth";
import { logger } from "../logger";
import { resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { ClineProviderConfig } from "../settings";
import { parseModelId, settings } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import { extractOpenAIUsage } from "../usage-tracking";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import { sanitizeHeaders } from "./request-dump";
import { recordRequestUrl } from "./request-url-tracker";
import {
	appendSideCarsForApi,
	outputToText,
	sideCarsForToolResult,
	sideCarsForUserMessage,
} from "./sidecar";
import { resolveToolJsonSchema } from "./tool-registry";
import { type AgentToolUse, ApiError, type ResolvedToolDefinition } from "./types";

// === Cline identity prompt ===
const CLINE_IDENTITY: Record<string, string> = {
	en: `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools. For example, use Read to examine files, Write/Edit to modify them, Bash to run commands, Glob/Grep to search, etc.`,
	"zh-CN": `你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。例如，使用 Read 查看文件，Write/Edit 修改文件，Bash 运行命令，Glob/Grep 搜索等。`,
};

// === Cline message types ===

type ClineContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } }
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string }
	| { type: "output_text"; text: string };

interface ClineMessage {
	role: "system" | "user" | "assistant" | "tool" | "developer";
	content?: string | ClineContentPart[] | null;
	tool_calls?: ClineToolCall[];
	tool_call_id?: string;
	/** Reasoning blocks from the assistant message */
	_reasoningBlocks?: Array<{
		text: string;
		providerMetadata?: import("./types").ReasoningProviderMetadata;
	}>;
}

interface ClineToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface ClineTool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ClineToolResult {
	tool_call_id: string;
	content: string;
}

// === SSE delta types ===

interface ClineDelta {
	role?: string;
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface ClineStreamChunk {
	id?: string;
	choices?: Array<{ index: number; delta: ClineDelta; finish_reason?: string | null }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number };
		prompt_tokens_details?: { cached_tokens?: number };
	};
	error?: { message?: string; type?: string; code?: string | number };
}

/** Default Cline API base URL for chat completions. */
const DEFAULT_CLINE_API_BASE = "https://api.cline.bot/api/v1";

/**
 * Cline API provider.
 *
 * Uses Cline's API gateway (api.cline.bot) with OAuth authentication.
 * The gateway proxies to OpenRouter. Models are listed from OpenRouter directly.
 */
export class ClineProvider implements ProviderAdapter {
	private config: ClineProviderConfig;

	constructor(config: ClineProviderConfig) {
		this.config = config;
	}

	/**
	 * Proxy-aware fetch. Resolves the proxy per target URL honouring this
	 * provider's own proxy override (absent/"default" → global policy), with
	 * loopback/NO_PROXY exemptions. Cline talks to external OpenRouter.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const target = input instanceof Request ? input.url : input;
		recordRequestUrl(String(target), init?.method);
		const proxy = resolveProxyForUrl(target, this.config.proxy);
		if (proxy) {
			// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
			return fetch(input, { ...init, proxy } as any);
		}
		return fetch(input, init);
	}

	/**
	 * Get the effective API key for requests.
	 * Tries cline-auth first (auto-refreshing), falls back to config.accessToken.
	 */
	private async getEffectiveApiKey(): Promise<string> {
		// Try to get a fresh token from cline-auth (handles refresh automatically)
		const freshToken = await getAccessToken();
		if (freshToken) {
			return freshToken.startsWith("workos:") ? freshToken : `workos:${freshToken}`;
		}

		// Fall back to static config token
		const accessToken = this.config.accessToken;
		if (!accessToken) {
			throw new Error(`Cline access token not configured for provider "${this.config.name}".`);
		}
		// Add workos: prefix if not already present
		return accessToken.startsWith("workos:") ? accessToken : `workos:${accessToken}`;
	}

	/**
	 * Build request headers for Cline API (OpenRouter-compatible).
	 */
	private buildHeaders(apiKey: string): Record<string, string> {
		return {
			...buildOpenRouterHeaders(),
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		};
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		// OpenAI-compatible format
		return tools.map(
			(tool): ClineTool => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: resolveToolJsonSchema(tool),
				},
			}),
		);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		_model: string,
		_narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		const result = this.buildClineHistory(dbMessages);
		return result;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		const h = history as ClineMessage[];
		const locale = (_locale ?? "en") as Locale;
		const identity = CLINE_IDENTITY[locale] ?? CLINE_IDENTITY.en;
		const content = `${identity}\n\n${systemPrompt}`;
		h.unshift({ role: "system", content });
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || DEFAULT_CLINE_API_BASE).replace(/\/+$/, "");

		const history = params.history as ClineMessage[];
		const tools = params.tools as ClineTool[];

		// Build messages: history + pending tool results + current user message
		const messages: ClineMessage[] = [...history];

		// Append tool results
		for (const tr of params.toolResults as ClineToolResult[]) {
			messages.push({
				role: "tool",
				tool_call_id: tr.tool_call_id,
				content: tr.content,
			});
		}

		// Append current user message (skip "." continuation markers)
		if (params.content && params.content !== ".") {
			if (params.images?.length) {
				const parts: ClineContentPart[] = [{ type: "text", text: params.content }];
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

		// Build request body
		const model = parseModelId(params.model).model;
		const body: Record<string, unknown> = {
			model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (tools.length > 0) {
			body.tools = tools;
		}

		const headers = this.buildHeaders(apiKey);
		params.requestDump?.setRequest({
			transport: "http",
			url: `${baseUrl}/chat/completions`,
			headers: sanitizeHeaders(headers),
			body,
		});
		logger.debug("Cline chat request", {
			model,
			baseUrl,
			toolCount: tools.length,
			messageCount: messages.length,
			hasToolResults: (params.toolResults as unknown[]).length > 0,
			hasAuth: !!headers.Authorization,
			authPrefix: headers.Authorization?.slice(0, 20),
		});

		const bodyText = JSON.stringify(body);
		params.onRequestStart?.();
		const response = await this.pfetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: bodyText,
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
			throw new ApiError(response.status, `Cline API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("Cline API returned no body");
		}

		yield* this.parseSSEStream(response.body);
		if (responseTextPromise) {
			const bodyText = await responseTextPromise;
			const maxSize = settings.agent?.requestDumpMaxSize ?? 1024 * 1024;
			params.requestDump?.setResponseBodyTextWithLimit(bodyText, maxSize);
		}
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		_isError: boolean,
		_images?: Array<{ format: string; base64: string }>,
	): unknown {
		return { tool_call_id: toolUseId, content: output } satisfies ClineToolResult;
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		_model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const h = history as ClineMessage[];
		for (const tr of toolResults as ClineToolResult[]) {
			h.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
		}
		const hasText = !!content && content !== ".";
		if (images?.length) {
			const parts: ClineContentPart[] = [
				{ type: "text", text: hasText ? content : "[user sent image(s)]" },
			];
			for (const img of images) {
				parts.push({
					type: "image_url",
					image_url: { url: `data:image/${img.format};base64,${img.base64}` },
				});
			}
			h.push({ role: "user", content: parts });
		} else if (hasText) {
			h.push({ role: "user", content });
		}
	}

	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: AgentToolUse[],
		_reasoningBlocks?: Array<{
			text: string;
			providerMetadata?: import("./types").ReasoningProviderMetadata;
		}>,
		_webSearches?: Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
		}>,
		_messageId?: string,
	): void {
		const h = history as ClineMessage[];
		const msg: ClineMessage = { role: "assistant", content: text || "" };
		if (toolUses.length > 0) {
			msg.tool_calls = toolUses.map((tu) => ({
				id: tu.toolUseId,
				type: "function" as const,
				function: { name: tu.name, arguments: JSON.stringify(tu.input) },
			}));
		}
		h.push(msg);
	}

	async generate(text: string, model: string): Promise<string> {
		const result = await this.generateWithMeta(text, model);
		return result.text;
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: import("./provider").GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || DEFAULT_CLINE_API_BASE).replace(/\/+$/, "");

		const bareModel = parseModelId(model).model;
		const messages: Array<{ role: "system" | "user"; content: string }> = [];
		if (systemInstruction) {
			messages.push({ role: "system", content: systemInstruction });
		}
		messages.push({ role: "user", content: text });

		// Cline gateway may always return SSE even without stream:true,
		// so we explicitly request streaming and collect the text from the SSE stream.
		const response = await this.pfetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify({
				model: bareModel,
				messages,
				stream: true,
			}),
			signal: options?.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Cline API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("Cline API returned no body");
		}

		return this.collectStreamTextWithMeta(response.body);
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string> {
		const result = await this.generateWithHistoryWithMeta(
			systemInstruction,
			content,
			model,
			locale,
		);
		return result.text;
	}

	async generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<GenerateMetaResult> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || DEFAULT_CLINE_API_BASE).replace(/\/+$/, "");

		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		const bareModel = parseModelId(model).model;

		// Cline gateway may always return SSE even without stream:true,
		// so we explicitly request streaming and collect the text from the SSE stream.
		const response = await this.pfetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify({
				model: bareModel,
				messages: [
					{ role: "system", content: systemInstruction },
					{ role: "user", content: `${reminder}\n\n${content}` },
				],
				stream: true,
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Cline API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("Cline API returned no body");
		}

		return this.collectStreamTextWithMeta(response.body);
	}

	// === Internal methods ===

	private buildClineHistory(dbMessages: DbMessage[]): {
		history: ClineMessage[];
		trailingToolResults: ClineToolResult[];
		trailingUserText?: string;
	} {
		// Filter model-visible messages: user, assistant, sys (system context)
		// Exclude: system (legacy, kept for backward compatibility), disp (UI-only display messages)
		const topLevel = dbMessages.filter(
			(m) =>
				!m.parentToolUseId && (m.role === "user" || m.role === "assistant" || m.role === "sys"),
		);

		// Drop the last user message — it's sent as the current message
		if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
			topLevel.pop();
		}

		const history: ClineMessage[] = [];
		let pendingToolResults: ClineToolResult[] = [];
		let pendingUserSideCars: NonNullable<DbMessage["sideCars"]> = [];

		for (const msg of topLevel) {
			if (msg.role === "assistant") {
				// Flush pending tool results as role: "tool" messages
				for (const tr of pendingToolResults) {
					history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
				}
				const pendingSideCarText = appendSideCarsForApi("", pendingUserSideCars);
				if (pendingSideCarText) history.push({ role: "user", content: pendingSideCarText });
				pendingToolResults = [];
				pendingUserSideCars = [];

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

				const toolCalls: ClineToolCall[] =
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

				const hasText = text.length > 0;
				if (!hasText && toolCalls.length === 0) {
					continue;
				}

				const assistantMsg: ClineMessage = { role: "assistant", content: hasText ? text : "" };
				if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
				history.push(assistantMsg);

				// Collect tool results
				if (msg.toolCalls) {
					for (const tc of msg.toolCalls) {
						if (tc.status === "success" || tc.status === "fail") {
							const outputText = appendSideCarsForApi(
								outputToText(tc.outputJson),
								sideCarsForToolResult(msg.sideCars, tc.toolUseId),
							);
							pendingToolResults.push({
								tool_call_id: tc.toolUseId,
								content: outputText,
							});
						}
					}
				}
				pendingUserSideCars = sideCarsForUserMessage(msg.sideCars);
			} else if (msg.role === "user") {
				// Flush pending tool results before user message
				for (const tr of pendingToolResults) {
					history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
				}
				pendingToolResults = [];

				const text = appendSideCarsForApi(msg.contentText || "", pendingUserSideCars);
				if (text) {
					history.push({ role: "user", content: text });
				}
				pendingUserSideCars = [];
			} else if (msg.role === "sys") {
				for (const tr of pendingToolResults) {
					history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
				}
				const pendingSideCarText = appendSideCarsForApi("", pendingUserSideCars);
				if (pendingSideCarText) history.push({ role: "user", content: pendingSideCarText });
				pendingToolResults = [];
				pendingUserSideCars = [];

				const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
				const textParts = content
					.filter((b: { type: string }) => b.type === "text")
					.map((b: { text: string }) => b.text);
				const text = textParts.join("\n") || msg.contentText || "";
				if (text) {
					history.push({ role: "system", content: text });
				}
			}
		}

		return {
			history,
			trailingToolResults: pendingToolResults,
			trailingUserText: appendSideCarsForApi("", pendingUserSideCars) || undefined,
		};
	}

	private async collectStreamTextWithMeta(
		body: ReadableStream<Uint8Array>,
	): Promise<GenerateMetaResult> {
		const decoder = new TextDecoder();
		let buffer = "";
		let text = "";
		let usage: GenerateMetaResult["usage"] = null;

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
					if (!trimmed || trimmed === "data: [DONE]") continue;
					if (!trimmed.startsWith("data: ")) continue;

					let chunk: ClineStreamChunk;
					try {
						chunk = JSON.parse(trimmed.slice(6));
					} catch {
						continue;
					}

					if (chunk.error) {
						throw new ApiError(500, `Cline API error: ${chunk.error.message || "Unknown error"}`);
					}

					if (chunk.usage) {
						usage = extractOpenAIUsage(chunk.usage);
					}

					const delta = chunk.choices?.[0]?.delta;
					if (delta?.content) {
						text += delta.content;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		return { text, usage };
	}

	private async *parseSSEStream(
		body: ReadableStream<Uint8Array>,
	): AsyncGenerator<ParsedStreamEvent> {
		const decoder = new TextDecoder();
		let buffer = "";
		const toolAccum = new Map<
			number,
			{ id: string; name: string; args: string; emitted: boolean }
		>();

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
					if (!trimmed || trimmed === "data: [DONE]") continue;
					if (!trimmed.startsWith("data: ")) continue;

					let chunk: ClineStreamChunk;
					try {
						chunk = JSON.parse(trimmed.slice(6));
					} catch {
						continue;
					}

					// Handle error
					if (chunk.error) {
						yield {
							invalidState: {
								reason: String(chunk.error.code ?? chunk.error.type ?? "api_error"),
								message: chunk.error.message || "Unknown Cline API error",
							},
						};
						return;
					}

					// Handle usage — Cline Gateway may embed usage in the last
					// choices chunk (choices non-empty) or send it as a separate
					// usage-only chunk (choices empty). Process usage regardless.
					if (chunk.usage) {
						const promptTokens = chunk.usage.prompt_tokens;
						if (promptTokens != null) {
							yield {
								usage: {
									promptTokens,
									completionTokens: chunk.usage.completion_tokens,
									reasoningTokens:
										chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
									cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
								},
							};
						}
						// If this is a usage-only chunk (no choices), skip further processing
						if (!chunk.choices || chunk.choices.length === 0) continue;
					}

					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta;
					const results: ParsedStreamEvent[] = [];
					const result: ParsedStreamEvent = {};

					// Text content
					if (delta.content) {
						result.text = delta.content;
					}

					// Tool call deltas
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index;

							if (tc.id && !toolAccum.has(idx)) {
								const id = tc.id;
								const name = tc.function?.name ?? "";
								toolAccum.set(idx, { id, name, args: "", emitted: false });
								results.push({
									toolUseChunk: { toolUseId: id, name, input: undefined, stop: false },
								});
							}

							const acc = toolAccum.get(idx);
							if (acc && !acc.emitted) {
								if (tc.function?.arguments) {
									acc.args += tc.function.arguments;
									results.push({
										toolUseChunk: {
											toolUseId: acc.id,
											name: acc.name,
											input: tc.function.arguments,
											stop: false,
										},
									});

									// Early completion if args form valid JSON
									if (this.isParsableJson(acc.args)) {
										results.push({
											toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
										});
										acc.emitted = true;
									}
								}
							}
						}
					}

					// On finish_reason
					if (choice.finish_reason) {
						for (const [, acc] of toolAccum) {
							if (!acc.emitted) {
								results.push({
									toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
								});
								acc.emitted = true;
							}
						}

						// Emit flat toolUses
						const toolUses: AgentToolUse[] = [];
						for (const [, acc] of toolAccum) {
							if (acc.id) {
								let input: Record<string, unknown> = {};
								try {
									input = JSON.parse(acc.args);
								} catch {
									input = { _raw: acc.args };
								}
								toolUses.push({ toolUseId: acc.id, name: acc.name, input });
							}
						}
						toolAccum.clear();

						if (toolUses.length > 0) {
							result.toolUses = toolUses;
						}

						switch (choice.finish_reason) {
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
							case "model_context_window_exceeded":
								result.invalidState = {
									reason: "model_context_window_exceeded",
									message: "The model has reached its context window limit.",
								};
								break;
						}
					}

					if (result.text || result.toolUses || result.invalidState) {
						results.push(result);
					}

					for (const evt of results) {
						yield evt;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private isParsableJson(s: string): boolean {
		try {
			JSON.parse(s);
			return true;
		} catch {
			return false;
		}
	}
}
