/**
 * Default settings values and per-field documentation.
 * Extracted from the monolithic settings/index.ts.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cloneDefaultContextThresholds } from "@shared/context-thresholds";
import { DEFAULT_CODEX_TIER_ORDER } from "../codex-manager";
import type { FieldDoc, NarraForkSettings } from "./types";

export const DEFAULTS: NarraForkSettings = {
	server: { port: 7778, host: "localhost", openBrowser: "browser", allowedOrigins: [] },
	proxy: { mode: "direct" },
	paths: { defaultProjectDir: resolve(homedir(), "projects") },
	knowledge: {
		injectMode: "summary",
		maxInjectedEntries: 3,
		minKeywordLen: 3,
		scanToolOutput: true,
		maxToolOutputScanChars: 8000,
		packMaxSizeMb: 100,
		packMaxUncompressedMb: 500,
		packActivateRequiresPermission: true,
	},
	plugins: {
		enabled: true,
		allowPrivateProxyTarget: false,
	},
	agent: {
		defaultPermissionMode: "acceptEdits",
		defaultStartInPlanMode: false,
		// Deliberately empty: an unset summary model follows the default model
		// (resolveConfiguredSummaryModel). Shipping a concrete model here would
		// present a provider the user never configured as a real selection, and
		// `checkSummaryModelAvailable` would then fail it and open the picker on a
		// fresh install.
		summaryModel: "",
		translationModel: "__summary__",
		customModels: [],
		hiddenModels: [],
		maxTurns: 1000,
		subagentModels: {
			explore: "",
			plan: "",
			search: "",
			review: "",
		},
		subagentAllowedModels: {
			explore: [],
			plan: [],
			general: [],
			search: [],
			review: [],
		},
		legacyEncoding: false,
		freshShellEnv: false,
		requestDumpEnabled: false,
		requestDumpErrorsOnly: false,
		// 32MB. Enabling dumping is an explicit, warned, high-risk opt-in made to capture
		// a specific failure, so the ceiling must be high enough that a real request —
		// full conversation history, replayed tool output, inline images — survives intact.
		// The old 1MB default silently truncated almost every request worth dumping.
		requestDumpMaxSize: 32 * 1024 * 1024,
		modelContextWindows: {},
		translateReasoning: false,
		defaultRelaxedPlan: false,
		defaultPruneEnabled: false,
		planModeAllowInlinePlan: true,
		planReflectionAutoApprove: false,
		planReflectionAllowAutoCompact: false,
		questionReflectionEnabled: false,
		questionReflectionTimeoutMs: 300_000,
		dangerReflectionLevel: "standard",
		dangerReflectionEnabled: true,
		dangerSkipReadOnlyConfirmations: false,
		whitelistDirs: [],
		blacklistDirs: [],
		commandWhitelist: [],
		commandBlacklist: [],
		autoContinuationMode: "protectedOnly",
		maxTransientRetries: 10,
		silentToolCallThreshold: 50,
		pipelineUnusedToolCallThreshold: 10,
		behaviorFenceInterval: -1,
		tasksReminderInterval: 15,
		behaviorFenceAttachTasks: true,
		defaultReasoningEffort: "max",
		reasoningEffortBlocklist: [],
		retryBackoffCeilMs: 20_000,
		firstTokenTimeoutMs: 300_000,
		autoCompactKeepPairs: 2,
		autoCompactPruneThreshold: 80,
		minPruneRatio: 30,
		queueDuringCompaction: true,
		contextThresholds: cloneDefaultContextThresholds(),
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
		trustedProxyCidrs: ["127.0.0.0/8", "::1/128"],
	},
	oauth: {
		externalWebSocket: {
			ticketTtlMs: 30_000,
			maxTickets: 4096,
			maxFrameBytes: 65_536,
			allowedOrigins: [],
			maxSubscriptionsPerFrame: 20,
			maxSubscriptionsPerConnection: 50,
			maxGlobalConnections: 1000,
			maxConnectionsPerToken: 8,
			maxConnectionsPerGrant: 16,
			maxConnectionsPerClient: 256,
			maxConnectionsPerUser: 32,
			maxBufferedAmount: 1_048_576,
		},
	},
	routines: {
		disabledRoutines: [],
		enabledRoutines: [],
	},
	customApiProviders: [],
	openaiProviders: [],
	anthropicProviders: [],
	geminiProviders: [],
	codex: {
		loadBalancingMode: "tier-balanced",
		tierOrder: [...DEFAULT_CODEX_TIER_ORDER],
		// codex-reversed 显示官方默认 reasoning level 为 medium，避免默认 high 过快消耗额度。
		defaultReasoningEffort: "medium",
		useWebSocket: true,
		useWebSearch: true,
		useImageGeneration: true,
		// Present the built-in Codex adapter as the real Codex CLI by default.
		userAgentMode: "codex",
	},
	// Empty by default: the built-in reference price table in
	// server/lib/model-pricing.ts applies until an operator corrects a row.
	pricing: {
		overrides: {},
	},
	search: {
		channels: [
			{ id: "native", kind: "native", enabled: true },
			{ id: "subagent", kind: "subagent", enabled: false, maxTurns: 4 },
		],
		customProviders: [],
		defaultTimeoutMs: 60_000,
		maxOutputChars: 24_000,
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
	devices: {
		globalDefaultDeviceId: null,
		rpcTimeoutMs: 120_000,
		maxRpcBytes: 10 * 1024 * 1024,
		maxConcurrentRpcPerDevice: 16,
		transferChunkBytes: 1024 * 1024,
		transferConcurrency: 4,
		maxConcurrentTransfersPerDevice: 2,
		transferVerify: "crc32c",
		transfersDir: null,
		allowPlaintextEnrollmentOnPrivateNetwork: false,
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
	"server.allowedOrigins": {
		desc: "额外允许跨源读取 /api/* 的来源（逐字匹配，如 https://ide.example.com）。同源、本机回环（localhost/127.x）以及编辑器 webview 来源本身就被允许，无需在此列出；只有部署在其他非本机主机上的前端才需要配置。",
		type: "string[]",
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

	// ── proxy ───────────────────────────────────────────────────────────
	"proxy.mode": {
		type: "string",
		valid: '"direct" | "system" | "custom"',
	},
	"proxy.url": {
		desc: '自定义代理 URL，仅 mode 为 "custom" 时使用。支持 http/https 协议，仅填 host:port 时默认按 http 处理。',
		type: "string",
	},

	// ── paths ───────────────────────────────────────────────────────────
	"paths.defaultProjectDir": {
		desc: "默认项目目录。新建项目时的默认父目录。",
		type: "string",
	},

	// ── knowledge ───────────────────────────────────────────────────────
	"knowledge.injectMode": {
		desc: '知识库被动注入模式。"summary"=自动注入命中条目摘要；"off"=关闭被动注入。',
		type: "string",
	},
	"knowledge.maxInjectedEntries": {
		desc: "每轮自动注入的最大知识条目数（控制上下文增长）。",
		type: "number",
	},
	"knowledge.minKeywordLen": {
		desc: "触发匹配的最小关键词长度（与 trigram >= 3 对齐）。",
		type: "number",
	},
	"knowledge.scanToolOutput": {
		desc: "是否扫描工具输出（如日志）以匹配知识库并注入提醒。",
		type: "boolean",
	},
	"knowledge.maxToolOutputScanChars": {
		desc: "扫描工具输出前截断到的最大字符数（性能保护）。",
		type: "number",
	},
	"knowledge.packMaxSizeMb": {
		desc: "Pack 归档上传的最大体积（MB，zip/tar.gz）。",
		type: "number",
	},
	"knowledge.packMaxUncompressedMb": {
		desc: "Pack 解压后总大小上限（MB，防 zip bomb）。",
		type: "number",
	},
	"knowledge.packActivateRequiresPermission": {
		desc: "PackActivate 是否需要用户显式批准（它会改变叙述者的目录访问范围）。",
		type: "boolean",
	},

	// ── plugins ─────────────────────────────────────────────────────────
	"plugins.enabled": {
		desc: "是否启用插件子系统（默认启用）。环境变量 NF_PLUGINS_ENABLED / NARRAFORK_PLUGINS_ENABLED 若设置则优先，可作为应急关闭开关。",
		type: "boolean",
	},
	"plugins.allowPrivateProxyTarget": {
		desc: "允许代理 URL 指向私有/保留 IP 地址（127.x、10.x、172.16-31.x、192.168.x、169.254.x、::1 等）并传递给插件。默认 false 以阻止 SSRF；私有化部署使用内网代理时需显式开启。",
		type: "boolean",
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

	// ── devices（远端执行器）───────────────────────────────────────────
	"devices.globalDefaultDeviceId": {
		desc: "全局默认执行设备 id。为空/null 表示在本地服务器执行。叙述者可用 SwitchDevice 覆盖。",
		type: "string",
	},
	"devices.rpcTimeoutMs": {
		desc: "远端工具操作（文件/命令/git）单次 RPC 的超时时间（毫秒）。",
		type: "number",
	},
	"devices.maxRpcBytes": {
		desc: "单个 RPC 结果/流可承载的最大字节数，超出在执行器侧截断。",
		type: "number",
	},
	"devices.maxConcurrentRpcPerDevice": {
		desc: "每个设备允许的最大并发 RPC 数。",
		type: "number",
	},
	"devices.transferChunkBytes": {
		desc: "文件传输的分块大小（字节）。默认 1 MiB。",
		type: "number",
	},
	"devices.transferConcurrency": {
		desc: "单个传输内并行飞行的分块数。默认 4。",
		type: "number",
	},
	"devices.maxConcurrentTransfersPerDevice": {
		desc: "每个设备允许的最大并发传输数。默认 2。",
		type: "number",
	},
	"devices.transferVerify": {
		desc: '文件传输的整文件校验策略。"sha256" 仅在上传方向（服务器→设备）做端到端强校验；下载方向（设备→服务器）依赖传输层可靠性 + 精确字节数校验（crc32c 为逐块尽力校验，不触发重传）。',
		type: "string",
		valid: '"crc32c" | "sha256" | "none"',
	},
	"devices.transfersDir": {
		desc: "下载文件的默认落盘根目录。为空则使用 ~/.narrafork/transfers。",
		type: "string",
	},
	"devices.allowPlaintextEnrollmentOnPrivateNetwork": {
		desc: "允许在内网明文 http 下使用一键安装命令自动领取设备密钥。默认关闭：一键安装会让安装命令本身成为凭据，https 下该交换是加密的，明文 http 下不是——开启表示你接受设备密钥在注册那一次以明文经过内网。无论此项如何设置，公网可路由地址上的明文 http 一律拒绝发放密钥；关闭时可改用「手动粘贴密钥」方式安装。内网判定仅限字面 IP 地址，主机名一律不适用（服务器无法验证域名实际解析到哪个网络）。",
		type: "boolean",
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
		desc: "用于生成摘要的模型。用于压缩上下文、标题生成等辅助任务。应选择速度快成本低的模型。留空则跟随默认模型。",
		type: "string",
	},
	"agent.translationModel": {
		desc: "用于翻译 reasoning/thinking 块的模型。默认 __summary__，动态跟随 summaryModel。",
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
		valid: "1-1000, 默认 1000",
	},
	"agent.subagentModels.explore": {
		desc: "explore 子代理的默认模型。空字符串表示使用全局 defaultModel。",
		type: "string",
	},
	"agent.subagentModels.plan": {
		desc: "plan 子代理默认模型。空字符串表示继承父叙述者/全局默认模型。",
		type: "string",
	},
	"agent.subagentModels.search": {
		desc: "search 子代理默认模型。空字符串表示继承父叙述者/全局默认模型。",
		type: "string",
	},
	"agent.subagentModels.review": {
		desc: "review 子代理默认模型。空字符串表示继承父叙述者/全局默认模型。",
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
	"agent.subagentAllowedModels.search": {
		desc: "search 子代理允许的模型池。空数组表示无限制。",
		type: "string[]",
	},
	"agent.subagentAllowedModels.review": {
		desc: "review 子代理允许的模型池。空数组表示无限制。",
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
		desc: "单条 raw dump 落库的最大字节数。默认 32MB (33554432)。设为 -1 表示不限制。超出时优先丢弃 SSE 事件、再按剩余预算截断请求/响应体，并标记 bodyTextTruncated，不会整包丢弃请求体。",
		type: "number",
	},
	"agent.modelContextWindows": {
		desc: '按模型覆盖上下文窗口大小（tokens）。键为完整模型值 "provider:modelId"，值为 token 数。优先级最高。',
		type: "Record<string, number>",
	},
	"agent.translateReasoning": {
		desc: "启用后，每个 reasoning/thinking 块完成后自动通过 translationModel 翻译成用户语言（非英文时）。",
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
	"agent.planModeAllowInlinePlan": {
		desc: "是否允许 plan mode 内联计划（ExitPlanMode 的 inline_plan 参数）。关闭后仅支持 plan 文件形式，ExitPlanMode 的工具 schema、描述与计划模式系统提示会同步移除内联选项，计划内容只从指定的 plan 文件读取。默认开启。",
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
	"agent.autoContinuationMode": {
		desc: "自动续跑模式：每轮结束后如果 spec 任务仍未完成，是否自动继续。always=总是续跑；blockStop=只剩 blocked 任务时停止；protectedOnly=仅当有未完成的 protected 任务时续跑；off=从不续跑。叙述者可单独覆盖此默认值。",
		type: "string",
		valid: "always / blockStop / protectedOnly / off，默认 protectedOnly",
	},
	"agent.maxTransientRetries": {
		desc: "可恢复的 API 错误最大重试次数。-1 表示无限重试；有状态提供商（Responses/Codex）会在外层重建历史后重试。",
		type: "number",
		valid: "-1 = 无限重试, 默认 10",
	},
	"agent.silentToolCallThreshold": {
		desc: "模型连续执行工具但未输出可见文本达到此次数时，通过 sidecar 要求其简短说明当前工作。-1 表示关闭。",
		type: "number",
		valid: "-1 = 关闭，默认 50",
	},
	"agent.pipelineUnusedToolCallThreshold": {
		desc: "Pipeline 捕获结果连续多少次工具调用未被 ExtractPipeline 使用后，在下一次非 Pipeline 控制工具调用前自动清理。-1 表示关闭。",
		type: "number",
		valid: "-1 = 关闭，正整数，默认 10",
	},
	"agent.behaviorFenceInterval": {
		desc: "行为护栏定期注入的全局默认间隔：每隔 N 个已完成工具调用，通过 sidecar 注入一次行为护栏内容。护栏内容为空时不注入。-1 表示关闭。叙述者可单独覆盖此默认值。",
		type: "number",
		valid: "-1 = 关闭，或正整数，默认 -1",
	},
	"agent.tasksReminderInterval": {
		desc: "大纲（tasks.json）定期注入的全局默认间隔：每隔 N 个已完成工具调用，通过 sidecar 注入一次大纲内容。-1 表示关闭。叙述者可单独覆盖此默认值。",
		type: "number",
		valid: "-1 = 关闭，或正整数，默认 15",
	},
	"agent.behaviorFenceAttachTasks": {
		desc: "行为护栏是否附着到 tasks.json 提醒的全局默认值：开启后，每当 tasks.json 任务提醒注入时一并注入行为护栏内容（护栏内容为空时不注入）。叙述者可单独覆盖此默认值。",
		type: "boolean",
		valid: "true / false，默认 true",
	},
	"agent.defaultReasoningEffort": {
		desc: "全局默认思考强度，作为所有模型的唯一默认值。叙述者自身设置为非空时覆盖此值；否则该默认值应用于所有模型，并在请求时就近降级到模型支持的档位。默认 max。",
		type: "string",
		valid: '"none" | "low" | "medium" | "high" | "xhigh" | "max"，默认 max',
	},
	"agent.retryBackoffCeilMs": {
		desc: "可恢复错误重试退避时间上限（毫秒）。指数退避不会超过此值。默认 20000（20 秒）。",
		type: "number",
		valid: "正整数，默认 20000",
	},
	"agent.firstTokenTimeoutMs": {
		desc: "首 token 超时时间（毫秒）。AI API 请求发起后，若在此时间内未收到 text/tool/reasoning/web_search/image_generation/queueEvent 等实质事件，则中断本次请求并按可恢复错误规则重试。0 表示禁用。默认 300000（5 分钟）。",
		type: "number",
		valid: "0-600000，0 = 禁用，默认 300000",
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
	"agent.reasoningEffortBlocklist": {
		desc: "思考强度黑名单。默认向所有模型发送思考强度（另有内置规则排除 4.6 之前的 Claude）；上游拒绝该参数时把模型加到这里。每项含 pattern、enabled；pattern 为不区分大小写的子串，或 /正则/flags。",
		type: "array",
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
	"agent.minPruneRatio": {
		desc: "最小裁剪比例。每次裁剪边界推进时，至少裁掉剩余可裁剪消息的该比例。值越大，单次裁剪幅度越大、裁剪次数越少，从而减少 prompt 缓存前缀失效、降低计费；代价是单次丢弃更多上下文。",
		type: "number",
		valid: "0-100, 默认 30",
	},
	"agent.queueDuringCompaction": {
		desc: "叙述者正在进行上下文压缩时，新发送的用户消息是否排队等压缩完成后再执行。开启时消息进入队列（可编辑、可取消），压缩结束后自动开始该轮次；关闭时立即发送，与压缩并发。无论开关如何，用户都可以在发送菜单中选择插队立即执行。",
		type: "boolean",
		valid: "true / false，默认 true",
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
		desc: "是否允许新用户注册。false 时禁用注册。首个注册的用户始终为管理员，且创建后会自动置为 false，需要时可由管理员重新开启。",
		type: "boolean",
	},
	"auth.trustedProxyCidrs": {
		desc: "认证限流可信任的反向代理 IP/CIDR。仅这些代理提供的 X-Forwarded-For 或 X-Real-IP 会用于识别客户端；默认只信任本机回环代理。",
		type: "string[]",
	},

	// ── oauth.externalWebSocket ─────────────────────────────────────────
	// The endpoint is always enabled; per-capability access is enforced by OAuth
	// scopes/grants. The entries below are operational limits only.
	"oauth.externalWebSocket.ticketTtlMs": {
		desc: "外部 WebSocket 单次升级 ticket 的有效期（毫秒）。",
		type: "number",
	},
	"oauth.externalWebSocket.maxTickets": {
		desc: "服务器全局最多保留的待使用外部 WebSocket ticket 数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxFrameBytes": {
		desc: "外部 WebSocket 单帧允许的最大字节数。",
		type: "number",
	},
	"oauth.externalWebSocket.allowedOrigins": {
		desc: "浏览器外部 WebSocket 的精确 Origin 白名单。空列表拒绝所有携带 Origin 的连接；非浏览器客户端可不发送 Origin。",
		type: "string[]",
	},
	"oauth.externalWebSocket.maxSubscriptionsPerFrame": {
		desc: "外部 WebSocket 单帧最多可添加或移除的叙述者订阅数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxSubscriptionsPerConnection": {
		desc: "单个外部 WebSocket 连接允许的最大活跃叙述者订阅数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxGlobalConnections": {
		desc: "服务器允许的外部 OAuth WebSocket 全局最大连接数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxConnectionsPerToken": {
		desc: "同一 OAuth 访问令牌允许的最大并发 WebSocket 连接数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxConnectionsPerGrant": {
		desc: "同一 OAuth 授权允许的最大并发 WebSocket 连接数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxConnectionsPerClient": {
		desc: "同一 OAuth 客户端允许的最大并发 WebSocket 连接数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxConnectionsPerUser": {
		desc: "同一用户允许的最大外部 OAuth WebSocket 并发连接数。",
		type: "number",
	},
	"oauth.externalWebSocket.maxBufferedAmount": {
		desc: "外部 WebSocket 发送缓冲区允许的最大字节数，超过后应关闭连接。",
		type: "number",
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
	"codex.loadBalancingMode": {
		desc: '多凭证时的负载均衡策略。"priority" 使用最高优先级凭证，"balanced" 均衡选择，"tier-balanced" 先按账号等级排序、同等级内均衡选择。',
		type: "string",
		valid: '"priority" | "balanced" | "tier-balanced"',
	},
	"codex.tierOrder": {
		desc: 'Codex 等级均衡模式的账号等级顺序。默认 ["pro", "prolite", "plus", "team", "k12", "free"]，未列出的等级自动排在最后。',
		type: "string[]",
		valid: '"pro" | "prolite" | "plus" | "team" | "k12" | "free" | "other"',
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
	"codex.userAgentMode": {
		desc: "内置 Codex 适配器出站请求呈现的 User-Agent 模式（narrafork / claude-code / codex / custom）。默认 codex，仿真真实 Codex CLI。",
		type: "string",
		valid: '"narrafork" | "claude-code" | "codex" | "custom"',
	},
	"codex.customUserAgent": {
		desc: "当 codex.userAgentMode 为 custom 时使用的自定义 User-Agent 字符串。",
		type: "string",
	},
	"codex.extraHeaders": {
		desc: "内置 Codex 请求附加的自定义请求头（同名时覆盖仿真请求头）。",
		type: "object",
	},
	"clientFingerprint.installationId": {
		desc: "作为 x-codex-installation-id 发送的持久化 UUID（客户端指纹身份，首次访问自动生成）。",
		type: "string",
	},

	// ── pricing ─────────────────────────────────────────────────────────
	"pricing.overrides": {
		type: "object",
	},

	// ── search ──────────────────────────────────────────────────────────
	"search.channels": {
		desc: "统一网络搜索渠道列表。按顺序尝试；native 原生搜索只在支持的模型上作为最高优先级生效。",
		type: "array",
	},
	"search.customProviders": {
		desc: "自定义搜索 API provider 列表，独立于模型 provider。",
		type: "array",
	},
	"search.defaultTimeoutMs": {
		desc: "单次搜索渠道调用默认超时时间（毫秒）。",
		type: "number",
	},
	"search.maxOutputChars": {
		desc: "搜索工具返回给模型的最大字符数，防止结果过大。",
		type: "number",
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
