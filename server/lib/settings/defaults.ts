/**
 * Default settings values and per-field documentation.
 * Extracted from the monolithic settings/index.ts.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_CODEX_TIER_ORDER } from "../codex-manager";
import type { FieldDoc, NarraForkSettings } from "./types";

export const DEFAULTS: NarraForkSettings = {
	server: { port: 7778, host: "localhost", openBrowser: "browser" },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	agent: {
		defaultPermissionMode: "acceptEdits",
		defaultStartInPlanMode: false,
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
		requestDumpErrorsOnly: false,
		requestDumpMaxSize: 1024 * 1024, // 1MB
		modelContextWindows: {},
		translateReasoning: false,
		defaultRelaxedPlan: false,
		defaultPruneEnabled: false,
		planReflectionAutoApprove: false,
		planReflectionAllowAutoCompact: false,
		questionReflectionEnabled: false,
		questionReflectionTimeoutMs: 300_000,
		dangerReflectionLevel: "standard",
		dangerReflectionEnabled: true,
		dangerSkipReadOnlyConfirmations: false,
		maxTransientRetries: 10,
		silentToolCallThreshold: 20,
		retryBackoffCeilMs: 20_000,
		firstTokenTimeoutMs: 60_000,
		autoCompactKeepPairs: 2,
		autoCompactPruneThreshold: 80,
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
	customApiProviders: [],
	openaiProviders: [],
	anthropicProviders: [],
	codex: {
		loadBalancingMode: "tier-balanced",
		tierOrder: [...DEFAULT_CODEX_TIER_ORDER],
		// codex-reversed 显示官方默认 reasoning level 为 medium，避免默认 high 过快消耗额度。
		defaultReasoningEffort: "medium",
		useWebSocket: true,
		useWebSearch: true,
		useImageGeneration: true,
	},
	update: {
		serverUrl: "https://narrafork-update.b.domexie.cn",
		product: "narrafork",
		channel: "stable",
		checkIntervalMinutes: 60,
		autoDownload: false,
	},
	vnet: {
		enabled: true,
		allowAnonymousRelay: false,
		maxPeersPerNetwork: 64,
		maxMessageBytes: 1024 * 1024,
		udp: {
			enabled: true,
			host: "0.0.0.0",
			port: 0,
		},
	},
	shares: {
		defaultExpiryHours: 24,
		maxFileSizeMb: 4096,
	},
};

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

	// ── vnet ────────────────────────────────────────────────────────────
	"vnet.enabled": {
		desc: "启用应用层虚拟网络 relay。用于 Bun 应用间通过虚拟地址通信。",
		type: "boolean",
	},
	"vnet.relayToken": {
		desc: "外部 Bun 应用连接 /ws/vnet 时可使用的共享 relay token。为空时仅支持 JWT 或显式匿名。",
		type: "string",
	},
	"vnet.allowAnonymousRelay": {
		desc: "是否允许无 JWT/无 relayToken 的 vnet relay 连接。默认关闭，仅建议本地实验使用。",
		type: "boolean",
	},
	"vnet.maxPeersPerNetwork": {
		desc: "单个虚拟网络允许的最大 peer 数。",
		type: "number",
	},
	"vnet.maxMessageBytes": {
		desc: "单个 vnet relay 消息的最大字节数。",
		type: "number",
	},
	"vnet.udp.enabled": {
		desc: "是否启用 UDP rendezvous / 基础打洞。失败时自动降级为 relay-only。",
		type: "boolean",
	},
	"vnet.udp.host": {
		desc: "UDP rendezvous 监听地址。",
		type: "string",
	},
	"vnet.udp.port": {
		desc: "UDP rendezvous 监听端口。0 表示自动分配。",
		type: "number",
	},

	// ── agent ───────────────────────────────────────────────────────────
	"agent.defaultModel": {
		type: "string",
	},
	"agent.defaultPermissionMode": {
		desc: "新建叙述者的默认权限模式。控制工具调用是否需要用户批准（不包含计划模式）。",
		type: "string",
		valid: '"default" | "acceptEdits" | "bypassPermissions" | "readOnly" | "dontAsk"',
	},
	"agent.defaultStartInPlanMode": {
		desc: "新建叙述者是否默认进入计划模式。计划模式是独立 trait，不再作为权限模式保存。",
		type: "boolean",
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
	"agent.requestDumpErrorsOnly": {
		desc: "启用后仅为报错的模型/API 请求持久化原始请求与响应 dump，成功请求不会保存 dump。",
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
	"agent.defaultPruneEnabled": {
		desc: "新建叙述者的自动裁剪默认值。默认关闭；开启可能导致提示词缓存失效、计费变贵。",
		type: "boolean",
	},
	"agent.planReflectionAutoApprove": {
		desc: "启用后，在允许编辑/全部允许模式下，ExitPlanMode 会先运行计划反思；反思确认后自动批准计划并跳过人工审批。",
		type: "boolean",
	},
	"agent.planReflectionAllowAutoCompact": {
		desc: "启用后，ExitPlanMode 计划反思可以选择自动批准并重置上下文，将计划写入 Conversation Context 后开始执行。默认关闭。",
		type: "boolean",
	},
	"agent.questionReflectionEnabled": {
		desc: "启用后，AskUserQuestion 在全部允许模式下等待超时仍未回答时，会自动运行 question reflection 并提交答案。",
		type: "boolean",
	},
	"agent.questionReflectionTimeoutMs": {
		desc: "AskUserQuestion 自动 question reflection 的等待时间（毫秒）。默认 300000，即 5 分钟。",
		type: "number",
		valid: "10000-3600000，默认 300000",
	},
	"agent.dangerReflectionLevel": {
		desc: "全部允许模式下危险反思的全局档位：off 关闭；light 只拦截明确危险操作，放行未知/未分类 Bash；standard 拦截中高风险；strict 拦截所有已分类风险。",
		type: "off | light | standard | strict",
	},
	"agent.dangerReflectionEnabled": {
		desc: "兼容旧配置的危险反思开关。新配置优先使用 dangerReflectionLevel；false 等价于 off，true 等价于 standard。",
		type: "boolean",
	},
	"agent.dangerSkipReadOnlyConfirmations": {
		desc: "危险反思模式下跳过只读操作的二次确认；Edit 视为可恢复操作，不触发安全暂停；删除、明确危险执行模式、环境注入、无法分析/未分类 Bash 和外部写入等仍按当前档位判断。",
		type: "boolean",
	},
	"agent.maxTransientRetries": {
		desc: "可恢复的 API 错误最大重试次数。-1 表示无限重试。有状态提供商（Responses/Codex）不支持重试。",
		type: "number",
		valid: "-1 = 无限重试, 默认 10",
	},
	"agent.silentToolCallThreshold": {
		desc: "模型连续执行工具但未输出可见文本达到此次数时，通过 sidecar 要求其简短说明当前工作。-1 表示关闭。",
		type: "number",
		valid: "-1 = 关闭，默认 20",
	},
	"agent.retryBackoffCeilMs": {
		desc: "可恢复错误重试退避时间上限（毫秒）。指数退避不会超过此值。默认 20000（20 秒）。",
		type: "number",
		valid: "正整数，默认 20000",
	},
	"agent.firstTokenTimeoutMs": {
		desc: "首 token 超时时间（毫秒）。AI API 请求发起后，若在此时间内未收到 text/tool/reasoning/web_search/image_generation/queueEvent 等实质事件，则中断本次请求并按可恢复错误规则重试。0 表示禁用。默认 60000（60 秒）。",
		type: "number",
		valid: "0-600000，0 = 禁用，默认 60000",
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
		desc: "标准模型(≤600k tokens)开始裁剪的上下文使用百分比(0-100)。",
		type: "number",
	},
	"agent.contextThresholds.standard.compactStart": {
		desc: "标准模型开始压缩的上下文使用百分比(0-100)。达到此阈值时触发压缩检查；若小于等于 pruneStart，则禁用渐进裁剪并在该阈值直接压缩。",
		type: "number",
	},
	"agent.contextThresholds.large.pruneStart": {
		desc: "大模型(>600k tokens)开始裁剪的上下文使用百分比(0-100)。",
		type: "number",
	},
	"agent.contextThresholds.large.compactStart": {
		desc: "大模型开始压缩的上下文使用百分比(0-100)；若小于等于 pruneStart，则禁用渐进裁剪并在该阈值直接压缩。",
		type: "number",
	},
	"agent.autoCompactKeepPairs": {
		desc: "自动压缩时在压缩摘要之后保留的最近 user/assistant 对话轮数。",
		type: "number",
	},
	"agent.autoCompactPruneThreshold": {
		desc: "最大裁剪百分比。已裁剪消息占总消息数达到此值时，强制启动后台上下文压缩；低于此值时继续渐进式裁剪。",
		type: "number",
		valid: "0-100, 默认 80",
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
		desc: '多凭证时的负载均衡策略。"priority" 使用最高优先级凭证，"balanced" 均衡选择，"tier-balanced" 先按账号等级排序、同等级内均衡选择。',
		type: "string",
		valid: '"priority" | "balanced" | "tier-balanced"',
	},
	"codex.tierOrder": {
		desc: 'Codex 等级均衡模式的账号等级顺序。默认 ["pro", "prolite", "plus", "team", "free"]，未列出的等级自动排在最后。',
		type: "string[]",
		valid: '"pro" | "prolite" | "plus" | "team" | "free" | "other"',
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
	"codex.useWebSearch": {
		desc: "是否向 Codex 请求注入原生 web_search 网络搜索工具。关闭后不再发送该工具。默认开启。",
		type: "boolean",
	},
	"codex.useImageGeneration": {
		desc: "是否向 Codex 请求注入原生 image_generation 图像生成工具。关闭后不再发送该工具。默认开启。",
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
