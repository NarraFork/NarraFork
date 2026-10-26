import { hasCredentialBoundReasoning } from "@shared/reasoning-credentials";
import { logger } from "../logger";
import { resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { GeminiProviderConfig } from "../settings";
import { parseModelId } from "../settings";
import { readWithTimeout, StreamByteBudget } from "../stream-timeout";
import type { UsageData } from "../usage-tracking";
import { getHttpUserAgent, resolveClientFingerprint } from "../user-agent";
import { fetchWithNetworkDiagnostics } from "./diagnostic-fetch";
import { parseErrorDiagnostics } from "./error-diagnostics";
import { isCompletionLimitReason } from "./error-handling";
import { reportInputCharacters } from "./input-characters";
import { buildOpencodeSessionHeader } from "./opencode-session";
import { type NeutralTurn, projectHistory, webSearchSummary } from "./projection";
import type {
	BuiltHistory,
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import {
	assertModelInputModalities,
	effectiveModelProfile,
	resolveMetadataReasoning,
	resolveOutputTokenLimit,
} from "./provider-model-metadata";
import { type ProviderTransport, runProviderTransport } from "./provider-transport";
import { captureResponseStream, sanitizeHeaders } from "./request-dump";
import { parseJsonTextWithBody } from "./response-body";
import type { ToolLoadingTarget } from "./tool-loading";
import { resolveToolJsonSchema } from "./tool-registry";
import { type AgentToolUse, ApiError, type ResolvedToolDefinition } from "./types";
import { orderUserContent } from "./user-content-order";

// === Gemini identity prompt ===
const GEMINI_IDENTITY: Record<string, string> = {
	en: `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools.`,
	"zh-CN": `你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。`,
};

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const GEMINI_GENERATE_MAX_STREAM_BYTES = 64 * 1024 * 1024;
export const GEMINI_GENERATE_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;
export const GEMINI_GENERATE_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const GEMINI_GENERATE_MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;

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

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function assertByteLimit(value: string, limit: number, label: string): void {
	const size = byteLength(value);
	if (size > limit) {
		throw new ApiError(413, `Gemini ${label} exceeded hard limit (${size} > ${limit} bytes)`);
	}
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

	constructor(
		config: GeminiProviderConfig,
		private transport?: ProviderTransport,
	) {
		this.config = config;
	}

	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const target = input instanceof Request ? input.url : input;
		const proxy = resolveProxyForUrl(target, this.config.proxy);
		return runProviderTransport(this.transport, input, init, (target, options) =>
			fetchWithNetworkDiagnostics(target, options, {
				proxy,
				redactText: this.transport?.redactText,
			}),
		);
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

	private headers(apiKey: string, conversationId?: string, stream = false): Record<string, string> {
		const fingerprint = resolveClientFingerprint({
			mode: this.config.userAgentMode,
			custom: this.config.customUserAgent,
			fallback: getHttpUserAgent(),
			extraHeaders: this.config.extraHeaders,
			conversationId,
		});
		const headers = new Headers({
			"Content-Type": "application/json",
			"x-goog-api-key": apiKey,
			"User-Agent": fingerprint.userAgent,
			...(stream ? { Accept: "text/event-stream" } : {}),
			...buildOpencodeSessionHeader({
				baseUrl: this.baseUrl(),
				conversationId,
				extraHeaders: this.config.extraHeaders,
			}),
		});
		// HTTP names are case-insensitive; extra headers replace, never comma-join defaults.
		for (const [name, value] of Object.entries(fingerprint.headers)) headers.set(name, value);
		return Object.fromEntries(headers.entries());
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
		model: string,
		narratorId?: string,
	): Promise<BuiltHistory> {
		const projected = await projectHistory(
			dbMessages,
			{
				strict: hasCredentialBoundReasoning(parseModelId(model).model),
				reasoningSource: this.getActiveReasoningSource(),
			},
			narratorId,
		);
		return {
			history: this.geminiWireHistory(projected.turns),
			replayedInjectionMessageIds: projected.replayedInjectionMessageIds,
		};
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

	private reasoningSourceOverride?: string;

	setReasoningSourceOverride(source: string | undefined): void {
		this.reasoningSourceOverride = source;
	}

	toolLoadingTarget(): ToolLoadingTarget {
		return { protocol: "gemini-compatible" };
	}

	getActiveReasoningSource(): string | undefined {
		return this.reasoningSourceOverride ?? `gemini:${this.config.prefix}:generate-content`;
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
		const hasText = !!params.content && params.content !== ".";
		const userParts = geminiUserParts(hasText ? params.content : "", params.images);

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
		const metadata = effectiveModelProfile(params.model);
		const maxOutputTokens = resolveOutputTokenLimit(metadata, params.maxOutputTokens);
		if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
		const thinkingConfig = mapReasoningEffortToThinking(
			resolveMetadataReasoning(metadata, params.reasoningEffort),
			metadata.reasoning?.mode,
		);
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

		assertModelInputModalities(params.model, body, metadata);
		const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
		const headers = this.headers(apiKey, params.conversationId);

		logger.debug("Gemini chat request", {
			model,
			baseUrl,
			toolCount: tools[0]?.functionDeclarations.length ?? 0,
			contentCount: contents.length,
			hasSystem: !!systemInstruction,
			hasToolResults: toolResultParts.length > 0,
		});

		await reportInputCharacters(params, body);
		const bodyText = JSON.stringify(body);
		assertByteLimit(bodyText, GEMINI_GENERATE_MAX_STREAM_BYTES, "request body");
		params.requestDump?.beginResponseAttempt({
			transport: "http",
			method: "POST",
			url,
			headers: sanitizeHeaders(headers),
			bodyText,
		});
		params.onRequestStart?.();
		params.streamProgress?.beginAttempt();
		const response = await this.pfetch(url, {
			method: "POST",
			headers,
			body: bodyText,
			signal: params.signal,
		}).catch((error) => {
			params.requestDump?.setResponseError(error);
			params.requestDump?.finishResponseCapture(false);
			throw error;
		});
		params.streamProgress?.onHeaders(response.status);
		params.requestDump?.setResponseMeta({
			status: response.status,
			headers: sanitizeHeaders(response.headers),
		});

		if (!response.body) throw new Error("Gemini API returned no body");
		const tap = captureResponseStream(response.body, params.requestDump, params.streamProgress);
		try {
			if (!response.ok) {
				const errText = await readResponseTextWithLimit(
					new Response(tap.stream),
					GEMINI_GENERATE_MAX_SSE_EVENT_BYTES,
				).catch(() => "");
				throw createGeminiHttpError(response, errText);
			}
			yield* this.parseSSEStream(tap.stream);
		} catch (error) {
			params.requestDump?.setResponseError(error);
			throw error;
		} finally {
			tap.finish();
		}
	}

	/** Maps a tool_use id to its function name so tool results can reference it. */
	private toolUseIdToName = new Map<string, string>();

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
		return this.generateStreaming({
			model,
			systemInstruction,
			userText: text,
			signal: options?.signal,
			reasoningEffort: options?.reasoningEffort,
			maxOutputTokens: options?.maxOutputTokens,
			onTextDelta: options?.onTextDelta,
			onReasoningDelta: options?.onReasoningDelta,
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
		return this.generateStreaming({
			model,
			systemInstruction,
			userText: `${reminder}\n\n${content}`,
			signal: options?.signal,
			reasoningEffort: options?.reasoningEffort,
			maxOutputTokens: options?.maxOutputTokens,
			onTextDelta: options?.onTextDelta,
			onReasoningDelta: options?.onReasoningDelta,
		});
	}

	// === Internal ===

	private async generateStreaming(opts: {
		model: string;
		systemInstruction?: string;
		userText: string;
		signal?: AbortSignal;
		reasoningEffort?: ChatParams["reasoningEffort"];
		maxOutputTokens?: number;
		onTextDelta?: GenerateOptions["onTextDelta"];
		onReasoningDelta?: GenerateOptions["onReasoningDelta"];
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
		const metadata = effectiveModelProfile(opts.model);
		const thinkingConfig = mapReasoningEffortToThinking(
			resolveMetadataReasoning(metadata, opts.reasoningEffort),
			metadata.reasoning?.mode,
		);
		const maxOutputTokens = resolveOutputTokenLimit(metadata, opts.maxOutputTokens);
		if (thinkingConfig || maxOutputTokens !== undefined)
			body.generationConfig = {
				...(thinkingConfig && { thinkingConfig }),
				...(maxOutputTokens !== undefined && { maxOutputTokens }),
			};

		const bodyText = JSON.stringify(body);
		assertByteLimit(bodyText, GEMINI_GENERATE_MAX_STREAM_BYTES, "request body");
		const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
		const response = await this.pfetch(url, {
			method: "POST",
			headers: this.headers(apiKey, undefined, true),
			body: bodyText,
			signal: opts.signal,
		});
		if (!response.ok) {
			const responseText = await readResponseTextWithLimit(
				response,
				GEMINI_GENERATE_MAX_STREAM_BYTES,
			);
			throw createGeminiHttpError(response, responseText);
		}
		if (!response.body) throw new Error("Gemini API returned no body");

		if (response.headers.get("content-type")?.includes("application/json")) {
			const responseText = await readResponseTextWithLimit(
				response,
				GEMINI_GENERATE_MAX_STREAM_BYTES,
			);
			return parseGenerateJsonFallback(responseText, opts.onTextDelta);
		}

		let text = "";
		let usage: UsageData | null = null;
		let outputTruncated = false;
		for await (const event of this.parseSSEStream(response.body)) {
			if (event.text) {
				text += event.text;
				await opts.onTextDelta?.(event.text);
			}
			if (event.reasoning) await opts.onReasoningDelta?.(event.reasoning);
			if (event.usage) usage = usageFromStreamEvent(event.usage);
			if (event.invalidState) {
				if (text && isCompletionLimitReason(event.invalidState.reason)) {
					outputTruncated = true;
					continue;
				}
				throw new ApiError(
					invalidStateHttpStatus(event.invalidState.reason),
					event.invalidState.message,
				);
			}
		}
		return { text, usage, ...(outputTruncated && { outputTruncated }) };
	}

	/**
	 * Second projection stage for generateContent: neutral turns → contents.
	 *
	 * functionResponse parts carry no call id, so results pair with calls by name and
	 * order; the first stage emits both in call order.
	 */
	private geminiWireHistory(turns: readonly NeutralTurn[]): GeminiHistoryItem[] {
		const history: GeminiHistoryItem[] = [];
		for (const turn of turns) {
			if (turn.kind === "input") {
				for (const item of turn.items) {
					const parts = geminiUserParts(
						item.text,
						item.images.flatMap((image) => (image ? [image] : [])),
					);
					if (parts.length) history.push({ role: "user", parts });
				}
				continue;
			}
			if (turn.kind === "tool_results") {
				history.push({
					role: "user",
					parts: turn.results.map((result) => ({
						functionResponse: {
							name: result.name,
							response: result.isError ? { error: result.text } : { output: result.text },
						},
					})),
				});
				continue;
			}
			const searches = turn.items.filter((item) => item.kind === "web_search");
			// Searches ran on another provider; the model only learns of them as context.
			if (searches.length)
				history.push({
					role: "user",
					parts: [{ text: searches.map(webSearchSummary).join("\n") }],
				});
			const parts: GeminiPart[] = [];
			for (const item of turn.items) {
				if (item.kind === "reasoning") {
					if (!item.text) continue;
					const gemini = item.credentials.gemini as { thoughtSignature?: unknown } | undefined;
					const signature =
						item.sameSource && typeof gemini?.thoughtSignature === "string"
							? gemini.thoughtSignature
							: undefined;
					parts.push({
						text: item.text,
						thought: true,
						...(signature ? { thoughtSignature: signature } : {}),
					});
				} else if (item.kind === "text") {
					parts.push({ text: item.text });
				} else if (item.kind === "tool_call") {
					this.toolUseIdToName.set(item.wireId, item.name);
					parts.push({
						functionCall: { name: item.name, args: item.input },
						...(item.signature?.sameSource ? { thoughtSignature: item.signature.value } : {}),
					});
				}
			}
			if (parts.length) history.push({ role: "model", parts });
		}
		return history;
	}

	private async *parseSSEStream(
		body: ReadableStream<Uint8Array>,
		onRawChunk?: (chunk: string) => void,
	): AsyncGenerator<ParsedStreamEvent> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		const toolUses: AgentToolUse[] = [];
		const lane: GeminiGenerateLane = { nextIndex: 0 };
		const streamBudget = new StreamByteBudget(
			GEMINI_GENERATE_MAX_STREAM_BYTES,
			"Gemini SSE stream",
		);
		const textBudget = new StreamByteBudget(GEMINI_GENERATE_MAX_TEXT_BYTES, "Gemini response text");
		const argumentBudget = new StreamByteBudget(
			GEMINI_GENERATE_MAX_ARGUMENT_BYTES,
			"Gemini function arguments",
		);
		let buffer = "";
		const parseFrame = (frame: string) =>
			parseGenerateSseEvent(
				frame,
				toolUses,
				this.getActiveReasoningSource(),
				(text) => textBudget.add(byteLength(text)),
				(args) => argumentBudget.add(byteLength(args)),
				lane,
			);

		try {
			while (true) {
				const { done, value } = await readWithTimeout(reader);
				if (done) break;
				streamBudget.add(value.byteLength);
				const decoded = decoder.decode(value, { stream: true });
				onRawChunk?.(decoded);
				buffer += decoded;

				let boundary = nextSseBoundary(buffer);
				while (boundary) {
					const frame = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary.length);
					yield* parseFrame(frame);
					boundary = nextSseBoundary(buffer);
				}
				if (byteLength(buffer) > GEMINI_GENERATE_MAX_SSE_EVENT_BYTES) {
					throw new ApiError(413, "Gemini SSE event exceeded hard limit");
				}
			}
			const decodedTail = decoder.decode();
			onRawChunk?.(decodedTail);
			buffer += decodedTail;
			let boundary = nextSseBoundary(buffer);
			while (boundary) {
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				yield* parseFrame(frame);
				boundary = nextSseBoundary(buffer);
			}
			const tail = buffer.trim();
			if (tail) yield* parseFrame(tail);
		} catch (error) {
			await reader
				.cancel(error instanceof Error ? error.message : "Gemini stream limit")
				.catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
	}
}

interface GeminiGenerateLane {
	nextIndex: number;
	kind?: "text" | "reasoning" | "tool";
	candidateIndex?: number;
	outputIndex?: number;
}

function* parseGenerateSseEvent(
	rawEvent: string,
	toolUses: AgentToolUse[],
	signatureSource: string | undefined,
	countText: (text: string) => void,
	countArguments: (args: string) => void,
	lane: GeminiGenerateLane,
): Generator<ParsedStreamEvent> {
	if (byteLength(rawEvent) > GEMINI_GENERATE_MAX_SSE_EVENT_BYTES) {
		throw new ApiError(413, "Gemini SSE event exceeded hard limit");
	}
	const dataLines: string[] = [];
	for (const line of rawEvent.split(/\r?\n/)) {
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	const payload = dataLines.join("\n").trim();
	if (!payload || payload === "[DONE]") return;

	let chunk: GeminiStreamChunk;
	try {
		chunk = JSON.parse(payload) as GeminiStreamChunk;
	} catch {
		throw new ApiError(502, "Gemini SSE contained invalid JSON");
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
	if (chunk.usageMetadata) yield { usage: mapUsageStream(chunk.usageMetadata) };

	const candidate = chunk.candidates?.[0];
	const candidateIndex = candidate?.index ?? 0;
	for (const [partIndex, part] of (candidate?.content?.parts ?? []).entries()) {
		const kind = part.functionCall
			? "tool"
			: part.thought
				? "reasoning"
				: part.text != null
					? "text"
					: part.thoughtSignature
						? lane.kind
						: undefined;
		if (!kind) continue;
		// candidate.index selects an alternative response, NOT a content part.
		// Single-part same-kind chunks are increments of one lane. Multiple parts
		// in a frame, kind switches, and tool calls establish real new positions.
		if (
			lane.kind !== kind ||
			lane.candidateIndex !== candidateIndex ||
			partIndex > 0 ||
			kind === "tool"
		) {
			lane.outputIndex = lane.nextIndex++;
			lane.kind = kind;
			lane.candidateIndex = candidateIndex;
		}
		const outputIndex = lane.outputIndex;
		const blockId = `gemini:${candidateIndex}:part:${outputIndex}`;
		if (part.functionCall) {
			const toolUseId = generateGeminiToolId();
			const input = JSON.stringify(part.functionCall.args ?? {});
			countArguments(input);
			const tu: AgentToolUse = {
				toolUseId,
				name: part.functionCall.name,
				input: part.functionCall.args ?? {},
				outputIndex,
				...(part.thoughtSignature && {
					thoughtSignature: part.thoughtSignature,
					thoughtSignatureSource: signatureSource,
				}),
			};
			toolUses.push(tu);
			yield {
				toolUseChunk: {
					toolUseId,
					name: part.functionCall.name,
					input,
					stop: true,
					outputIndex,
					...(part.thoughtSignature && {
						thoughtSignature: part.thoughtSignature,
						thoughtSignatureSource: signatureSource,
					}),
				},
			};
		} else if (kind === "reasoning" && (part.text || part.thoughtSignature)) {
			if (part.text) countText(part.text);
			yield {
				reasoning: part.text,
				reasoningBlockId: blockId,
				reasoningOutputIndex: outputIndex,
				...(part.thoughtSignature && {
					reasoningMetadata: { gemini: { thoughtSignature: part.thoughtSignature } },
				}),
			};
		} else if (part.text) {
			countText(part.text);
			yield { text: part.text, textOutputIndex: outputIndex, textBlockId: blockId };
		}
	}
	if (!candidate?.finishReason) return;
	const result: ParsedStreamEvent = { stopReason: candidate.finishReason };
	if (toolUses.length > 0) result.toolUses = [...toolUses];
	if (candidate.finishReason === "MAX_TOKENS") {
		result.invalidState = {
			reason: "max_tokens",
			message: "Response truncated: model reached maximum token limit.",
		};
	} else if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(candidate.finishReason)) {
		result.invalidState = {
			reason: "content_filter",
			message: `Response blocked by Gemini (${candidate.finishReason}).`,
		};
	}
	yield result;
}

function nextSseBoundary(buffer: string): { index: number; length: number } | null {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf < 0 && crlf < 0) return null;
	if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
	return { index: lf, length: 2 };
}

async function readResponseTextWithLimit(response: Response, limit: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let output = "";
	let total = 0;
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new ApiError(413, "Gemini response body exceeded hard limit");
			output += decoder.decode(value, { stream: true });
		}
		return output + decoder.decode();
	} catch (error) {
		await reader
			.cancel(error instanceof Error ? error.message : "Gemini body limit")
			.catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

// === Helpers ===

/** Placed images follow their `[image #N]` placeholder; the rest trail the text as before. */
function geminiUserParts(
	text: string,
	images?: Array<{ format: string; base64: string }>,
): GeminiPart[] {
	return orderUserContent(text, images ?? [], "after").map((part) =>
		part.type === "text"
			? { text: part.text }
			: { inlineData: { mimeType: `image/${part.image.format}`, data: part.image.base64 } },
	);
}

/**
 * Recursively sanitize a JSON Schema for Gemini's function-declaration format.
 * Gemini's Schema type is a strict OpenAPI subset — it rejects `additionalProperties`,
 * `$schema`, `const`, `$ref`, and a few other keywords. This drops the unsupported
 * keys and rewrites string `const` to a single-value `enum`. Non-string enum
 * constraints are dropped while preserving the schema's type.
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
			// Gemini's enum field accepts strings only; retain the type for other literals.
			if (typeof value === "string") out.enum = [value];
			continue;
		}
		if (key === "enum" && Array.isArray(value) && !value.every((v) => typeof v === "string")) {
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
	effort: string | undefined,
	mode?: string | null,
): { includeThoughts?: boolean; thinkingLevel?: string; thinkingBudget?: number } | undefined {
	if (!effort) return undefined;
	if (effort === "none") return { thinkingBudget: 0 };
	// Budget-only models do not accept thinkingLevel. Retain their upstream
	// budget default instead of inventing numeric budgets from semantic levels.
	if (mode === "budget") return { includeThoughts: true };
	const levelMap: Record<string, "minimal" | "low" | "medium" | "high"> = {
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: "high",
	};
	const thinkingLevel = levelMap[effort] ?? "medium";
	return { includeThoughts: true, thinkingLevel };
}

async function parseGenerateJsonFallback(
	responseText: string,
	onTextDelta: GenerateOptions["onTextDelta"],
): Promise<GenerateMetaResult> {
	// The body is already in hand here, so keep it: reporting only "invalid JSON"
	// discards the one thing that identifies an HTML error page as such.
	const json = parseJsonTextWithBody<GeminiStreamChunk>(responseText, {
		label: "Gemini API",
		status: 200,
		contentType: "application/json",
	});
	if (json.error) {
		throw new ApiError(json.error.code ?? 500, `Gemini API error: ${json.error.message}`);
	}

	const candidate = json.candidates?.[0];
	if (json.promptFeedback?.blockReason) {
		throw new ApiError(422, `Request blocked by Gemini: ${json.promptFeedback.blockReason}`);
	}
	if (["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(candidate?.finishReason ?? "")) {
		throw new ApiError(422, `Response blocked by Gemini (${candidate?.finishReason}).`);
	}
	let text = "";
	for (const part of candidate?.content?.parts ?? []) {
		if (!part.text || part.thought) continue;
		text += part.text;
		assertByteLimit(text, GEMINI_GENERATE_MAX_TEXT_BYTES, "response text");
		await onTextDelta?.(part.text);
	}
	const outputTruncated = candidate?.finishReason === "MAX_TOKENS";
	if (outputTruncated && !text) {
		throw new ApiError(422, "Response truncated: model reached maximum token limit.");
	}
	return { text, usage: mapUsage(json.usageMetadata), ...(outputTruncated && { outputTruncated }) };
}

/**
 * Build the error for a non-2xx Gemini response with structured diagnostics.
 *
 * The message keeps its historical `Gemini API error <status>: <body>` shape,
 * but the status, the `{ error: { status, message } }` envelope and the
 * response headers now travel in `diagnostics` too, like the OpenAI and
 * Anthropic providers. Quota recovery needs exactly those: OpenCode Go's
 * per-family Gemini root (`/inference/go/google/v1beta`) answers a spent plan
 * with a 429 whose wait hint lives only in `retry-after`.
 */
function createGeminiHttpError(response: Response, rawBody: string): ApiError {
	let payload: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(rawBody);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			payload = parsed as Record<string, unknown>;
		}
	} catch {
		// Non-JSON body: the raw text below is still the message.
	}
	const nested =
		payload.error && typeof payload.error === "object"
			? (payload.error as Record<string, unknown>)
			: undefined;
	const message = typeof nested?.message === "string" ? nested.message : rawBody;
	const diagnostics = parseErrorDiagnostics(
		{
			...payload,
			statusCode: response.status,
			message,
			responseHeaders: Object.fromEntries(response.headers.entries()),
		},
		{ source: "provider", phase: "http_error", statusCode: response.status, message },
	);
	return new ApiError(
		response.status,
		`Gemini API error ${response.status}: ${rawBody}`,
		diagnostics,
	);
}

function invalidStateHttpStatus(reason: string): number {
	const numericStatus = Number(reason);
	if (Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus <= 599) {
		return numericStatus;
	}
	if (reason.toLowerCase() === "resource_exhausted") return 429;
	if (reason.toLowerCase() === "cancelled") return 499;
	if (reason.toLowerCase() === "max_tokens" || reason.toLowerCase() === "content_filter") {
		return 422;
	}
	return 502;
}

function usageFromStreamEvent(usage: NonNullable<ParsedStreamEvent["usage"]>): UsageData {
	const cachedInputTokens = usage.cachedInputTokens ?? 0;
	const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
	// inputTokens 已归一；仅在缺失时从完整 prompt 扣除缓存读写。
	return {
		inputTokens:
			usage.inputTokens ??
			Math.max((usage.promptTokens ?? 0) - cachedInputTokens - cacheCreationInputTokens, 0),
		outputTokens: usage.completionTokens ?? 0,
		cachedInputTokens,
		cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0,
	};
}

/**
 * ⚠️ 新增 provider adapter 前必须先调研其 token 数据组成：input 是否已含缓存、缓存读取/写入
 * 分别落在哪个字段、数值是「单次值」还是「会话累计值」，再决定换算方式。弄错的代价不会立刻
 * 显现——错误口径会被静默写入 api_requests，污染用量统计与缓存命中率，事后只能靠数据特征
 * 反推修补。
 */
function mapUsage(usage: GeminiUsageMetadata | undefined): UsageData | null {
	if (!usage) return null;
	const promptTokens = usage.promptTokenCount ?? 0;
	const cachedInputTokens = usage.cachedContentTokenCount ?? 0;
	return {
		// Gemini promptTokenCount 明确包含缓存读取，异常计数也不能按净输入猜测。
		inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
		outputTokens: usage.candidatesTokenCount ?? 0,
		cachedInputTokens,
		cacheCreationInputTokens: 0,
		reasoningTokens: usage.thoughtsTokenCount ?? 0,
	};
}

function mapUsageStream(usage: GeminiUsageMetadata): NonNullable<ParsedStreamEvent["usage"]> {
	const promptTokens = usage.promptTokenCount ?? 0;
	const cachedInputTokens = usage.cachedContentTokenCount ?? 0;
	return {
		promptTokens,
		inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
		completionTokens: usage.candidatesTokenCount ?? 0,
		reasoningTokens: usage.thoughtsTokenCount ?? undefined,
		cachedInputTokens: usage.cachedContentTokenCount ?? undefined,
	};
}

/**
 * Reserved key used to persist a functionCall's Gemini thought signature inside
 * the tool call's stored `inputJson` (avoids a DB schema migration). It is
 * stripped from the args before they are sent back to the model.
 */
export const GEMINI_THOUGHT_SIGNATURE_KEY = "__geminiThoughtSignature";
export const GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY = "__geminiThoughtSignatureSource";

let geminiToolIdCounter = 0;
function generateGeminiToolId(): string {
	geminiToolIdCounter = (geminiToolIdCounter + 1) % 1_000_000;
	return `gemini_tool_${Date.now().toString(36)}_${geminiToolIdCounter.toString(36)}`;
}
