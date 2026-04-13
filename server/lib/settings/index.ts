import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getCodexManager, migrateLegacyCodexOAuth } from "../codex-manager";

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

const DEFAULTS: NarraForkSettings = {
	server: { port: 7778, host: "localhost", openBrowser: "browser" },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	agent: {
		defaultPermissionMode: "acceptEdits",
		customModels: [],
		hiddenModels: [],
		maxTurns: 200,
		subagentModels: {
			explore: "",
			plan: "",
		},
		subagentAllowedModels: {
			explore: [],
			plan: [],
			general: [],
		},
		legacyEncoding: false,
		freshShellEnv: false,
		requestDumpEnabled: false,
		requestDumpMaxSize: 1024 * 1024, // 1MB
		modelContextWindows: {},
		translateReasoning: false,
		defaultRelaxedPlan: false,
		smartInterruptionCheck: true,
		maxTransientRetries: 10,
		retryBackoffCeilMs: 20_000,
	},
	chapters: {
		maxActiveWorktrees: 10,
		maxActiveContainers: 5,
		worktreeSizeWarningMb: 500,
		autoSaveOnDormant: true,
		dormantAfterMinutes: 0,
	},
	containers: {
		portRangeStart: 10000,
		portRangeEnd: 20000,
		proxy: {
			enabled: false,
			port: 7780,
		},
	},
	editor: {
		type: "vscode",
	},
	auth: {
		jwtSecret: "",
		registrationOpen: true,
	},
	routines: {
		disabledRoutines: [],
		enabledRoutines: [],
	},
	codex: {
		// codex-reversed 显示官方默认 reasoning level 为 medium，避免默认 high 过快消耗额度。
		defaultReasoningEffort: "medium",
		useWebSocket: true,
	},
	update: {
		serverUrl: "https://narrafork-update.b.domexie.cn",
		product: "narrafork",
		channel: "stable",
		checkIntervalMinutes: 60,
		autoDownload: false,
	},
	shares: {
		defaultExpiryHours: 24,
		maxFileSizeMb: 4096,
	},
};

// ---------------------------------------------------------------------------
// Per-field documentation (dot-path → description)
// ---------------------------------------------------------------------------

export interface FieldDoc {
	desc: string;
	type: string;
	valid?: string;
}

/**
 * Runtime documentation for every leaf setting, keyed by dot-path.
 * Kept alongside DEFAULTS so changes stay in sync.
 */
