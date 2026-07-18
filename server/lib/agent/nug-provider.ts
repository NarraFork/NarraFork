import type {
import { resolveProxyForUrl } from "../net/proxy";
import {
	getNugCachedModelHash,
	type ResolvedNugModelMeta,
	resolveNugModelMeta,
} from "../nug-model-cache";
import { applyNugModelCatalogUpdate } from "../nug-model-sync";
import { getToolMessage, type Locale } from "../prompt-i18n";
import { shouldUseNativeSearch } from "../search/native";
import type { NUGProviderConfig } from "../settings";
import { settings } from "../settings";
import type { UsageData } from "../usage-tracking";
import { AnthropicProvider } from "./anthropic-provider";
import { fetchWithNetworkDiagnostics } from "./diagnostic-fetch";
import { normalizeApiRequestDiagnostics, parseErrorDiagnostics } from "./error-diagnostics";
import {
	extractImageFileName,
	parseSSEStream,
import { buildNugDelegateBaseConfig } from "./nug-delegate-config";
import {
	BoundedConfirmedRefSet,
	type ConfirmedRefSet,
	type DedupResult,
	dedupAnthropicHistoryImages,
	dedupOpenAIHistoryImages,
	type ImagePayloadMap,
	isImageCacheMissError,
	restoreAnthropicHistoryImages,
	restoreOpenAIHistoryImages,
} from "./nug-image-dedup";
import { OpenAIProvider } from "./openai-provider";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import { DEFAULT_DUMP_MAX_BYTES, sanitizeHeaders } from "./request-dump";
import { resolveModel } from "./resolve-model";
import { ensureNonEmptySchema, resolveToolJsonSchema } from "./tool-registry";
import {
	type AgentToolUse,
	ApiError,
	type ApiRequestDiagnostics,
	type ResolvedToolDefinition,
} from "./types";

/** Create an API error with bounded diagnostics for retry detection and persistence. */
function httpError(message: string, status: number, diagnostics?: ApiRequestDiagnostics): Error {
	return new ApiError(status, message, diagnostics);
}

function nugResponseDiagnostics(
	response: Response,
	bodyText: string,
	defaults: Partial<ApiRequestDiagnostics> = {},
): ApiRequestDiagnostics | undefined {
	let payload: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(bodyText);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			payload = parsed as Record<string, unknown>;
		}
	} catch {
		// Non-JSON upstream bodies are retained only as a bounded snippet below.
	}
	const parsed = parseErrorDiagnostics(payload, {
		source: "gateway",
		phase: "http_response",
		statusCode: response.status,
		requestId: response.headers.get("x-request-id") ?? undefined,
		responseHeaders: sanitizeHeaders(response.headers),
		responseSnippet: bodyText,
		transport: "http",
		...defaults,
	});
	return (
		parsed ??
		normalizeApiRequestDiagnostics({
			source: "gateway",
			phase: "http_response",
			statusCode: response.status,
			requestId: response.headers.get("x-request-id") ?? undefined,
			responseHeaders: sanitizeHeaders(response.headers),
			responseSnippet: bodyText,
			transport: "http",
			...defaults,
		})
	);
}

/**
 * Image refs the NUG gateway has confirmed are cached, keyed by gateway identity
 * (baseUrl + apiKey). Shared across NugProvider instances in this process so the
 * confirmation survives the per-request provider re-creation done by
 * resolveProviderAndModel(). A ref is only added after the gateway emits an
 * `imageCacheAckEvent`, and is dropped on a cache miss so the next request resends
 * the image inline.
 */
const confirmedImageRefsByGateway = new Map<string, ConfirmedRefSet>();

function confirmedRefSetFor(key: string): ConfirmedRefSet {
	let set = confirmedImageRefsByGateway.get(key);
	if (!set) {
		set = new BoundedConfirmedRefSet(MAX_CONFIRMED_IMAGE_REFS_PER_GATEWAY);
		confirmedImageRefsByGateway.set(key, set);
	}
	return set;
}

