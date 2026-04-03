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
}

export interface BuiltinSkillDef {
	name: string;
	descriptionEn: string;
	descriptionZh: string;
	/** The markdown body of the SKILL.md (everything after the frontmatter). */
	content: string;
}

export interface BuiltinToolDef {
	/** The tool name as registered in the toolRegistry (e.g. "Terminal"). */
	toolName: string;
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

/** Get all unique categories. */
export function getBuiltinCategories(): string[] {
	return [...new Set(BUILTIN_ROUTINES.map((r) => r.category))];
}