export const SETTING_DOCS: Record<string, FieldDoc> = {
	// ── server ──────────────────────────────────────────────────────────
	"server.port": {
		desc: "服务器监听端口。重启后生效。",
		type: "number",
	},
	"server.host": {
		desc: '服务器监听地址。"localhost" 仅本机访问，"0.0.0.0" 允许局域网访问。重启后生效。',
		type: "string",
	},
	"server.openBrowser": {
		desc: '服务器启动时是否自动打开浏览器。"off" 不打开，"browser" 打开浏览器标签，"app" 打开 PWA 窗口。',
		type: "string",
		valid: '"off" | "browser" | "app"',
	},
	"server.tls.enabled": {
		desc: "是否启用 HTTPS。启用后需要配置 certFile 和 keyFile。",
		type: "boolean",
	},
	"server.tls.certFile": {
		desc: "PEM 格式 TLS 证书文件路径。",
		type: "string",
	},
	"server.tls.keyFile": {
		desc: "PEM 格式 TLS 私钥文件路径。",
		type: "string",
	},
	"server.tls.passphrase": {
		desc: "私钥密码（如果私钥已加密）。可选。",
		type: "string",
	},
	"server.tls.caFile": {
		desc: "CA 证书文件路径，覆盖系统默认信任的 CA。可选。",
		type: "string",
	},

	// ── paths ───────────────────────────────────────────────────────────
	"paths.defaultProjectDir": {
		desc: "默认项目目录。新建项目时的默认父目录。",
		type: "string",
	},

	// ── agent ───────────────────────────────────────────────────────────
	"agent.defaultModel": {
		type: "string",
	},
	"agent.defaultPermissionMode": {
		desc: "新建叙述者的默认权限模式。控制工具调用是否需要用户批准。",
		type: "string",
		valid:
			'"default"(每次询问) | "acceptEdits"(自动接受编辑) | "bypassPermissions"(跳过所有) | ' +
			'"readOnly"(只读) | "plan"(规划模式) | "dontAsk"(不询问)',
	},
	"agent.summaryModel": {
		desc: "用于生成摘要的模型。用于压缩上下文、翻译推理块等辅助任务。应选择速度快成本低的模型。",
		type: "string",
	},
	"agent.customModels": {
		desc: '自定义模型列表，添加到 UI 模型选择器。每项包含 value("provider:modelId")、label(显示名)、provider(可选)。',
		type: "array",
	},
	"agent.hiddenModels": {
		desc: "隐藏的模型列表。这些模型不会在 UI 模型选择器中显示，但仍可通过 API 使用。",
		type: "string[]",
	},
	"agent.maxTurns": {
		desc: "叙述者会话的最大轮次。达到后 agent loop 停止。范围 1-1000。在 80% 时会发送 wrap-up 提醒。",
		type: "number",
		valid: "1-1000, 默认 200",
	},
	"agent.subagentModels.explore": {
		desc: "explore 子代理的默认模型。空字符串表示使用全局 defaultModel。",
		type: "string",
	},
	"agent.subagentModels.plan": {
		desc: "plan 子代理的默认模型。空字符串表示使用全局 defaultModel。",
		type: "string",
	},
	"agent.subagentAllowedModels.explore": {
		desc: "explore 子代理允许的模型池。空数组表示无限制，可使用任何模型。",
		type: "string[]",
	},
	"agent.subagentAllowedModels.plan": {
		desc: "plan 子代理允许的模型池。空数组表示无限制。",
		type: "string[]",
	},
	"agent.subagentAllowedModels.general": {
		desc: "general 子代理允许的模型池。空数组表示无限制。",
		type: "string[]",
	},
	"agent.legacyEncoding": {
		desc: "启用非 UTF-8 编码检测（GBK、Shift_JIS 等）。启用后文件读写使用 chardet 自动检测并保留原始编码。禁用时仅使用 UTF-8。",
		type: "boolean",
	},
	"agent.freshShellEnv": {
		desc: "启用后 Bash 工具通过 login shell 加载最新环境变量，而非继承服务器进程环境。适用于服务器启动后修改了 shell 配置的场景。",
		type: "boolean",
	},
	"agent.requestDumpEnabled": {
		desc: "启用后为每次模型/API 请求持久化原始请求与响应 dump，可在管理员请求历史中查看完整原始数据。",
		type: "boolean",
	},
	"agent.requestDumpMaxSize": {
		desc: "Raw dump 响应体文本的最大字节数。默认 1MB (1048576)。设为 -1 表示不限制。超出部分会被截断并标记。",
		type: "number",
	},
	"agent.modelContextWindows": {
		desc: '按模型覆盖上下文窗口大小（tokens）。键为完整模型值 "provider:modelId"，值为 token 数。优先级最高。',
		type: "Record<string, number>",
	},
	"agent.translateReasoning": {
		desc: "启用后，每个 reasoning/thinking 块完成后自动通过 summaryModel 翻译成用户语言（非英文时）。",
		type: "boolean",
	},
	"agent.defaultRelaxedPlan": {
		desc: "新建叙述者的 relaxed plan 默认值。启用时 plan 模式下工具保持完全可用；禁用时 plan 模式限制为只读工具集合。",
		type: "boolean",
	},
	"agent.smartInterruptionCheck": {
		desc: "自动检测模型输出是否被截断/中断。通过启发式检查（末尾标点、代码块闭合）和 summaryModel 判断，决定是否自动重试生成。",
		type: "boolean",
	},
	"agent.maxTransientRetries": {
		desc: "可恢复的 API 错误最大重试次数。-1 表示无限重试。有状态提供商（Responses/Codex）不支持重试。",
		type: "number",
		valid: "-1 = 无限重试, 默认 10",
	},
	"agent.retryBackoffCeilMs": {
		desc: "可恢复错误重试退避时间上限（毫秒）。指数退避不会超过此值。默认 20000（20 秒）。",
		type: "number",
		valid: "正整数，默认 20000",
	},
	"agent.customRetryRules": {
		desc: "用户自定义可重试错误规则。匹配到的错误视为 transient 进行重试。每项含 id、domain(域名关键字)、statusCode、keyword、enabled、note。",
		type: "array",
	},
	"agent.whitelistDirs": {
		desc: '全局白名单目录。每项含 path、accessLevel("readOnly"|"readWrite"|"full")、enabled。与项目和叙述者级别合并。',
		type: "array",
	},
	"agent.blacklistDirs": {
		desc: '全局黑名单目录。优先级高于白名单。每项含 path、denyLevel("denyWrite"|"denyAll")、enabled。',
		type: "array",
	},
	"agent.commandWhitelist": {
		desc: "全局命令白名单。匹配的命令自动允许执行，无需用户确认。每项含 pattern(Bash 命令模式)、enabled。",
		type: "array",
	},
	"agent.commandBlacklist": {
		desc: "全局命令黑名单。匹配的命令自动拒绝。每项含 pattern、denyPrompt(拒绝提示)、enabled。",
		type: "array",
	},
	"agent.defaultSystemPrompt": {
		desc: "默认系统提示词。所有叙述者在自身 systemPrompt 为空时使用此值作为基础提示。",
		type: "string",
	},
	"agent.webFetchPolicy.allowAll": {
		desc: "为 true 时所有 URL 自动允许抓取，无需用户批准。",
		type: "boolean",
	},
	"agent.webFetchPolicy.whitelist": {
		desc: "URL 关键词白名单。匹配的 URL 自动允许。每项含 pattern、enabled。",
		type: "array",
	},
	"agent.webFetchPolicy.blacklist": {
		desc: "URL 关键词黑名单。优先级高于白名单。匹配的 URL 自动拒绝。每项含 pattern、enabled。",
		type: "array",
	},
	"agent.webFetchPolicy.proxy.mode": {
		desc: 'WebFetch 代理模式。"direct" 直连，"system" 从环境变量自动检测，"custom" 使用自定义 URL。',
		type: "string",
		valid: '"direct" | "system" | "custom"',
	},
	"agent.webFetchPolicy.proxy.url": {
		desc: '自定义代理 URL，仅 mode 为 "custom" 时使用。',
		type: "string",
	},
	"agent.contextThresholds.standard.pruneStart": {
		desc: "标准模型(≤600k tokens)开始渐进式消息剪枝的上下文使用百分比(0-100)。",
		type: "number",
	},
	"agent.contextThresholds.standard.compactStart": {
		desc: "标准模型触发上下文压缩的百分比(0-100)。达到此阈值时压缩旧消息。",
		type: "number",
	},
	"agent.contextThresholds.large.pruneStart": {
		desc: "大模型(>600k tokens)开始渐进式消息剪枝的百分比(0-100)。",
		type: "number",
	},
	"agent.contextThresholds.large.compactStart": {
		desc: "大模型触发上下文压缩的百分比(0-100)。",
		type: "number",
	},

	// ── chapters ────────────────────────────────────────────────────────
	"chapters.maxActiveWorktrees": {
		desc: "最大活跃 worktree 数量。超出时自动将最不活跃的章节休眠。≤0 禁用自动休眠。",
		type: "number",
		valid: "≥1, 默认 10",
	},
	"chapters.maxActiveContainers": {
		desc: "最大活跃容器数量。超出时新容器创建会被拒绝。",
		type: "number",
		valid: "≥0, 默认 5",
	},
	"chapters.worktreeSizeWarningMb": {
		desc: "Worktree 大小警告阈值(MB)。超出时向用户发出警告。0 表示禁用警告。",
		type: "number",
		valid: "≥0, 默认 500",
	},
	"chapters.autoSaveOnDormant": {
		desc: "章节休眠时是否自动 git commit 保存未提交的更改。",
		type: "boolean",
	},
	"chapters.dormantAfterMinutes": {
		desc: "章节不活跃多少分钟后自动休眠。0 表示禁用自动休眠（仅在超出 maxActiveWorktrees 时休眠）。",
		type: "number",
		valid: "≥0, 默认 0 (禁用)",
	},

	// ── containers ──────────────────────────────────────────────────────
	"containers.portRangeStart": {
		desc: "容器端口分配范围起始值。",
		type: "number",
	},
	"containers.portRangeEnd": {
		desc: "容器端口分配范围结束值。",
		type: "number",
	},
	"containers.proxy.enabled": {
		desc: "是否启用容器代理服务。代理将 Host 头匹配的请求路由到对应容器。",
		type: "boolean",
	},
	"containers.proxy.port": {
		desc: "容器代理服务监听端口。",
		type: "number",
	},

	// ── editor ──────────────────────────────────────────────────────────
	"editor.type": {
		desc: '默认编辑器类型。用于"在编辑器中打开"功能。',
		type: "string",
		valid: '"vscode" | "cursor" | "windsurf" | "zed"',
	},

	// ── auth ────────────────────────────────────────────────────────────
	"auth.registrationOpen": {
		desc: "是否允许新用户注册。false 时禁用注册（首个注册的用户始终为管理员）。",
		type: "boolean",
	},

	// ── routines ────────────────────────────────────────────────────────
	"routines.disabledRoutines": {
		desc: '全局禁用的例程 ID 黑名单。列表中的例程对所有项目禁用。例程 ID 如 "terminal"、"share_file"、"recall" 等。',
		type: "string[]",
	},
	"routines.enabledRoutines": {
		desc: "全局启用的例程 ID 白名单。用于显式启用默认关闭的例程（defaultEnabled: false 的例程）。",
		type: "string[]",
	},

	// ── codex ───────────────────────────────────────────────────────────
	"codex.proxy": {
		desc: "所有 Codex 请求的 HTTPS 代理 URL。可选。",
		type: "string",
	},
	"codex.loadBalancingMode": {
		desc: '多凭证时的负载均衡策略。"priority" 使用最高优先级凭证，"balanced" 轮询。',
		type: "string",
		valid: '"priority" | "balanced"',
	},
	"codex.defaultReasoningEffort": {
		desc: "Codex 模型默认推理努力级别。越高推理越深入但消耗更多 token。",
		type: "string",
		valid: '"none" | "low" | "medium" | "high" | "xhigh"',
	},
	"codex.useWebSocket": {
		desc: "使用 Responses WebSocket 而非 HTTP 连接到 Codex（实验性功能，默认开启，失败时会自动回退 HTTP）。",
		type: "boolean",
	},

	// ── update ──────────────────────────────────────────────────────────
	"update.serverUrl": {
		desc: "更新服务器 URL。",
		type: "string",
	},
	"update.product": {
		desc: "产品 ID，用于多产品更新服务器区分。",
		type: "string",
	},
	"update.channel": {
		desc: '更新通道。"stable" 稳定版，"beta" 测试版。',
		type: "string",
		valid: '"stable" | "beta"',
	},
	"update.checkIntervalMinutes": {
		desc: "自动检查更新的间隔（分钟）。0 表示禁用自动检查。",
		type: "number",
	},
	"update.autoDownload": {
		desc: "检测到新版本时是否自动下载。下载后仍需用户确认安装。",
		type: "boolean",
	},

	// ── shares ──────────────────────────────────────────────────────────
	"shares.defaultExpiryHours": {
		desc: "共享文件的默认过期时间（小时）。过期后下载链接失效。",
		type: "number",
	},
	"shares.maxFileSizeMb": {
		desc: "允许共享的最大文件/文件夹大小（MB）。",
		type: "number",
	},
};

