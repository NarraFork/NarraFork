/**
 * Settings type definitions — all interfaces for NarraFork configuration.
 * Extracted from the monolithic settings/index.ts for better modularity.
 */

import type { PathFlavor, RuleTargetSelector } from "@server/services/execution-policy/types";
import type { ModelCard } from "@shared/model-card";
import type { SubagentModelReasoningEfforts } from "@shared/subagent-model-policy";
import type { TokenDanceCatalogModel } from "@shared/tokendance";
import type { LoadBalancingMode } from "../codex-manager";
import type { CodexPlanTier } from "../codex-usage-summary";
import type { DiskSafetySettings } from "../disk-safety-config";
import type { ModelCatalogSettings } from "../model-catalog";
import type { PermissionMode } from "../permission-modes";
import type { UserAgentMode } from "../user-agent";

export interface ModelOption {
	value: string;
	label: string;
	provider?: string;
}

export type DangerReflectionLevel = "off" | "light" | "standard" | "strict";

export type AutoContinuationMode = "always" | "blockStop" | "protectedOnly" | "off";

export type CustomApiProtocol =
	| "anthropic-messages"
	| "openai-responses"
	| "completions-compatible"
	| "gemini-compatible";

/**
 * Legacy protocol values accepted from persisted settings and older clients.
 * normalizeCustomApiProvider migrates them to the current values:
 *   codex-native / responses-compatible   → openai-responses
 *   anthropic-official / anthropic-compatible → anthropic-messages
 */
export type LegacyCustomApiProtocol =
	| "codex-native"
	| "responses-compatible"
	| "anthropic-official"
	| "anthropic-compatible";

export interface CustomApiProviderConfig {
	/** Unique short ID shared across protocol switches. */
	id: string;
	/** User-defined display name. */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/** User-defined provider prefix used in model IDs, e.g. "openai" or "anthropic". */
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	/** Canonical custom API protocol used by the UI and settings storage. */
	protocol: CustomApiProtocol;
	/** Gemini wire transport. Missing defaults to generate-content for compatibility. */
	geminiTransport?: "generate-content" | "interactions";
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/** Anthropic: default reasoning effort when narrator reasoningEffort is unset. */
	defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** Optional per-provider proxy override. Absent/"default" = follow the global policy. */
	proxy?: ProxyOverride;
	/** Anthropic: skip TLS certificate verification for MITM proxies or self-signed certs. */
	tlsRejectUnauthorized?: boolean;
	/** Anthropic official: upstream serves the server-side web_search tool (side-request search). */
	nativeSearch?: boolean;
	/** Codex: ChatGPT account ID sent as ChatGPT-Account-Id header. */
	codexAccountId?: string;
	/** Codex: use Responses WebSocket instead of HTTP. */
	codexWebSocket?: boolean;
	/** Codex: allow the native web_search tool to be sent to the model. */
	codexWebSearch?: boolean;
	/** Codex: allow the native image_generation tool to be sent to the model. */
	codexImageGeneration?: boolean;
	/**
	 * Which User-Agent to present on outbound requests. Absent = provider default
	 * (Claude CLI UA for official Anthropic, narrafork UA otherwise).
	 */
	userAgentMode?: UserAgentMode;
	/** Custom User-Agent string, used when userAgentMode === "custom". */
	customUserAgent?: string;
	/** Additional request headers injected on outbound requests. */
	extraHeaders?: Record<string, string>;
}

/**
 * Client-egress relay modes for NUG providers (see docs/CODEX_CLIENT_RELAY.md).
 * The codex account credentials stay on NUG; only the network egress to OpenAI
 * comes from this machine.
 */
export type NugEgressMode =
	/** Default: NUG connects to OpenAI directly (status quo). */
	| "nug"
	/** This nf dials chatgpt.com with its own IP and relays ciphertext for NUG. */
	| "local-direct"
	/** Same, but dialing through a local proxy (e.g. clash) instead. */
	| "local-proxy";

export interface OpenAIProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "DeepSeek", "Groq", "OpenAI". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/**
	 * User-defined provider prefix used in model IDs, e.g. "openai", "deepseek", "groq".
	 * Model IDs are formatted as "{prefix}:{model}", e.g. "deepseek:deepseek-chat".
	 * Must be unique across all providers. Defaults to "openai" for legacy compat.
	 */
	prefix: string;
	apiKey: string;
	/**
	 * Internal: full Authorization header value that overrides the default
	 * `Bearer ${apiKey}` (e.g. Codex Agent Identity's `AgentAssertion ...`).
	 * Set dynamically by the Codex provider; not persisted in settings.
	 */
	authorizationHeader?: string;
	baseUrl: string;
	defaultModel: string;
	/** @deprecated Use `apiMode` instead. Kept for backward compatibility. */
	responsesApi?: boolean;
	/**
	 * Which OpenAI API variant to use:
	 *   - "responses"   — OpenAI Responses API (/responses endpoint, developer role, function_call items)
	 *   - "completions"  — Standard Chat Completions API (/chat/completions, system role, tool_calls)
	 *   - "codex"        — Codex: Responses API format to /responses endpoint,
	 *                       default baseUrl https://chatgpt.com/backend-api/codex,
	 *                       extra headers (originator, ChatGPT-Account-Id).
	 * Defaults to "responses".
	 */
	apiMode?: "responses" | "completions" | "codex";
	/** Codex: ChatGPT account ID sent as ChatGPT-Account-Id header (for org subscriptions). */
	codexAccountId?: string;
	/** Codex: use Responses WebSocket instead of HTTP (experimental; falls back to HTTP when unavailable). */
	codexWebSocket?: boolean;
	/** Codex: allow the native web_search tool to be sent to the model. */
	codexWebSearch?: boolean;
	/** Codex: allow the native image_generation tool to be sent to the model. */
	codexImageGeneration?: boolean;
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/** Optional per-provider proxy override. Absent/"default" = follow the global policy. */
	proxy?: ProxyOverride;
	/** Internal: additional request headers injected by provider adapters such as NUG. */
	extraHeaders?: Record<string, string>;
	/**
	 * Internal: per-request dynamic headers, called at request-build time so
	 * values that change at runtime (e.g. the NUG client-relay channel id,
	 * which rotates on every reconnect) are always current. Merged after
	 * extraHeaders, so dynamic values win. Not persisted in settings.
	 */
	dynamicHeaders?: () => Record<string, string>;
	/** Which User-Agent to present on outbound requests. Absent = narrafork UA default. */
	userAgentMode?: UserAgentMode;
	/** Custom User-Agent string, used when userAgentMode === "custom". */
	customUserAgent?: string;
}

