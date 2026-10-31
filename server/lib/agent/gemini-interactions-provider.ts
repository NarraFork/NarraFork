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
import { captureResponseStream, sanitizeHeaders } from "./request-dump";
import { stringifyRequestBody } from "./request-json";
import { parseJsonTextWithBody } from "./response-body";
import { unsupportedResponseFormatReason } from "./response-format";
import type { ToolLoadingTarget } from "./tool-loading";
import { resolveToolJsonSchema } from "./tool-registry";
import { ApiError, type ResolvedToolDefinition } from "./types";
import { orderUserContent } from "./user-content-order";

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
	textLength?: number;
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
			history: this.interactionsWireHistory(projected.turns),
			replayedInjectionMessageIds: projected.replayedInjectionMessageIds,
		};
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

	toolLoadingTarget(): ToolLoadingTarget {
		return { protocol: "gemini-compatible" };
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
			model: params.model,
			maxOutputTokens: params.maxOutputTokens,
			steps,
			tools: params.tools as GeminiFunctionDeclaration[],
			systemInstruction,
			reasoningEffort: params.reasoningEffort,
			stream: true,
		});
		await reportInputCharacters(params, body);
		const bodyText = await stringifyRequestBody(body, params.signal);

		const url = `${this.baseUrl()}/interactions`;
		const headers = this.headers(true, params.conversationId);
		params.requestDump?.beginResponseAttempt({
			transport: "http",
			method: "POST",
			url,
			headers: sanitizeHeaders(headers),
			bodyText,
		});
		logger.debug("Gemini Interactions request", {
			model,
			baseUrl: this.baseUrl(),
			stepCount: steps.length,
			toolCount: (params.tools as unknown[]).length,
			hasSystem: !!systemInstruction,
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

		if (!response.body) throw new Error("Gemini Interactions API returned no body");
		const tap = captureResponseStream(response.body, params.requestDump, params.streamProgress);
		try {
			if (!response.ok) {
				const errorText = await readResponseTextWithLimit(
					new Response(tap.stream),
					GEMINI_MAX_SSE_EVENT_BYTES,
				);
				throw interactionHttpError(response.status, errorText);
			}
			yield* this.parseSSEStream(tap.stream);
		} catch (error) {
			params.requestDump?.setResponseError(error);
			throw error;
		} finally {
			tap.finish();
		}
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
		const result = await this.generateStreaming({
			model,
			systemInstruction,
			userText: text,
			signal: options?.signal,
			reasoningEffort: options?.reasoningEffort,
			maxOutputTokens: options?.maxOutputTokens,
			onTextDelta: options?.onTextDelta,
			onReasoningDelta: options?.onReasoningDelta,
		});
		// The Interactions surface has no JSON-Schema output mode, so a requested
		// responseFormat is reported as degraded rather than silently dropped.
		if (!options?.responseFormat || result.responseFormatDegraded) return result;
		return {
			...result,
			responseFormatDegraded: unsupportedResponseFormatReason("Gemini Interactions"),
		};
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
			maxOutputTokens: options?.maxOutputTokens,
			onTextDelta: options?.onTextDelta,
			onReasoningDelta: options?.onReasoningDelta,
		});
	}

	private headers(stream: boolean, conversationId?: string): Record<string, string> {
		const fingerprint = resolveClientFingerprint({
			mode: this.config.userAgentMode,
			custom: this.config.customUserAgent,
			fallback: getHttpUserAgent(),
			extraHeaders: this.config.extraHeaders,
			conversationId,
		});
		const headers = new Headers({
			"Content-Type": "application/json",
			"x-goog-api-key": this.getApiKey(),
			"Api-Revision": INTERACTIONS_REVISION,
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

	private buildRequestBody(options: {
		model: string;
		steps: GeminiInteractionStep[];
		tools?: GeminiFunctionDeclaration[];
		systemInstruction?: string;
		reasoningEffort?: ChatParams["reasoningEffort"];
		maxOutputTokens?: number;
		stream: boolean;
	}): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: parseModelId(options.model).model,
			input: options.steps,
			stream: options.stream,
			store: false,
		};
		if (options.systemInstruction) body.system_instruction = options.systemInstruction;
		if (options.tools?.length) body.tools = options.tools;
		const metadata = effectiveModelProfile(options.model);
		const effort = resolveMetadataReasoning(metadata, options.reasoningEffort);
		// This adapter has no verified Interactions disable mapping. Do not silently
		// turn an explicit, supported disable request into low/minimal thinking.
		if (effort === "none" && metadata.reasoning?.canDisable === true) {
			throw new Error(
				"Gemini Interactions cannot disable thinking; use the generateContent transport for this model.",
			);
		}
		const thinkingLevel = metadata.reasoning?.levels?.length
			? effort === "xhigh" || effort === "max"
				? "high"
				: effort === "none"
					? "minimal"
					: effort
			: mapReasoningEffortToThinking(parseModelId(options.model).model, effort);
		const generationConfig: Record<string, unknown> = {};
		if (
			metadata.reasoning?.supported !== false &&
			(metadata.reasoning?.supported === true ||
				supportsThinkingConfig(parseModelId(options.model).model))
		) {
			generationConfig.thinking_summaries = "auto";
			if (thinkingLevel) generationConfig.thinking_level = thinkingLevel;
		}
		const maxOutputTokens = resolveOutputTokenLimit(metadata, options.maxOutputTokens);
		if (maxOutputTokens !== undefined) generationConfig.max_output_tokens = maxOutputTokens;
		if (Object.keys(generationConfig).length) body.generation_config = generationConfig;
		assertModelInputModalities(options.model, body, metadata);
		return body;
	}

	private async generateStreaming(options: {
		model: string;
		systemInstruction?: string;
		userText: string;
		signal?: AbortSignal;
		reasoningEffort?: ChatParams["reasoningEffort"];
		maxOutputTokens?: number;
		onTextDelta?: GenerateOptions["onTextDelta"];
		onReasoningDelta?: GenerateOptions["onReasoningDelta"];
	}): Promise<GenerateMetaResult> {
		const body = this.buildRequestBody({
			model: options.model,
			maxOutputTokens: options.maxOutputTokens,
			steps: [{ type: "user_input", content: options.userText }],
			systemInstruction: options.systemInstruction,
			reasoningEffort: options.reasoningEffort,
			stream: true,
		});
		const bodyText = await stringifyRequestBody(body, options.signal);
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

	/** Second projection stage for Interactions: neutral turns → steps. */
	private interactionsWireHistory(turns: readonly NeutralTurn[]): GeminiHistoryItem[] {
		const history: GeminiHistoryItem[] = [];
		for (const turn of turns) {
			if (turn.kind === "input") {
				for (const item of turn.items) {
					const images = item.images.flatMap((image) => (image ? [image] : []));
					if (!images.length) {
						if (item.text) history.push({ type: "user_input", content: item.text });
						continue;
					}
					history.push({
						type: "user_input",
						content: orderUserContent(item.text, images, "after").map(
							(part): GeminiInputContent =>
								part.type === "text"
									? { type: "text", text: part.text }
									: { type: "image", data: part.image.base64, mime_type: part.image.mediaType },
						),
					});
				}
				continue;
			}
			if (turn.kind === "tool_results") {
				for (const result of turn.results)
					history.push({
						type: "function_result",
						call_id: result.wireId,
						name: result.name,
						// Images ride with a successful result, as the live turn sends them.
						result: result.isError
							? { error: result.text }
							: result.images.length
								? [
										{ type: "text", text: result.text },
										...result.images.map((image) => ({
											type: "image",
											data: image.base64,
											mime_type: image.mediaType,
										})),
									]
								: result.text,
					});
				continue;
			}
			const searches = turn.items.filter((item) => item.kind === "web_search");
			// Searches ran on another provider; the model only learns of them as context.
			if (searches.length)
				history.push({ type: "user_input", content: searches.map(webSearchSummary).join("\n") });
			// A call's signature rides on a thought step; one already carried by a thought
			// is not repeated.
			const seenSignatures = new Set<string>();
			for (const item of turn.items) {
				if (item.kind === "reasoning") {
					const gemini = (item.credentials.gemini ?? {}) as {
						thoughtSignature?: unknown;
						stepId?: unknown;
					};
					const signature =
						item.sameSource && typeof gemini.thoughtSignature === "string"
							? gemini.thoughtSignature
							: undefined;
					if (signature) seenSignatures.add(signature);
					history.push({
						type: "thought",
						...(item.sameSource && typeof gemini.stepId === "string" ? { id: gemini.stepId } : {}),
						...(signature ? { signature } : {}),
						...(item.text ? { summary: [{ type: "text", text: item.text }] } : {}),
					});
				} else if (item.kind === "text") {
					history.push({ type: "model_output", content: item.text });
				} else if (item.kind === "tool_call") {
					const signature = item.signature?.sameSource ? item.signature.value : undefined;
					if (signature && !seenSignatures.has(signature)) {
						seenSignatures.add(signature);
						history.push({ type: "thought", signature });
					}
					history.push({
						type: "function_call",
						id: item.wireId,
						name: item.name,
						arguments: item.input,
					});
				}
			}
		}
		return history;
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
	const parts = orderUserContent(hasText ? content : "", images, "after").map(
		(part): GeminiInputContent =>
			part.type === "text"
				? { type: "text", text: part.text }
				: { type: "image", data: part.image.base64, mime_type: `image/${part.image.format}` },
	);
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
	effort: string | undefined,
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
	const stepId = envelope.step && "id" in envelope.step ? envelope.step.id : undefined;
	const blockId = `gemini:step:${eventType === "step.start" ? (stepId ?? index) : (activeSteps.get(index)?.id ?? stepId ?? index)}`;
	if (eventType === "step.start" && envelope.step) {
		const step = envelope.step;
		if (step.type === "model_output") {
			const text = textFromModelOutput(step);
			activeSteps.set(index, { type: step.type, id: step.id, index, textLength: text.length });
			if (text) {
				countText(text);
				yield { text, textOutputIndex: index, textBlockId: blockId };
			}
		} else if (step.type === "thought") {
			activeSteps.set(index, {
				type: step.type,
				id: step.id,
				index,
				signature: step.signature,
				textLength: extractThoughtTexts(step.summary).join("").length,
			});
			const metadata = thoughtMetadata(step.id, index, step.signature);
			for (const summary of extractThoughtTexts(step.summary)) {
				countText(summary);
				yield {
					reasoning: summary,
					reasoningMetadata: metadata,
					reasoningOutputIndex: index,
					reasoningBlockId: blockId,
				};
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
					reasoningBlockId: blockId,
				};
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
			active.textLength = (active.textLength ?? 0) + text.length;
			if (active.type === "thought") {
				yield {
					reasoning: text,
					reasoningBlockId: blockId,
					reasoningMetadata: thoughtMetadata(active.id, index, active.signature),
					reasoningOutputIndex: index,
				};
			} else {
				yield { text, textOutputIndex: index, textBlockId: blockId };
			}
		}
		return;
	}

	if (eventType === "step.stop") {
		const active = activeSteps.get(index);
		const step = envelope.step;
		const finalText =
			step?.type === "model_output"
				? textFromModelOutput(step)
				: step?.type === "thought"
					? extractThoughtTexts(step.summary).join("")
					: "";
		const suffix = finalText.slice(active?.textLength ?? 0);
		if (suffix && (active?.type === "thought" || active?.type === "model_output")) {
			countText(suffix);
			if (active.type === "thought")
				yield {
					reasoning: suffix,
					reasoningBlockId: blockId,
					reasoningOutputIndex: index,
					reasoningMetadata: thoughtMetadata(active.id, index, active.signature),
				};
			else yield { text: suffix, textBlockId: blockId, textOutputIndex: index };
		}
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
				reasoningBlockId: blockId,
			};
		}
		if (active?.type === "thought" || active?.type === "model_output") {
			yield {
				contentBoundary: {
					kind: active.type === "thought" ? "reasoning" : "text",
					phase: "complete",
					blockId: blockId,
					outputIndex: index,
				},
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
	// Keep the body: "invalid JSON" alone cannot distinguish a malformed payload
	// from a proxy's HTML error page.
	const interaction = parseJsonTextWithBody<GeminiInteraction>(responseText, {
		label: "Gemini Interactions API",
		status: 200,
		contentType: "application/json",
	});
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

function mapUsage(usage: GeminiInteractionUsage | undefined): UsageData | null {
	if (!usage) return null;
	const promptTokens = usage.total_input_tokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0;
	const cachedInputTokens = usage.total_cached_tokens ?? usage.cached_input_tokens ?? 0;
	return {
		// Interactions 原始输入计数包含缓存读取。
		inputTokens: Math.max(promptTokens - cachedInputTokens, 0),
		outputTokens: usage.total_output_tokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0,
		cachedInputTokens,
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

export const GEMINI_THOUGHT_SIGNATURE_KEY = "__geminiThoughtSignature";
export const GEMINI_THOUGHT_SIGNATURE_SOURCE_KEY = "__geminiThoughtSignatureSource";

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
		if (key === "enum" && Array.isArray(value) && !value.every((v) => typeof v === "string")) {
			continue;
		}
		if (key === "const") {
			// Gemini's enum field accepts strings only; retain the type for other literals.
			if (typeof value === "string") output.enum = [value];
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
