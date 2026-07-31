import type {
	AgentSideCar,
	AgentSideCarTarget,
	AgentToolUse,
	ApiRequestDiagnosticSource,
	ApiRequestDiagnostics,
	BuiltHistory,
	DbMessage,
	DbSideCar,
	DbToolCall,
	ParsedStreamEvent,
	ReasoningProviderMetadata,
	WebSearchAction,
import {
	FOLLOW_DEFAULT_MODEL,
	getAnthropicProviderConfig,
	getClineProviderConfig,
	getGeminiProviderConfig,
	getNugProviderConfig,
	getOpenaiProviderConfig,
	parseModelId,
	resolveEffectiveModel,
	resolveProvider,
	settings,
} from "../settings";
import type { UsageData } from "../usage-tracking";
import { AnthropicProvider } from "./anthropic-provider";
import { ClineProvider } from "./cline-provider";
import { CodexProvider } from "./codex-provider";
import { GeminiInteractionsProvider } from "./gemini-interactions-provider";
import { GeminiProvider } from "./gemini-provider";
import { NugProvider } from "./nug-provider";
import { OpenAIProvider } from "./openai-provider";
import type { ApiRequestDumpCollector } from "./request-dump";

}

// === Provider stream protocol types ===
//
// layer and bundled plugin code can use them without importing anything under
// `server/`. Re-exported here to keep existing host import paths working.

export type {
	AgentSideCar,
	AgentSideCarTarget,
	AgentToolUse,
	ApiRequestDiagnosticSource,
	ApiRequestDiagnostics,
	BuiltHistory,
	DbMessage,
	DbSideCar,
	DbToolCall,
	ParsedStreamEvent,
	ReasoningProviderMetadata,
	WebSearchAction,
};

// === Chat parameters passed to provider.chat() ===

/**
 * Full host-side chat parameters.
 *
 * the host runtime concerns — abort signal, request dump collector, callbacks —
 * that the shared request builder never reads. Keeping the `extends` explicit
 * means the shared subset cannot drift away from what the host actually passes.
 */
export interface ChatParams extends ProtocolChatParams {
	signal: AbortSignal;
	/**
	 * Sticky session key for provider-side account affinity.
	 * For narrator loops this is narratorId.
	 */
	stickySessionKey?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Service tier for Codex-mode providers — "priority" enables fast mode */
	serviceTier?: string;
	/** Metadata to include in the request body (e.g. user_id for Anthropic) */
	metadata?: { user_id: string };
	/** Optional collector for persisting raw provider request/response dumps. */
	requestDump?: ApiRequestDumpCollector;
	/**
	 * Reset any reusable upstream transport state before this request. Used when the
	 * agent loop rebuilt history (e.g. after compact) so WebSocket/previous-response
	 * chains do not continue from stale context.
	 */
	resetUpstreamSession?: boolean;
	/**
	 * Called after the provider has successfully assembled a concrete request and is
	 * about to hand it to the upstream transport.  The agent loop uses this marker
	 * to distinguish a real empty upstream response from local request preparation
	 * paths that completed without ever contacting the API.
	 */
	onRequestStart?: (info?: { credentialId?: string }) => void;
}

export interface GenerateOptions {
	/** Optional reasoning/thinking effort for lightweight generation helpers. */
	reasoningEffort?: ChatParams["reasoningEffort"];
	/** Optional provider output-token ceiling for lightweight generation helpers. */
	maxOutputTokens?: number;
	/** Optional abort signal to cancel the underlying upstream request. */
	signal?: AbortSignal;
	/**
	 * Receives each visible text delta while the lightweight generation is streaming.
	 * Only the new delta is passed so callers can count or coalesce output without
	 * repeatedly copying the full accumulated response. Callers should keep this
	 * callback lightweight and throttle any WebSocket or persistence work.
	 */
	onTextDelta?: (delta: string) => void | Promise<void>;
	/**
	 * Receives each reasoning/thinking delta while the lightweight generation is
	 * streaming — the counterpart of {@link onTextDelta} for the model's private
	 * thinking channel. Used to show a "thinking · N chars" phase before any
	 * visible output exists (see `@shared/progress-phase`).
	 *
	 * Providers that never surface reasoning on their generate path simply never
	 * call this, which degrades to the previous output-only behaviour. Same
	 * contract as `onTextDelta`: deltas only, keep it lightweight.
	 */
	onReasoningDelta?: (delta: string) => void | Promise<void>;
}