// Development-time completeness check: warn if SETTING_DOCS misses any DEFAULTS leaf
if (process.env.NODE_ENV !== "production") {
	function collectLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
		const paths: string[] = [];
		for (const key of Object.keys(obj)) {
			const path = prefix ? `${prefix}.${key}` : key;
			const val = obj[key];
			if (
				val !== null &&
				typeof val === "object" &&
				!Array.isArray(val) &&
				!(val instanceof Date)
			) {
				paths.push(...collectLeafPaths(val as Record<string, unknown>, path));
			} else {
				paths.push(path);
			}
		}
		return paths;
	}
	const defaultLeaves = collectLeafPaths(DEFAULTS as unknown as Record<string, unknown>);
	const docKeys = new Set(Object.keys(SETTING_DOCS));
	const missing = defaultLeaves.filter((p) => !docKeys.has(p));
	if (missing.length > 0) {
		console.warn(`[settings] SETTING_DOCS missing entries for: ${missing.join(", ")}`);
	}
}

export const narraforkDir = resolve(homedir(), ".narrafork");
const settingsPath = resolve(narraforkDir, "settings.json");

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
export function deepMerge<T extends Record<string, any>>(
	defaults: T,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	overrides: Record<string, any>,
): T {
	const result = { ...defaults };
	for (const key of Object.keys(overrides)) {
		const val = overrides[key];
		if (val && typeof val === "object" && !Array.isArray(val) && key in defaults) {
			result[key as keyof T] = deepMerge(
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				defaults[key as keyof T] as Record<string, any>,
				val,
			) as T[keyof T];
		} else {
			result[key as keyof T] = val;
		}
	}
	return result;
}

