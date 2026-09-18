import { outputToText } from "@shared/agent-protocol/tool-output";
import { modelTextFromContentBlocks } from "@shared/native-injection";
import { logger } from "../logger";
import { resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { GeminiProviderConfig } from "../settings";
import { parseModelId, settings } from "../settings";
import { readWithTimeout, StreamByteBudget } from "../stream-timeout";
import type { UsageData } from "../usage-tracking";
import { fetchWithNetworkDiagnostics } from "./diagnostic-fetch";
import { isCompletionLimitReason } from "./error-handling";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import { signatureSourcesCompatible } from "./reasoning-source";
import { DEFAULT_DUMP_MAX_BYTES, sanitizeHeaders } from "./request-dump";
import { parseJsonTextWithBody } from "./response-body";
import { resolveToolJsonSchema } from "./tool-registry";
import { type AgentToolUse, ApiError, type ResolvedToolDefinition } from "./types";

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
const GEMINI_GENERATE_MAX_REQUEST_DUMP_BYTES = 4 * 1024 * 1024;

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

function resolveDumpLimit(configured: number | undefined): number {
	if (configured == null) return DEFAULT_DUMP_MAX_BYTES;
	if (configured < 0) return GEMINI_GENERATE_MAX_REQUEST_DUMP_BYTES;
	return Math.min(configured, GEMINI_GENERATE_MAX_REQUEST_DUMP_BYTES);
}

function truncateUtf8ToBytes(
	text: string,
	maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
	const fullBytes = byteLength(text);
	if (fullBytes <= maxBytes) return { text, bytes: fullBytes, truncated: false };
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
		else high = mid - 1;
	}
	if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
	const accepted = text.slice(0, low);
	return { text: accepted, bytes: byteLength(accepted), truncated: true };
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
		const proxy = resolveProxyForUrl(target, this.config.proxy);
		return fetchWithNetworkDiagnostics(input, init, { proxy });
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
		return `gemini:${this.config.prefix}:generate-content`;
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

		const bodyText = JSON.stringify(body);
		assertByteLimit(bodyText, GEMINI_GENERATE_MAX_STREAM_BYTES, "request body");
		params.onRequestStart?.();
		const response = await this.pfetch(url, {
			method: "POST",
			headers,
			body: bodyText,
			signal: params.signal,
		});
		params.requestDump?.setResponseMeta({
			status: response.status,
			headers: sanitizeHeaders(response.headers),
		});

		const dumpLimit = resolveDumpLimit(settings.agent?.requestDumpMaxSize);
		if (!response.ok) {
			const errText = await readResponseTextWithLimit(
				response,
				GEMINI_GENERATE_MAX_SSE_EVENT_BYTES,
			).catch(() => "");
			params.requestDump?.setResponseBodyText(truncateUtf8ToBytes(errText, dumpLimit).text);
			throw new ApiError(response.status, `Gemini API error ${response.status}: ${errText}`);
		}
		if (!response.body) {
			throw new Error("Gemini API returned no body");
		}

		let dumpText = "";
		let dumpedBytes = 0;
		let dumpTruncated = false;
		const onRawChunk = params.requestDump
			? (chunk: string) => {
					if (dumpTruncated) return;
					const remaining = dumpLimit - dumpedBytes;
					if (remaining <= 0) {
						dumpTruncated = true;
						return;
					}
					const accepted = truncateUtf8ToBytes(chunk, remaining);
					dumpText += accepted.text;
					dumpedBytes += accepted.bytes;
					dumpTruncated = accepted.truncated || dumpedBytes >= dumpLimit;
					params.requestDump?.setResponseBodyText(dumpText);
				}
			: undefined;
		try {
			yield* this.parseSSEStream(response.body, onRawChunk);
		} catch (error) {
			params.requestDump?.setResponseError(error);
			throw error;
		} finally {
			if (params.requestDump && dumpTruncated) {
				const marker = "\n\n[... response dump truncated]";
				const prefix = truncateUtf8ToBytes(
					dumpText,
					Math.max(0, dumpLimit - byteLength(marker)),
				).text;
				params.requestDump.setResponseBodyText(`${prefix}${marker}`);
			}
		}
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		_images?: Array<{ format: string; base64: string }>,
		toolName?: string,
	): unknown {
		// Gemini matches results to calls by function name, not by an ID. The loop
		// passes the tool-use id here; buildHistory/pushAssistantTurn track the
		// name->id association, but for trailing results we must recover the name.
		// The loop always pairs formatToolResult output with the tool name via the
		// tool-call record, so we encode name in a lookup done by the loop caller.
		// To keep the name we stash it on a private map keyed by toolUseId.
		assertByteLimit(output, GEMINI_GENERATE_MAX_TEXT_BYTES, "tool result text");
		const name = toolName ?? this.toolUseIdToName.get(toolUseId) ?? toolUseId;
		const response: Record<string, unknown> = isError ? { error: output } : { output };
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
			outputIndex?: number;
		}>,
		_webSearches?: Array<{ id: string; query?: string; queries?: string[]; outputIndex?: number }>,
		_messageId?: string,
		_imageGenerations?: Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
		}>,
		textOutputIndex?: number,
	): void {
		const ordered: Array<{ index: number; sequence: number; part: GeminiPart }> = [];
		let sequence = 0;
		const currentSource = this.getActiveReasoningSource();
		for (const block of reasoningBlocks ?? []) {
			if (!block.text) continue;
			const part: GeminiPart = { text: block.text, thought: true };
			const signature = extractThoughtSignature(block.providerMetadata, currentSource);
			if (signature) part.thoughtSignature = signature;
			ordered.push({
				index: block.outputIndex ?? Number.MAX_SAFE_INTEGER - 2,
				sequence: sequence++,
				part,
			});
		}
		if (text) {
			ordered.push({
				index: textOutputIndex ?? Number.MAX_SAFE_INTEGER - 1,
				sequence: sequence++,
				part: { text },
			});
		}
		for (const toolUse of toolUses) {
			this.toolUseIdToName.set(toolUse.toolUseId, toolUse.name);
			const { args, signature, signatureSource } = extractArgsAndSignature(toolUse.input);
			const replaySignature = signatureSourcesCompatible(
				toolUse.thoughtSignatureSource ?? signatureSource,
				currentSource,
			)
				? (toolUse.thoughtSignature ?? signature)
				: undefined;
			const part: GeminiPart = { functionCall: { name: toolUse.name, args } };
			if (replaySignature) part.thoughtSignature = replaySignature;
			ordered.push({
				index: toolUse.outputIndex ?? Number.MAX_SAFE_INTEGER,
				sequence: sequence++,
				part,
			});
		}
		ordered.sort((left, right) => left.index - right.index || left.sequence - right.sequence);
		const parts = ordered.map((item) => item.part);
		if (parts.length === 0) parts.push({ text: "" });
		(history as GeminiHistoryItem[]).push({ role: "model", parts });
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
		return this.generateStreaming({
			model,
			systemInstruction,
			userText: text,
			signal: options?.signal,
			reasoningEffort: options?.reasoningEffort,
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
		const thinkingConfig = mapReasoningEffortToThinking(opts.reasoningEffort);
		if (thinkingConfig) body.generationConfig = { thinkingConfig };

		const bodyText = JSON.stringify(body);
		assertByteLimit(bodyText, GEMINI_GENERATE_MAX_STREAM_BYTES, "request body");
		const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
		const response = await this.pfetch(url, {
			method: "POST",
			headers: {
				Accept: "text/event-stream",
				"Content-Type": "application/json",
				"x-goog-api-key": apiKey,
			},
			body: bodyText,
			signal: opts.signal,
		});
		if (!response.ok) {
			const responseText = await readResponseTextWithLimit(
				response,
				GEMINI_GENERATE_MAX_STREAM_BYTES,
			);
			throw new ApiError(response.status, `Gemini API error ${response.status}: ${responseText}`);
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

	private buildGeminiHistory(dbMessages: DbMessage[]): {
		history: GeminiHistoryItem[];
		trailingToolResults: GeminiToolResult[];
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

				const content = Array.isArray(msg.contentJson)
					? (msg.contentJson as Array<Record<string, unknown>>)
					: [];
				const completedCalls =
					msg.toolCalls?.filter((call) => call.status === "success" || call.status === "fail") ??
					[];
				const callsById = new Map(completedCalls.map((call) => [call.toolUseId, call]));
				const seenCalls = new Set<string>();
				const ordered: Array<{ index: number; sequence: number; part: GeminiPart }> = [];
				let sequence = 0;
				const currentSource = this.getActiveReasoningSource();
				for (const block of content) {
					const index = numericOutputIndex(block.outputIndex);
					if (block.type === "reasoning" && typeof block.text === "string" && block.text) {
						const metadata = block.providerMetadata as
							| import("./types").ReasoningProviderMetadata
							| undefined;
						const signature = extractThoughtSignature(metadata, currentSource);
						ordered.push({
							index: index ?? Number.MAX_SAFE_INTEGER - 2,
							sequence: sequence++,
							part: {
								text: block.text,
								thought: true,
								...(signature ? { thoughtSignature: signature } : {}),
							},
						});
					} else if (block.type === "text" && typeof block.text === "string" && block.text) {
						ordered.push({
							index: index ?? Number.MAX_SAFE_INTEGER - 1,
							sequence: sequence++,
							part: { text: block.text },
						});
					} else if (block.type === "tool_use") {
						const toolUseId =
							typeof block.id === "string"
								? block.id
								: typeof block.toolUseId === "string"
									? block.toolUseId
									: undefined;
						const call = toolUseId ? callsById.get(toolUseId) : undefined;
						if (!call) continue;
						seenCalls.add(call.toolUseId);
						this.toolUseIdToName.set(call.toolUseId, call.toolName);
						const { args, signature, signatureSource } = extractArgsAndSignature(
							block.input ?? call.inputJson,
						);
						const source =
							typeof block.thoughtSignatureSource === "string"
								? block.thoughtSignatureSource
								: signatureSource;
						const replaySignature = signatureSourcesCompatible(source, currentSource)
							? typeof block.thoughtSignature === "string"
								? block.thoughtSignature
								: signature
							: undefined;
						ordered.push({
							index: index ?? Number.MAX_SAFE_INTEGER,
							sequence: sequence++,
							part: {
								functionCall: { name: call.toolName, args },
								...(replaySignature ? { thoughtSignature: replaySignature } : {}),
							},
						});
					}
				}
				if (!content.some((block) => block.type === "text") && msg.contentText) {
					ordered.push({
						index: Number.MAX_SAFE_INTEGER - 1,
						sequence: sequence++,
						part: { text: msg.contentText },
					});
				}
				for (const call of completedCalls) {
					if (seenCalls.has(call.toolUseId)) continue;
					this.toolUseIdToName.set(call.toolUseId, call.toolName);
					const { args, signature, signatureSource } = extractArgsAndSignature(call.inputJson);
					const replaySignature = signatureSourcesCompatible(signatureSource, currentSource)
						? signature
						: undefined;
					ordered.push({
						index: Number.MAX_SAFE_INTEGER,
						sequence: sequence++,
						part: {
							functionCall: { name: call.toolName, args },
							...(replaySignature ? { thoughtSignature: replaySignature } : {}),
						},
					});
				}
				ordered.sort((left, right) => left.index - right.index || left.sequence - right.sequence);
				const parts = ordered.map((item) => item.part);
				if (parts.length === 0) continue;
				history.push({ role: "model", parts });

				// Collect tool results for the following user turn.
				if (msg.toolCalls) {
					for (const tc of msg.toolCalls) {
						if (tc.status === "success" || tc.status === "fail") {
							const outputText = outputToText(tc.outputJson);
							pendingToolResults.push({
								name: tc.toolName,
								response: tc.status === "fail" ? { error: outputText } : { output: outputText },
							});
						}
					}
				}
			} else if (msg.role === "user") {
				flushToolResults();
				const text = msg.contentText || "";
				if (text) history.push({ role: "user", parts: [{ text }] });
			} else if (msg.role === "sys") {
				flushToolResults();

				const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
				const text = modelTextFromContentBlocks(content) || msg.contentText || "";
				// Gemini has no system role in contents; fold as a user turn.
				if (text) history.push({ role: "user", parts: [{ text }] });
			}
		}

		return { history, trailingToolResults: pendingToolResults };
	}

	private async *parseSSEStream(
		body: ReadableStream<Uint8Array>,
		onRawChunk?: (chunk: string) => void,
	): AsyncGenerator<ParsedStreamEvent> {
		const decoder = new TextDecoder();
		const reader = body.getReader();
		const toolUses: AgentToolUse[] = [];
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

function* parseGenerateSseEvent(
	rawEvent: string,
	toolUses: AgentToolUse[],
	signatureSource: string | undefined,
	countText: (text: string) => void,
	countArguments: (args: string) => void,
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
	const outputIndex = candidate?.index;
	for (const part of candidate?.content?.parts ?? []) {
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
		} else if (part.thought && part.text) {
			countText(part.text);
			yield {
				reasoning: part.text,
				reasoningOutputIndex: outputIndex,
				...(part.thoughtSignature && {
					reasoningMetadata: { gemini: { thoughtSignature: part.thoughtSignature } },
				}),
			};
		} else if (part.text) {
			countText(part.text);
			yield { text: part.text, textOutputIndex: outputIndex };
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
	return {
		inputTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
		outputTokens: usage.completionTokens ?? 0,
		cachedInputTokens: usage.cachedInputTokens ?? 0,
		cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0,
	};
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
	currentSource: string | undefined,
): string | undefined {
	const signature = metadata?.gemini?.thoughtSignature;
	if (!signature) return undefined;
	return signatureSourcesCompatible(metadata.signatureSource, currentSource)
		? signature
		: undefined;
}

/**
 * Reserved key used to persist a functionCall's Gemini thought signature inside
 * the tool call's stored `inputJson` (avoids a DB schema migration). It is
 * stripped from the args before they are sent back to the model.
 */
export const GEMINI_THOUGHT_SIGNATURE_KEY = "__geminiThoughtSignature";
export const GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY = "__geminiThoughtSignatureSource";

/**
 * Split a persisted/streamed tool-call input into the real function args and the
 * embedded Gemini thought signature (if any). The reserved signature key is
 * removed from the returned args so it never reaches the model.
 */
function extractArgsAndSignature(input: unknown): {
	args: Record<string, unknown>;
	signature?: string;
	signatureSource?: string;
} {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { args: (input as Record<string, unknown>) ?? {} };
	}
	const record = input as Record<string, unknown>;
	if (!(GEMINI_THOUGHT_SIGNATURE_KEY in record)) {
		return { args: record };
	}
	const {
		[GEMINI_THOUGHT_SIGNATURE_KEY]: signature,
		[GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY]: signatureSource,
		...args
	} = record;
	return {
		args,
		signature: typeof signature === "string" ? signature : undefined,
		signatureSource: typeof signatureSource === "string" ? signatureSource : undefined,
	};
}

function numericOutputIndex(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

let geminiToolIdCounter = 0;
function generateGeminiToolId(): string {
	geminiToolIdCounter = (geminiToolIdCounter + 1) % 1_000_000;
	return `gemini_tool_${Date.now().toString(36)}_${geminiToolIdCounter.toString(36)}`;
}