export interface GenerateMetaResult {
	text: string;
	contextPercent?: number;
	usage?: UsageData | null;
	credentialId?: string;
	meterUsage?: number;
	meterUnit?: string;
}

// === The adapter interface ===

export interface ProviderAdapter {
	/** Convert ToolDefinition[] to provider-specific tool format */
	formatTools(tools: import("./types").ResolvedToolDefinition[]): unknown[];

	/**
	 * True when this provider can leak XML tool calls (`<invoke>...</invoke>`) into the
	 * agent loop uses this to always collect a bounded raw dump so leaked-tool diagnostics
	 * have downloadable SSE data, and to run the post-turn stateless recovery safety net.
	 */
	mayLeakXmlToolCalls?: boolean;

	/** Convert DB messages to provider history + trailing tool results */
	buildHistory(dbMessages: DbMessage[], model: string, narratorId?: string): Promise<BuiltHistory>;

	/**
	 * Stable identity ("provider:channel") of the upstream this provider is
	 * currently routed to, used to gate thinking-signature replay across
	 * servers. Returns `undefined` for providers that never mint Anthropic-style
	 * signatures (openai/codex/cline) — such blocks carry no signature so there
	 * is nothing to gate. For NUG this reflects the active channel (e.g.
	 * `prepareForModel`/`buildHistory` has resolved the model.
	 */
	getActiveReasoningSource?(): string | undefined;

	/** Inject system prompt into the history array (mutates in place) */
	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		model: string,
		locale?: string,
	): void;

	/** Stream a chat completion, yielding parsed events */
	chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent>;

	/** Format a single tool result for the provider protocol */
	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
		/** Real tool name for protocols (e.g. Gemini Interactions) that echo it with results. */
		toolName?: string,
	): unknown;

	/** Append a user turn to history (mutates in place) */
	pushUserTurn(
		history: unknown[],
		content: string,
		model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void;

	/** Append an assistant turn to history (mutates in place) */
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
			action?: WebSearchAction;
		}>,
		messageId?: string,
		imageGenerations?: Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
		}>,
		/** Provider-native content block index for the text block (for interleaved ordering). */
		textOutputIndex?: number,
		/** Anthropic redacted thinking blocks to preserve during a tool-use trajectory. */
		redactedThinkingBlocks?: Array<{
			data: string;
			outputIndex?: number;
			signatureSource?: string;
		}>,
	): void;

	/** Simple text generation — no tools, no loop. Returns generated text. */
	generate(text: string, model: string): Promise<string>;

	/**
	 * Like generate() but also returns contextUsagePercentage if available.
	 * `systemInstruction` is optional and lets providers with a native system/developer
	 * channel place instructions outside the user text.
	 */
	generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult>;

	/**
	 * Generate text using a history-based conversation (system instruction + user content).
	 * Used for title generation where we need to separate instruction from content.
	 */
	generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string>;

	/** Like generateWithHistory() but also returns usage and other request metadata if available. */
	generateWithHistoryWithMeta?(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult>;
}

// === Provider resolution ===

export function createGeminiProvider(
	config: import("../settings").GeminiProviderConfig,
): ProviderAdapter {
	return config.geminiTransport === "interactions"
		? new GeminiInteractionsProvider(config)
		: new GeminiProvider(config);
}

function createProviderByName(provider: string): ProviderAdapter | null {
	}
	if (provider === "codex") {
		return new CodexProvider({
			useWebSocket: settings.codex?.useWebSocket ?? true,
			useWebSearch: settings.codex?.useWebSearch ?? true,
			useImageGeneration: settings.codex?.useImageGeneration ?? true,
		});
	}

	const anthropicConfig = getAnthropicProviderConfig(provider);
	if (anthropicConfig) {
		return new AnthropicProvider(anthropicConfig);
	}

	const nugConfig = getNugProviderConfig(provider);
	if (nugConfig) {
		return new NugProvider(nugConfig);
	}

	const openaiConfig = getOpenaiProviderConfig(provider);
	if (openaiConfig) {
		return new OpenAIProvider(openaiConfig);
	}

	const clineConfig = getClineProviderConfig(provider);
	if (clineConfig) {
		return new ClineProvider(clineConfig);
	}

	const geminiConfig = getGeminiProviderConfig(provider);
	if (geminiConfig) {
		return createGeminiProvider(geminiConfig);
	}

	return null;
}