function toUsageData(usage: ParsedStreamEvent["usage"]): UsageData | undefined {
	if (!usage) return undefined;
	return {
		inputTokens: usage.inputTokens ?? usage.promptTokens ?? 0,
		outputTokens: usage.completionTokens ?? 0,
		cachedInputTokens: usage.cachedInputTokens ?? 0,
		cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
		cacheCreation5mInputTokens: usage.cacheCreation5mTokens ?? 0,
		cacheCreation1hInputTokens: usage.cacheCreation1hTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0,
	};
}

export interface NugUsageEvent {
	id: string;
	channelType: string;
	model: string;
	meterUsage: number;
	quotaCost: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
	status: string;
	createdAt: string;
	[key: string]: unknown;
}

export interface NugUsageSummary {
	[key: string]: unknown;
}

// === NUG-specific API response types ===

export interface NugChannelHealthStatus {
	channelType: string;
	totalCredentials: number;
	availableCredentials: number;
	disabledCredentials: number;
	availabilityRate: number;
	currentConcurrency: number;
	maxConcurrency: number;
	queueDepth: number;
}

export interface NugQuota {
	balance: number;
	totalGranted: number;
	detailedQuotaBalance?: string | null;
	extra?: unknown;
}

export interface NugBillingProviderInfo {
	name: string;
	displayName: string;
}

export interface NugBillingOrder {
	id: string;
	user_id?: string;
	amount: string;
	quota_amount: string;
	provider: string;
	channel?: string;
	status: "pending" | "paid" | "failed" | "closed" | "refunded" | string;
	external_order_id?: string;
	pay_url?: string;
	paid_at?: string;
	refunded_at?: string;
	pay_channel?: number;
	created_at: string;
}

export interface NugBillingConfig {
	enabled: boolean;
	providers: NugBillingProviderInfo[];
	unitName: string;
	quotaRate: number;
	channelQuotaRates?: { alipay?: number; wechat?: number };
	orderMinAmount: number;
	orderMaxAmount: number;
	balance: number;
	totalGranted: number;
	pollIntervalMs?: number;
}

export interface NugBillingOrderResponse {
	order: NugBillingOrder;
	pollIntervalMs?: number;
}

const NUG_MODEL_HASH_HEADER = "X-NUG-Model-Hash";
const NUG_UNKNOWN_MODEL_HASH = "none";
const MAX_CONFIRMED_IMAGE_REFS_PER_GATEWAY = 4096;

/**
 * NUG (Narrafork Unified Gateway) provider adapter.
 *
 * unified /v1/chat endpoint or channel-specific endpoints.
 *
 */
export class NugProvider implements ProviderAdapter {
	private config: NUGProviderConfig;
	private activeMeta: ResolvedNugModelMeta | null = null;
	private activeDelegate: ProviderAdapter | null = null;

	constructor(config: NUGProviderConfig) {
		this.config = config;
	}

	/**
	 * Proxy-aware fetch. Resolves the proxy per target URL honouring this
	 * provider's own proxy override (absent/"default" → global policy); local
	 * gateways (127.0.0.1) are auto-exempted via loopback/NO_PROXY, remote NUG
	 * hosts go through it.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const target = input instanceof Request ? input.url : input;
		const proxy = resolveProxyForUrl(target, this.config.proxy);
		return fetchWithNetworkDiagnostics(input, init, { proxy });
	}

	/**
	 * delegate handles the request (anthropic/openai/codex/responses) it uses native
	 * tool-use fields, so leak diagnostics/recovery are unnecessary there.
	 */
	get mayLeakXmlToolCalls(): boolean {
		return this.activeDelegate == null;
	}

	private get baseUrl(): string {
		return this.config.baseUrl
			.trim()
			.replace(/\/+$/, "")
			.replace(/\/(?:api\/v1|api|v1)$/i, "");
	}

	private modelHashHeaderValue(): string {
		return getNugCachedModelHash(this.config.id) ?? NUG_UNKNOWN_MODEL_HASH;
	}

	private modelHashHeaders(): Record<string, string> {
		return { [NUG_MODEL_HASH_HEADER]: this.modelHashHeaderValue() };
	}

