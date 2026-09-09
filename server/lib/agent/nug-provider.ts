import { resolveProxyForUrl } from "../net/proxy";
import {
	getNugCachedModelHash,
	type ResolvedNugModelMeta,
	resolveNugModelMeta,
	setNugCachedCapabilities,
} from "../nug-model-cache";
import { applyNugModelCatalogUpdate } from "../nug-model-sync";
import { shouldUseNativeSearch } from "../search/native";
import type { NUGProviderConfig } from "../settings";

import { AnthropicProvider } from "./anthropic-provider";
import { fetchWithNetworkDiagnostics } from "./diagnostic-fetch";

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
	/** Channel instance name; several instances may share one channelType. */
	channel?: string;
	channelType: string;
	healthy?: boolean;
	availabilityRate: number;
	totalCredentials?: number;
	availableCredentials?: number;
	disabledCredentials?: number;
	currentConcurrency?: number;
	maxConcurrency?: number;
	queueDepth?: number;
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
 * Communicates with a remote NUG service. For each supported channel type
 * (anthropic, openai, codex, responses), creates a typed delegate that handles
 * request building, history formatting, and SSE parsing.
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
	 * All NUG channels use typed delegates with native tool-use fields, so XML
	 * tool call leakage does not occur.
	 */
	get mayLeakXmlToolCalls(): boolean {
		return false;
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

	private resolveMeta(model: string): ResolvedNugModelMeta {
		return resolveNugModelMeta(this.config.id, this.config.prefix, model);
	}

	private modelForDelegate(meta: ResolvedNugModelMeta): string {
		return `${this.config.prefix}:${meta.routedModel}`;
	}

	prepareForModel(model: string): void {
		const meta = this.resolveMeta(model);
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;
	}

	private createDelegate(meta: ResolvedNugModelMeta): ProviderAdapter {
		const extraHeaders = this.modelHashHeaders();
		const delegateBase = buildNugDelegateBaseConfig(this.config, meta, extraHeaders);
		switch (meta.channelType) {
			case "codex":
			case "openai":
			case "responses": {
				// All three channels carry OpenAI-shaped reasoning credentials
				// (`encrypted_content`), which are only replayable against the same
				// gateway channel — tag them with the NUG channel identity instead of
				// the delegate's own prefix.
				const delegate = new OpenAIProvider({
					...delegateBase,
					baseUrl: `${this.baseUrl}/v1`,
					apiMode:
						meta.channelType === "codex"
							? "codex"
							: meta.channelType === "responses"
								? "responses"
								: "completions",
					...(meta.channelType === "codex"
						? {
								codexWebSocket: false,
								// apiMode codex already presents the codex-tui originator,
								// installation id and the stable codex body contract.
							}
						: {}),
				});
				delegate.setReasoningSourceOverride(this.reasoningSourceForMeta(meta));
				// The delegate is created per model, so the target is known here — the
				// synchronous pushAssistantTurn can classify reasoning (strict vs
				// relay) without waiting for a chat() run to note it.
				delegate.noteActiveModel(this.modelForDelegate(meta));
				return delegate;
			}
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
				throw new Error(
					`NUG protocol configuration error: unsupported channelType ${JSON.stringify(meta.channelType)} for model ${JSON.stringify(meta.routedModel)}. Refresh the model catalog and check gateway/client protocol compatibility.`,
				);
		}
	}

	/**
	 * Stable `provider:channel` identity for the upstream that mints reasoning
	 * credentials on this channel — Anthropic thinking `signature`s on the
	 * anthropic-family channels, OpenAI `encrypted_content` on
	 * codex/openai/responses. Credentials are only valid against the channel
	 * that produced them, so every credential-producing channel reports its
	 * identity. (Channels that mint no credentials would also be covered by the
	 * generic template, but no such channelType exists today.)
	 */
	private reasoningSourceForMeta(meta: ResolvedNugModelMeta): string | undefined {
		if (
			meta.channelType === "anthropic" ||
			meta.channelType === "codex" ||
			meta.channelType === "openai" ||
			meta.channelType === "responses"
		) {
			return `${this.config.prefix}:${meta.channel}`;
		}
		return undefined;
	}

	private ensureDelegateForModel(model: string): ProviderAdapter {
		const meta = this.resolveMeta(model);
		if (
			this.activeDelegate &&
			this.activeMeta?.routedModel === meta.routedModel &&
			this.activeMeta.channelType === meta.channelType &&
			this.activeMeta.channel === meta.channel
		) {
			return this.activeDelegate;
		}
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;
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
		// Unreachable: all supported channel types create a delegate.
		return tools;
	}

	async buildHistory(
		dbMessages: DbMessage[],
		model: string,
		narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		const meta = this.resolveMeta(model);
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;
		// Delegates carry their own reasoning-source override (assigned in
		// createDelegate: anthropic-family → thinking signatures, codex/openai/
		// responses → encrypted_content), so no extra source plumbing is needed
		// here.
		return delegate.buildHistory(dbMessages, this.modelForDelegate(meta), narratorId);
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
		if (this.activeMeta) {
			delegate.injectSystemPrompt(
				history,
				systemPrompt,
				this.modelForDelegate(this.activeMeta),
				locale,
			);
		}
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
		// The history shape depends on the delegate: anthropic uses Messages-API
		// image parts, codex/openai use OpenAI image parts. Dispatching on the
		// delegate type ensures the dedup walker matches the actual shape.
		const history = Array.isArray(params.history) ? params.history : undefined;
		const confirmed = this.confirmedImageRefs;
		const usesAnthropicHistory = delegate instanceof AnthropicProvider;
		const dedupHistory = (h: unknown[]): DedupResult => {
			if (usesAnthropicHistory) return dedupAnthropicHistoryImages(h, confirmed);
			return dedupOpenAIHistoryImages(h, confirmed);
		};
		const restoreHistory = (h: unknown[], p: ImagePayloadMap): void => {
			if (usesAnthropicHistory) restoreAnthropicHistoryImages(h, p);
			else restoreOpenAIHistoryImages(h, p);
		};
		const dedup: DedupResult | undefined = history ? dedupHistory(history) : undefined;
		let restored = false;
		const restore = (): void => {
			if (restored || !history || !dedup || dedup.stripped.size === 0) return;
			restored = true;
			restoreHistory(history, dedup.stripped);
		};

		const runOnce = (): AsyncGenerator<ParsedStreamEvent> =>
			this.filterModelCatalogEvents(
				delegate.chat({ ...params, model: this.modelForDelegate(meta) }),
			);

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
		// Unreachable: all supported channel types create a delegate.
		return { toolUseId, content: [{ text: output }], isError };
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const delegate = this.ensureDelegateForModel(model);
		if (this.activeMeta) {
			delegate.pushUserTurn(
				history,
				content,
				this.modelForDelegate(this.activeMeta),
				toolResults,
				images,
			);
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
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const meta = this.resolveMeta(model);
		const delegate = this.createDelegate(meta);
		this.activeMeta = meta;
		this.activeDelegate = delegate;
		return delegate.generateWithMeta(text, this.modelForDelegate(meta), systemInstruction, options);
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
		if (delegate.generateWithHistoryWithMeta) {
			return delegate.generateWithHistoryWithMeta(
				systemInstruction,
				content,
				this.modelForDelegate(meta),
				locale,
				options,
			);
		}
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

	/**
	 * Fetch the gateway's model catalog.
	 *
	 * `signal` is optional so existing callers keep their current (unbounded)
	 * behaviour; opportunistic callers that run on a user interaction pass a
	 * timeout signal so a hung gateway cannot stall them.
	 */
	async getModels(options?: { signal?: AbortSignal }): Promise<{
		models: Array<Record<string, unknown>>;
		modelHash?: string;
		hash?: string;
		usdRate?: number;
		capabilities?: string[];
	}> {
		const response = await this.pfetch(`${this.baseUrl}/v1/models`, {
			headers: { Authorization: `Bearer ${this.config.apiKey}`, ...this.modelHashHeaders() },
			...(options?.signal ? { signal: options.signal } : {}),
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
			capabilities?: unknown;
		};
		const headerHash = response.headers.get("X-NUG-Model-Hash")?.trim();
		if (!data.modelHash && headerHash) {
			data.modelHash = headerHash;
		}
		if (!data.hash && data.modelHash) {
			data.hash = data.modelHash;
		}
		const usdRate = typeof data.usdRate === "number" ? data.usdRate : undefined;
		// Recorded on every catalog fetch, including when the field is absent: that
		// clears a stale advertisement, which is what makes a rolled-back gateway
		// stop being treated as capable.
		const capabilities = setNugCachedCapabilities(this.config.id, data.capabilities);
		return {
			models: data.models ?? [],
			modelHash: data.modelHash,
			hash: data.hash,
			usdRate,
			...(capabilities ? { capabilities } : {}),
		};
	}
}
