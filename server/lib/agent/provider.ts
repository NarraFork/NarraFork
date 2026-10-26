import type { ChatParams as ProtocolChatParams } from "@shared/agent-protocol/chat-params";
import type {
	AgentToolUse,
	ApiRequestDiagnosticSource,
	ApiRequestDiagnostics,
	BuiltHistory,
	DbMessage,
	DbToolCall,
	ParsedStreamEvent,
	ProviderTextCitation,
	ReasoningProviderMetadata,
	WebSearchAction,
} from "@shared/agent-protocol/types";
import type { ContextInputCharacters } from "@shared/context-usage";
import type { ProviderReadiness } from "@shared/provider-readiness";
import { getCodexManager } from "../codex-manager";
import { resolveCommandCodeToken } from "../commandcode-manager";
import { catalogError } from "../errors";
import { logger } from "../logger";
import {
	FOLLOW_DEFAULT_MODEL,
	getAnthropicProviderConfig,
	getGeminiProviderConfig,
	getNugProviderConfig,
	getOpenaiProviderConfig,
	parseModelId,
	resolveEffectiveModel,
	resolveModelProtocol,
	resolveProvider,
	settings,
} from "../settings";
import { getTokenDanceCatalogModels, getTokenDanceRuntimeConfig } from "../tokendance-runtime";
import type { UsageData } from "../usage-tracking";
import { AnthropicProvider } from "./anthropic-provider";
import { CodexProvider } from "./codex-provider";
import { buildCommandCodeProvider } from "./commandcode-provider";
import { GeminiInteractionsProvider } from "./gemini-interactions-provider";
import { GeminiProvider } from "./gemini-provider";
import { NugProvider } from "./nug-provider";
import { OpenAIProvider } from "./openai-provider";
import {
	connectionForProtocolSwitch,
	type ProtocolConnectionFields,
	protocolMatchesConnection,
} from "./protocol-override";
import { type ProviderSource, ProviderSourceRegistry } from "./provider-source-registry";
import type { ApiRequestDumpCollector } from "./request-dump";
import type { StreamProgress } from "./stream-progress";
import { TokenDanceProvider } from "./tokendance-provider";

// === Provider stream protocol types ===
//
// Canonical definitions live in `@shared/agent-protocol/types` so the protocol
// layer and bundled plugin code can use them without importing anything under
// `server/`. Re-exported here to keep existing host import paths working.

export type {
	AgentToolUse,
	ApiRequestDiagnosticSource,
	ApiRequestDiagnostics,
	BuiltHistory,
	DbMessage,
	DbToolCall,
	ParsedStreamEvent,
	ProviderTextCitation,
	ReasoningProviderMetadata,
	WebSearchAction,
};

// === Chat parameters passed to provider.chat() ===