	private chatHeaders(conversationId?: string, effort?: string): Record<string, string> {
		const h: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.config.apiKey}`,
			Accept: "text/event-stream",
			...this.modelHashHeaders(),
		};
		if (conversationId) {
			h["X-Conversation-ID"] = conversationId;
		}
		// additionalModelRequestFields based on this and the model's effort schema.
		// Mirror the Go backend's whitelist so only valid effort levels are sent.
		}
		return h;
	}

	private resolveMeta(model: string): ResolvedNugModelMeta {
		return resolveNugModelMeta(this.config.id, this.config.prefix, model);
	}

	private modelForDelegate(meta: ResolvedNugModelMeta): string {
		return `${this.config.prefix}:${meta.routedModel}`;
	}

	prepareForModel(model: string): void {
		const meta = this.resolveMeta(model);
		this.activeMeta = meta;
		this.activeDelegate = this.createDelegate(meta);
	}

	private createDelegate(meta: ResolvedNugModelMeta): ProviderAdapter | null {
		const extraHeaders = this.modelHashHeaders();
		const delegateBase = buildNugDelegateBaseConfig(this.config, meta, extraHeaders);
		switch (meta.channelType) {
			case "codex":
				return new OpenAIProvider({
					...delegateBase,
					baseUrl: `${this.baseUrl}/v1`,
					apiMode: "codex",
					codexWebSocket: false,
					// Force Codex CLI header emulation on the NUG codex channel so it
					// always presents the codex_cli_rs originator + installation id.
					emulateCodexHeaders: true,
				});
			case "openai":
				return new OpenAIProvider({
					...delegateBase,
					baseUrl: `${this.baseUrl}/v1`,
					apiMode: "completions",
				});
			case "responses":
				return new OpenAIProvider({
					...delegateBase,
					baseUrl: `${this.baseUrl}/v1`,
					apiMode: "responses",
				});
			case "anthropic": {
				const delegate = new AnthropicProvider({
					...delegateBase,
					baseUrl: `${this.baseUrl}/v1/anthropic`,
					officialApi: false,
				});
				// Tag thinking signatures with the NUG channel identity (e.g.
				// `nug:anthropic`) so they are not confused with a direct
				// anthropic upstream or another NUG channel.
				delegate.setReasoningSourceOverride(this.reasoningSourceForMeta(meta));
				return delegate;
			}
			default:
				return null;
		}
	}

	/**
	 * Stable `provider:channel` identity for the upstream that mints thinking
	 * and the `anthropic` delegate) produce signatures; other channels
	 * (codex/openai/responses) return `undefined`.
	 */
	private reasoningSourceForMeta(meta: ResolvedNugModelMeta): string | undefined {
			return `${this.config.prefix}:${meta.channel}`;
		}
		return undefined;
	}

	private ensureDelegateForModel(model: string): ProviderAdapter | null {
		const meta = this.resolveMeta(model);
		if (this.activeMeta?.routedModel === meta.routedModel) return this.activeDelegate;
		this.activeMeta = meta;
		this.activeDelegate = this.createDelegate(meta);
		return this.activeDelegate;
	}

	private consumeModelCatalogEvent(event: ParsedStreamEvent): boolean {
		const catalog = event.nugModelCatalog;
		if (!catalog) return false;
		applyNugModelCatalogUpdate(this.config, catalog.models, catalog.modelHash);
		return true;
	}

	/** Stable key identifying this gateway for the shared confirmed-ref cache. */
	private get gatewayKey(): string {
		return `${this.baseUrl}\u0000${this.config.apiKey}`;
	}

	/** The set of image refs this gateway has confirmed are cached. */
	private get confirmedImageRefs(): ConfirmedRefSet {
		return confirmedRefSetFor(this.gatewayKey);
	}

	/**
	 * Record gateway image-cache acknowledgements. Returns true if the event was an
	 * ack (and should not be forwarded to the agent loop).
	 */
	private consumeImageCacheAckEvent(event: ParsedStreamEvent): boolean {
		const ack = event.nugImageCacheAck;
		if (!ack) return false;
		const confirmed = this.confirmedImageRefs;
		for (const ref of ack.refs) confirmed.add(ref);
		return true;
	}

	private async *filterModelCatalogEvents(
		stream: AsyncIterable<ParsedStreamEvent>,
	): AsyncGenerator<ParsedStreamEvent> {
		for await (const event of stream) {
			if (this.consumeModelCatalogEvent(event)) continue;
			if (this.consumeImageCacheAckEvent(event)) continue;
			yield event;
		}
	}

	// === ProviderAdapter interface ===

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		if (this.activeDelegate) {
			const effectiveTools =
				this.activeMeta?.channelType === "codex" &&
				shouldUseNativeSearch(this.config.prefix, this.activeMeta.routedModel)
					? tools.filter((tool) => tool.name !== "WebSearch")
					: tools;
			return this.activeDelegate.formatTools(effectiveTools);
		}
		return tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: { json: ensureNonEmptySchema(resolveToolJsonSchema(tool)) },
			},
		}));
	}

	async buildHistory(
		dbMessages: DbMessage[],
		model: string,
		narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		const meta = this.resolveMeta(model);
		this.activeMeta = meta;
		this.activeDelegate = this.createDelegate(meta);
		if (this.activeDelegate) {
			// Delegate carries its own reasoning-source (the anthropic delegate was
			// given the NUG channel override in createDelegate; others mint no
			// signatures), so no extra source plumbing is needed here.
			return this.activeDelegate.buildHistory(dbMessages, this.modelForDelegate(meta), narratorId);
		}
			dbMessages,
			meta.bareModel,
			narratorId,
			this.getActiveReasoningSource(),
		);
	}

	getActiveReasoningSource(): string | undefined {
		if (this.activeDelegate?.getActiveReasoningSource) {
			return this.activeDelegate.getActiveReasoningSource();
		}
		return this.activeMeta ? this.reasoningSourceForMeta(this.activeMeta) : undefined;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		model: string,
		locale?: string,
	): void {
		const delegate = this.ensureDelegateForModel(model);
		if (delegate && this.activeMeta) {
			delegate.injectSystemPrompt(
				history,
				systemPrompt,
				this.modelForDelegate(this.activeMeta),
				locale,
			);
			return;
		}
		const modelId = this.activeMeta?.bareModel ?? resolveModel(model);
		const ack = getToolMessage("systemPromptAck", (locale ?? "en") as Locale);
		h.unshift(
			{
					content: systemPrompt,
					modelId,
				},
			},
			{
					content: ack,
				},
			},
		);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const meta = this.resolveMeta(params.model);
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;

		// Image dedup: every history image is tagged with a content-hash `imageRef`.
		// Only images whose ref the gateway has already acknowledged as cached are
		// sent ref-only (payload stripped); all others keep their inline payload so
		// the gateway can cache them and emit an `imageCacheAckEvent` we record.
		//
		// The agent loop reuses this same history array across turns and retries,
		// so any stripped payload is restored once this attempt finishes (success,
		// failure, or early close) to avoid leaving the persistent history empty.
		//
		// The history shape depends on the channel: anthropic uses Messages-API
		const history = Array.isArray(params.history) ? params.history : undefined;
		const confirmed = this.confirmedImageRefs;
		const dedupHistory = (h: unknown[]): DedupResult => {
			if (meta.channelType === "anthropic") return dedupAnthropicHistoryImages(h, confirmed);
			if (delegate) return dedupOpenAIHistoryImages(h, confirmed);
		};
		const restoreHistory = (h: unknown[], p: ImagePayloadMap): void => {
			if (meta.channelType === "anthropic") restoreAnthropicHistoryImages(h, p);
			else if (delegate) restoreOpenAIHistoryImages(h, p);
		};
		const dedup: DedupResult | undefined = history ? dedupHistory(history) : undefined;
		let restored = false;
		const restore = (): void => {
			if (restored || !history || !dedup || dedup.stripped.size === 0) return;
			restored = true;
			restoreHistory(history, dedup.stripped);
		};

		const runOnce = (): AsyncGenerator<ParsedStreamEvent> =>
			delegate
				? this.filterModelCatalogEvents(
						delegate.chat({ ...params, model: this.modelForDelegate(meta) }),
					)

		let yielded = false;
		let cacheMiss = false;
		try {
			for await (const event of runOnce()) {
				yielded = true;
				yield event;
			}
			return;
		} catch (err) {
			// A cache miss can only occur before any stream event (the gateway
			// rejects during body resolution). If we already streamed events, or
			// nothing was stripped, propagate the error.
			if (yielded || !dedup || dedup.stripped.size === 0 || !isImageCacheMissError(err)) {
				throw err;
			}
			// The gateway no longer has these payloads: forget the confirmation so
			// future turns resend them inline, restore the originals, and retry once.
			for (const ref of dedup.stripped.keys()) confirmed.delete(ref);
			cacheMiss = true;
		} finally {
			// Always restore stripped payloads so the reused history keeps full bytes.
			restore();
		}

		if (!cacheMiss) return;

		// Retry once with full inline payloads restored.
		yield* runOnce();
	}

		params: ChatParams,
		meta: ResolvedNugModelMeta,
	): AsyncGenerator<ParsedStreamEvent> {
		);

		const body = { model: meta.routedModel, ...request };
		const headers = this.chatHeaders(conversationId, params.reasoningEffort);
		params.requestDump?.setRequest({
			transport: "http",
			headers: sanitizeHeaders(headers),
			body,
		});

		const bodyText = JSON.stringify(body);
		params.onRequestStart?.();
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
			throw httpError(
				`NUG chat error ${response.status}: ${errText}`,
				response.status,
				nugResponseDiagnostics(response, errText, {
					model: meta.routedModel,
				}),
			);
		}

		if (!response.body) {
			throw httpError(
				"NUG returned no response body",
				502,
				nugResponseDiagnostics(response, "NUG returned no response body", {
					phase: "response_body",
					statusCode: 502,
					model: meta.routedModel,
				}),
			);
		}

		yield* parseSSEStream(response.body, {
			parseTextToolCalls: params.tools.length > 0,
			model: meta.bareModel,
		});
		if (responseTextPromise) {
			params.requestDump?.setResponseBodyTextWithLimit(
				await responseTextPromise,
				settings.agent?.requestDumpMaxSize ?? DEFAULT_DUMP_MAX_BYTES,
			);
		}
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
		toolName?: string,
	): unknown {
		if (this.activeDelegate) {
			return this.activeDelegate.formatToolResult(toolUseId, output, isError, images, toolName);
		}
			toolUseId,
			content: [{ text: output }],
			status: isError ? "error" : "success",
			isError,
		};
		if (images?.length) {
			result._images = images.map((img) => ({
				source: { bytes: img.base64 },
			}));
			result._imageLabel = extractImageFileName(output) ?? "image";
		}
		return result;
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const delegate = this.ensureDelegateForModel(model);
		if (delegate && this.activeMeta) {
			delegate.pushUserTurn(
				history,
				content,
				this.modelForDelegate(this.activeMeta),
				toolResults,
				images,
			);
			return;
		}
		const modelId = this.activeMeta?.bareModel ?? resolveModel(model);
			source: { bytes: img.base64 },
		}));

				content,
				modelId,
			},
		};
		h.push(userMsg);
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
		webSearches?: Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
		}>,
		messageId?: string,
		imageGenerations?: Array<{
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
		if (this.activeDelegate) {
			this.activeDelegate.pushAssistantTurn(
				history,
				text,
				toolUses,
				reasoningBlocks,
				webSearches,
				messageId,
				imageGenerations,
				textOutputIndex,
				redactedThinkingBlocks,
			);
			return;
		}
		// not camelCase "reasoningContent".
			reasoningBlocks,
			redactedThinkingBlocks,
			this.getActiveReasoningSource(),
		);
				content: text || "",
				...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
				...(toolUses.length > 0
					? {
							toolUses: toolUses.map((tu) => ({
								toolUseId: tu.toolUseId,
								name: tu.name,
								input: tu.input,
							})),
						}
					: {}),
			},
		};
		h.push(assistantMsg);
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
		const meta = this.resolveMeta(model);
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;
		if (delegate) {
			return delegate.generateWithMeta(
				text,
				this.modelForDelegate(meta),
				systemInstruction,
				options,
			);
		}
		const modelId = meta.bareModel;
				conversationId: crypto.randomUUID(),
				...(systemInstruction
					? {
							history: [
								{
										content: systemInstruction,
										modelId,
									},
								},
								{
										content: "Understood.",
									},
								},
						}
					: {}),
				currentMessage: {
						content: text,
						modelId,
					},
				},
			},
		};

		const body = { model: meta.routedModel, ...request };
			method: "POST",
			body: JSON.stringify(body),
			signal: options?.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG generate error ${response.status}: ${errText}`, response.status);
		}

		const chunks: string[] = [];
		let contextPercent: number | undefined;
		let usage: UsageData | undefined;
		let credentialId: string | undefined;
		let meterUsage: number | undefined;
		let meterUnit: string | undefined;

		if (response.body) {
			for await (const evt of parseSSEStream(response.body)) {
				if (this.consumeModelCatalogEvent(evt)) continue;
				if (evt.text != null) {
					chunks.push(evt.text);
					await options?.onTextDelta?.(evt.text);
				}
				if (evt.contextUsagePercentage != null) contextPercent = evt.contextUsagePercentage;
				if (evt.usage) usage = toUsageData(evt.usage);
				if (evt.credentialId) credentialId = evt.credentialId;
				if (evt.metering) {
					meterUsage = evt.metering.usage;
					meterUnit = evt.metering.unit;
				}
			}
		}

		return { text: chunks.join(""), contextPercent, usage, credentialId, meterUsage, meterUnit };
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
		const meta = this.resolveMeta(model);
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;
		if (delegate?.generateWithHistoryWithMeta) {
			return delegate.generateWithHistoryWithMeta(
				systemInstruction,
				content,
				this.modelForDelegate(meta),
				locale,
				options,
			);
		}
		if (delegate) {
			return {
				text: await delegate.generateWithHistory(
					systemInstruction,
					content,
					this.modelForDelegate(meta),
					locale,
					options,
				),
			};
		}
		const modelId = meta.bareModel;
		const ack = getToolMessage("titleAck", (locale ?? "en") as Locale);
		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);

				conversationId: crypto.randomUUID(),
				history: [
					{
							content: systemInstruction,
							modelId,
						},
					},
					{
							content: ack,
						},
					},
				currentMessage: {
						content: `${reminder}\n\n${content}`,
						modelId,
					},
				},
			},
		};

		const body = { model: meta.routedModel, ...request };
			method: "POST",
			body: JSON.stringify(body),
			signal: options?.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(
				`NUG generateWithHistory error ${response.status}: ${errText}`,
				response.status,
			);
		}

		const chunks: string[] = [];
		let contextPercent: number | undefined;
		let usage: UsageData | undefined;
		let credentialId: string | undefined;
		let meterUsage: number | undefined;
		let meterUnit: string | undefined;
		if (response.body) {
			for await (const evt of parseSSEStream(response.body)) {
				if (this.consumeModelCatalogEvent(evt)) continue;
				if (evt.text != null) {
					chunks.push(evt.text);
					await options?.onTextDelta?.(evt.text);
				}
				if (evt.contextUsagePercentage != null) contextPercent = evt.contextUsagePercentage;
				if (evt.usage) usage = toUsageData(evt.usage);
				if (evt.credentialId) credentialId = evt.credentialId;
				if (evt.metering) {
					meterUsage = evt.metering.usage;
					meterUnit = evt.metering.unit;
				}
			}
		}

		return { text: chunks.join(""), contextPercent, usage, credentialId, meterUsage, meterUnit };
	}

	// === NUG-specific methods (for frontend proxy routes) ===

	async getChannelsHealth(): Promise<{ channels: NugChannelHealthStatus[] }> {
		const response = await this.pfetch(`${this.baseUrl}/v1/channels/health`, {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG channels/health error ${response.status}: ${errText}`, response.status);
		}
		return (await response.json()) as { channels: NugChannelHealthStatus[] };
	}

	async getQuota(): Promise<NugQuota> {
		const response = await this.pfetch(`${this.baseUrl}/v1/quota`, {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG quota error ${response.status}: ${errText}`, response.status);
		}
		return (await response.json()) as NugQuota;
	}

	async getBillingConfig(): Promise<NugBillingConfig> {
		const response = await this.pfetch(`${this.baseUrl}/v1/billing/config`, {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG billing config error ${response.status}: ${errText}`, response.status);
		}
		return (await response.json()) as NugBillingConfig;
	}

	async createBillingOrder(body: {
		amount: number;
		provider: string;
		channel?: "alipay" | "wechat" | string;
	}): Promise<NugBillingOrderResponse> {
		const response = await this.pfetch(`${this.baseUrl}/v1/billing/orders`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.apiKey}`,
				...this.modelHashHeaders(),
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(
				`NUG billing order create error ${response.status}: ${errText}`,
				response.status,
			);
		}
		return (await response.json()) as NugBillingOrderResponse;
	}

	async getBillingOrder(orderId: string): Promise<NugBillingOrderResponse> {
		const response = await this.pfetch(
			`${this.baseUrl}/v1/billing/orders/${encodeURIComponent(orderId)}`,
			{
				headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
			},
		);
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG billing order error ${response.status}: ${errText}`, response.status);
		}
		return (await response.json()) as NugBillingOrderResponse;
	}

	async repayBillingOrder(orderId: string): Promise<NugBillingOrderResponse> {
		const response = await this.pfetch(
			`${this.baseUrl}/v1/billing/orders/${encodeURIComponent(orderId)}/repay`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
			},
		);
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(
				`NUG billing order repay error ${response.status}: ${errText}`,
				response.status,
			);
		}
		return (await response.json()) as NugBillingOrderResponse;
	}

	async getUsage(
		limit = 50,
		offset = 0,
		period?: string,
	): Promise<{ events: NugUsageEvent[]; total: number }> {
		const url = new URL(`${this.baseUrl}/v1/usage`);
		url.searchParams.set("limit", String(limit));
		url.searchParams.set("offset", String(offset));
		if (period) url.searchParams.set("period", period);
		const response = await this.pfetch(url.toString(), {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG usage error ${response.status}: ${errText}`, response.status);
		}
		return (await response.json()) as { events: NugUsageEvent[]; total: number };
	}

	async getUsageSummary(period?: string): Promise<NugUsageSummary> {
		const url = new URL(`${this.baseUrl}/v1/usage/summary`);
		if (period) url.searchParams.set("period", period);
		const response = await this.pfetch(url.toString(), {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG usage/summary error ${response.status}: ${errText}`, response.status);
		}
		return (await response.json()) as NugUsageSummary;
	}

	async getModels(): Promise<{
		models: Array<Record<string, unknown>>;
		modelHash?: string;
		hash?: string;
		usdRate?: number;
	}> {
		const response = await this.pfetch(`${this.baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw httpError(`NUG models error ${response.status}: ${errText}`, response.status);
		}
		const data = (await response.json()) as {
			models?: Array<Record<string, unknown>>;
			modelHash?: string;
			hash?: string;
			usdRate?: number;
		};
		const headerHash = response.headers.get("X-NUG-Model-Hash")?.trim();
		if (!data.modelHash && headerHash) {
			data.modelHash = headerHash;
		}
		if (!data.hash && data.modelHash) {
			data.hash = data.modelHash;
		}
		const usdRate = typeof data.usdRate === "number" ? data.usdRate : undefined;
		return { models: data.models ?? [], modelHash: data.modelHash, hash: data.hash, usdRate };
	}
}
