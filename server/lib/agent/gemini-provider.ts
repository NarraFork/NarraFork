import { logger } from "../logger";
import { resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { GeminiProviderConfig } from "../settings";
import { parseModelId, settings } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import type { UsageData } from "../usage-tracking";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
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

// === Gemini identity prompt ===
const GEMINI_IDENTITY: Record<string, string> = {
	en: `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools.`,
	"zh-CN": `你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。`,
};

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// === Gemini wire types ===

interface GeminiInlineData {
	mimeType: string;
	data: string;
}

interface GeminiFunctionCall {
	name: string;
	args: Record<string, unknown>;
}

interface GeminiFunctionResponse {
	name: string;
	response: Record<string, unknown>;
}

interface GeminiPart {
	text?: string;
	inlineData?: GeminiInlineData;
	functionCall?: GeminiFunctionCall;
	functionResponse?: GeminiFunctionResponse;
	/** Reasoning marker — parts with thought:true carry the model's thinking text. */
	thought?: boolean;
	/** Opaque signature that must be echoed back on subsequent turns to preserve thinking. */
	thoughtSignature?: string;
}

interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

/** Internal marker for the system instruction — carried in the history array, extracted in chat(). */
interface GeminiSystemMarker {
	role: "system";
	text: string;
}

type GeminiHistoryItem = GeminiContent | GeminiSystemMarker;

interface GeminiFunctionDeclaration {
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
}

interface GeminiToolResult {
	name: string;
	response: Record<string, unknown>;
}

// === SSE response types ===

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
	thoughtsTokenCount?: number;
	cachedContentTokenCount?: number;
}

interface GeminiStreamChunk {
	candidates?: Array<{
		content?: { role?: string; parts?: GeminiPart[] };
		finishReason?: string;
		index?: number;
	}>;
	usageMetadata?: GeminiUsageMetadata;
	promptFeedback?: { blockReason?: string };
	error?: { code?: number; message?: string; status?: string };
}

/**
 * Google Gemini API provider.
 *
 * Talks to the native generativelanguage.googleapis.com `v1beta`
 * `streamGenerateContent?alt=sse` endpoint. Stateless: the full conversation
 * history is sent on every request, matching NarraFork's agent-loop model.
 */
export class GeminiProvider implements ProviderAdapter {
	private config: GeminiProviderConfig;

	constructor(config: GeminiProviderConfig) {
		this.config = config;
	}

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

	private getApiKey(): string {
		const apiKey = this.config.apiKey;
		if (!apiKey) {
			throw new Error(`Gemini API key not configured for provider "${this.config.name}".`);
		}
		return apiKey;
	}