/**
 * Full host-side chat parameters.
 *
 * Extends the protocol-layer subset (`@shared/agent-protocol/chat-params`) with
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
	/** Local transport isolation only; does not change wire session IDs or credential affinity. */
	transportSessionKey?: string;
	/** Reasoning effort level — maps to thinking config (Anthropic), reasoning config (Codex), or provider-specific effort ("max" may be provider-specific) */
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Optional output ceiling; effective model metadata may lower, never raise it. */
	maxOutputTokens?: number;
	/** Service tier for Codex-mode providers — "priority" enables fast mode */
	serviceTier?: string;
	/** How tool loads in `history` were rendered; decides the Anthropic tool-change beta. */
	toolLoadingStrategy?: import("./tool-loading").ToolLoadingStrategy;
	/** Metadata to include in the request body (e.g. user_id for Anthropic) */
	metadata?: { user_id: string };
	/** Optional collector for persisting raw provider request/response dumps. */
	requestDump?: ApiRequestDumpCollector;
	/**
	 * Optional transport-progress tracker (headers, body bytes, SSE heartbeats) for the
	 * HTTP attempt. Diagnostic only: it never counts as provider activity.
	 */
	streamProgress?: StreamProgress;
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
	/** Complete final input counts; await bounded numeric preparation before sending/consuming output. */
	onInputCharacters?: (counts: ContextInputCharacters | null) => void | Promise<void>;
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
	/** Partial text retained after an output-token limit; not a complete response. */
	outputTruncated?: boolean;
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
	 * assistant text stream instead of using native tool-use fields (some gateways). The
	 * agent loop uses this to always collect a bounded raw dump so leaked-tool diagnostics
	 * have downloadable SSE data, and to run the post-turn stateless recovery safety net.
	 */
	mayLeakXmlToolCalls?: boolean;

	/** Convert DB messages to provider history + trailing tool results */
	buildHistory(dbMessages: DbMessage[], model: string, narratorId?: string): Promise<BuiltHistory>;

	/**
	 * The wire protocol this adapter speaks for `model`, used to pick a prefix-preserving
	 * tool loading strategy (see `tool-loading.ts`). Absent means tools are always
	 * re-declared in full.
	 */
	toolLoadingTarget?(model: string): import("./tool-loading").ToolLoadingTarget | undefined;

	/**
	 * Stable identity ("provider:channel") of the upstream this provider is
	 * currently routed to, used to gate thinking-signature replay across
	 * servers. Returns `undefined` for providers that never mint Anthropic-style
	 * signatures (openai/codex) — such blocks carry no signature so there
	 * is nothing to gate. For NUG this reflects the active channel (e.g.
	 * `nug:antigravity` vs `nug:channel-name`), which is only known after
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

const builtinProviderSources = new ProviderSourceRegistry();
const externalProviderSources = new ProviderSourceRegistry();

function hasTokenDancePrefixConflict(): boolean {
	return [
		...(settings.customApiProviders ?? []),
		...(settings.openaiProviders ?? []),
		...(settings.anthropicProviders ?? []),
		...(settings.geminiProviders ?? []),
		...(settings.nugProviders ?? []),
	].some((entry) => entry.prefix === "tokendance");
}

builtinProviderSources.register("tokendance", {
	resolve: (provider) => {
		if (provider !== "tokendance" || !getTokenDanceRuntimeConfig()) return null;
		if (hasTokenDancePrefixConflict()) {
			throw new Error(
				"TokenDance prefix conflicts with an existing API provider. Rename the existing provider prefix before using TokenDance.",
			);
		}
		return new TokenDanceProvider();
	},
	listReadiness: () => {
		const config = getTokenDanceRuntimeConfig();
		return [
			{
				id: "builtin:tokendance",
				prefix: "tokendance",
				name: "TokenDance",
				ready: !!config && !config.disabled,
			},
		];
	},
});

builtinProviderSources.register("codex", {
	resolve: (provider) =>
		provider === "codex"
			? new CodexProvider({
					useWebSocket: settings.codex?.useWebSocket ?? true,
					useWebSearch: settings.codex?.useWebSearch ?? true,
					useImageGeneration: settings.codex?.useImageGeneration ?? true,
				})
			: null,
	listReadiness: () => [
		{
			id: "builtin:codex",
			prefix: "codex",
			name: "Codex",
			ready: getCodexManager().hasAvailableCredentials,
		},
	],
});

builtinProviderSources.register("CommandCode", {
	resolve: (provider, model) =>
		provider === "CommandCode" ? buildCommandCodeProvider(model, settings.commandCode) : null,
	listReadiness: () => [
		{
			id: "builtin:CommandCode",
			prefix: "CommandCode",
			name: "Command Code",
			ready:
				!settings.commandCode?.disabled &&
				!!resolveCommandCodeToken(settings.commandCode?.apiKey).credential,
		},
	],
});

/** API families expose the same instances used to construct their adapters. */
function registerCredentialProviderSource<
	T extends {
		id: string;
		prefix: string;
		name: string;
		apiKey: string;
		disabled?: boolean;
	},