export interface AnthropicProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "Anthropic", "Anthropic Proxy". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/**
	 * User-defined provider prefix used in model IDs, e.g. "anthropic".
	 * Model IDs are formatted as "{prefix}:{model}", e.g. "anthropic:claude-sonnet-4-20250514".
	 * Must be unique across all providers.
	 */
	prefix: string;
	apiKey: string;
	baseUrl: string;
	defaultModel: string;
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/**
	 * Default reasoning effort for Anthropic models when narrator reasoningEffort is unset.
	 * Maps to thinking config (adaptive/disabled) and effort parameter for supported models.
	 */
	defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** Optional per-provider proxy override. Absent/"default" = follow the global policy. */
	proxy?: ProxyOverride;
	/** Skip TLS certificate verification (for use with MITM proxies or self-signed certs). */
	tlsRejectUnauthorized?: boolean;
	/**
	 * Whether this provider connects to the official Anthropic API (or an official relay).
	 * When true, enables Claude Code protocol features: server-side web search,
	 * beta flags, cache_control, billing header, Bearer auth, etc.
	 * When false (default), uses standard Anthropic Messages API compatible with
	 * third-party proxy/relay services.
	 */
	officialApi?: boolean;
	/**
	 * Whether the upstream actually serves Anthropic's server-side
	 * `web_search_20250305` tool. Cannot be inferred from `officialApi` — that
	 * only means "speaks the Claude Code request dialect", which relays fronting
	 * non-Anthropic upstreams also do. When enabled, WebSearch runs as a
	 * CLI-style one-shot side request; the main conversation request never
	 * declares the server tool (declaring it there was measured breaking
	 * prompt caching on relays).
	 */
	nativeSearch?: boolean;
	/** Internal: additional request headers injected by provider adapters such as NUG. */
	extraHeaders?: Record<string, string>;
	/**
	 * Which User-Agent to present on outbound requests. Absent = provider default
	 * (Claude CLI UA for official API, narrafork UA otherwise).
	 */
	userAgentMode?: UserAgentMode;
	/** Custom User-Agent string, used when userAgentMode === "custom". */
	customUserAgent?: string;
}

export interface NUGProviderConfig {
	/** Unique short ID (8 chars). */
	id: string;
	/** User-defined display name, e.g. "NUG Production". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/** Provider prefix used in model IDs, e.g. "nug". */
	prefix: string;
	/** NUG API Key for authentication. */
	apiKey: string;
	/** NUG service base URL, e.g. "http://127.0.0.1:7790". */
	baseUrl: string;
	/** Default model (bare name without prefix, may include channel e.g. "anthropic:claude-sonnet-4.5"). */
	defaultModel: string;
	/** NUG account username (auto-filled after login). */
	nugUsername?: string;
	/** NUG account user ID (auto-filled after login). */
	nugUserId?: string;
	/** OAuth client ID (registered on NUG admin). */
	oauthClientId?: string;
	/** OAuth client secret. */
	oauthClientSecret?: string;
	/** OAuth device ID (auto-filled after OAuth authorization). */
	oauthDeviceId?: string;
	/** Override OAuth callback URL (auto-detected from request headers by default). */
	oauthCallbackUrl?: string;
	/** Optional per-provider proxy override. Absent/"default" = follow the global policy. */
	proxy?: ProxyOverride;
	/**
	 * Client-egress relay mode (docs/CODEX_CLIENT_RELAY.md). Absent/"nug" = NUG
	 * dials upstream directly (status quo). "local-direct"/"local-proxy" make
	 * this nf lend its own egress to NUG for codex requests; credentials stay
	 * on NUG and are never visible to this process.
	 */
	egressMode?: NugEgressMode;
	/** Local proxy URL for egressMode "local-proxy", e.g. "http://127.0.0.1:7890". */
	egressProxyUrl?: string;
	/**
	 * When the local relay channel is down, allow requests to fall back to
	 * NUG-direct egress. Default false: fail loudly instead of silently
	 * switching egress IP mid-conversation.
	 */
	egressAllowDirectFallback?: boolean;
}

export interface GeminiProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "Gemini", "Google AI". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/**
	 * Provider prefix used in model IDs, e.g. "gemini".
	 * Model IDs are formatted as "{prefix}:{model}", e.g. "gemini:gemini-2.5-flash".
	 * Must be unique across all providers.
	 */
	prefix: string;
	/** Google Generative Language API key (sent as x-goog-api-key). */
	apiKey: string;
	/** API base URL, e.g. "https://generativelanguage.googleapis.com/v1beta". */
	baseUrl: string;
	/** Default model (bare name without prefix, e.g. "gemini-2.5-flash"). */
	defaultModel: string;
	/** Gemini wire transport. Missing defaults to generate-content for legacy configs. */
	geminiTransport?: "generate-content" | "interactions";
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/**
	 * Default reasoning effort for Gemini models when narrator reasoningEffort is unset.
	 * Maps to thinkingConfig.thinkingBudget (none disables thinking).
	 */
	defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** Optional per-provider proxy override. Absent/"default" = follow the global policy. */
	proxy?: ProxyOverride;
}