/**
 * Load settings from disk, with migrations.
 * After initial load, returns the in-memory cache to avoid repeated disk I/O.
 * Use `reloadSettings()` to force a re-read from disk.
 */
export function loadSettings(): NarraForkSettings {
	// Return cached settings if already loaded (avoids EMFILE on Windows)
	if (_cache.current) return _cache.current;
	return loadSettingsFromDisk();
}

/**
 * Force re-read settings from disk, bypassing the in-memory cache.
 * Use this after external modifications to settings.json.
 */
export function reloadSettings(): NarraForkSettings {
	const fresh = loadSettingsFromDisk();
	if (_cache.current) {
		for (const key of Object.keys(fresh) as Array<keyof NarraForkSettings>) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(_cache.current as any)[key] = fresh[key];
		}
	} else {
		_cache.current = fresh;
	}
	// biome-ignore lint/style/noNonNullAssertion: guaranteed non-null after assignment above
	return _cache.current!;
}

function loadSettingsFromDisk(): NarraForkSettings {
	mkdirSync(narraforkDir, { recursive: true });
	if (!existsSync(settingsPath)) {
		writeFileSync(settingsPath, JSON.stringify(DEFAULTS, null, 2));
	}
	const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
	const merged = deepMerge(DEFAULTS, raw);

	let needsSave = false;

	// Auto-generate JWT secret on first run
	if (!merged.auth.jwtSecret) {
		merged.auth.jwtSecret = randomBytes(32).toString("hex");
		needsSave = true;
	}

	// Migrate editor.legacyEncoding → agent.legacyEncoding
	if (raw.editor?.legacyEncoding === true && !raw.agent?.legacyEncoding) {
		merged.agent.legacyEncoding = true;
		delete (merged.editor as Record<string, unknown>).legacyEncoding;
		needsSave = true;
	}

	// Migrate legacy single openai config → openaiProviders array
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON migration
	const mergedAny = merged as any;
	if (mergedAny.openai?.apiKey && !merged.openaiProviders?.length) {
		const legacyId = generateMigrationId();
		merged.openaiProviders = [
			{
				id: legacyId,
				name: "OpenAI",
				prefix: "openai",
				apiKey: mergedAny.openai.apiKey,
				baseUrl: mergedAny.openai.baseUrl || "",
				defaultModel: mergedAny.openai.defaultModel || "",
				responsesApi: mergedAny.openai.responsesApi,
				apiMode: mergedAny.openai.apiMode,
				codexAccountId: mergedAny.openai.codexAccountId,
			},
		];
		needsSave = true;
	}

	// Migrate providers without prefix field (added in multi-provider update)
	if (merged.openaiProviders?.length) {
		let migrated = false;
		for (const p of merged.openaiProviders) {
			if (!p.prefix) {
				p.prefix = "openai";
				migrated = true;
			}
		}
		if (migrated) needsSave = true;
	}

	// Normalize nullable codex.defaultReasoningEffort from legacy values
	if (
		(merged.codex as { defaultReasoningEffort?: string | null } | undefined)
			?.defaultReasoningEffort === null
	) {
		if (merged.codex) {
			delete (merged.codex as { defaultReasoningEffort?: string }).defaultReasoningEffort;
		}
		needsSave = true;
	}

	// Clean up legacy openai field from settings.json
	if (mergedAny.openai !== undefined) {
		delete mergedAny.openai;
		needsSave = true;
	}

	// Migrate subagentAllowedModels from flat string[] to per-type object.
	// Old format: string[] — applied uniformly to all subagent types.
	// New format: { explore: string[], plan: string[], general: string[] }
	const rawPool = raw.agent?.subagentAllowedModels;
	if (Array.isArray(rawPool)) {
		merged.agent.subagentAllowedModels = {
			explore: [...rawPool],
			plan: [...rawPool],
			general: [...rawPool],
		};
		needsSave = true;
	}

	// Migrate legacy per-provider codexOAuth to centralized credential pool
	// biome-ignore lint/suspicious/noExplicitAny: migration needs to read removed fields
	const legacyProviders = merged.openaiProviders?.filter((p: any) => p.codexOAuth) as
		| Array<{ codexOAuth?: { refreshToken: string }; codexProxy?: string }>
		| undefined;
	if (legacyProviders?.length) {
		migrateLegacyCodexOAuth(legacyProviders);
		// Clean up codexOAuth and codexProxy from providers
		for (const p of merged.openaiProviders ?? []) {
			// biome-ignore lint/suspicious/noExplicitAny: migration needs to delete removed fields
			if ((p as any).codexOAuth) {
				// biome-ignore lint/suspicious/noExplicitAny: migration needs to delete removed fields
				delete (p as any).codexOAuth;
				// biome-ignore lint/suspicious/noExplicitAny: migration needs to delete removed fields
				delete (p as any).codexProxy;
				needsSave = true;
			}
		}
	}

	// Clean up agent fields that reference models from providers no longer in settings.
	const activePrefixes = new Set<string>();
	for (const prov of merged.openaiProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.anthropicProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.nugProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	for (const prov of merged.clineProviders ?? []) {
		if (prov.prefix) activePrefixes.add(prov.prefix);
	}
	// Also allow built-in providers that have no provider config

	if (purgeStaleAgentModelRefs(merged, (prefix) => !activePrefixes.has(prefix))) {
		needsSave = true;
	}

	if (needsSave) saveSettings(merged);

	return merged;
}

/** Simple 8-char random ID for migration (avoids importing nanoid at this level). */
function generateMigrationId(): string {
	return randomBytes(6).toString("base64url").slice(0, 8);
}

/**
 * Purge stale model references from agent settings.
 * `isPrefixStale` receives the prefix portion of a model value (before ":") and
 * returns true if that prefix should be considered stale.
 * Mutates `settings.agent` in place. Returns true if any field was changed.
 * Cleans: summaryModel, subagentModels, hiddenModels, modelContextWindows, customModels.
 */
export function purgeStaleAgentModelRefs(
	settings: NarraForkSettings,
	isPrefixStale: (prefix: string) => boolean,
): boolean {
	const isStale = (val: string | undefined): boolean => {
		if (!val) return false;
		const prefix = val.split(":")[0];
		return !!prefix && isPrefixStale(prefix);
	};

	let dirty = false;
	if (isStale(settings.agent.summaryModel)) {
		settings.agent.summaryModel = "";
		dirty = true;
	}
	for (const key of ["explore", "plan"] as const) {
		if (isStale(settings.agent.subagentModels[key])) {
			settings.agent.subagentModels[key] = "";
			dirty = true;
		}
	}
	const origHidden = settings.agent.hiddenModels ?? [];
	const cleanedHidden = origHidden.filter((m) => !isStale(m));
	if (cleanedHidden.length !== origHidden.length) {
		settings.agent.hiddenModels = cleanedHidden;
		dirty = true;
	}
	const origWindows = settings.agent.modelContextWindows ?? {};
	const cleanedWindows: Record<string, number> = {};
	for (const [k, v] of Object.entries(origWindows)) {
		if (!isStale(k)) cleanedWindows[k] = v;
	}
	if (Object.keys(cleanedWindows).length !== Object.keys(origWindows).length) {
		settings.agent.modelContextWindows = cleanedWindows;
		dirty = true;
	}
	const origCustom = settings.agent.customModels ?? [];
	const cleanedCustom = origCustom.filter((m) => !isStale(m.value));
	if (cleanedCustom.length !== origCustom.length) {
		settings.agent.customModels = cleanedCustom;
		dirty = true;
	}
	return dirty;
}

/** Internal mutable holder — `settings` re-exports its properties via the proxy-like sync in saveSettings. */
const _cache: { current: NarraForkSettings | null } = { current: null };

export function saveSettings(newSettings: NarraForkSettings): void {
	mkdirSync(narraforkDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2));
	// Sync in-memory cache so all modules see the updated values immediately
	if (_cache.current) {
		for (const key of Object.keys(newSettings) as Array<keyof NarraForkSettings>) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(_cache.current as any)[key] = newSettings[key];
		}
	}
}