>(
	kind: string,
	listConfigs: () => T[],
	getConfig: (prefix: string) => T | undefined,
	create: (config: T) => ProviderAdapter,
	isComplete: (config: T) => boolean = (config) => !!config.apiKey.trim(),
): void {
	builtinProviderSources.register(kind, {
		resolve: (prefix, model) => {
			const config = getConfig(prefix);
			if (!config) return null;
			// 逐模型协议覆盖：协议和这条连接本来的适配器不同时，换一族适配器，但留下代理和指纹。
			const protocol = resolveModelProtocol(prefix, model);
			const connection = config as ProtocolConnectionFields;
			if (protocol && !protocolMatchesConnection(kind, connection, protocol)) {
				try {
					const shared = connectionForProtocolSwitch(connection, model);
					if (protocol === "anthropic-messages") return new AnthropicProvider(shared);
					if (protocol === "gemini-compatible") return createGeminiProvider(shared);
					return new OpenAIProvider({
						...shared,
						apiMode: protocol === "openai-responses" ? "responses" : "completions",
					});
				} catch (error) {
					logger.warn("Model protocol override fell back to the provider default", {
						prefix,
						protocol,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return create(config);
		},
		listReadiness: () =>
			listConfigs().map((config) => ({
				id: `api:${config.id}`,
				prefix: config.prefix,
				name: config.name,
				ready: !config.disabled && isComplete(config),
			})),
	});
}

registerCredentialProviderSource(
	"anthropic",
	() => settings.anthropicProviders ?? [],
	getAnthropicProviderConfig,
	(config) => new AnthropicProvider(config),
);
registerCredentialProviderSource(
	"nug",
	() => settings.nugProviders ?? [],
	getNugProviderConfig,
	(config) => new NugProvider(config),
	(config) => !!config.apiKey.trim() && !!config.baseUrl.trim(),
);
registerCredentialProviderSource(
	"openai",
	() => settings.openaiProviders ?? [],
	getOpenaiProviderConfig,
	(config) => new OpenAIProvider(config),
);
registerCredentialProviderSource(
	"gemini",
	() => settings.geminiProviders ?? [],
	getGeminiProviderConfig,
	createGeminiProvider,
);

/** Synchronous routing and asynchronous local readiness share the registered sources. */
export async function listProviderReadiness(): Promise<ProviderReadiness[]> {
	const disabled = new Set(settings.agent.disabledProviders ?? []);
	disabled.add("tutorial");
	if (getTokenDanceRuntimeConfig() && hasTokenDancePrefixConflict()) disabled.add("tokendance");
	const builtin = await builtinProviderSources.listReadiness(disabled);
	const external = await externalProviderSources.listReadiness(disabled);
	const reserved = new Set([
		"codex",
		"tokendance",
		"tutorial",
		...builtin.map((entry) => entry.prefix),
	]);
	return [...builtin, ...external.filter((entry) => !reserved.has(entry.prefix))];
}

function createProviderByName(
	provider: string,
	model = `${provider}:default`,
): ProviderAdapter | null {
	// The retired prefix must never route to a billable upstream or plugin.
	if (provider === "tutorial") throw catalogError("TUTORIAL_REMOVED");
	return builtinProviderSources.resolve(provider, model);
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
	if (provider === "tokendance" && getTokenDanceRuntimeConfig()) {
		const model = getTokenDanceCatalogModels()[0];
		return model ? `tokendance:${model.id}` : null;
	}
	if (provider === "codex") {
		const custom = settings.agent.customModels ?? [];
		const codexCustom = custom.find((m) => m.provider === "codex")?.value;
		const normalized = prefixProviderModel("codex", codexCustom);
		return normalized ?? "codex:gpt-5.5";
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

export type ExternalProviderResolver = ProviderSource;

/** External routing cannot be registered without its readiness projection. */
export function registerExternalProviderResolver(source: ProviderSource): () => void {
	return externalProviderSources.register("external", source);
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
	if (adapter instanceof NugProvider || adapter instanceof TokenDanceProvider) {
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

	const explicit = createProviderByName(requestedProvider, requestedModel);
	if (explicit) {
		return buildResolution(requestedProvider, requestedModel, requestedProvider, explicit);
	}

	// Executable-plugin providers are resolved only after every builtin and
	// compatible-API provider has declined, so a plugin can never shadow a
	// builtin prefix (anthropic/openai/nug/gemini/codex).
	const external = externalProviderSources.resolve(requestedProvider, requestedModel);
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