export type SearchChannelKind =
	| "native"
	| "nug-mcp"
	| "custom-api"
	| "subagent"
	/** Contributed by a plugin through `contributes.searchProviders`. */
	| "plugin";

export type CustomSearchProviderProtocol = string;

export interface SearchChannelConfig {
	/**
	 * Stable channel ID: native, nug:{id}, custom:{id}, subagent,
	 * plugin:{pluginId}:{contributionId}.
	 */
	id: string;
	kind: SearchChannelKind;
	enabled: boolean;
	providerId?: string;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	maxTurns?: number;
	timeoutMs?: number;
}

export interface CustomSearchProviderConfig {
	id: string;
	name: string;
	disabled?: boolean;
	protocol: CustomSearchProviderProtocol;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	options?: Record<string, unknown>;
	timeoutMs?: number;
}

export interface SearchSettings {
	channels: SearchChannelConfig[];
	customProviders: CustomSearchProviderConfig[];
	defaultTimeoutMs?: number;
	maxOutputChars?: number;
}

export interface ModelAggregation {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** Display name, e.g. "Claude Opus 4.6". */
	name: string;
	/** Member model values (provider:modelId format), ordered by priority. */
	models: string[];
	/** Routing mode when auto is selected: "priority" uses first available, "balanced" round-robins. */
	routingMode: "priority" | "balanced";
}

/** Per-tool permission behavior override for an MCP server. */
export interface McpToolPermission {
	/** Tool name as reported by the MCP server (original name, NOT the mcp__prefix__name format). */
	toolName: string;
	/** Permission behavior: "readOnly"/"readWrite" auto-approve (scope-dependent), "ask" requires user approval, "deny" auto-rejects. */
	behavior: "readOnly" | "readWrite" | "ask" | "deny";
	/** Whether this rule is active. Defaults to true. */
	enabled?: boolean;
}

export interface McpServerConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name. */
	name: string;
	/** Transport type. */
	transport: "stdio" | "streamable-http" | "sse";
	/** stdio: executable command. */
	command?: string;
	/** stdio: command arguments. */
	args?: string[];
	/** stdio: working directory. */
	cwd?: string;
	/** Environment variables passed to the MCP server process or HTTP requests. */
	env?: Record<string, string>;
	/** sse/streamable-http: server URL. */
	url?: string;
	/** sse/streamable-http: custom request headers. */
	headers?: Record<string, string>;
	/** Whether this server is enabled. */
	enabled: boolean;
	/** Default permission behavior for all tools from this server. When unset, follows the narrator's permission mode. */
	defaultBehavior?: "readOnly" | "readWrite" | "ask" | "deny";
	/** Per-tool permission behavior overrides. Takes priority over defaultBehavior. */
	toolPermissions?: McpToolPermission[];
}

export interface TlsConfig {
	enabled: boolean;
	/** Path to PEM-formatted TLS certificate file. */
	certFile: string;
	/** Path to PEM-formatted TLS private key file. */
	keyFile: string;
	/** Passphrase for the private key (if encrypted). */
	passphrase?: string;
	/** Path to CA certificate file (overrides default trusted CAs). */
	caFile?: string;
}

/** Global outbound proxy mode shared by all outbound network channels. */
export type OutboundProxyMode = "system" | "direct" | "custom";

/**
 * Unified outbound proxy policy applied to every outbound network channel
 * (Codex, Anthropic, OpenAI-compatible, NUG, WebFetch, browser)
 * unless a per-location {@link ProxyOverride} overrides it.
 */
export interface OutboundProxyConfig {
	/**
	 * Proxy mode:
	 * - "system": auto-detect from HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars (default)
	 * - "direct": no proxy (direct connection)
	 * - "custom": use the manually specified URL
	 */
	mode: OutboundProxyMode;
	/** Proxy URL, only used when mode is "custom". */
	url?: string;
}

/**
 * Per-location proxy override mode. Adds "default" (inherit the global
 * {@link OutboundProxyConfig}) on top of the three global modes.
 */
export type ProxyOverrideMode = "default" | "direct" | "system" | "custom";

/**
 * Optional per-location proxy override. When absent or mode === "default",
 * the location follows the global outbound proxy policy. Otherwise it uses
 * its own mode: "direct" (no proxy), "system" (env vars), or "custom" (url).
 */
export interface ProxyOverride {
	mode: ProxyOverrideMode;
	/** Proxy URL, only used when mode is "custom". */
	url?: string;
}

/** OAuth access-token WebSocket feature gates and resource limits. */
export interface OAuthExternalWebSocketSettings {
	/**
	 * The external OAuth narrator WebSocket endpoint is always enabled; access to
	 * each capability (subscribe / send / interrupt) is governed by OAuth scopes
	 * and grants, not by feature toggles. The fields below are operational limits
	 * only.
	 */
	/** Lifetime of a single-use WebSocket upgrade ticket in milliseconds. */
	ticketTtlMs?: number;
	/** Maximum number of pending upgrade tickets retained globally. */
	maxTickets?: number;
	/** Maximum accepted WebSocket frame size in bytes. */
	maxFrameBytes?: number;
	/** Exact browser Origin allow-list; non-browser clients may omit Origin. */
	allowedOrigins?: string[];
	/** Maximum narrator subscriptions added or removed by one frame. */
	maxSubscriptionsPerFrame?: number;
	/** Maximum active narrator subscriptions on one connection. */
	maxSubscriptionsPerConnection?: number;
	/** Maximum OAuth external WebSocket connections across the server. */
	maxGlobalConnections?: number;
	/** Maximum concurrent connections sharing one access token. */
	maxConnectionsPerToken?: number;
	/** Maximum concurrent connections sharing one OAuth grant. */
	maxConnectionsPerGrant?: number;
	/** Maximum concurrent connections sharing one OAuth client. */
	maxConnectionsPerClient?: number;
	/** Maximum concurrent connections belonging to one user. */
	maxConnectionsPerUser?: number;
	/** Maximum socket bufferedAmount in bytes before the connection is closed. */
	maxBufferedAmount?: number;
}

