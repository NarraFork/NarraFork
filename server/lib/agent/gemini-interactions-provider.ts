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
import { resolveToolJsonSchema } from "./tool-registry";
import { type AgentToolUse, ApiError, type ResolvedToolDefinition } from "./types";

const GEMINI_IDENTITY: Record<string, string> = {
	en: "You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools.",
	"zh-CN":
		"你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。",
};

const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const INTERACTIONS_REVISION = "2026-05-20";

export const GEMINI_MAX_STREAM_BYTES = 64 * 1024 * 1024;
export const GEMINI_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;
export const GEMINI_MAX_TEXT_BYTES = 16 * 1024 * 1024;
export const GEMINI_MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
export const GEMINI_MAX_REQUEST_DUMP_BYTES = 4 * 1024 * 1024;

interface GeminiSystemMarker {
	type: "system";
	text: string;
}

interface GeminiUserInputStep {
	type: "user_input";
	content: string | GeminiInputContent[];
}

interface GeminiModelOutputStep {
	type: "model_output";
	content: string | GeminiOutputContent[];
	id?: string;
}

interface GeminiThoughtContent {
	type: "text";
	text: string;
}

interface GeminiThoughtStep {
	type: "thought";
	id?: string;
	signature?: string;
	summary?: GeminiThoughtContent | GeminiThoughtContent[];
}

interface GeminiFunctionCallStep {
	type: "function_call";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	signature?: string;
}

interface GeminiFunctionResultStep {
	type: "function_result";
	call_id: string;
	name: string;
	result: unknown;
}

interface GeminiInputContent {
	type: "text" | "image";
	text?: string;
	data?: string;
	mime_type?: string;
}

interface GeminiOutputContent {
	type: "text";
	text: string;
}

type GeminiInteractionStep =
	| GeminiUserInputStep
	| GeminiModelOutputStep
	| GeminiThoughtStep
	| GeminiFunctionCallStep
	| GeminiFunctionResultStep;

type GeminiHistoryItem = GeminiSystemMarker | GeminiInteractionStep;

interface GeminiFunctionDeclaration {
	type: "function";
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
}

interface GeminiInteractionUsage {
	total_input_tokens?: number;
	total_output_tokens?: number;
	total_tokens?: number;
	total_cached_tokens?: number;
	total_thought_tokens?: number;
	total_tool_use_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	prompt_tokens?: number;
	completion_tokens?: number;
	cached_input_tokens?: number;
	thought_tokens?: number;
	reasoning_tokens?: number;
}

interface GeminiInteraction {
	id?: string;
	status?: string;
	steps?: GeminiInteractionStep[];
	usage?: GeminiInteractionUsage;
	error?: GeminiInteractionError;
	incomplete_details?: { reason?: string; message?: string };
}

interface GeminiInteractionError {
	code?: number | string;
	status?: string;
	message?: string;
	type?: string;
	details?: unknown;
}

interface GeminiSSEEnvelope {
	event_type?: string;
	interaction?: GeminiInteraction;
	metadata?: { total_usage?: GeminiInteractionUsage };
	step?: GeminiInteractionStep;
	index?: number;
	delta?: unknown;
	error?: GeminiInteractionError;
}

interface GeminiActiveStep {
	type: GeminiInteractionStep["type"];
	id?: string;
	callId?: string;
	name?: string;
	index: number;
	signature?: string;
	argumentsSeen?: boolean;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function resolveDumpLimit(configured: number | undefined): number {
	if (configured == null) return DEFAULT_DUMP_MAX_BYTES;
	if (configured < 0) return GEMINI_MAX_REQUEST_DUMP_BYTES;
	return Math.min(configured, GEMINI_MAX_REQUEST_DUMP_BYTES);
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
	// Avoid persisting a dangling high surrogate if the byte boundary split a pair.
	if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
	const accepted = text.slice(0, low);
	return { text: accepted, bytes: byteLength(accepted), truncated: true };
}

function assertByteLimit(value: string, limit: number, label: string): void {
	const size = byteLength(value);
	if (size > limit) {
		throw new ApiError(413, `Gemini ${label} exceeded hard limit (${size} > ${limit} bytes)`);
	}
}

export class GeminiInteractionsProvider implements ProviderAdapter {
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
		if (!this.config.apiKey) {
			throw new Error(`Gemini API key not configured for provider "${this.config.name}".`);
		}
		return this.config.apiKey;
	}