export const settings: NarraForkSettings = loadSettings();
_cache.current = settings;

/** Returns a copy of the default settings (for reset / comparison). */
export function getDefaults(): NarraForkSettings {
	return structuredClone(DEFAULTS);
}

	"claude-haiku-4.5",
	"claude-sonnet-4.5",
	"claude-opus-4.5",
	"claude-opus-4.6",
	// Legacy short names (for resolveProvider backward compat)
	"claude-haiku",
	"claude-sonnet",
	"claude-opus",
];
const BUILTIN_CODEX_MODELS = [
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.2",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
];

/** Built-in Codex model IDs (without provider prefix). */
export function getBuiltinCodexModels(): string[] {
	return [...BUILTIN_CODEX_MODELS];
}

/** Registry for external model checkers and listers (avoids circular imports). */
let openaiModelChecker: ((model: string) => boolean) | null = null;
let anthropicModelChecker: ((model: string) => boolean) | null = null;
let codexModelChecker: ((model: string) => boolean) | null = null;
let nugModelChecker: ((model: string) => boolean) | null = null;
let clineModelChecker: ((model: string) => boolean) | null = null;
let openaiModelLister: (() => string[]) | null = null;
let anthropicModelLister: (() => string[]) | null = null;
let codexModelLister: (() => string[]) | null = null;
let nugModelLister: (() => string[]) | null = null;
let clineModelLister: (() => string[]) | null = null;

// Register codex model checker and lister immediately
registerCodexModelChecker((model) => BUILTIN_CODEX_MODELS.includes(model));
registerCodexModelLister(() => BUILTIN_CODEX_MODELS.map((m) => `codex:${m}`));

export function registerOpenaiModelChecker(checker: (model: string) => boolean): void {
	openaiModelChecker = checker;
}

}

export function registerOpenaiModelLister(lister: () => string[]): void {
	openaiModelLister = lister;
}

}

export function registerAnthropicModelChecker(checker: (model: string) => boolean): void {
	anthropicModelChecker = checker;
}

export function registerAnthropicModelLister(lister: () => string[]): void {
	anthropicModelLister = lister;
}

export function registerCodexModelChecker(checker: (model: string) => boolean): void {
	codexModelChecker = checker;
}