function isDefaultSentinel(model: string | undefined): boolean {
	if (!model) return false;
	const trimmed = model.trim();
	if (trimmed === FOLLOW_DEFAULT_MODEL) return true;
	const parsed = parseModelId(trimmed);
	return !!parsed.provider && parsed.model === FOLLOW_DEFAULT_MODEL;
}

function prefixProviderModel(provider: string, model: string | undefined): string | null {
	const trimmed = model?.trim();
	if (!trimmed || isDefaultSentinel(trimmed)) return null;
	return trimmed.includes(":") ? trimmed : `${provider}:${trimmed}`;
}

function defaultModelForProvider(provider: string): string | null {
	if (provider === "codex") {
		const custom = settings.agent.customModels ?? [];
		const codexCustom = custom.find((m) => m.provider === "codex")?.value;
		const normalized = prefixProviderModel("codex", codexCustom);
		return normalized ?? "codex:gpt-5.3-codex";
	}

	}

	const openaiDefault = prefixProviderModel(
		provider,
		getOpenaiProviderConfig(provider)?.defaultModel,
	);
	if (openaiDefault) return openaiDefault;

	const anthropicDefault = prefixProviderModel(
		provider,
		getAnthropicProviderConfig(provider)?.defaultModel,
	);
	if (anthropicDefault) return anthropicDefault;

	const nugDefault = prefixProviderModel(provider, getNugProviderConfig(provider)?.defaultModel);
	if (nugDefault) return nugDefault;

	const clineDefault = prefixProviderModel(
		provider,
		getClineProviderConfig(provider)?.defaultModel,
	);
	if (clineDefault) return clineDefault;

	const geminiDefault = prefixProviderModel(
		provider,
		getGeminiProviderConfig(provider)?.defaultModel,
	);
	if (geminiDefault) return geminiDefault;

	const custom = settings.agent.customModels ?? [];
	const providerCustom = custom.find((m) => m.provider === provider)?.value;
	if (providerCustom) {
		return prefixProviderModel(provider, providerCustom);
	}

	return null;
}

export interface ProviderResolution {
	requestedProvider: string;
	requestedModel: string;
	provider: string;
	adapter: ProviderAdapter;
	model: string;
}

export type ExternalProviderResolver = (
	requestedProvider: string,
	requestedModel: string,
) => ProviderAdapter | null | undefined;

let externalProviderResolver: ExternalProviderResolver | undefined;

/** Register the optional executable-plugin provider bridge without changing builtin resolution. */
export function registerExternalProviderResolver(
	resolver: ExternalProviderResolver | undefined,
): () => void {
	externalProviderResolver = resolver;
	return () => {
		if (externalProviderResolver === resolver) externalProviderResolver = undefined;
	};
}

function buildResolution(
	requestedProvider: string,
	requestedModel: string,
	provider: string,
	adapter: ProviderAdapter,
): ProviderResolution {
	const bareRequestedModel = parseModelId(requestedModel).model;
	const model =
		provider === requestedProvider
			? requestedModel
			: (defaultModelForProvider(provider) ?? `${provider}:${bareRequestedModel || "default"}`);
	if (adapter instanceof NugProvider) {
		adapter.prepareForModel(model);
	}
	return {
		requestedProvider,
		requestedModel,
		provider,
		adapter,
		model,
	};
}

export function resolveProviderAndModel(
	model?: string,
	stickyProvider?: string,
): ProviderResolution {
	const requestedModel = resolveEffectiveModel(model, stickyProvider);
	const requestedProvider = resolveProvider(requestedModel);

			throw new Error(
			);
		}

			throw new Error(
			);
		}

	}

	const explicit = createProviderByName(requestedProvider);
	if (explicit) {
		return buildResolution(requestedProvider, requestedModel, requestedProvider, explicit);
	}

	// Executable-plugin providers are resolved only after every builtin and
	// compatible-API provider has declined, so a plugin can never shadow a
	const external = externalProviderResolver?.(requestedProvider, requestedModel);
	if (external) {
		return buildResolution(requestedProvider, requestedModel, requestedProvider, external);
	}

	throw new Error(
		`Provider "${requestedProvider}" is not configured. ` +
			`Please check your provider settings or choose a different model.`,
	);
}

export function getProvider(provider: string): ProviderAdapter {
	const explicit = createProviderByName(provider);
	if (explicit) return explicit;
	const fallback = resolveProviderAndModel(`${provider}:default`);
	return fallback.adapter;
}
