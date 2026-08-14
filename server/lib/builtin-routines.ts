/**
 * Built-in routines registry.
 *
 * Currently only houses optional agent tools. Command and skill routines
 * may be added in the future.
 */

export interface BuiltinCommandDef {
	name: string;
	prompt: string;
	descriptionEn: string;
	descriptionZh: string;
	params?: Array<{
		name: string;
		description?: string;
		required?: boolean;
		defaultValue?: string;
	}>;
	modelOverride?: {
		model: string;
		mode: "temporary" | "permanent";
	};
}

export interface BuiltinSkillDef {
	name: string;
	descriptionEn: string;
	descriptionZh: string;
	/** The markdown body of the SKILL.md (everything after the frontmatter). */
	content: string;
}

export interface BuiltinToolDef {
	/** The primary tool name as registered in the toolRegistry (e.g. "Terminal"). */
	toolName: string;
	/** Additional tool names controlled by the same routine (e.g. Pipeline's pair). */
	toolNames?: string[];
	descriptionEn: string;
	descriptionZh: string;
}

export interface BuiltinRoutine {
	/** Unique stable identifier, e.g. "terminal", "recall". */
	id: string;
	type: "command" | "skill" | "tool";
	category: string;
	/**
	 * Whether this routine is enabled by default (before any user settings).
	 * Defaults to `false` when omitted — requires explicit toggle or `/load`.
	 */
	defaultEnabled?: boolean;
	command?: BuiltinCommandDef;
	skill?: BuiltinSkillDef;
	tool?: BuiltinToolDef;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BUILTIN_ROUTINES: BuiltinRoutine[] = [
	// ── Tools (optional agent tools) ─────────────────────────────────────
	{
		id: "terminal",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "Terminal",
			descriptionEn: "Interactive terminal — read buffer, send input, list terminals",
			descriptionZh: "交互式终端 — 读取缓冲区、发送输入、列出终端",
		},
	},
	{
		id: "pipeline",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "StartPipeline",
			toolNames: ["StartPipeline", "ExtractPipeline"],
			descriptionEn: "Pipeline capture and extraction — inspect long tool outputs efficiently",
			descriptionZh: "Pipeline 捕获与提取 — 高效检查较长工具输出",
		},
	},
	{
		id: "share_file",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "ShareFile",
			descriptionEn: "Share files/directories — generate temporary download links",
			descriptionZh: "分享文件/目录 — 生成临时下载链接",
		},
	},
	{
		id: "recall",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "Recall",
			descriptionEn: "Search and browse all narrator conversations",
			descriptionZh: "搜索和浏览所有叙述者对话",
		},
	},
	{
		id: "browser",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "Browser",
			descriptionEn: "Interactive browser — navigate, click, fill forms, take screenshots",
			descriptionZh: "交互式浏览器 — 导航、点击、填写表单、截图",
		},
	},
	{
		id: "fork_narrator",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "ForkNarrator",
			descriptionEn: "Fork the current narrator session into a new chapter",
			descriptionZh: "将当前叙述者会话分叉到新章节",
		},
	},
	{
		id: "narrafork_admin",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "NarraForkAdmin",
			descriptionEn: "Admin settings management — get and modify all NarraFork settings",
			descriptionZh: "管理员设置管理 — 获取和修改所有 NarraFork 设置",
		},
	},
	{
		id: "knowledge_admin",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "KnowledgeAdmin",
			descriptionEn:
				"Knowledge ACL management (admin only) — levels, tags, tag types, grants, per-user/entry ACL",
			descriptionZh: "知识库 ACL 管理（仅管理员）— 密级、标签、标签类型、授权、用户/条目 ACL",
		},
	},
	{
		id: "plugin_install",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "PluginInstall",
			descriptionEn:
				"Plugin install management (admin only) — list import packages, install, and optionally enable plugins",
			descriptionZh: "插件安装管理（仅管理员）— 列出导入包、安装并可选择启用插件",
		},
	},
	{
		id: "mcp_admin",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "McpAdmin",
			descriptionEn:
				"MCP server management (admin only) — list, add, remove, connect, disconnect, and test external MCP servers",
			descriptionZh:
				"MCP 服务器管理（仅管理员）— 列出、添加、移除、连接、断开和测试外部 MCP 服务器",
		},
	},
	{
		id: "hook_admin",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "HookAdmin",
			descriptionEn:
				"Hook management (admin only) — list, create, update, and delete narrator lifecycle hooks (command/http)",
			descriptionZh:
				"Hook 管理（仅管理员）— 列出、创建、更新和删除叙述者生命周期 Hook（命令/HTTP）",
		},
	},
	{
		id: "scheduled_task_admin",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "ScheduledTaskAdmin",
			descriptionEn:
				"Scheduled task management (admin only) — create, update, toggle, run, and delete cron narrator tasks",
			descriptionZh: "定时任务管理（仅管理员）— 创建、更新、启停、立即运行和删除 cron 叙述者任务",
		},
	},
	{
		id: "knowledge_create",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "KnowledgeCreate",
			descriptionEn:
				"Knowledge create — add a new entry to your personal library (or directly to the global base with write permission)",
			descriptionZh: "知识库创建 — 在个人知识库新建条目（有写权限时可直接写入全局库）",
		},
	},
	{
		id: "knowledge_edit",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "KnowledgeEdit",
			descriptionEn:
				"Knowledge edit — save/rebase/publish your personal entries, update entry metadata, transfer ownership",
			descriptionZh: "知识库编辑 — 保存/变基/发布个人条目，更新条目元数据，转移所有权",
		},
	},
	{
		id: "knowledge_review",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "KnowledgeReview",
			descriptionEn:
				"Knowledge review — review and approve/reject publish requests into the global base, resolve conflicts",
			descriptionZh: "知识库审阅 — 审阅并批准/驳回发布到全局库的请求，解决冲突",
		},
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getBuiltinRoutine(id: string): BuiltinRoutine | undefined {
	return BUILTIN_ROUTINES.find((r) => r.id === id);
}

export function getAllBuiltinRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES;
}

export function getBuiltinCommandRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES.filter((r) => r.type === "command");
}

export function getBuiltinSkillRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES.filter((r) => r.type === "skill");
}

export function getBuiltinToolRoutines(): BuiltinRoutine[] {
	return BUILTIN_ROUTINES.filter((r) => r.type === "tool");
}

/** Return every registry tool controlled by one built-in tool routine. */
export function getBuiltinToolNames(tool: BuiltinToolDef): string[] {
	return [...new Set([tool.toolName, ...(tool.toolNames ?? [])])];
}

/** Get all unique categories. */
export function getBuiltinCategories(): string[] {
	return [...new Set(BUILTIN_ROUTINES.map((r) => r.category))];
}