export function registerCodexModelLister(lister: () => string[]): void {
	codexModelLister = lister;
}

}

}

export function registerNugModelChecker(checker: (model: string) => boolean): void {
	nugModelChecker = checker;
}

export function registerNugModelLister(lister: () => string[]): void {
	nugModelLister = lister;
}

export function registerClineModelChecker(checker: (model: string) => boolean): void {
	clineModelChecker = checker;
}

export function registerClineModelLister(lister: () => string[]): void {
	clineModelLister = lister;
}

/**
 * Sentinel value stored in `narrators.model` to indicate "follow the default model from settings".
 * When the user changes `settings.agent.defaultModel`, narrators with this value automatically
 * pick up the new default on their next session start.
 */
export const FOLLOW_DEFAULT_MODEL = "__default__";

/**
 * Resolve the effective model string.  If the stored value is null, undefined,
 * or the `__default__` sentinel, fall back to `settings.agent.defaultModel`.
 */
export function resolveEffectiveModel(model: string | null | undefined): string {
	if (!model || model === FOLLOW_DEFAULT_MODEL) return settings.agent.defaultModel;
	return model;
}

/**
 * Get all available model values (provider:id format), excluding hidden models.
 */
export function getVisibleModels(): string[] {
	const hidden = new Set(settings.agent.hiddenModels ?? []);
	const openai = openaiModelLister?.() ?? [];
	const anthropic = anthropicModelLister?.() ?? [];
	const codex = codexModelLister?.() ?? [];
	const nug = nugModelLister?.() ?? [];
	const cline = clineModelLister?.() ?? [];
	const custom = (settings.agent.customModels ?? []).map((m) => m.value);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const v of [
		...openai,
		...anthropic,
		...codex,
		...nug,
		...cline,
		...custom,
	]) {
		if (!seen.has(v) && !hidden.has(v)) {
			seen.add(v);
			result.push(v);
		}
	}
	return result;
}

/**
 * Parse a model string that may contain a "provider:" prefix.
 * Supports any provider prefix that is alphanumeric + hyphen + underscore.
 * Examples:
 *   "openai:gpt-4o"           → { provider: "openai", model: "gpt-4o" }
 *   "deepseek:deepseek-chat"  → { provider: "deepseek", model: "deepseek-chat" }
 *   "gpt-4o"                  → { provider: undefined, model: "gpt-4o" }
 */
export function parseModelId(raw?: string): { provider?: string; model: string } {
	if (!raw) return { model: "" };
	const idx = raw.indexOf(":");
	if (idx > 0) {
		const prefix = raw.slice(0, idx);
		if (/^[a-zA-Z0-9_-]+$/.test(prefix)) {
			return { provider: prefix, model: raw.slice(idx + 1) };
		}
	}
	return { model: raw };
}

/**
 * Get the OpenAI provider config by its prefix.
 * If prefix is undefined, returns the first provider (legacy compat).
 */
