/**
 * Built-in routines registry.
 *
 * Houses optional agent tools plus command and skill routines. Skill routines
 * materialize a `SKILL.md` when enabled (see `routine-service`).
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
		id: "scheduled_task",
		type: "tool",
		category: "tools",
		tool: {
			toolName: "ScheduledTask",
			descriptionEn:
				"Scheduled task management — create, inspect, edit, enable/disable, delete and trigger cron tasks",
			descriptionZh: "定时任务管理 — 创建、查看、编辑、启用/禁用、删除和立即触发 cron 任务",
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
				"MCP server management (admin only) — list, add, remove, connect, disconnect, refresh tools, and test external MCP servers",
			descriptionZh:
				"MCP 服务器管理（仅管理员）— 列出、添加、移除、连接、断开、刷新工具和测试外部 MCP 服务器",
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

	// ── Skills (materialized as SKILL.md when enabled) ──────────────────
	{
		id: "skill-creator",
		type: "skill",
		category: "workflow",
		/**
		 * Opt-in methodology guide: useful when the user asks to create/update a
		 * skill, but would pollute every session if preloaded by default.
		 */
		defaultEnabled: false,
		skill: {
			name: "skill-creator",
			descriptionEn:
				"Create or update NarraFork skills — scoped instructions, companion files, and validation",
			descriptionZh: "创建或更新 NarraFork 技能 — 有边界的指令、附属文件与校验",
			content: `# Skill Creator

Create or update NarraFork skills that give narrators useful, non-obvious guidance without constraining unrelated work.

## Core Principles

**Assume the narrator is already capable.** Include only information that changes decisions or improves work. Remove generic advice, repeated instructions, speculative edge cases, and examples that do not clarify the task.

**Preserve user intent and scope.** A skill should support the requested task, not replace the user's product choices, expand the assignment, or modify unrelated configuration. Do not turn one example, past failure, or personal preference into a universal rule.

**Match specificity to the risk.** Leave room for reasonable approaches when several are fine. Use fixed steps only when correctness, safety, or a genuinely fragile workflow requires them.

**Keep discovery cheap and precise.** \`name\` and \`description\` are visible before the skill body loads. Describe the capability and when it applies; avoid catchalls that attract unrelated work.

**Disclose detail progressively.** Keep purpose, essential constraints, and routing in \`SKILL.md\`. Put large schemas, examples, or mode-specific procedures in companion reference files and read only what the current task needs.

## Anatomy of a Skill

A skill is a directory containing a required \`SKILL.md\` and optional companion files:

\`\`\`text
skill-name/
|-- SKILL.md                 Required: YAML frontmatter + markdown body
|-- scripts/                 Optional executable helpers
|-- references/              Optional docs loaded as needed
\`-- assets/                  Optional templates / files used in output
\`\`\`

NarraFork discovers any directory under a skills root that contains \`SKILL.md\`. Nested directories under a skill directory are companion files, not nested skills. When a skill loads, companion files are listed as paths under the skill base directory (keep the tree small and purposeful).

### SKILL.md

YAML frontmatter must include:

- \`name\` — skill identifier used for Skill tool / \`/load\` invocation
- \`description\` — what it does and when it applies (keep it discriminating)

The markdown body is loaded only when the skill is used. Put purpose, workflow, real constraints, and links to companion files there.

### Companion Files

Add subdirectories only when the concrete task needs them:

- \`scripts/\` — deterministic helpers the skill runs via Bash (run them once before finishing)
- \`references/\` — schemas, API notes, mode-specific guides; link from \`SKILL.md\` and say when to read them
- \`assets/\` — templates or binaries copied into generated output, not loaded as instructions

Write companion files with Write into the skill directory. Avoid empty placeholder trees.

Do not add README, changelog, installation guides, or duplicated quick references unless a specific packaging requirement needs them.

## Skill Locations

| Scope | Path |
|-------|------|
| Global (all projects) | \`$NARRAFORK_HOME/skills/<skill-dir>/SKILL.md\` (usually \`~/.narrafork/skills/\`) |
| Project (one repo) | \`<project gitPath>/.narrafork/skills/<skill-dir>/SKILL.md\` |

Discovery also scans \`.narrafork/skill\`, \`.claude/skills\`, \`.agents/skills\`, and \`.codex/skills\` under the project or home root — prefer the NarraFork paths above for new skills.

Prefer project skills for repo-specific workflows and global skills for cross-project methodology. Honor a user-specified location.

## Naming

- Lowercase letters, digits, and hyphens; folder name should match the skill name
- Short and action-oriented (e.g. \`release-changelog\`, \`db-migration-check\`)
- Under 64 characters; namespace by domain when it aids discovery (\`review-…\`, \`deploy-…\`)

## Description

Frontmatter \`description\` is the primary discovery surface. State the capability and when it applies. Add a boundary only when a similar request should *not* activate the skill.

\`\`\`yaml
description: Create or update NarraFork skills with scoped instructions and optional companion resources.
\`\`\`

Do not dump the full workflow into the description.

## Create or Update a Skill

Adapt the work to the request: a narrow edit is a focused change; a new skill may need structure, instructions, and validation.

### Write path (preferred in a live session)

1. Choose scope (global vs project) and directory name.
2. Write \`SKILL.md\` with complete frontmatter and body via Write.
3. Write any companion files under the same skill directory.
4. Validate with the checklist below.
5. Make it available in the session (below).

### API path

- Global: \`POST /api/skills/global\` with \`{ name, description, content }\`
- Project: \`POST /api/skills?projectId=<id>\` with the same fields

\`content\` is the markdown body; frontmatter is generated. These endpoints write only \`SKILL.md\`. Companion files must still be written into the skill directory with Write.

### Make the skill available in the current session

- The Skill tool reloads skill summaries on use; a newly written skill is usually visible immediately.
- If it is missing from the available list (summary cache is short-lived), invoke it by exact name — lookup force-refreshes when the name is not in the fresh cache.
- New narrator sessions pick up skills at creation time.
- Renaming \`SKILL.md\` to \`SKILL.md.disabled\` hides a skill from automatic discovery (the UI toggle does this).

There is no \`create_skill\` / \`get_skills\` agent tool — use Write and the existing skill APIs.

## Validate

Before finishing, check:

1. \`SKILL.md\` exists at the intended path
2. Frontmatter has non-empty \`name\` and \`description\`
3. \`name\` matches how users will invoke it; directory name matches
4. Description is specific enough to avoid wrong-task activation
5. Body states outcome, constraints, and when to read companion files
6. Companion file paths referenced in the body actually exist
7. No leftover scaffold placeholders (TODO, "example only")
8. For scripts: run them once and confirm behavior

When testing is warranted, verify observable behavior rather than wording. Prefer a narrow fix over accumulating universal rules from every incident.

## What Not To Include

- Generic advice the narrator already knows
- Copied manuals already available from authoritative sources
- Unrelated permissions, product decisions, or scope expansions
- Empty directories, placeholder examples, or docs nobody will read
`,
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