	private baseUrl(): string {
		return (this.config.baseUrl || DEFAULT_GEMINI_BASE).replace(/\/+$/, "");
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		return tools.map((tool): GeminiFunctionDeclaration => {
			const schema = sanitizeGeminiSchema(resolveToolJsonSchema(tool));
			const declaration: GeminiFunctionDeclaration = {
				type: "function",
				name: tool.name,
				description: tool.description,
			};
			const properties = schema.properties as Record<string, unknown> | undefined;
			if (properties && Object.keys(properties).length > 0) declaration.parameters = schema;
			return declaration;
		});
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
		const locale = (_locale ?? "en") as Locale;
		const identity = GEMINI_IDENTITY[locale] ?? GEMINI_IDENTITY.en;
		(history as GeminiHistoryItem[]).unshift({
			type: "system",
			text: `${identity}\n\n${systemPrompt}`,
		});
	}

	getActiveReasoningSource(): string | undefined {
		return `gemini:${this.config.prefix}:interactions`;
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const model = parseModelId(params.model).model;
		const { systemInstruction, steps } = splitSystemAndSteps(params.history as GeminiHistoryItem[]);
		steps.push(...(params.toolResults as GeminiFunctionResultStep[]));
		appendCurrentUserInput(steps, params.content, params.images);

		const body = this.buildRequestBody({
			model,
			steps,
			tools: params.tools as GeminiFunctionDeclaration[],
			systemInstruction,
			reasoningEffort: params.reasoningEffort,
			stream: true,
		});
		const bodyText = JSON.stringify(body);
		assertByteLimit(bodyText, GEMINI_MAX_STREAM_BYTES, "request body");

		const url = `${this.baseUrl()}/interactions`;
		const headers = this.headers(true);
		params.requestDump?.setRequest({
			transport: "http",
			url,
			headers: sanitizeHeaders(headers),
			body,
		});
		logger.debug("Gemini Interactions request", {
			model,
			baseUrl: this.baseUrl(),
			stepCount: steps.length,
			toolCount: (params.tools as unknown[]).length,
			hasSystem: !!systemInstruction,
		});

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
			const errorText = await readResponseTextWithLimit(response, GEMINI_MAX_SSE_EVENT_BYTES);
			params.requestDump?.setResponseBodyText(truncateUtf8ToBytes(errorText, dumpLimit).text);
			throw interactionHttpError(response.status, errorText);
		}
		if (!response.body) throw new Error("Gemini Interactions API returned no body");

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
					if (accepted.truncated) dumpTruncated = true;
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
		images?: Array<{ format: string; base64: string }>,
		toolName?: string,
	): unknown {
		assertByteLimit(output, GEMINI_MAX_TEXT_BYTES, "tool result text");
		let result: unknown = isError ? { error: output } : output;
		if (!isError && images?.length) {
			result = [
				{ type: "text", text: output },
				...images.map((image) => ({
					type: "image",
					data: image.base64,
					mime_type: `image/${image.format}`,
				})),
			];
		}
		return {
			type: "function_result",
			call_id: toolUseId,
			name: toolName ?? toolUseId,
			result,
		} satisfies GeminiFunctionResultStep;
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		_model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const steps = history as GeminiHistoryItem[];
		steps.push(...(toolResults as GeminiFunctionResultStep[]));
		appendCurrentUserInput(steps, content, images);
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
		const ordered: Array<{ index: number; sequence: number; step: GeminiInteractionStep }> = [];
		let sequence = 0;
		const currentSource = this.getActiveReasoningSource();

		for (const block of reasoningBlocks ?? []) {
			const metadata = block.providerMetadata;
			const signature = extractThoughtSignature(metadata, currentSource);
			ordered.push({
				index: block.outputIndex ?? Number.MAX_SAFE_INTEGER - 2,
				sequence: sequence++,
				step: {
					type: "thought",
					...(metadata?.gemini?.stepId ? { id: metadata.gemini.stepId } : {}),
					...(signature ? { signature } : {}),
					...(block.text ? { summary: [{ type: "text", text: block.text }] } : {}),
				},
			});
		}
		if (text) {
			ordered.push({
				index: textOutputIndex ?? Number.MAX_SAFE_INTEGER - 1,
				sequence: sequence++,
				step: { type: "model_output", content: text },
			});
		}
		for (const toolUse of toolUses) {
			const { args, signature, signatureSource } = extractArgsAndSignature(toolUse.input);
			const replaySignature = signatureSourcesCompatible(
				toolUse.thoughtSignatureSource ?? signatureSource,
				currentSource,
			)
				? (toolUse.thoughtSignature ?? signature)
				: undefined;
			if (
				replaySignature &&
				!(reasoningBlocks ?? []).some(
					(block) =>
						extractThoughtSignature(block.providerMetadata, currentSource) === replaySignature,
				)
			) {
				ordered.push({
					index: toolUse.outputIndex ?? Number.MAX_SAFE_INTEGER,
					sequence: sequence++,
					step: { type: "thought", signature: replaySignature },
				});
			}
			ordered.push({
				index: toolUse.outputIndex ?? Number.MAX_SAFE_INTEGER,
				sequence: sequence++,
				step: {
					type: "function_call",
					id: toolUse.toolUseId,
					name: toolUse.name,
					arguments: args,
				},
			});
		}
		ordered.sort((a, b) => a.index - b.index || a.sequence - b.sequence);
		(history as GeminiHistoryItem[]).push(...ordered.map((item) => item.step));
	}

	async generate(text: string, model: string): Promise<string> {
		return (await this.generateWithMeta(text, model)).text;
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
		return (
			await this.generateWithHistoryWithMeta(systemInstruction, content, model, locale, options)
		).text;
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

	private headers(stream: boolean): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"x-goog-api-key": this.getApiKey(),
			"Api-Revision": INTERACTIONS_REVISION,
			...(stream ? { Accept: "text/event-stream" } : {}),
		};
	}

	private buildRequestBody(options: {
		model: string;
		steps: GeminiInteractionStep[];
		tools?: GeminiFunctionDeclaration[];
		systemInstruction?: string;
		reasoningEffort?: ChatParams["reasoningEffort"];
		stream: boolean;
	}): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: options.model,
			input: options.steps,
			stream: options.stream,
			store: false,
		};
		if (options.systemInstruction) body.system_instruction = options.systemInstruction;
		if (options.tools?.length) body.tools = options.tools;
		const thinkingLevel = mapReasoningEffortToThinking(options.model, options.reasoningEffort);
		if (supportsThinkingConfig(options.model)) {
			body.generation_config = {
				thinking_summaries: "auto",
				...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
			};
		}
		return body;
	}

	private async generateStreaming(options: {
		model: string;
		systemInstruction?: string;
		userText: string;
		signal?: AbortSignal;
		reasoningEffort?: ChatParams["reasoningEffort"];
		onTextDelta?: GenerateOptions["onTextDelta"];
		onReasoningDelta?: GenerateOptions["onReasoningDelta"];
	}): Promise<GenerateMetaResult> {
		const model = parseModelId(options.model).model;
		const body = this.buildRequestBody({
			model,
			steps: [{ type: "user_input", content: options.userText }],
			systemInstruction: options.systemInstruction,
			reasoningEffort: options.reasoningEffort,
			stream: true,
		});
		const bodyText = JSON.stringify(body);
		assertByteLimit(bodyText, GEMINI_MAX_STREAM_BYTES, "request body");
		const response = await this.pfetch(`${this.baseUrl()}/interactions`, {
			method: "POST",
			headers: this.headers(true),
			body: bodyText,
			signal: options.signal,
		});
		if (!response.ok) {
			const responseText = await readResponseTextWithLimit(response, GEMINI_MAX_STREAM_BYTES);
			throw interactionHttpError(response.status, responseText);
		}
		if (!response.body) throw new Error("Gemini Interactions API returned no body");

		if (response.headers.get("content-type")?.includes("application/json")) {
			const responseText = await readResponseTextWithLimit(response, GEMINI_MAX_STREAM_BYTES);
			return parseInteractionJsonFallback(responseText, options.onTextDelta);
		}

		let text = "";
		let usage: UsageData | null = null;
		let outputTruncated = false;
		for await (const event of this.parseSSEStream(response.body)) {
			if (event.text) {
				text += event.text;
				await options.onTextDelta?.(event.text);
			}
			if (event.reasoning) await options.onReasoningDelta?.(event.reasoning);
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
		trailingToolResults: GeminiFunctionResultStep[];
		trailingUserText?: string;
	} {
		const topLevel = dbMessages.filter(
			(message) =>
				!message.parentToolUseId &&
				(message.role === "user" || message.role === "assistant" || message.role === "sys"),
		);
		if (topLevel.at(-1)?.role === "user") topLevel.pop();

		const history: GeminiHistoryItem[] = [];
		let pendingToolResults: GeminiFunctionResultStep[] = [];
		const flushToolResults = () => {
			if (pendingToolResults.length > 0) {
				history.push(...pendingToolResults);
				pendingToolResults = [];
			}
		};

		for (const message of topLevel) {
			if (message.role === "assistant") {
				flushToolResults();

				const content = Array.isArray(message.contentJson)
					? (message.contentJson as Array<Record<string, unknown>>)
					: [];
				const completedCalls =
					message.toolCalls?.filter(
						(call) => call.status === "success" || call.status === "fail",
					) ?? [];
				const toolBlocks = new Map(
					content
						.filter(
							(block) =>
								block.type === "tool_use" &&
								(typeof block.id === "string" || typeof block.toolUseId === "string"),
						)
						.map((block) => [(block.id ?? block.toolUseId) as string, block]),
				);
				const ordered: Array<{ index: number; sequence: number; step: GeminiInteractionStep }> = [];
				const seenThoughtSignatures = new Set<string>();
				let sequence = 0;

				for (const block of content) {
					const outputIndex = numericOutputIndex(block.outputIndex);
					if (block.type === "reasoning") {
						const metadata = block.providerMetadata as
							| import("./types").ReasoningProviderMetadata
							| undefined;
						const signature = extractThoughtSignature(metadata, this.getActiveReasoningSource());
						if (signature) seenThoughtSignatures.add(signature);
						ordered.push({
							index: outputIndex ?? Number.MAX_SAFE_INTEGER - 2,
							sequence: sequence++,
							step: {
								type: "thought",
								...(metadata?.gemini?.stepId ? { id: metadata.gemini.stepId } : {}),
								...(signature ? { signature } : {}),
								...(typeof block.text === "string" && block.text
									? { summary: [{ type: "text", text: block.text }] }
									: {}),
							},
						});
					} else if (block.type === "text" && typeof block.text === "string" && block.text) {
						ordered.push({
							index: outputIndex ?? Number.MAX_SAFE_INTEGER - 1,
							sequence: sequence++,
							step: { type: "model_output", content: block.text },
						});
					}
				}

				if (!content.some((block) => block.type === "text") && message.contentText) {
					ordered.push({
						index: Number.MAX_SAFE_INTEGER - 1,
						sequence: sequence++,
						step: { type: "model_output", content: message.contentText },
					});
				}

				for (const call of completedCalls) {
					const block = toolBlocks.get(call.toolUseId);
					const input = block?.input ?? call.inputJson;
					const { args, signature, signatureSource } = extractArgsAndSignature(input);
					const blockSignature =
						typeof block?.thoughtSignature === "string" ? block.thoughtSignature : undefined;
					const blockSignatureSource =
						typeof block?.thoughtSignatureSource === "string"
							? block.thoughtSignatureSource
							: signatureSource;
					const thoughtSignature = signatureSourcesCompatible(
						blockSignatureSource,
						this.getActiveReasoningSource(),
					)
						? (blockSignature ?? signature)
						: undefined;
					if (thoughtSignature && !seenThoughtSignatures.has(thoughtSignature)) {
						seenThoughtSignatures.add(thoughtSignature);
						ordered.push({
							index: numericOutputIndex(block?.outputIndex) ?? Number.MAX_SAFE_INTEGER,
							sequence: sequence++,
							step: { type: "thought", signature: thoughtSignature },
						});
					}
					ordered.push({
						index: numericOutputIndex(block?.outputIndex) ?? Number.MAX_SAFE_INTEGER,
						sequence: sequence++,
						step: {
							type: "function_call",
							id: call.toolUseId,
							name: call.toolName,
							arguments: args,
						},
					});
					const output = outputToText(call.outputJson);
					pendingToolResults.push({
						type: "function_result",
						call_id: call.toolUseId,
						name: call.toolName,
						result: call.status === "fail" ? { error: output } : output,
					});
				}
				ordered.sort((a, b) => a.index - b.index || a.sequence - b.sequence);
				history.push(...ordered.map((item) => item.step));
			} else if (message.role === "user") {
				flushToolResults();
				const text = message.contentText || "";
				if (text) history.push({ type: "user_input", content: text });
			} else {
				flushToolResults();
				const blocks = Array.isArray(message.contentJson)
					? (message.contentJson as Array<{ type?: string; text?: string }>)
					: [];
				const text = modelTextFromContentBlocks(blocks) || message.contentText || "";
				if (text) history.push({ type: "user_input", content: text });
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
		const activeSteps = new Map<number, GeminiActiveStep>();
		const argumentBudgets = new Map<string, StreamByteBudget>();
		const streamBudget = new StreamByteBudget(GEMINI_MAX_STREAM_BYTES, "Gemini SSE stream");
		const textBudget = new StreamByteBudget(GEMINI_MAX_TEXT_BYTES, "Gemini response text");
		let buffer = "";

		const countText = (text: string) => {
			textBudget.add(byteLength(text));
		};
		const countArguments = (callId: string, text: string) => {
			let budget = argumentBudgets.get(callId);
			if (!budget) {
				budget = new StreamByteBudget(
					GEMINI_MAX_ARGUMENT_BYTES,
					`Gemini function arguments for ${callId}`,
				);
				argumentBudgets.set(callId, budget);
			}
			budget.add(byteLength(text));
		};

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
					const rawEvent = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary.length);
					yield* parseGeminiSseEvent(rawEvent, activeSteps, countText, countArguments);
					boundary = nextSseBoundary(buffer);
				}
				// Complete frames were removed above. Only the residual incomplete event
				// is subject to the per-event limit; a chunk may contain many small events.
				if (byteLength(buffer) > GEMINI_MAX_SSE_EVENT_BYTES) {
					throw new ApiError(413, "Gemini SSE event exceeded hard limit");
				}
			}
			buffer += decoder.decode();
			let boundary = nextSseBoundary(buffer);
			while (boundary) {
				const rawEvent = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				yield* parseGeminiSseEvent(rawEvent, activeSteps, countText, countArguments);
				boundary = nextSseBoundary(buffer);
			}
			const tail = buffer.trim();
			if (tail) yield* parseGeminiSseEvent(tail, activeSteps, countText, countArguments);
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

function appendCurrentUserInput(
	steps: GeminiHistoryItem[],
	content: string,
	images?: Array<{ format: string; base64: string }>,
): void {
	const hasText = !!content && content !== ".";
	if (!hasText && !images?.length) {
		if (steps.length === 0) steps.push({ type: "user_input", content: content || "." });
		return;
	}
	if (!images?.length) {
		steps.push({ type: "user_input", content });
		return;
	}
	const parts: GeminiInputContent[] = [];
	if (hasText) parts.push({ type: "text", text: content });
	for (const image of images) {
		parts.push({ type: "image", data: image.base64, mime_type: `image/${image.format}` });
	}
	steps.push({ type: "user_input", content: parts });
}

function splitSystemAndSteps(history: GeminiHistoryItem[]): {
	systemInstruction?: string;
	steps: GeminiInteractionStep[];
} {
	let systemInstruction: string | undefined;
	const steps: GeminiInteractionStep[] = [];
	for (const item of history) {
		if (item.type === "system") systemInstruction = item.text;
		else steps.push(item);
	}
	return { systemInstruction, steps };
}

type GeminiThinkingTiers = "minimal-only" | "all" | "low-medium-high" | "low-high" | "minimal-high";

function getThinkingTiers(model: string): GeminiThinkingTiers | undefined {
	const lower = model.toLowerCase();
	if (!lower.includes("gemini-")) return undefined;
	if (lower.includes("gemini-3.1-flash-lite-image")) return "minimal-high";
	if (lower.includes("gemini-3.1-pro")) return "low-medium-high";
	if (/(?:^|[-_.])gemini-3(?:\.0)?-pro(?:[-_.]|$)/.test(lower)) return "low-high";
	if (/gemini-3(?:\.[15])?(?:[-_.]|$)/.test(lower)) return "all";
	return undefined;
}

function supportsThinkingConfig(model: string): boolean {
	return getThinkingTiers(model) !== undefined;
}

function mapReasoningEffortToThinking(
	model: string,
	effort: ChatParams["reasoningEffort"] | undefined,
): "minimal" | "low" | "medium" | "high" | undefined {
	if (!effort) return undefined;
	const tiers = getThinkingTiers(model);
	if (!tiers) return undefined;
	if (tiers === "minimal-only") return "minimal";
	if (effort === "none") return tiers === "all" || tiers === "minimal-high" ? "minimal" : "low";
	if (effort === "low") return tiers === "minimal-high" ? "minimal" : "low";
	if (effort === "medium") {
		if (tiers === "all" || tiers === "low-medium-high") return "medium";
		return "high";
	}
	return "high";
}

function* parseGeminiSseEvent(
	rawEvent: string,
	activeSteps: Map<number, GeminiActiveStep>,
	countText: (text: string) => void,
	countArguments: (callId: string, text: string) => void,
): Generator<ParsedStreamEvent> {
	if (byteLength(rawEvent) > GEMINI_MAX_SSE_EVENT_BYTES) {
		throw new ApiError(413, "Gemini SSE event exceeded hard limit");
	}
	let namedEvent: string | undefined;
	const dataLines: string[] = [];
	for (const line of rawEvent.split(/\r?\n/)) {
		if (line.startsWith("event:")) namedEvent = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	}
	const payload = dataLines.join("\n").trim();
	if (!payload || payload === "[DONE]") return;
	let envelope: GeminiSSEEnvelope;
	try {
		envelope = JSON.parse(payload) as GeminiSSEEnvelope;
	} catch {
		throw new ApiError(502, "Gemini Interactions SSE contained invalid JSON");
	}
	const eventType = envelope.event_type ?? namedEvent ?? "";
	if (eventType === "error" || envelope.error) {
		const error = envelope.error ?? (envelope as unknown as GeminiInteractionError);
		yield { invalidState: mapInteractionError(error) };
		return;
	}
	if (eventType === "interaction.created") {
		const interactionId = envelope.interaction?.id;
		if (interactionId) yield { messageId: interactionId };
		return;
	}
	if (
		eventType === "interaction.completed" ||
		eventType === "interaction.requires_action" ||
		eventType === "interaction.in_progress" ||
		eventType === "interaction.failed" ||
		eventType === "interaction.incomplete" ||
		eventType === "interaction.cancelled" ||
		eventType === "interaction.budget_exceeded"
	) {
		const eventStatus = eventType.slice("interaction.".length);
		const interaction = envelope.interaction ?? { status: eventStatus };
		const usage = interaction.usage ?? envelope.metadata?.total_usage;
		if (usage) yield { usage: mapUsageStream(usage) };
		const invalid = mapInteractionStatus(interaction);
		if (invalid) yield { invalidState: invalid };
		else if (interaction.status && interaction.status !== "in_progress") {
			yield { stopReason: interaction.status };
		}
		return;
	}

	const index = envelope.index ?? 0;
	if (eventType === "step.start" && envelope.step) {
		const step = envelope.step;
		if (step.type === "model_output") {
			activeSteps.set(index, { type: step.type, id: step.id, index });
			const text = textFromModelOutput(step);
			if (text) {
				countText(text);
				yield { text, textOutputIndex: index };
			}
		} else if (step.type === "thought") {
			activeSteps.set(index, {
				type: step.type,
				id: step.id,
				index,
				signature: step.signature,
			});
			const metadata = thoughtMetadata(step.id, index, step.signature);
			for (const summary of extractThoughtTexts(step.summary)) {
				countText(summary);
				yield { reasoning: summary, reasoningMetadata: metadata, reasoningOutputIndex: index };
			}
		} else if (step.type === "function_call") {
			const callId = step.id;
			if (!callId) throw new ApiError(502, "Gemini function_call step missing id");
			activeSteps.set(index, {
				type: step.type,
				id: step.id,
				callId,
				name: step.name,
				index,
				argumentsSeen: Object.keys(step.arguments ?? {}).length > 0,
			});
			const input =
				Object.keys(step.arguments ?? {}).length > 0 ? JSON.stringify(step.arguments) : "";
			if (input) countArguments(callId, input);
			yield {
				toolUseChunk: {
					toolUseId: callId,
					name: step.name,
					input,
					outputIndex: index,
				},
			};
		}
		return;
	}

	if (eventType === "step.delta") {
		const active = activeSteps.get(index);
		if (!active) return;
		const delta = envelope.delta;
		if (active.type === "thought") {
			const signature = extractThoughtSignatureDelta(delta);
			if (signature) {
				active.signature = signature;
				yield {
					reasoningMetadata: thoughtMetadata(active.id, index, signature),
					reasoningOutputIndex: index,
				};
				return;
			}
		}
		if (active.type === "function_call" && active.callId) {
			const argumentDelta = extractArgumentDelta(delta);
			if (argumentDelta) {
				active.argumentsSeen = true;
				countArguments(active.callId, argumentDelta);
				yield {
					toolUseChunk: {
						toolUseId: active.callId,
						input: argumentDelta,
						outputIndex: index,
					},
				};
			}
		} else {
			const text = extractTextDelta(delta);
			if (!text) return;
			countText(text);
			if (active.type === "thought") {
				yield {
					reasoning: text,
					reasoningMetadata: thoughtMetadata(active.id, index, active.signature),
					reasoningOutputIndex: index,
				};
			} else {
				yield { text, textOutputIndex: index };
			}
		}
		return;
	}

	if (eventType === "step.stop") {
		const active = activeSteps.get(index);
		const step = envelope.step;
		if (active?.type === "function_call" && active.callId) {
			yield {
				toolUseChunk: {
					toolUseId: active.callId,
					name: active.name,
					stop: true,
					outputIndex: index,
				},
			};
		} else if (active?.type === "thought") {
			const thought = step?.type === "thought" ? step : undefined;
			const signature = thought?.signature ?? active.signature;
			yield {
				reasoningMetadata: thoughtMetadata(active.id, index, signature),
				reasoningOutputIndex: index,
			};
		}
		activeSteps.delete(index);
	}
}

function thoughtMetadata(
	stepId: string | undefined,
	stepIndex: number,
	thoughtSignature: string | undefined,
): import("./types").ReasoningProviderMetadata {
	return {
		gemini: {
			...(stepId ? { stepId } : {}),
			stepIndex,
			...(thoughtSignature ? { thoughtSignature } : {}),
		},
	};
}

function extractThoughtTexts(content: unknown): string[] {
	if (typeof content === "string") return content ? [content] : [];
	if (Array.isArray(content)) return content.flatMap(extractThoughtTexts);
	if (!content || typeof content !== "object") return [];
	const record = content as Record<string, unknown>;
	if (typeof record.text === "string") return record.text ? [record.text] : [];
	if (record.content != null) return extractThoughtTexts(record.content);
	if (record.summary != null) return extractThoughtTexts(record.summary);
	return [];
}

function extractTextDelta(delta: unknown): string {
	return extractThoughtTexts(delta).join("");
}

function extractThoughtSignatureDelta(delta: unknown): string | undefined {
	if (!delta || typeof delta !== "object") return undefined;
	const record = delta as Record<string, unknown>;
	if (record.type !== "thought_signature") return undefined;
	return typeof record.signature === "string" ? record.signature : undefined;
}

function extractArgumentDelta(delta: unknown): string {
	if (typeof delta === "string") return delta;
	if (!delta || typeof delta !== "object") return "";
	const record = delta as Record<string, unknown>;
	if (typeof record.delta === "string") return record.delta;
	if (typeof record.arguments === "string") return record.arguments;
	if (typeof record.arguments_delta === "string") return record.arguments_delta;
	if (typeof record.text === "string") return record.text;
	return "";
}

function nextSseBoundary(buffer: string): { index: number; length: number } | null {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf < 0 && crlf < 0) return null;
	if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
	return { index: lf, length: 2 };
}