export function getOpenaiProviderConfig(prefix?: string): OpenAIProviderConfig | undefined {
	const providers = (settings.openaiProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/** Whether a provider uses Codex API mode and supports Codex-only controls. */
export function usesCodexApiMode(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	return getOpenaiProviderConfig(prefix)?.apiMode === "codex";
}

/**
 * Whether a provider uses a stateful server-side conversation (Responses API).
 * Stateful providers cannot safely retry the same API call because the server
 * already consumed the previous request and advanced its internal state.
 *
 * `prefix === "codex"` is hard-coded because Codex uses a dedicated config path
 * (not the openaiProviders array), so `getOpenaiProviderConfig("codex")` would
 * return undefined.  All other stateful providers are detected via `apiMode`.
 */
export function usesStatefulApi(prefix?: string): boolean {
	if (!prefix) return false;
	if (prefix === "codex") return true;
	const mode = getOpenaiProviderConfig(prefix)?.apiMode;
	return mode === "codex" || mode === "responses";
}

/** Whether a provider is an Anthropic provider (supports thinking/effort controls). */
export function isAnthropicProvider(prefix?: string): boolean {
	if (!prefix) return false;
	return !!getAnthropicProviderConfig(prefix);
}

/**
 * Resolve the default reasoning effort for a provider (two-level fallback).
 * 1. Provider-specific default (Codex or Anthropic provider config)
 * 2. Global default (agent.defaultReasoningEffort)
 * Returns undefined if no default is configured.
 */
export function resolveDefaultReasoningEffort(
	provider?: string,
): "none" | "low" | "medium" | "high" | "xhigh" | undefined {
	if (usesCodexApiMode(provider)) {
		return settings.codex?.defaultReasoningEffort ?? settings.agent.defaultReasoningEffort;
	}
	if (isAnthropicProvider(provider)) {
		return (
			getAnthropicProviderConfig(provider)?.defaultReasoningEffort ??
			settings.agent.defaultReasoningEffort
		);
	}
	return settings.agent.defaultReasoningEffort;
}

/**
 * Get the provider prefix for a given OpenAI provider config.
 * Simply returns the config's prefix field.
 */
export function openaiProviderPrefix(config: OpenAIProviderConfig): string {
	return config.prefix;
}

/**
 * Get the Anthropic provider config by its prefix.
 * If prefix is undefined, returns the first provider.
 */
export function getAnthropicProviderConfig(prefix?: string): AnthropicProviderConfig | undefined {
	const providers = (settings.anthropicProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/**
 * Get the provider prefix for a given Anthropic provider config.
 * Simply returns the config's prefix field.
 */
export function anthropicProviderPrefix(config: AnthropicProviderConfig): string {
	return config.prefix;
}

/**
 * If prefix is undefined, returns the first provider.
 */
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

	return config.prefix;
}

/**
 * Get the NUG provider config by its prefix.
 * If prefix is undefined, returns the first provider.
 */
export function getNugProviderConfig(prefix?: string): NUGProviderConfig | undefined {
	const providers = (settings.nugProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/** Get the provider prefix for a given NUG provider config. */
export function nugProviderPrefix(config: NUGProviderConfig): string {
	return config.prefix;
}

/**
 * Get the Cline provider config by its prefix.
 * If prefix is undefined, returns the first provider.
 */
export function getClineProviderConfig(prefix?: string): ClineProviderConfig | undefined {
	const providers = (settings.clineProviders ?? []).filter((p) => !p.disabled);
	if (!prefix) return providers[0];
	return providers.find((p) => p.prefix === prefix);
}

/** Get the provider prefix for a given Cline provider config. */
export function clineProviderPrefix(config: ClineProviderConfig): string {
	return config.prefix;
}

export function hasConfiguredClineProvider(): boolean {
	const providers = settings.clineProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.accessToken);
}

function hasConfiguredOpenaiProvider(): boolean {
	const providers = settings.openaiProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

function hasConfiguredAnthropicProvider(): boolean {
	const providers = settings.anthropicProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey);
}

}

function hasConfiguredCodexProvider(): boolean {
	if (!settings.codex) return false;
	try {
		return getCodexManager().availableCount > 0;
	} catch {
		return false;
	}
}

	return providers.some((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

}

export function hasConfiguredNugProvider(): boolean {
	const providers = settings.nugProviders ?? [];
	return providers.some((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

/** Get the first configured NUG provider. */
export function getFirstNugProvider(): NUGProviderConfig | undefined {
	return (settings.nugProviders ?? []).find((p) => !p.disabled && !!p.apiKey && !!p.baseUrl);
}

function getConfiguredProviderCandidates(): string[] {
	const available = new Set<string>();
	if (hasConfiguredOpenaiProvider()) {
		for (const p of settings.openaiProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "openai");
		}
	}
	if (hasConfiguredAnthropicProvider()) {
		for (const p of settings.anthropicProviders ?? []) {
			if (!p.disabled && p.apiKey) available.add(p.prefix || "anthropic");
		}
	}
	if (hasConfiguredCodexProvider()) {
		available.add("codex");
	}
		}
	}
	if (hasConfiguredNugProvider()) {
		for (const p of settings.nugProviders ?? []) {
			if (!p.disabled && p.apiKey && p.baseUrl) available.add(p.prefix || "nug");
		}
	}
	}
	if (hasConfiguredClineProvider()) {
		for (const p of settings.clineProviders ?? []) {
			if (!p.disabled && p.accessToken) available.add(p.prefix || "cline");
		}
	}
	const result: string[] = [];

	const preferredOpenai = (settings.openaiProviders ?? []).find((p) => p.apiKey)?.prefix;
	if (preferredOpenai && available.has(preferredOpenai)) {
		result.push(preferredOpenai);
	}

	const preferredAnthropic = (settings.anthropicProviders ?? []).find((p) => p.apiKey)?.prefix;
	if (preferredAnthropic && available.has(preferredAnthropic)) {
		result.push(preferredAnthropic);
	}

	if (available.has("codex")) {
		result.push("codex");
	}

	}

	for (const provider of available) {
		if (!result.includes(provider)) result.push(provider);
	}
	return result;
}

/** Resolve provider name for a given model (supports "provider:model" prefix). */
export function resolveProvider(model?: string): string {
	const { provider: explicit, model: bare } = parseModelId(model);
	if (explicit) return explicit;

	if (bare) {
		if (BUILTIN_CODEX_MODELS.includes(bare)) return "codex";

		const custom = settings.agent.customModels ?? [];
		const found = custom.find((m) => m.value === bare || m.value === model);
		if (found?.provider) return found.provider;

		if (openaiModelChecker?.(bare)) return "openai";
		if (anthropicModelChecker?.(bare)) return "anthropic";
		if (codexModelChecker?.(bare)) return "codex";
		if (nugModelChecker?.(bare)) return "nug";
		if (clineModelChecker?.(bare)) return "cline";
	}

	const configured = getConfiguredProviderCandidates();
	if (configured.length > 0) {
		return configured[0];
	}

	// Preserve legacy fallback when no provider can be inferred.
}

// === Context Window Sizes ===

/**
 * Model context window configuration.
 * Reference: https://platform.openai.com/docs/models
 * Codex models reference: internal/registry/model_definitions_static_data.go
 */
interface ModelContextConfig {
	/**
	 * Total context window size (input + output tokens).
	 * This is the maximum total tokens the model can process in a single request.
	 */
	contextLength: number;
	/**
	 * Maximum output/completion tokens the model can generate in a single response.
	 * This is typically smaller than contextLength to leave room for input tokens.
	 * If not specified, defaults to contextLength (no separate output limit).
	 *
	 * Note: For Codex Responses API, max_completion_tokens parameter is not supported
	 * and will be stripped from requests. This value is for reference/display only.
	 */
	maxCompletionTokens?: number;
}

/**
 * Built-in model context window sizes (tokens).
 * For models with only contextLength specified, maxCompletionTokens defaults to contextLength.
 */
const BUILTIN_CONTEXT_WINDOWS: Record<string, number | ModelContextConfig> = {
	// OpenAI models
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	"gpt-4-turbo": 128_000,
	"gpt-4": 8_192,
	"gpt-3.5-turbo": 16_385,
	o1: 200_000,
	"o1-mini": 128_000,
	"o3-mini": 200_000,
	// Codex models (ChatGPT Pro/Plus)
	// Context windows here mirror the official model catalog exposed by codex-reversed.
	"gpt-5-codex": { contextLength: 256_000, maxCompletionTokens: 128_000 },
	// codex-reversed 内置 model catalog 显示这些模型的 context_window 为 272000。
	"gpt-5.1-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-max": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.1-codex-mini": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.2": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	"gpt-5.4-mini": { contextLength: 400_000, maxCompletionTokens: 128_000 },
	"gpt-5.3-codex": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	// Common third-party models (via OpenAI-compatible APIs)
	"deepseek-chat": 64_000,
	"deepseek-reasoner": 64_000,
	// Claude models (via OpenAI-compatible gateways)
	"claude-3-5-sonnet": 200_000,
	"claude-3-opus": 200_000,
	"claude-sonnet-4": 200_000,
	"claude-opus-4": 200_000,
	// Claude 4.6 models — 1M context (GA since 2026-03-11)
	"claude-sonnet-4-6": 1_000_000,
	"claude-opus-4-6": 1_000_000,
	"claude-sonnet-4.6": 1_000_000,
	"claude-opus-4.6": 1_000_000,
	// Anthropic native API models
	"claude-sonnet-4-20250514": 200_000,
	"claude-opus-4-20250514": 200_000,
	"claude-haiku-4-20250414": 200_000,
	"claude-3-5-sonnet-20241022": 200_000,
	"claude-3-5-haiku-20241022": 200_000,
	"claude-3-opus-20240229": 200_000,
};

/**
 * Get the context window size for a model.
 * Falls back to 128k for unknown models.
 */
export function getModelContextWindow(model: string, provider: string): number | null {
	const bareModel = parseModelId(model).model;
	const fullModelValue = provider ? `${provider}:${bareModel}` : model;

	// 0. Check per-model user overrides (highest priority)
	const userOverrides = settings.agent.modelContextWindows ?? {};
	if (userOverrides[fullModelValue]) {
		return userOverrides[fullModelValue];
	}
	// Also try the raw model string in case it already has provider prefix
	if (model !== fullModelValue && userOverrides[model]) {
		return userOverrides[model];
	}

	// 1. Check provider configuration (OpenAI or Anthropic)
		const oaiConfig = getOpenaiProviderConfig(provider);
		if (oaiConfig?.defaultContextWindow) {
			return oaiConfig.defaultContextWindow;
		}
		const anthropicConfig = getAnthropicProviderConfig(provider);
		if (anthropicConfig?.defaultContextWindow) {
			return anthropicConfig.defaultContextWindow;
		}
	}

	// 2. Check built-in table (exact match)
	const builtinConfig = BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig) {
		return typeof builtinConfig === "number" ? builtinConfig : builtinConfig.contextLength;
	}

	// 3. Fuzzy match (handles -latest, -preview, date suffixes, etc.)
	// Sort by pattern length descending so longer (more specific) patterns match first.
	// e.g. "claude-sonnet-4-6" should match before "claude-sonnet-4".
	const normalizedBare = bareModel.toLowerCase();
	const sortedEntries = Object.entries(BUILTIN_CONTEXT_WINDOWS).sort(
		(a, b) => b[0].length - a[0].length,
	);
	for (const [pattern, config] of sortedEntries) {
		if (normalizedBare.startsWith(pattern)) {
			return typeof config === "number" ? config : config.contextLength;
		}
	}

	// 4. Unknown model — return default 128k (conservative estimate)
	return 128_000;
}

