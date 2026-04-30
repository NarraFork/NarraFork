/**
 * Settings type definitions — all interfaces for NarraFork configuration.
 * Extracted from the monolithic settings/index.ts for better modularity.
 */

export interface ModelOption {
	value: string;
	label: string;
	provider?: string;
}

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
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
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
	defaultReasoningEffort?: "none" | "low" | "medium" | "high";
	/** Optional HTTPS proxy URL for all requests to this provider. */
	proxy?: string;
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
}

	/** Unique short ID (8 chars). */
	id: string;
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	prefix: string;
	apiKey: string;
	baseUrl: string;
	/** Default model (bare name without prefix). */
	defaultModel: string;
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
}

export interface ClineProviderConfig {
	/** Unique short ID (8 chars, nanoid). */
	id: string;
	/** User-defined display name, e.g. "Cline", "Cline Production". */
	name: string;
	/** Whether this provider is disabled (keeps config but excluded from resolution). */
	disabled?: boolean;
	/** Provider prefix used in model IDs, e.g. "cline". */
	prefix: string;
	/** Cline API base URL, e.g. "https://openrouter.ai/api/v1". */
	baseUrl: string;
	/** OAuth access token (workos: prefix will be added automatically). */
	accessToken?: string;
	/** Default model (bare name without prefix). */
	defaultModel: string;
	/** Default context window size (tokens) for models in this provider. */
	defaultContextWindow?: number;
	/** User-selected models from the OpenRouter pool. Only these are available for use. */
	enabledModels?: string[];
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
	/** Permission behavior: "allow" auto-approves, "ask" requires user approval, "deny" auto-rejects. */
	behavior: "allow" | "ask" | "deny";
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
	defaultBehavior?: "allow" | "ask" | "deny";
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

export interface NarraForkSettings {
	server: {
		port: number;
		host: string;
		/** Browser launch behaviour on server start: "off" | "browser" | "app" */
		openBrowser: "off" | "browser" | "app";
		/** Optional TLS configuration for HTTPS. */
		tls?: TlsConfig;
	};
	paths: { defaultProjectDir: string };
	agent: {
		defaultModel: string;
		defaultPermissionMode: string;
		summaryModel: string;
		customModels: ModelOption[];
		hiddenModels: string[];
		maxTurns: number;
		subagentModels: {
			explore: string;
			plan: string;
		};
		/** Per-type allowed model pools for subagents. Empty array = no restriction. */
		subagentAllowedModels: {
			explore: string[];
			plan: string[];
			general: string[];
		};
		legacyEncoding: boolean;
		/**
		 * Per-model context window overrides (tokens).
		 * Key is the full model value ("provider:modelId"), value is the context window size.
		 * Takes highest priority in getModelContextWindow().
		 */
		modelContextWindows: Record<string, number>;
		/** Translate reasoning/thinking blocks via summaryModel after each block completes. */
		translateReasoning: boolean;
		/** Default value for the relaxed plan toggle on new narrators. */
		defaultRelaxedPlan: boolean;
		/**
		 * Global default reasoning effort — lowest priority fallback.
		 * Fallback chain: narrator.reasoningEffort → provider.defaultReasoningEffort → agent.defaultReasoningEffort.
		 */
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
		/** Use login shell for Bash tool to source fresh environment variables instead of inheriting server process env. */
		freshShellEnv: boolean;
		/** Persist raw request/response dumps for each provider call into usage history. */
		requestDumpEnabled: boolean;
		/** Maximum size (bytes) for raw dump body text. Default 1MB. Set to -1 for unlimited. */
		requestDumpMaxSize: number;
		/** Smart output interruption check — auto-detect and retry interrupted model output. */
		smartInterruptionCheck: boolean;
		/** Maximum retries for recoverable (transient) API errors. -1 = infinite. */
		maxTransientRetries: number;
		/** Maximum backoff delay (ms) for transient-error retries. Default 20000 (20s). */
		retryBackoffCeilMs: number;
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
			accessLevel: "readOnly" | "readWrite" | "full";
			enabled?: boolean;
		}>;
		/** Global blacklist directories — merged with project and narrator level. */
		blacklistDirs?: Array<{
			path: string;
			denyLevel: "denyWrite" | "denyAll";
			enabled?: boolean;
		}>;
		/** Global command whitelist — commands auto-allowed for all narrators. */
		commandWhitelist?: Array<{
			pattern: string;
			enabled?: boolean;
		}>;
		/** Global command blacklist — commands auto-denied for all narrators. */
		commandBlacklist?: Array<{
			pattern: string;
			denyPrompt?: string;
			enabled?: boolean;
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
		 * Multi-instance providers use their own `disabled` field instead.
		 */
		disabledProviders?: string[];
		/** WebFetch permission policy. */
		webFetchPolicy?: {
			/** When true, all URLs are auto-allowed without user approval. */
			allowAll?: boolean;
			/** URL keyword whitelist — matching URLs are auto-allowed. */
			whitelist?: Array<{ pattern: string; enabled?: boolean }>;
			/** URL keyword blacklist — matching URLs are auto-denied (priority over whitelist). */
			blacklist?: Array<{ pattern: string; enabled?: boolean }>;
			/** Proxy configuration for WebFetch HTTP requests and browser. */
			proxy?: {
				/**
				 * Proxy mode:
				 * - "direct": no proxy
				 * - "system": auto-detect from HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars
				 * - "custom": use the manually specified URL
				 */
				mode: "direct" | "system" | "custom";
				/** Proxy URL, only used when mode is "custom". */
				url?: string;
			};
		};
		/**
		 * Context window management thresholds (percentage, 0–100).
		 * Split by model context window size: standard (≤600k) vs large (>600k).
		 * - pruneStart: begin progressive message pruning at this percentage
		 * - compactStart: trigger context compaction at this percentage
		 */
		contextThresholds?: {
			standard: { pruneStart: number; compactStart: number };
			large: { pruneStart: number; compactStart: number };
		};
	};
	chapters: {
		maxActiveWorktrees: number;
		maxActiveContainers: number;
		worktreeSizeWarningMb: number;
		autoSaveOnDormant: boolean;
		dormantAfterMinutes: number;
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
	};
		credentialsPath: string;
		configPath: string;
		defaultModel?: string;
		proxy?: string;
	};
	/**
	 * Codex (ChatGPT Pro/Plus) provider configuration.
	 * Credentials are managed separately in ~/.narrafork/codex-credentials.json.
	 */
	codex?: {
		/** Default HTTPS proxy for all Codex requests (can be overridden per-credential). */
		proxy?: string;
		/** Load balancing mode: "priority" (use highest priority) or "balanced" (round-robin). */
		loadBalancingMode?: "priority" | "balanced";
		/** Default reasoning effort for Codex models when narrator reasoningEffort is unset. */
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
		/** Use WebSocket instead of HTTP for Codex connections (experimental, enabled by default). */
		useWebSocket?: boolean;
	};
	/** Built-in routines configuration. */
	routines: {
		/** Globally disabled routine IDs (blacklist — all enabled by default). */
		disabledRoutines: string[];
		/** Explicitly enabled routine IDs (for routines with defaultEnabled: false). */
		enabledRoutines: string[];
	};
	/** Multiple OpenAI-compatible API providers. */
	openaiProviders?: OpenAIProviderConfig[];
	/** Anthropic native API providers. */
	anthropicProviders?: AnthropicProviderConfig[];
	/** NUG (Narrafork Unified Gateway) providers — unified AI gateway. */
	nugProviders?: NUGProviderConfig[];
	/** Cline API providers — OpenRouter-compatible with OAuth authentication. */
	clineProviders?: ClineProviderConfig[];
	/** External MCP server configurations. */
	mcpServers?: McpServerConfig[];
	/** Delta update configuration. */
	update?: {
		/** Update server URL. */
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
	/** File sharing configuration (ShareFile tool). */
	shares?: {
		/** Default expiry time in hours for shared files (default: 24). */
		defaultExpiryHours: number;
		/** Maximum file/folder size in MB allowed for sharing (default: 4096). */
		maxFileSizeMb: number;
	};
}

export interface FieldDoc {
	desc: string;
	type: string;
	valid?: string;
}