	private baseUrl(): string {
		return (this.config.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		if (tools.length === 0) return [];
		const functionDeclarations: GeminiFunctionDeclaration[] = tools.map((tool) => {
			const schema = sanitizeGeminiSchema(resolveToolJsonSchema(tool));
			const decl: GeminiFunctionDeclaration = {
				name: tool.name,
				description: tool.description,
			};
			// Gemini rejects an empty object parameters block ({type:object,properties:{}});
			// omit parameters entirely for no-argument tools.
			if (schema && typeof schema === "object") {
				const props = (schema as { properties?: Record<string, unknown> }).properties;
				if (props && Object.keys(props).length > 0) {
					decl.parameters = schema;
				}
			}
			return decl;
		});
		return [{ functionDeclarations }];
	}

	async buildHistory(
		dbMessages: DbMessage[],
		_model: string,
		_narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[]; trailingUserText?: string }> {
		return this.buildGeminiHistory(dbMessages);
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		const h = history as GeminiHistoryItem[];
		const locale = (_locale ?? "en") as Locale;
		const identity = GEMINI_IDENTITY[locale] ?? GEMINI_IDENTITY.en;
		const text = `${identity}\n\n${systemPrompt}`;
		h.unshift({ role: "system", text });
	}

	getActiveReasoningSource(): string | undefined {
		return `gemini:${this.config.prefix}`;
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = this.getApiKey();
		const baseUrl = this.baseUrl();
		const model = parseModelId(params.model).model;

		const rawHistory = params.history as GeminiHistoryItem[];
		const { systemInstruction, contents } = splitSystemAndContents(rawHistory);

		// Append trailing tool results as a user turn with functionResponse parts.
		const toolResultParts: GeminiPart[] = (params.toolResults as GeminiToolResult[]).map((tr) => ({
			functionResponse: { name: tr.name, response: tr.response },
		}));

		// Append current user message (skip "." continuation markers).
		const userParts: GeminiPart[] = [];
		const hasText = !!params.content && params.content !== ".";
		if (hasText) userParts.push({ text: params.content });
		if (params.images?.length) {
			for (const img of params.images) {
				userParts.push({ inlineData: { mimeType: `image/${img.format}`, data: img.base64 } });
			}
		}

		if (toolResultParts.length > 0) {
			contents.push({ role: "user", parts: toolResultParts });
			// A pending user message after tool results goes in its own user turn.
			if (userParts.length > 0) contents.push({ role: "user", parts: userParts });
		} else if (userParts.length > 0) {
			contents.push({ role: "user", parts: userParts });
		} else if (contents.length === 0) {
			// Nothing to send — emit an empty user part so the request is valid.
			contents.push({ role: "user", parts: [{ text: params.content || "." }] });
		}

		const tools = params.tools as Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;

		const generationConfig: Record<string, unknown> = {};
		const thinkingConfig = mapReasoningEffortToThinking(params.reasoningEffort);
		if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

		const body: Record<string, unknown> = { contents };
		if (systemInstruction) {
			body.systemInstruction = { parts: [{ text: systemInstruction }] };
		}
		if (tools.length > 0 && tools[0].functionDeclarations.length > 0) {
			body.tools = tools;
		}
		if (Object.keys(generationConfig).length > 0) {
			body.generationConfig = generationConfig;
		}

		const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey,
		};

		params.requestDump?.setRequest({
			transport: "http",
			url,
			headers: sanitizeHeaders(headers),
			body,
		});
		logger.debug("Gemini chat request", {
			model,
			baseUrl,
			toolCount: tools[0]?.functionDeclarations.length ?? 0,
			contentCount: contents.length,
			hasSystem: !!systemInstruction,
			hasToolResults: toolResultParts.length > 0,
		});

		params.onRequestStart?.();
		const response = await this.pfetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
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
			throw new ApiError(response.status, `Gemini API error ${response.status}: ${errText}`);
		}
		if (!response.body) {
			throw new Error("Gemini API returned no body");
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
		isError: boolean,
		_images?: Array<{ format: string; base64: string }>,
	): unknown {
		// Gemini matches results to calls by function name, not by an ID. The loop
		// passes the tool-use id here; buildHistory/pushAssistantTurn track the
		// name->id association, but for trailing results we must recover the name.
		// The loop always pairs formatToolResult output with the tool name via the
		// tool-call record, so we encode name in a lookup done by the loop caller.
		// To keep the name we stash it on a private map keyed by toolUseId.
		const name = this.toolUseIdToName.get(toolUseId) ?? toolUseId;
		const response: Record<string, unknown> = isError ? { error: output } : { output: output };
		return { name, response } satisfies GeminiToolResult;
	}

	/** Maps a tool_use id to its function name so tool results can reference it. */
	private toolUseIdToName = new Map<string, string>();