/** A configured OpenID Connect identity provider for SSO. */
export interface OidcProviderConfig {
	/** Stable internal id (used as the `provider` key in user_identities). */
	id: string;
	/** Display name shown on the login button (e.g. "Company SSO"). */
	name: string;
	/** Issuer URL — its /.well-known/openid-configuration is auto-discovered. */
	issuer: string;
	clientId: string;
	clientSecret: string;
	/** OAuth scopes; "openid" is always included. Defaults to ["openid","profile","email"]. */
	scopes?: string[];
	/**
	 * When true, a successful login with no matching identity auto-creates a
	 * local user (subject to allowedEmailDomains). When false, the user must
	 * already exist and have linked this provider. Defaults to false.
	 */
	allowSignup?: boolean;
	/** Restrict auto-signup / login to these email domains (e.g. ["example.com"]). */
	allowedEmailDomains?: string[];
	/** Disable this provider without removing its config. */
	enabled?: boolean;
}

export interface TokenDanceSettings {
	apiKey: string;
	disabled: boolean;
	generation: number;
	/** Bounded last successful catalog; available after service restart. */
	models?: TokenDanceCatalogModel[];
	/** Initial fixed model collection was applied; manual visibility choices now win. */
	modelCollectionInitialized?: boolean;
}

export interface NarraForkSettings {
	/** Backend-only singleton credentials; never return this object to clients. */
	tokendance?: TokenDanceSettings;
	/** Tool-triggered local filesystem safety; absent older settings use safe defaults. */
	diskSafety?: DiskSafetySettings;
	/** Instance-wide, monotonic setup completion; absent until legacy preferences are migrated. */
	setupWizardCompleted?: boolean;
	/**
	 * Database backend selection. SQLite is the default and needs nothing here.
	 *
	 * Selecting PostgreSQL requires `backend: "postgres"` (or NF_DATABASE_BACKEND) AND a
	 * connection URL from the ENVIRONMENT (NF_DATABASE_URL or DATABASE_URL). The URL is
	 * deliberately NOT read from this file: the settings object is served by GET /api/settings
	 * to any authenticated user and a connection string carries credentials, so a
	 * `database.postgres.url` key is rejected as a configuration error rather than ignored.
	 * `postgres` below carries only non-secret pool tuning.
	 */
	database?: {
		/** Exact "sqlite" (default) or "postgres"; anything else is a startup error. */
		backend?: "sqlite" | "postgres";
		/** Non-secret pool tuning. Numbers only; positive; seconds for the timeouts. */
		postgres?: {
			max?: number;
			idleTimeout?: number;
			maxLifetime?: number;
			connectTimeout?: number;
		};
	};
	server: {
		port: number;
		/** "auto-lan" resolves the first LAN IP on each start, with localhost fallback. */
		host: string;
		/** Browser launch behaviour on server start: "off" | "browser" | "app" */
		openBrowser: "off" | "browser" | "app";
		/** Optional TLS configuration for HTTPS. */
		tls?: TlsConfig;
		/**
		 * Extra origins allowed to read `/api/*` cross-origin, matched verbatim.
		 *
		 * Same-origin, loopback and editor-webview origins are allowed without being
		 * listed here (see `lib/cors-origin.ts`), so this is only for a front end served
		 * from a different, non-local host.
		 */
		allowedOrigins?: string[];
	};
	/**
	 * Machine-level client fingerprint state shared across providers.
	 * `installationId` is a persisted UUID (generated lazily) sent as the
	 * `x-codex-installation-id` key inside Codex request-body `client_metadata`
	 * (not as a direct HTTP header — matches the real Codex CLI). `claudeDeviceId`
	 * is a persisted 64-hex id (generated lazily) sent as
	 * `metadata.user_id.device_id` on official Anthropic requests, matching the
	 * shape and lifetime of the Claude Code CLI's own `device_id`.
	 */
	clientFingerprint?: {
		installationId?: string;
		claudeDeviceId?: string;
	};
	/**
	 * Unified outbound proxy policy applied to every outbound network channel.
	 * Defaults to "system" (follow the OS/env proxy). Replaces the previous
	 * per-provider proxy fields (codex.proxy, provider.proxy,
	 * agent.webFetchPolicy.proxy), which are kept only for migration.
	 */
	proxy?: OutboundProxyConfig;
	/**
	 * Per-instance branding, so several deployments can be told apart in one
	 * browser. When a window is unfocused or the app is installed as a PWA, the tab
	 * title / app name / icon are the only distinguishing marks — and they are
	 * identical across instances out of the box.
	 *
	 * Both fields are optional and blank means "use the NarraFork defaults"; see
	 * `shared/branding.ts` for resolution and why every read path is forgiving.
	 */
	branding?: {
		/** Instance display name. Blank/absent = "NarraFork". */
		name?: string;
		/**
		 * Icon accent colour as `#rrggbb`. Absent = NarraFork indigo (#4c6ef5).
		 * Drives the favicon, PWA icons and apple-touch-icon. Deliberately NOT the
		 * manifest `theme_color`, which is the dark UI background rather than an
		 * accent — see `server/routes/branding.ts`.
		 */
		iconColor?: string;
	};
	paths: {
		defaultProjectDir: string;
		/**
		 * Extra absolute directories the in-browser editor may write into, beyond a
		 * narrator's own worktree. Empty by default; every entry widens the write
		 * allow-list. See `fs-write-boundary.ts` for what is still refused inside one.
		 */
		extraWritableDirs: string[];
	};
	/** Knowledge base: how knowledge is auto-injected into agent context. */
	knowledge: {
		/** "summary" = inject matched entry summaries; "off" = disable passive injection. */
		injectMode: "summary" | "off";
		/** Max entries auto-injected per turn (caps context growth). */
		maxInjectedEntries: number;
		/** Minimum keyword length to attempt a match (aligns with trigram >= 3). */
		minKeywordLen: number;
		/** Scan tool outputs (e.g. logs) for knowledge hits and inject reminders. */
		scanToolOutput: boolean;
		/** Truncate tool output to this many chars before scanning (performance guard). */
		maxToolOutputScanChars: number;
		/** Max pack archive upload size in MB (zip/tar.gz). */
		packMaxSizeMb: number;
		/** Max total uncompressed size of an extracted pack in MB (zip-bomb guard). */
		packMaxUncompressedMb: number;
		/** Whether PackActivate requires explicit user permission (it changes the narrator's dir access). */
		packActivateRequiresPermission: boolean;
	};
	/** Plugin subsystem settings. */
	plugins: {
		/**
		 * Whether the plugin subsystem is enabled. Defaults to true. The
		 * `NF_PLUGINS_ENABLED` / `NARRAFORK_PLUGINS_ENABLED` environment variables,
		 * when set, take precedence over this value (operational kill switch:
		 * setting them to "0"/"false" force-disables regardless of this setting).
		 */
		enabled: boolean;
	};
	agent: {
		defaultModel: string;
		defaultPermissionMode: PermissionMode;
		/** Creation default only; auto keeps chapter/project and standalone/private behavior. */
		defaultNarratorVisibility: "auto" | "private" | "public";
		/** Creation default only; narrowed to visibility, auto uses its widest legal audience. */
		defaultNarratorWriteAudience: "auto" | "owner" | "project" | "public";
		/** Whether newly-created narrators should start with the plan trait enabled. */
		defaultStartInPlanMode: boolean;
		summaryModel: string;
		/** Model used to translate reasoning blocks. "__summary__" follows summaryModel dynamically. */
		translationModel: string;
		/** Model used for prompt optimization. "__summary__" follows summaryModel dynamically. */
		promptOptimizeModel: string;
		/** Maximum number of context messages for prompt optimization. Default 10. */
		promptOptimizeContextMaxMessages?: number;
		customModels: ModelOption[];
		hiddenModels: string[];
		maxTurns: number;
		subagentModels: {
			explore: string;
			plan: string;
			search?: string;
			review?: string;
		};
		/** Per-type allowed model pools for subagents. Empty array = no restriction. */
		subagentAllowedModels: {
			explore: string[];
			plan: string[];
			general: string[];
			search?: string[];
			review?: string[];
		};
		/** Optional fixed tiers for entries in the corresponding allowed model pool. */
		subagentModelReasoningEfforts?: SubagentModelReasoningEfforts;
		/**
		 * Enable non-UTF-8 charset detection (GBK, Shift_JIS, …) for file read/write
		 * and grep. Note: shell command output is auto-detected on Windows regardless
		 * of this flag, because the OEM console code page commonly garbles CLI output.
		 */
		legacyEncoding: boolean;
		/**
		 * Per-model context window overrides (tokens).
		 * Key is the full model value ("provider:modelId"), value is the context window size.
		 * Takes highest priority in getModelContextWindow().
		 */
		modelContextWindows: Record<string, number>;
		/**
		 * Model cards — per-model metadata templates (context window, max
		 * completion tokens, reasoning tiers, official USD prices).
		 *
		 * Stores only the DIFFERENCE from NarraFork's builtin cards: an entry
		 * carries its `modelKey` plus the fields the user changed, and a card
		 * matching its builtin is not stored. So untouched fields track builtin
		 * updates across releases while edited fields stay pinned.
		 *
		 * Distinct from `modelContextWindows`, which stays higher priority: a card
		 * describes a *class* of model ids (via aliases and prefixes), whereas that
		 * map force-overrides one exact `provider:model` value.
		 */
		modelCards?: ModelCard[];
		/** Versioned public metadata overlays; never stores the public catalog itself. */
		modelCatalog?: ModelCatalogSettings;
		/** Translate reasoning/thinking blocks via translationModel after each block completes. */
		translateReasoning: boolean;
		/** Default value for the relaxed plan toggle on new narrators. */
		defaultRelaxedPlan: boolean;
		/**
		 * Whether plan mode accepts inline plans (the `inline_plan` parameter of ExitPlanMode).
		 * When false, only the file-based plan flow is supported: the ExitPlanMode tool
		 * schema, its description, and the plan-mode system reminder drop the inline option,
		 * and plan resolution reads exclusively from the designated plan file.
		 */
		planModeAllowInlinePlan: boolean;
		/** Let ExitPlanMode plan reflection auto-approve plans in edit-capable permission modes. */
		planReflectionAutoApprove: boolean;
		/** Allow ExitPlanMode plan reflection to auto-approve and reset context. */
		planReflectionAllowAutoCompact: boolean;
		/** Let AskUserQuestion auto-answer with reflection after a timeout in bypass-permissions mode. */
		questionReflectionEnabled: boolean;
		/** Human-admin opt-in; strict bound reflection is required even when danger reflection is off. */
		permissionRuleAutoApprove: boolean;
		/** Timeout in milliseconds before AskUserQuestion auto-answer reflection runs. */
		questionReflectionTimeoutMs: number;
		/** Danger reflection policy level for bypass-permissions operations. */
		dangerReflectionLevel: DangerReflectionLevel;
		/** Enable danger reflection secondary confirmations for high-risk bypass-permissions operations. */
		dangerReflectionEnabled: boolean;
		/** Skip danger reflection secondary confirmations for operations that are classified as read-only. */
		dangerSkipReadOnlyConfirmations: boolean;
		/** Auto-continuation mode: controls whether/when the agent auto-continues after a turn. */
		autoContinuationMode: AutoContinuationMode;
		/**
		 * Global default reasoning effort — the single source of truth for the
		 * default tier. A narrator's own reasoningEffort (when non-null) overrides
		 * it; otherwise this value applies to every model and is clamped to the
		 * model's supported tiers at request time. Defaults to "max".
		 */
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
		/**
		 * Models that must NOT receive a reasoning-effort hint.
		 *
		 * Effort is sent to every model by default (blacklist, not whitelist), on
		 * top of a built-in rule for pre-4.6 Claude. Add a pattern here when an
		 * upstream rejects the parameter. Plain text is a case-insensitive
		 * substring match on the bare model id; `/regex/flags` is a regex.
		 */
		reasoningEffortBlocklist?: Array<{ pattern: string; enabled?: boolean }>;
		/** Use login shell for Bash tool to source fresh environment variables instead of inheriting server process env. */
		freshShellEnv: boolean;
		/** Persist raw request/response dumps for each provider call into usage history. */
		requestDumpEnabled: boolean;
		/** When request dumps are enabled, only persist raw dumps for failed provider calls. */
		requestDumpErrorsOnly: boolean;
		/** Maximum size (bytes) for raw dump body text. Default 1MB. Set to -1 for unlimited. */
		requestDumpMaxSize: number;
		/** Maximum retries for recoverable (transient) API errors. -1 = infinite. */
		maxTransientRetries: number;
		/** Maximum tool calls per model response (integer 1–128). Exceeding it aborts the narrator, not a session-wide cumulative limit. */
		maxToolCallsPerResponse: number;
		/** Tool-call count without visible text before asking the model for a short progress update. -1 = disabled. */
		silentToolCallThreshold: number;
		/** Pipeline capture inactivity threshold in tool calls. -1 = disabled. */
		pipelineUnusedToolCallThreshold: number;
		/** Global default for behavior-fence periodic injection interval (completed tool calls). -1 = disabled. */
		behaviorFenceInterval: number;
		/** Global default for tasks.json reminder periodic injection interval (completed tool calls). -1 = disabled. */
		tasksReminderInterval: number;
		/** Global default for whether the behavior fence rides along with the tasks.json reminder. */
		behaviorFenceAttachTasks: boolean;
		/** Maximum backoff delay (ms) for transient-error retries. Default 20000 (20s). */
		retryBackoffCeilMs: number;
		/** Time to wait for the first meaningful AI API event before aborting and retrying. 0 = disabled. */
		firstTokenTimeoutMs: number;
		/** User-defined retryable error rules. Matched errors are treated as transient. */
		customRetryRules?: Array<{
			id: string;
			/** Domain keyword to match in error message (case-insensitive). */
			domain?: string;
			/** HTTP status code to match. */
			statusCode?: number;
			/** Content keyword to match in error message (case-insensitive). */
			keyword?: string;
			enabled?: boolean;
			/** User note for this rule. */
			note?: string;
		}>;
		/** Global whitelist directories — merged with project and narrator level. */
		whitelistDirs?: Array<{
			path: string;
			pathFlavor?: PathFlavor;
			pathKey?: string;
			accessLevel: "readOnly" | "readWrite" | "full";
			enabled?: boolean;
			selector?: RuleTargetSelector;
			/** Legacy compatibility; canonical settings should use selector. */
			deviceScope?: string | null;
		}>;
		/** Global blacklist directories — merged with project and narrator level. */
		blacklistDirs?: Array<{
			path: string;
			pathFlavor?: PathFlavor;
			pathKey?: string;
			denyLevel: "denyWrite" | "denyAll";
			enabled?: boolean;
			selector?: RuleTargetSelector;
			/** Legacy compatibility; canonical settings should use selector. */
			deviceScope?: string | null;
		}>;
		/** Global command whitelist — commands auto-allowed for all narrators. */
		commandWhitelist?: Array<{
			pattern: string;
			enabled?: boolean;
			selector?: RuleTargetSelector;
			/** Legacy compatibility; canonical settings should use selector. */
			deviceScope?: string | null;
		}>;
		/** Global command blacklist — commands auto-denied for all narrators. */
		commandBlacklist?: Array<{
			pattern: string;
			denyPrompt?: string;
			enabled?: boolean;
			selector?: RuleTargetSelector;
			/** Legacy compatibility; canonical settings should use selector. */
			deviceScope?: string | null;
		}>;
		/** Default system prompt — used as base prompt for all narrators when their own systemPrompt is null. */
		defaultSystemPrompt?: string;
		/**
		 * Model aggregations — group models from different providers under a single virtual entry.
		 * Users can select an aggregation and route to a specific provider or use auto mode.
		 */
		modelAggregations?: ModelAggregation[];
		/**
		 * Ordered list of provider prefixes controlling display & merge order.
		 * Providers not listed are appended at the end in their default order.
		 */
		providerOrder?: string[];
		/**
		 * Platform-level providers (codex) that are disabled.
		 * Multi-instance providers use their own `disabled` field instead.
		 */
		disabledProviders?: string[];
		/** Browser proxy override for new sessions. Absent/"default" = global policy. */
		browserProxy?: ProxyOverride;
		/** Explicit pre-approval for Notification.send; never overrides read-only mode. */
		notificationPolicy?: { allowSend?: boolean };
		/** WebFetch permission policy. */
		webFetchPolicy?: {
			/** When true, all URLs are auto-allowed without user approval. */
			allowAll?: boolean;
			/** URL keyword whitelist — matching URLs are auto-allowed. */
			whitelist?: Array<{ pattern: string; enabled?: boolean }>;
			/** URL keyword blacklist — matching URLs are auto-denied (priority over whitelist). */
			blacklist?: Array<{ pattern: string; enabled?: boolean }>;
			/** Optional WebFetch proxy override. Absent/"default" = follow the global policy. */
			proxy?: ProxyOverride;
		};
		/**
		 * Context window management thresholds (percentage, 0–100).
		 * Split by model context window size: standard (≤600k) vs large (>600k).
		 * - compactStart: trigger context compaction at this percentage
		 */
		contextThresholds?: {
			standard: { compactStart: number };
			large: { compactStart: number };
		};
		/** Number of recent user/assistant turns kept after automatic history compact. */
		autoCompactKeepPairs?: number;
		/**
		 * When a narrator has an in-progress context compaction, whether a newly-sent
		 * user message is QUEUED until the compaction finishes instead of starting a
		 * turn right away. Default true.
		 *
		 * Queuing is the safe default because a turn started mid-compact runs against
		 * the history the compact is replacing. It is a real queue, not a blocking
		 * wait: the send returns immediately and the message stays editable and
		 * cancellable until the compact settles. Off = send immediately, concurrent
		 * with the compact. Either way, an explicit `priority` send cuts in.
		 */
		queueDuringCompaction?: boolean;
	};
	chapters: {
		maxActiveWorktrees: number;
		maxActiveContainers: number;
		worktreeSizeWarningMb: number;
		autoSaveOnDormant: boolean;
		dormantAfterMinutes: number;
		/**
		 * Whether tool calls / external edits capture content-addressed whole-tree
		 * snapshots of the workspace (the precise rollback boundary). When off, the
		 * snapshot scan never runs on the tool path and rollback degrades to per-file
		 * replay of recorded Write/Edit inputs. Structural captures (fork/merge/restore)
		 * are unaffected. Default true; hot-path captures also degrade automatically
		 * when a worktree proves too large to scan within the capture budget.
		 */
		treeSnapshotsEnabled: boolean;
	};
	containers: {
		portRangeStart: number;
		portRangeEnd: number;
		proxy: {
			enabled: boolean;
			port: number;
		};
	};
	editor: {
		type: "vscode" | "cursor" | "windsurf" | "zed";
		/** @deprecated Moved to `agent.legacyEncoding`. Kept for migration. */
		legacyEncoding?: boolean;
	};
	auth: {
		jwtSecret: string;
		registrationOpen: boolean;
		/**
		 * Reverse proxies whose forwarding headers may affect authentication
		 * throttling. Entries are exact IPs or CIDRs. Loopback is trusted by default.
		 */
		trustedProxyCidrs?: string[];
		/**
		 * Optional WebAuthn / passkey configuration. When omitted, the relying
		 * party ID and origin are derived from each request's Origin header, so
		 * passkeys work out of the box on localhost and LAN hostnames without any
		 * setup. Set these only to pin a specific domain in advanced deployments
		 * (e.g. behind a reverse proxy on a fixed hostname).
		 */
		webauthn?: {
			/** Relying Party ID (a domain, e.g. "narrafork.example.com"). */
			rpID?: string;
			/** Display name shown by authenticators. Defaults to "NarraFork". */
			rpName?: string;
			/** Allowed full origins (e.g. ["https://narrafork.example.com"]). */
			origins?: string[];
		};
		/**
		 * Configured OpenID Connect (OIDC) identity providers for SSO. Each entry
		 * enables a "Sign in with …" option. Empty/omitted = SSO disabled.
		 */
		oidcProviders?: OidcProviderConfig[];
	};
	/** OAuth provider runtime configuration. */
	oauth?: {
		/** External OAuth access-token WebSocket controls and resource limits. */
		externalWebSocket?: OAuthExternalWebSocketSettings;
	};
	/**
	 * Codex (ChatGPT Pro/Plus) provider configuration.
	 * Credentials are managed separately in ~/.narrafork/codex-credentials.json.
	 */
	codex?: {
		/** Optional per-provider proxy override. Absent/"default" = follow the global policy. */
		proxy?: ProxyOverride;
		/** Load balancing mode: priority, balanced, or tier-balanced. */
		loadBalancingMode?: LoadBalancingMode;
		/** Account tier order used by tier-balanced mode. */
		tierOrder?: CodexPlanTier[];
		/** Default reasoning effort for Codex models when narrator reasoningEffort is unset. */
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
		/** Use WebSocket instead of HTTP for Codex connections (experimental, enabled by default). */
		useWebSocket?: boolean;
		/** Allow the native web_search tool to be sent to Codex models. Enabled by default. */
		useWebSearch?: boolean;
		/** Allow the native image_generation tool to be sent to Codex models. Enabled by default. */
		useImageGeneration?: boolean;
		/** Which User-Agent to present on Codex requests. Absent = codex CLI UA (emulation). */
		userAgentMode?: UserAgentMode;
		/** Custom User-Agent string, used when userAgentMode === "custom". */
		customUserAgent?: string;
		/** Additional request headers injected on Codex requests. */
		extraHeaders?: Record<string, string>;
	};
	/**
	 * Official reference price overrides, in USD per 1M tokens.
	 *
	 * The built-in table in `server/lib/model-pricing.ts` carries the published
	 * vendor list prices, but vendors change them faster than NarraFork ships
	 * releases. Keys are bare model IDs (`gpt-5.6-sol`, not `codex:gpt-5.6-sol`);
	 * omitted fields keep the built-in value, and an entry for a model that has
	 * no built-in row prices it from scratch.
	 */
	pricing?: {
		overrides?: Record<
			string,
			{ input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
		>;
	};
	/** Unified web search channel configuration. */
	search?: SearchSettings;
	/** Built-in routines configuration. */
	routines: {
		/** Globally disabled routine IDs (blacklist — all enabled by default). */
		disabledRoutines: string[];
		/** Explicitly enabled routine IDs (for routines with defaultEnabled: false). */
		enabledRoutines: string[];
		/**
		 * Three-position mode per optional tool routine: "manual" | "auto" | "resident".
		 *
		 * Authoritative when present; the two lists above are kept in sync as the
		 * legacy on/off projection (`resident` ↔ enabled, `manual` ↔ disabled) so
		 * older config files and readers stay correct. See `lib/routine-modes.ts`.
		 */
		toolModes?: Record<string, string>;
	};
	/** Canonical custom API providers shared by Anthropic/OpenAI/Codex-compatible protocols. */
	customApiProviders?: CustomApiProviderConfig[];
	/** Multiple OpenAI-compatible API providers (derived from customApiProviders). */
	openaiProviders?: OpenAIProviderConfig[];
	/** Anthropic native API providers (derived from customApiProviders). */
	anthropicProviders?: AnthropicProviderConfig[];
	/** NUG (Narrafork Unified Gateway) providers — unified AI gateway. */
	nugProviders?: NUGProviderConfig[];
	/** Google Gemini API providers — native generativelanguage.googleapis.com protocol. */
	geminiProviders?: GeminiProviderConfig[];
	/** External MCP server configurations. */
	mcpServers?: McpServerConfig[];
	/** Update source and download configuration. */
	update?: {
		/** Updates, release notes and helper downloads. Absent/default inherits the global proxy. */
		proxy?: ProxyOverride;
		/** Update source. Optional for legacy settings and mocks; defaults to GitHub. */
		source?: "github" | "update-server";
		/** GitHub repository slug (owner/repo), not a URL. */
		githubRepository?: string;
		/** Update server URL, retained when switching to GitHub. */
		serverUrl: string;
		/** Product ID for multi-product update servers. */
		product: string;
		/** Update channel: stable or beta. */
		channel: "stable" | "beta";
		/** Auto-check interval in minutes (0 to disable). */
		checkIntervalMinutes: number;
		/** Automatically download updates when available. */
		autoDownload: boolean;
	};
	/** Application-level virtual network relay for Bun-to-Bun communication. */
	vnet?: {
		enabled: boolean;
		/** Optional shared relay token for non-browser Bun applications. */
		relayToken?: string;
		/** Allow unauthenticated relay websocket connections. Disabled by default. */
		allowAnonymousRelay: boolean;
		maxPeersPerNetwork: number;
		maxMessageBytes: number;
		udp: {
			enabled: boolean;
			host: string;
			port: number;
		};
	};
	/** File sharing configuration (ShareFile tool). */
	shares?: {
		/** Default expiry time in hours for shared files (default: 24). */
		defaultExpiryHours: number;
		/** Maximum file/folder size in MB allowed for sharing (default: 4096). */
		maxFileSizeMb: number;
	};
	/** Remote executor devices — routing of file/command tools to remote machines. */
	devices?: {
		/** Global default execution device id. null/empty → local server. */
		globalDefaultDeviceId?: string | null;
		/** Per-RPC timeout in ms for remote tool operations (default: 120000). */
		rpcTimeoutMs: number;
		/** Max bytes a single RPC result/stream may carry (default: 10 MB). */
		maxRpcBytes: number;
		/** Max concurrent in-flight short RPCs per device (default: 64). */
		maxConcurrentRpcPerDevice: number;
		/** Internal one-time migration marker; preserves later operator overrides. */
		rpcConcurrencyDefaultsVersion?: number;
		/** File-transfer chunk size in bytes (default: 1 MiB). */
		transferChunkBytes: number;
		/** Parallel in-flight chunks within a single transfer (default: 4). */
		transferConcurrency: number;
		/** Max concurrent transfers per device (default: 2). */
		maxConcurrentTransfersPerDevice: number;
		/** Whole-file verification strategy for transfers (default: "crc32c"). */
		transferVerify: "crc32c" | "sha256" | "none";
		/** Default root directory for downloaded files. null → ~/.narrafork/transfers. */
		transfersDir: string | null;
		/**
		 * Allow the automated enrollment exchange over plaintext http when the server
		 * is reached at a private-network address (RFC 1918 / CGNAT / link-local /
		 * IPv6 ULA), not just over https or loopback.
		 *
		 * Off by default, and it must stay a deliberate choice rather than a
		 * convenience default. The one-line installer trades the old "script carries
		 * no credential" property for the ticket becoming the credential; with https
		 * that exchange is encrypted, and on http it is not. A LAN is a much higher
		 * bar than the open internet, but "higher" is not "encrypted", so enabling
		 * this accepts that the device key crosses the local network in the clear
		 * once, at enrollment.
		 *
		 * Public hostnames are never covered by this: no matter what this is set to,
		 * plaintext http on a routable address refuses to hand out a key.
		 */
		allowPlaintextEnrollmentOnPrivateNetwork?: boolean;
	};
}

export interface FieldDoc {
	desc: string;
	type: string;
	valid?: string;
}