function textFromModelOutput(step: GeminiModelOutputStep): string {
	if (typeof step.content === "string") return step.content;
	return step.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function mapInteractionError(error: GeminiInteractionError | undefined): {
	reason: string;
	message: string;
} {
	const reason = String(error?.status ?? error?.type ?? error?.code ?? "api_error").toLowerCase();
	return { reason, message: error?.message || "Unknown Gemini Interactions API error" };
}

function mapInteractionStatus(
	interaction: GeminiInteraction | undefined,
): { reason: string; message: string } | undefined {
	if (!interaction) return undefined;
	if (interaction.error) return mapInteractionError(interaction.error);
	const status = interaction.status?.toLowerCase();
	if (
		!status ||
		status === "completed" ||
		status === "requires_action" ||
		status === "in_progress"
	) {
		return undefined;
	}
	const detailReason = interaction.incomplete_details?.reason?.toLowerCase();
	const detailMessage = interaction.incomplete_details?.message;
	if (
		status === "budget_exceeded" ||
		detailReason === "max_output_tokens" ||
		detailReason === "max_tokens"
	) {
		return {
			reason: "max_tokens",
			message: detailMessage || "Gemini interaction stopped after reaching its output budget.",
		};
	}
	if (status === "cancelled" || status === "canceled") {
		return { reason: "cancelled", message: detailMessage || "Gemini interaction was cancelled." };
	}
	if (status === "failed") {
		return {
			reason: detailReason || "api_error",
			message: detailMessage || "Gemini interaction failed.",
		};
	}
	return {
		reason: detailReason || status,
		message: detailMessage || `Gemini interaction ended with status ${status}.`,
	};
}

function statusToHttpCode(status: string | undefined): number {
	if (status === "cancelled" || status === "canceled") return 499;
	if (status === "budget_exceeded" || status === "incomplete") return 422;
	return 502;
}

function interactionHttpError(status: number, text: string): ApiError {
	let detail = text;
	try {
		const parsed = JSON.parse(text) as { error?: GeminiInteractionError } & GeminiInteractionError;
		const error = parsed.error ?? parsed;
		detail = error.message || text;
	} catch {
		// Keep the raw bounded error body.
	}
	return new ApiError(status, `Gemini Interactions API error ${status}: ${detail}`);
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
		output += decoder.decode();
		return output;
	} catch (error) {
		await reader
			.cancel(error instanceof Error ? error.message : "Gemini body limit")
			.catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

async function parseInteractionJsonFallback(
	responseText: string,
	onTextDelta: GenerateOptions["onTextDelta"],
): Promise<GenerateMetaResult> {
	let interaction: GeminiInteraction;
	try {
		interaction = JSON.parse(responseText) as GeminiInteraction;
	} catch {
		throw new ApiError(502, "Gemini Interactions API returned invalid JSON");
	}
	const invalid = mapInteractionStatus(interaction);
	if (invalid && !isCompletionLimitReason(invalid.reason)) {
		throw new ApiError(statusToHttpCode(interaction.status), invalid.message);
	}

	let text = "";
	for (const step of interaction.steps ?? []) {
		if (step.type !== "model_output") continue;
		const delta = textFromModelOutput(step);
		if (!delta) continue;
		text += delta;
		assertByteLimit(text, GEMINI_MAX_TEXT_BYTES, "response text");
		await onTextDelta?.(delta);
	}
	if (invalid && !text) {
		throw new ApiError(statusToHttpCode(interaction.status), invalid.message);
	}
	return {
		text,
		usage: mapUsage(interaction.usage),
		...(invalid && { outputTruncated: true }),
	};
}

function invalidStateHttpStatus(reason: string): number {
	const normalized = reason.toLowerCase();
	const numericStatus = Number(reason);
	if (Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus <= 599) {
		return numericStatus;
	}
	if (normalized === "resource_exhausted") return 429;
	if (normalized === "cancelled" || normalized === "canceled") return 499;
	if (normalized === "max_tokens" || normalized === "content_filter") return 422;
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

function mapUsage(usage: GeminiInteractionUsage | undefined): UsageData | null {
	if (!usage) return null;
	return {
		inputTokens: usage.total_input_tokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0,
		outputTokens: usage.total_output_tokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0,
		cachedInputTokens: usage.total_cached_tokens ?? usage.cached_input_tokens ?? 0,
		cacheCreationInputTokens: 0,
		reasoningTokens:
			usage.total_thought_tokens ?? usage.thought_tokens ?? usage.reasoning_tokens ?? 0,
	};
}

function mapUsageStream(usage: GeminiInteractionUsage): NonNullable<ParsedStreamEvent["usage"]> {
	const promptTokens = usage.total_input_tokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
	const cachedInputTokens = usage.total_cached_tokens ?? usage.cached_input_tokens ?? 0;
	return {
		promptTokens,
		inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
		completionTokens:
			usage.total_output_tokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0,
		reasoningTokens: usage.total_thought_tokens ?? usage.thought_tokens ?? usage.reasoning_tokens,
		cachedInputTokens: cachedInputTokens || undefined,
	};
}

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

export const GEMINI_THOUGHT_SIGNATURE_KEY = "__geminiThoughtSignature";
export const GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY = "__geminiThoughtSignatureSource";

function extractArgsAndSignature(input: unknown): {
	args: Record<string, unknown>;
	signature?: string;
	signatureSource?: string;
} {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { args: (input as Record<string, unknown>) ?? {} };
	}
	const record = input as Record<string, unknown>;
	if (!(GEMINI_THOUGHT_SIGNATURE_KEY in record)) return { args: record };
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

export function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return sanitizeNode(schema) as Record<string, unknown>;
}

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
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (GEMINI_UNSUPPORTED_KEYS.has(key)) continue;
		if (key === "const") {
			output.enum = [value];
		} else if (key === "properties" && value && typeof value === "object") {
			output.properties = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
					name,
					sanitizeNode(schema),
				]),
			);
		} else if (key === "items") {
			output.items = sanitizeNode(value);
		} else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			output.anyOf = (value as unknown[]).map(sanitizeNode);
		} else {
			output[key] = sanitizeNode(value);
		}
	}
	return output;
}