	pushUserTurn(
		history: unknown[],
		content: string,
		_model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const h = history as GeminiHistoryItem[];
		const toolParts: GeminiPart[] = (toolResults as GeminiToolResult[]).map((tr) => ({
			functionResponse: { name: tr.name, response: tr.response },
		}));
		if (toolParts.length > 0) {
			h.push({ role: "user", parts: toolParts });
		}
		const hasText = !!content && content !== ".";
		const userParts: GeminiPart[] = [];
		if (hasText) userParts.push({ text: content });
		else if (images?.length) userParts.push({ text: "[user sent image(s)]" });
		if (images?.length) {
			for (const img of images) {
				userParts.push({ inlineData: { mimeType: `image/${img.format}`, data: img.base64 } });
			}
		}
		if (userParts.length > 0) {
			h.push({ role: "user", parts: userParts });
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
		_webSearches?: Array<{ id: string; query?: string; queries?: string[]; outputIndex?: number }>,
		_messageId?: string,
	): void {
		const h = history as GeminiHistoryItem[];
		const parts: GeminiPart[] = [];

		// Preserve thinking parts (with signatures) so multi-turn thinking works.
		for (const rb of reasoningBlocks ?? []) {
			if (!rb.text) continue;
			const part: GeminiPart = { text: rb.text, thought: true };
			const sig = extractThoughtSignature(rb.providerMetadata);
			if (sig) part.thoughtSignature = sig;
			parts.push(part);
		}

		if (text) parts.push({ text });

		for (const tu of toolUses) {
			this.toolUseIdToName.set(tu.toolUseId, tu.name);
			const { args, signature } = extractArgsAndSignature(tu.input);
			const fcPart: GeminiPart = { functionCall: { name: tu.name, args } };
			// Gemini 3: echo the thought signature back on the functionCall part.
			const sig = tu.thoughtSignature ?? signature;
			if (sig) fcPart.thoughtSignature = sig;
			parts.push(fcPart);
		}

		if (parts.length === 0) parts.push({ text: "" });
		h.push({ role: "model", parts });
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
		return this.generateNonStreaming({
			model,
			systemInstruction,
			userText: text,
			signal: options?.signal,
			reasoningEffort: options?.reasoningEffort,
		});
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
		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		return this.generateNonStreaming({
			model,
			systemInstruction,
			userText: `${reminder}\n\n${content}`,
			signal: options?.signal,
			reasoningEffort: options?.reasoningEffort,
		});
	}

	// === Internal ===

	private async generateNonStreaming(opts: {
		model: string;
		systemInstruction?: string;
		userText: string;
		signal?: AbortSignal;
		reasoningEffort?: ChatParams["reasoningEffort"];
	}): Promise<GenerateMetaResult> {
		const apiKey = this.getApiKey();
		const baseUrl = this.baseUrl();
		const model = parseModelId(opts.model).model;

		const body: Record<string, unknown> = {
			contents: [{ role: "user", parts: [{ text: opts.userText }] }],
		};
		if (opts.systemInstruction) {
			body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
		}
		const thinkingConfig = mapReasoningEffortToThinking(opts.reasoningEffort);
		if (thinkingConfig) body.generationConfig = { thinkingConfig };

		const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
		const response = await this.pfetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
			body: JSON.stringify(body),
			signal: opts.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `Gemini API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as GeminiStreamChunk;
		if (json.error) {
			throw new ApiError(json.error.code ?? 500, `Gemini API error: ${json.error.message}`);
		}

		let out = "";
		for (const part of json.candidates?.[0]?.content?.parts ?? []) {
			if (part.text && !part.thought) out += part.text;
		}
		const usage = mapUsage(json.usageMetadata);
		return { text: out, usage };
	}

	private buildGeminiHistory(dbMessages: DbMessage[]): {
		history: GeminiHistoryItem[];
		trailingToolResults: GeminiToolResult[];
		trailingUserText?: string;
	} {
		const topLevel = dbMessages.filter(
			(m) =>
				!m.parentToolUseId && (m.role === "user" || m.role === "assistant" || m.role === "sys"),
		);

		// Drop the last user message — it is sent as the current message.
		if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
			topLevel.pop();
		}

		const history: GeminiHistoryItem[] = [];
		let pendingToolResults: GeminiToolResult[] = [];
		let pendingUserSideCars: NonNullable<DbMessage["sideCars"]> = [];

		const flushToolResults = () => {
			if (pendingToolResults.length > 0) {
				history.push({
					role: "user",
					parts: pendingToolResults.map((tr) => ({
						functionResponse: { name: tr.name, response: tr.response },
					})),
				});
				pendingToolResults = [];
			}
		};

		for (const msg of topLevel) {
			if (msg.role === "assistant") {
				flushToolResults();
				const pendingSideCarText = appendSideCarsForApi("", pendingUserSideCars);
				if (pendingSideCarText) {
					history.push({ role: "user", parts: [{ text: pendingSideCarText }] });
				}
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
				const toolCalls =
					msg.toolCalls?.filter(
						(tc) => tc.toolName && tc.toolUseId && completedToolUseIds.has(tc.toolUseId),
					) ?? [];

				const parts: GeminiPart[] = [];
				if (text) parts.push({ text });
				for (const tc of toolCalls) {
					this.toolUseIdToName.set(tc.toolUseId, tc.toolName);
					// The thought signature is persisted inside inputJson under a reserved
					// key; split it back out and strip it from the args sent to the model.
					const { args, signature } = extractArgsAndSignature(tc.inputJson);
					const fcPart: GeminiPart = { functionCall: { name: tc.toolName, args } };
					if (signature) fcPart.thoughtSignature = signature;
					parts.push(fcPart);
				}
				if (parts.length === 0) continue;
				history.push({ role: "model", parts });

				// Collect tool results for the following user turn.
				if (msg.toolCalls) {
					for (const tc of msg.toolCalls) {
						if (tc.status === "success" || tc.status === "fail") {
							const outputText = appendSideCarsForApi(
								outputToText(tc.outputJson),
								sideCarsForToolResult(msg.sideCars, tc.toolUseId),
							);
							pendingToolResults.push({
								name: tc.toolName,
								response: tc.status === "fail" ? { error: outputText } : { output: outputText },
							});
						}
					}
				}
				pendingUserSideCars = sideCarsForUserMessage(msg.sideCars);
			} else if (msg.role === "user") {
				flushToolResults();
				const text = appendSideCarsForApi(msg.contentText || "", pendingUserSideCars);
				if (text) history.push({ role: "user", parts: [{ text }] });
				pendingUserSideCars = [];
			} else if (msg.role === "sys") {
				flushToolResults();
				const pendingSideCarText = appendSideCarsForApi("", pendingUserSideCars);
				if (pendingSideCarText) {
					history.push({ role: "user", parts: [{ text: pendingSideCarText }] });
				}
				pendingUserSideCars = [];

				const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
				const textParts = content
					.filter((b: { type: string }) => b.type === "text")
					.map((b: { text: string }) => b.text);
				const text = textParts.join("\n") || msg.contentText || "";
				// Gemini has no system role in contents; fold as a user turn.
				if (text) history.push({ role: "user", parts: [{ text }] });
			}
		}

		return {
			history,
			trailingToolResults: pendingToolResults,
			trailingUserText: appendSideCarsForApi("", pendingUserSideCars) || undefined,
		};
	}

	private async *parseSSEStream(
		body: ReadableStream<Uint8Array>,
	): AsyncGenerator<ParsedStreamEvent> {
		const decoder = new TextDecoder();
		let buffer = "";
		const toolUses: AgentToolUse[] = [];

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
					if (!trimmed.startsWith("data:")) continue;
					const payload = trimmed.slice(5).trim();
					if (!payload || payload === "[DONE]") continue;

					let chunk: GeminiStreamChunk;
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}

					if (chunk.error) {
						yield {
							invalidState: {
								reason: String(chunk.error.status ?? chunk.error.code ?? "api_error"),
								message: chunk.error.message || "Unknown Gemini API error",
							},
						};
						return;
					}

					if (chunk.promptFeedback?.blockReason) {
						yield {
							invalidState: {
								reason: "content_filter",
								message: `Request blocked by Gemini: ${chunk.promptFeedback.blockReason}`,
							},
						};
						return;
					}

					if (chunk.usageMetadata) {
						yield { usage: mapUsageStream(chunk.usageMetadata) };
					}

					const candidate = chunk.candidates?.[0];
					const parts = candidate?.content?.parts ?? [];
					for (const part of parts) {
						if (part.functionCall) {
							const toolUseId = generateGeminiToolId();
							const tu: AgentToolUse = {
								toolUseId,
								name: part.functionCall.name,
								input: part.functionCall.args ?? {},
								// Gemini 3 requires this signature to be echoed back on the
								// functionCall part in the next turn's history.
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};
							toolUses.push(tu);
							yield {
								toolUseChunk: {
									toolUseId,
									name: part.functionCall.name,
									input: JSON.stringify(part.functionCall.args ?? {}),
									stop: true,
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								},
							};
						} else if (part.thought && part.text) {
							yield {
								reasoning: part.text,
								...(part.thoughtSignature && {
									reasoningMetadata: {
										gemini: { thoughtSignature: part.thoughtSignature },
									},
								}),
							};
						} else if (part.text) {
							yield { text: part.text };
						}
					}

					if (candidate?.finishReason) {
						const result: ParsedStreamEvent = { stopReason: candidate.finishReason };
						if (toolUses.length > 0) result.toolUses = [...toolUses];
						switch (candidate.finishReason) {
							case "MAX_TOKENS":
								result.invalidState = {
									reason: "max_tokens",
									message: "Response truncated: model reached maximum token limit.",
								};
								break;
							case "SAFETY":
							case "PROHIBITED_CONTENT":
							case "BLOCKLIST":
								result.invalidState = {
									reason: "content_filter",
									message: `Response blocked by Gemini (${candidate.finishReason}).`,
								};
								break;
						}
						yield result;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

// === Helpers ===

/**
 * Recursively sanitize a JSON Schema for Gemini's function-declaration format.
 * Gemini's Schema type is a strict OpenAPI subset — it rejects `additionalProperties`,
 * `$schema`, `const`, `$ref`, and a few other keywords. This drops the unsupported
 * keys and rewrites `const` to a single-value `enum`.
 */
export function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return sanitizeNode(schema) as Record<string, unknown>;
}

// Gemini's function-declaration Schema is a strict OpenAPI 3.0 subset. Any JSON
// Schema draft keyword outside that subset is rejected with a 400
// ("Unknown name ... Cannot find field"). Strip every such keyword at all
// nesting levels. Notably `propertyNames`/`additionalProperties` (emitted by
// z.record()) and the draft applicator keywords must be removed.
const GEMINI_UNSUPPORTED_KEYS = new Set([
	"additionalProperties",
	"propertyNames",
	"unevaluatedProperties",
	"patternProperties",
	"minProperties",
	"maxProperties",
	"$schema",
	"$id",
	"$ref",
	"$defs",
	"$comment",
	"definitions",
	"default",
	"examples",
	"not",
	"if",
	"then",
	"else",
	"dependencies",
	"dependentSchemas",
	"dependentRequired",
	"contains",
	"minContains",
	"maxContains",
	"prefixItems",
	"additionalItems",
	"unevaluatedItems",
	"multipleOf",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"uniqueItems",
]);

function sanitizeNode(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(sanitizeNode);
	if (!node || typeof node !== "object") return node;

	const input = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(input)) {
		if (GEMINI_UNSUPPORTED_KEYS.has(key)) continue;
		if (key === "const") {
			// Rewrite const → single-value enum, which Gemini supports.
			out.enum = [value];
			continue;
		}
		if (key === "properties" && value && typeof value === "object") {
			const props: Record<string, unknown> = {};
			for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
				props[pk] = sanitizeNode(pv);
			}
			out.properties = props;
			continue;
		}
		if (key === "items") {
			out.items = sanitizeNode(value);
			continue;
		}
		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			// Gemini supports anyOf; normalize oneOf/allOf to anyOf.
			out.anyOf = (value as unknown[]).map(sanitizeNode);
			continue;
		}
		out[key] = sanitizeNode(value);
	}
	return out;
}

/**
 * Split the internal history array into the extracted system instruction and
 * the Gemini `contents[]`. The system marker (if any) is always the first item.
 */
function splitSystemAndContents(history: GeminiHistoryItem[]): {
	systemInstruction?: string;
	contents: GeminiContent[];
} {
	let systemInstruction: string | undefined;
	const contents: GeminiContent[] = [];
	for (const item of history) {
		if ((item as GeminiSystemMarker).role === "system") {
			systemInstruction = (item as GeminiSystemMarker).text;
		} else {
			contents.push(item as GeminiContent);
		}
	}
	return { systemInstruction, contents };
}

/**
 * Map NarraFork reasoning effort to Gemini thinkingConfig.
 *
 * Gemini exposes a three-tier thinking level (low / medium / high) via the
 * official Interactions API standard. NarraFork's finer-grained effort scale is
 * collapsed onto those three tiers:
 * - "none"           → thinkingBudget 0 (disable thinking)
 * - "low"            → thinkingLevel "low"
 * - "medium"         → thinkingLevel "medium"
 * - "high"/"xhigh"/"max" → thinkingLevel "high"
 * - undefined        → let the model decide (omit config)
 */
function mapReasoningEffortToThinking(
	effort: ChatParams["reasoningEffort"] | undefined,
): { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number } | undefined {
	if (!effort) return undefined;
	if (effort === "none") return { thinkingBudget: 0 };
	const levelMap: Record<string, "low" | "medium" | "high"> = {
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: "high",
	};
	const thinkingLevel = levelMap[effort] ?? "medium";
	return { includeThoughts: true, thinkingLevel };
}

function mapUsage(usage: GeminiUsageMetadata | undefined): UsageData | null {
	if (!usage) return null;
	return {
		inputTokens: usage.promptTokenCount ?? 0,
		outputTokens: usage.candidatesTokenCount ?? 0,
		cachedInputTokens: usage.cachedContentTokenCount ?? 0,
		cacheCreationInputTokens: 0,
		reasoningTokens: usage.thoughtsTokenCount ?? 0,
	};
}

function mapUsageStream(usage: GeminiUsageMetadata): NonNullable<ParsedStreamEvent["usage"]> {
	return {
		promptTokens: usage.promptTokenCount ?? 0,
		inputTokens: (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
		completionTokens: usage.candidatesTokenCount ?? 0,
		reasoningTokens: usage.thoughtsTokenCount ?? undefined,
		cachedInputTokens: usage.cachedContentTokenCount ?? undefined,
	};
}

/** Extract a Gemini thoughtSignature stored on reasoning provider metadata. */
function extractThoughtSignature(
	metadata: import("./types").ReasoningProviderMetadata | undefined,
): string | undefined {
	return metadata?.gemini?.thoughtSignature;
}

/**
 * Reserved key used to persist a functionCall's Gemini thought signature inside
 * the tool call's stored `inputJson` (avoids a DB schema migration). It is
 * stripped from the args before they are sent back to the model.
 */
export const GEMINI_THOUGHT_SIGNATURE_KEY = "__geminiThoughtSignature";

/**
 * Split a persisted/streamed tool-call input into the real function args and the
 * embedded Gemini thought signature (if any). The reserved signature key is
 * removed from the returned args so it never reaches the model.
 */
function extractArgsAndSignature(input: unknown): {
	args: Record<string, unknown>;
	signature?: string;
} {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { args: (input as Record<string, unknown>) ?? {} };
	}
	const record = input as Record<string, unknown>;
	if (!(GEMINI_THOUGHT_SIGNATURE_KEY in record)) {
		return { args: record };
	}
	const { [GEMINI_THOUGHT_SIGNATURE_KEY]: sig, ...args } = record;
	return { args, signature: typeof sig === "string" ? sig : undefined };
}

let geminiToolIdCounter = 0;
function generateGeminiToolId(): string {
	geminiToolIdCounter = (geminiToolIdCounter + 1) % 1_000_000;
	return `gemini_tool_${Date.now().toString(36)}_${geminiToolIdCounter.toString(36)}`;
}