/** Threshold above which a model is considered "large context". */
export const LARGE_CONTEXT_BOUNDARY = 600_000;

export const DEFAULT_CONTEXT_THRESHOLDS = {
	standard: { pruneStart: 95, compactStart: 99 },
	large: { pruneStart: 95, compactStart: 99 },
};

/**
 * Get the prune/compact thresholds for a model based on its context window size.
 * Models with context window > 600k use the "large" thresholds; others use "standard".
 */
export function getContextThresholds(
	model: string,
	provider: string,
): { pruneStart: number; compactStart: number } {
	const ctxWin = getModelContextWindow(model, provider) ?? 128_000;
	const tier = ctxWin > LARGE_CONTEXT_BOUNDARY ? "large" : "standard";
	const userThresholds = settings.agent.contextThresholds;
	const cfg = userThresholds?.[tier] ?? DEFAULT_CONTEXT_THRESHOLDS[tier];
	return {
		pruneStart: cfg.pruneStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].pruneStart,
		compactStart: cfg.compactStart ?? DEFAULT_CONTEXT_THRESHOLDS[tier].compactStart,
	};
}

/**
 * Get the maximum completion tokens for a model.
 * Returns null if not specified (meaning no separate limit).
 */
export function getModelMaxCompletionTokens(model: string, _provider: string): number | null {
	const bareModel = parseModelId(model).model;

	// Check built-in table (exact match first)
	const builtinConfig = BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig !== undefined) {
		// Exact match found
		if (typeof builtinConfig === "object") {
			return builtinConfig.maxCompletionTokens ?? null;
		}
		// Simple number config means no separate completion limit
		return null;
	}

	// Fuzzy match (handles -latest, -preview, date suffixes, etc.)
	const normalizedBare = bareModel.toLowerCase();
	for (const [pattern, config] of Object.entries(BUILTIN_CONTEXT_WINDOWS)) {
		if (normalizedBare.startsWith(pattern) && typeof config === "object") {
			return config.maxCompletionTokens ?? null;
		}
	}

	return null;
}
