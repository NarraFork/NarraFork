import {
	type Locale,
	type LocalizedValue,
	normalizeLocale,
	pickLocalizedValue,
} from "./i18n-locales";

export type LearningLocale = Locale;
export type LocalizedText = LocalizedValue<string>;

export interface LearningAction {
	label: LocalizedText;
	description: LocalizedText;
	href: string;
}

export interface LearningSection {
	title: LocalizedText;
	body: LocalizedText;
}

export interface LearningDocSource {
	id: string;
	category: string;
	tags: string[];
	title: LocalizedText;
	summary: LocalizedText;
	sections: LearningSection[];
	workflow: LocalizedText[];
	bestPractices: LocalizedText[];
	pitfalls: LocalizedText[];
	agentHints: LocalizedText[];
	actions: LearningAction[];
}

export interface LearningDoc {
	id: string;
	category: string;
	tags: string[];
	title: string;
	summary: string;
	sections: Array<{ title: string; body: string }>;
	workflow: string[];
	bestPractices: string[];
	pitfalls: string[];
	agentHints: string[];
	actions: Array<{ label: string; description: string; href: string }>;
}

export interface LearningDocSummary {
	id: string;
	category: string;
	tags: string[];
	title: string;
	summary: string;
	actions: Array<{ label: string; description: string; href: string }>;
}

export interface LearningCategory {
	id: string;
	label: string;
	description: string;
}

const categories: Record<string, LocalizedText & { description: LocalizedText }> = {
	start: {
		en: "Start here",
		"zh-CN": "从这里开始",
		description: {
			en: "Core concepts and the shortest path to productive use.",
			"zh-CN": "核心概念与最短可用路径。",
		},
	},
	agent: {
		en: "AI collaboration",
		"zh-CN": "AI 协作",
		description: {
			en: "Narrators, subagents, permissions, tools, and safe autonomous work.",
			"zh-CN": "叙述者、子代理、权限、工具与安全自动化。",
		},
	},
	automation: {
		en: "Automation",
		"zh-CN": "自动化",
		description: {
			en: "Routines, skills, hooks, MCP, and reusable workflows.",
			"zh-CN": "套路、技能、钩子、MCP 与可复用工作流。",
		},
	},
	runtime: {
		en: "Runtime",
		"zh-CN": "运行资源",
		description: {
			en: "Terminals, containers, files, snapshots, sharing, and storage.",
			"zh-CN": "终端、容器、文件、快照、分享与储存空间。",
		},
	},
	admin: {
		en: "Operations",
		"zh-CN": "运维与设置",
		description: {
			en: "Providers, models, notifications, updates, users, and system settings.",
			"zh-CN": "提供商、模型、通知、更新、用户与系统设置。",
		},
	},
};

const docs: LearningDocSource[] = [
	{
		id: "overview",
		category: "start",
		tags: ["intro", "concepts", "workflow"],
		title: { en: "NarraFork in one page", "zh-CN": "一页理解 NarraFork" },
		summary: {
			en: "Use NarraFork as a private AI coding workspace: create work areas, delegate to narrators, inspect outputs, and keep decisions traceable.",
			"zh-CN":
				"把 NarraFork 当成私有 AI 编程工作台：创建工作空间，委派叙述者，检查产出，并让决策过程可追溯。",
		},
		sections: [
			{
				title: { en: "Mental model", "zh-CN": "核心心智模型" },
				body: {
					en: "A narrator is an AI work session with tools. Projects connect NarraFork to your Git repositories. Supporting features such as routines, skills, terminals, containers, notifications, and reviews make that work repeatable and auditable.",
					"zh-CN":
						"叙述者是带工具的 AI 工作会话；叙事线把 NarraFork 连接到你的 Git 仓库；套路、技能、终端、容器、通知和评审让工作可复用、可审计。",
				},
			},
		],
		workflow: [
			{
				en: "Finish initial setup: configure providers and models, then verify runtime availability.",
				"zh-CN": "先完成初始化：配置提供商与模型，再确认运行资源可用。",
			},
			{
				en: "Create or open a project only when you need repository-bound work; otherwise start with a standalone narrator.",
				"zh-CN": "需要绑定仓库时创建/打开叙事线；只想讨论、规划或查阅资料时可直接新建独立叙述者。",
			},
			{
				en: "Give narrators concrete objectives, let them plan larger changes, and review tool results before merging or releasing.",
				"zh-CN": "给叙述者明确目标；较大改动先让其计划；合并或发布前检查工具结果与代码差异。",
			},
		],
		bestPractices: [
			{
				en: "Use this Learning area before creating new routines or permissions so the automation matches existing platform conventions.",
				"zh-CN": "创建套路或权限前先查学习版块，确保自动化方式符合平台已有约定。",
			},
			{
				en: "Prefer small, reviewable tasks for narrators; split broad goals into phases with checkpoints.",
				"zh-CN": "给叙述者的任务尽量小而可评审；宽泛目标拆成带检查点的阶段。",
			},
		],
		pitfalls: [
			{
				en: "Do not treat AI output as final merely because a tool succeeded; validate builds, tests, and user-facing behavior.",
				"zh-CN": "不要因为工具调用成功就把 AI 产出视为最终结果；仍需验证构建、测试和用户可见行为。",
			},
		],
		agentHints: [],
		actions: [
			{
				label: { en: "Open settings", "zh-CN": "打开设置" },
				description: {
					en: "Configure providers, models, appearance, and runtime.",
					"zh-CN": "配置提供商、模型、外观与运行资源。",
				},
				href: "/settings",
			},
			{
				label: { en: "New narrator", "zh-CN": "新建叙述者" },
				description: {
					en: "Start an AI session not bound to a specific project.",
					"zh-CN": "启动不绑定具体叙事线的 AI 会话。",
				},
				href: "/narrators",
			},
		],
	},
	{
		id: "narrators",
		category: "agent",
		tags: ["narrator", "chat", "agent", "background"],
		title: { en: "Narrators and work sessions", "zh-CN": "叙述者与工作会话" },
		summary: {
			en: "Narrators are the primary AI collaborators in NarraFork. They can read files, edit code, run commands, ask questions, and continue in the background.",
			"zh-CN":
				"叙述者是 NarraFork 的主要 AI 协作者，可读写文件、运行命令、提问澄清，并支持后台持续执行。",
		},
		sections: [
			{
				title: { en: "Standalone vs project-bound", "zh-CN": "独立会话与叙事线会话" },
				body: {
					en: "Standalone narrators are best for planning, research, and operations. Project-bound narrators inherit repository context and are better for code changes.",
					"zh-CN":
						"独立叙述者适合规划、研究和运维；绑定叙事线的叙述者继承仓库上下文，更适合实际代码修改。",
				},
			},
			{
				title: { en: "Background tasks", "zh-CN": "后台任务" },
				body: {
					en: "Long-running narrator work can continue while you navigate elsewhere. Watch status, unread updates, and final summaries from recent tabs or narrator pages.",
					"zh-CN":
						"长任务可在你切换页面后继续执行；可通过最近访问或叙述者页面查看状态、未读更新和最终结果。",
				},
			},
		],
		workflow: [
			{
				en: "Choose the right context: standalone for thinking, project-bound for repository work.",
				"zh-CN": "先选上下文：思考/调研用独立会话，仓库改动用叙事线会话。",
			},
			{
				en: "State the objective, constraints, and what counts as done.",
				"zh-CN": "说明目标、约束和完成标准。",
			},
			{
				en: "For non-trivial code changes, expect the narrator to enter plan mode before editing.",
				"zh-CN": "较复杂代码改动应先进入计划模式，再开始编辑。",
			},
			{
				en: "Review tool calls, diffs, and validation output before accepting results.",
				"zh-CN": "接受结果前检查工具调用、diff 和验证输出。",
			},
		],
		bestPractices: [
			{
				en: "Ask for concrete deliverables, not vague effort: for example, 'add validation and run typecheck'.",
				"zh-CN": "提出具体交付物，而非模糊努力，例如“新增校验并运行类型检查”。",
			},
			{
				en: "Use recent tabs and workspaces to keep active narrators visible.",
				"zh-CN": "用最近访问和工作区保持活跃叙述者可见。",
			},
			{
				en: "Interrupt when objectives change; do not let an outdated task continue consuming tokens.",
				"zh-CN": "目标变化时及时中断，避免过期任务继续消耗 token。",
			},
		],
		pitfalls: [
			{
				en: "A narrator may be capable of a tool but still need permission for sensitive actions.",
				"zh-CN": "叙述者具备工具能力并不等于可以无审批执行敏感操作。",
			},
			{
				en: "Do not mix unrelated goals in one long session if you need clean review history.",
				"zh-CN": "如果需要清晰评审记录，不要在同一长会话里混入无关目标。",
			},
		],
		agentHints: [
			{
				en: "If a task is broad, use EnterPlanMode before making changes and present a concrete implementation plan.",
				"zh-CN": "任务较大时先进入计划模式，输出具体实施方案后再改动。",
			},
			{
				en: "Summarize validations in the final answer because users cannot see raw command output by default.",
				"zh-CN": "最终回复应总结验证结果，因为用户默认看不到原始命令输出。",
			},
		],
		actions: [
			{
				label: { en: "Narrators", "zh-CN": "叙述者" },
				description: {
					en: "Browse and create standalone sessions.",
					"zh-CN": "浏览并创建独立会话。",
				},
				href: "/narrators",
			},
			{
				label: { en: "Archived", "zh-CN": "归档会话" },
				description: {
					en: "Review completed or archived narrator sessions.",
					"zh-CN": "查看已完成或归档的叙述者。",
				},
				href: "/narrators/archived",
			},
		],
	},
	{
		id: "subagents-and-plan-mode",
		category: "agent",
		tags: ["subagent", "plan", "review", "parallel"],
		title: { en: "Subagents and plan mode", "zh-CN": "子代理与计划模式" },
		summary: {
			en: "Subagents isolate focused work. Plan mode protects larger implementations by requiring investigation and an approved approach before edits.",
			"zh-CN":
				"子代理用于隔离专项任务；计划模式要求先调查并获得方案批准，再进行较大实现，降低返工风险。",
		},
		sections: [
			{
				title: { en: "Subagent types", "zh-CN": "子代理类型" },
				body: {
					en: "Explore agents are read-only investigators, plan agents design architecture inside plan mode, general agents can perform self-contained write tasks, and review agents focus on code review.",
					"zh-CN":
						"explore 子代理只读调查；plan 子代理在计划模式中做架构分析；general 子代理可处理独立写入任务；review 子代理专注代码评审。",
				},
			},
			{
				title: { en: "When to use plan mode", "zh-CN": "何时使用计划模式" },
				body: {
					en: "Use plan mode for new features, multi-file changes, architectural decisions, unclear requirements, or tasks with several valid approaches.",
					"zh-CN": "新增功能、多文件改动、架构取舍、需求不清或存在多种可行方案时，应使用计划模式。",
				},
			},
		],
		workflow: [
			{ en: "Investigate with read-only tools first.", "zh-CN": "先用只读工具调查上下文。" },
			{
				en: "Delegate broad searches to explore subagents only when the search space is large.",
				"zh-CN": "只有搜索空间很大时，才把广泛调查委派给 explore 子代理。",
			},
			{
				en: "Exit plan mode with a complete implementation plan for user approval.",
				"zh-CN": "用完整实施方案退出计划模式并请求批准。",
			},
			{ en: "After approval, implement directly and validate.", "zh-CN": "批准后直接实现并验证。" },
		],
		bestPractices: [
			{
				en: "Ask subagents for distilled findings, not full file dumps.",
				"zh-CN": "要求子代理返回提炼后的结论，不要让它转储完整文件。",
			},
			{
				en: "Keep plan steps tied to concrete files and validation commands.",
				"zh-CN": "计划步骤要绑定具体文件和验证命令。",
			},
		],
		pitfalls: [
			{
				en: "Do not use subagents for one-file lookups that direct Grep or Read can answer.",
				"zh-CN": "一个 Grep 或 Read 能解决的单文件查找，不要滥用子代理。",
			},
		],
		agentHints: [
			{
				en: "Only spawn subagents when isolation reduces context noise or enables parallel work.",
				"zh-CN": "只有隔离能减少上下文噪音或支持并行时，才派生子代理。",
			},
			{
				en: "Never edit while still in plan mode; wait for explicit plan approval.",
				"zh-CN": "处于计划模式时不要编辑，必须等待方案明确批准。",
			},
		],
		actions: [
			{
				label: { en: "Agent settings", "zh-CN": "AI 代理" },
				description: {
					en: "Adjust agent behavior and prompts.",
					"zh-CN": "调整 AI 代理行为与提示词。",
				},
				href: "/settings/agent",
			},
			{
				label: { en: "Custom subagents", "zh-CN": "自定义子代理" },
				description: {
					en: "Manage reusable specialized subagent definitions.",
					"zh-CN": "管理可复用的专用子代理定义。",
				},
				href: "/settings/agent",
			},
		],
	},
	{
		id: "permissions-and-safety",
		category: "agent",
		tags: ["permissions", "safety", "tools", "approval"],
		title: { en: "Tool permissions and safety", "zh-CN": "工具权限与安全" },
		summary: {
			en: "NarraFork pauses sensitive tool calls for approval and supports reusable permission routines to reduce repeated prompts without sacrificing safety.",
			"zh-CN":
				"NarraFork 会暂停敏感工具调用等待审批，也支持可复用权限规则，在减少重复弹窗的同时保持安全边界。",
		},
		sections: [
			{
				title: { en: "Permission decisions", "zh-CN": "权限决策" },
				body: {
					en: "Approval is recorded with the tool call, so later review can see who allowed or denied a sensitive operation.",
					"zh-CN": "审批记录会绑定到工具调用，后续评审可追踪是谁允许或拒绝了敏感操作。",
				},
			},
			{
				title: { en: "Reusable permissions", "zh-CN": "可复用权限" },
				body: {
					en: "Tool permission routines let you whitelist safe commands or directories and blacklist dangerous patterns.",
					"zh-CN": "工具权限规则可白名单安全命令/目录，也可黑名单危险模式。",
				},
			},
		],
		workflow: [
			{
				en: "Start with strict defaults for new repositories or unfamiliar agents.",
				"zh-CN": "新仓库或不熟悉的 Agent 先使用严格默认权限。",
			},
			{
				en: "Whitelist repeated low-risk commands such as formatters and type checks.",
				"zh-CN": "把重复低风险命令（如格式化、类型检查）加入白名单。",
			},
			{
				en: "Keep destructive operations manual unless the project has a mature recovery workflow.",
				"zh-CN": "除非已有成熟恢复流程，否则破坏性操作保持人工审批。",
			},
		],
		bestPractices: [
			{
				en: "Whitelist narrow command patterns instead of broad shells.",
				"zh-CN": "白名单尽量匹配具体命令，不要泛化到整个 shell。",
			},
			{
				en: "Review permission routines after incidents or repeated denials.",
				"zh-CN": "出现事故或反复拒绝后，复盘并调整权限规则。",
			},
		],
		pitfalls: [
			{
				en: "A broad directory whitelist can accidentally grant access to secrets or generated artifacts.",
				"zh-CN": "过宽的目录白名单可能意外授权访问密钥或生成产物。",
			},
		],
		agentHints: [
			{
				en: "Explain why a command is needed before requesting permission for risky operations.",
				"zh-CN": "申请危险操作权限前，应说明命令目的与必要性。",
			},
			{
				en: "Prefer dedicated file tools over shell commands for reading, editing, and searching.",
				"zh-CN": "读文件、编辑和搜索优先使用专用工具，而不是 shell 命令。",
			},
		],
		actions: [
			{
				label: { en: "Tool permissions", "zh-CN": "工具权限" },
				description: {
					en: "Configure reusable permission routines.",
					"zh-CN": "配置可复用的工具权限规则。",
				},
				href: "/routines/tool-permissions",
			},
			{
				label: { en: "Routines", "zh-CN": "套路" },
				description: { en: "Manage automation routines.", "zh-CN": "管理自动化套路。" },
				href: "/routines",
			},
		],
	},
	{
		id: "routines",
		category: "automation",
		tags: ["routines", "automation", "prompts", "permissions"],
		title: { en: "Routines", "zh-CN": "套路" },
		summary: {
			en: "Routines package repeatable instructions, permissions, and automation behavior so narrators can follow team conventions consistently.",
			"zh-CN": "套路把可复用指令、权限和自动化行为打包起来，让叙述者稳定遵循团队约定。",
		},
		sections: [
			{
				title: { en: "What routines are for", "zh-CN": "套路适合做什么" },
				body: {
					en: "Use routines for recurring workflows such as release preparation, review checklists, test plans, or safe tool permission bundles.",
					"zh-CN": "适合把发布准备、评审清单、测试计划、安全权限包等重复流程沉淀为套路。",
				},
			},
		],
		workflow: [
			{
				en: "Identify a repeated workflow that has stable steps.",
				"zh-CN": "先找出步骤稳定、反复出现的工作流。",
			},
			{
				en: "Write the routine as operational instructions, not abstract policy.",
				"zh-CN": "把套路写成可执行指令，而不是抽象原则。",
			},
			{
				en: "Attach permissions only when they are narrow and justified.",
				"zh-CN": "只有权限范围窄且理由充分时，才把权限附加到套路。",
			},
			{
				en: "Test the routine on a low-risk task before broad use.",
				"zh-CN": "先在低风险任务上试用，再大范围使用。",
			},
		],
		bestPractices: [
			{
				en: "Keep routine names outcome-oriented, such as 'prepare-release' or 'review-api-change'.",
				"zh-CN": "套路命名应面向结果，例如 prepare-release 或 review-api-change。",
			},
			{
				en: "Version important routines by updating their description when behavior changes.",
				"zh-CN": "重要套路行为变化时，在描述里说明版本/变化点。",
			},
		],
		pitfalls: [
			{
				en: "Do not hide critical project decisions inside a routine that users never see.",
				"zh-CN": "不要把关键叙事线决策藏在用户看不到的套路里。",
			},
		],
		agentHints: [
			{
				en: "If a user references a slash command, check whether it maps to a skill or routine before improvising.",
				"zh-CN": "用户提到 slash command 时，先判断是否对应技能或套路，不要自行发挥。",
			},
		],
		actions: [
			{
				label: { en: "Open routines", "zh-CN": "打开套路" },
				description: {
					en: "Create and maintain reusable workflows.",
					"zh-CN": "创建和维护可复用工作流。",
				},
				href: "/routines",
			},
		],
	},
	{
		id: "skills",
		category: "automation",
		tags: ["skills", "slash-command", "knowledge"],
		title: { en: "Skills", "zh-CN": "技能" },
		summary: {
			en: "Skills are structured knowledge packs and slash-command behaviors that agents must load when a matching task appears.",
			"zh-CN":
				"技能是结构化知识包和 slash-command 行为；当任务匹配技能时，Agent 必须先加载技能再执行。",
		},
		sections: [
			{
				title: { en: "Project and global skills", "zh-CN": "项目技能与全局技能" },
				body: {
					en: "Project skills live with a repository. Global skills apply across the instance and are useful for organization-wide practices.",
					"zh-CN": "项目技能随仓库生效；全局技能跨实例使用，适合组织级实践。",
				},
			},
			{
				title: { en: "Agent behavior", "zh-CN": "Agent 行为" },
				body: {
					en: "The Skill tool exposes available skills and loads full instructions into the current conversation when invoked.",
					"zh-CN": "Skill 工具会展示可用技能，并在调用时把完整指令加载进当前会话。",
				},
			},
		],
		workflow: [
			{
				en: "Create a skill when instructions are domain-specific and longer than a routine should be.",
				"zh-CN": "当指令具有领域性且长度超过普通套路时，创建技能。",
			},
			{
				en: "Give the skill a clear trigger description so agents know when it is mandatory.",
				"zh-CN": "给技能写清触发条件，让 Agent 知道何时必须调用。",
			},
			{
				en: "Include supporting files only when they are necessary for execution.",
				"zh-CN": "只有执行必需时才附加支持文件。",
			},
		],
		bestPractices: [
			{
				en: "Write skills with concrete procedures and examples.",
				"zh-CN": "技能内容应包含具体流程和例子。",
			},
			{
				en: "Disable obsolete global skills instead of deleting them immediately.",
				"zh-CN": "废弃全局技能可先禁用，不必立刻删除。",
			},
		],
		pitfalls: [
			{
				en: "A vague trigger causes agents to overuse or ignore the skill.",
				"zh-CN": "触发条件模糊会导致 Agent 滥用或忽略技能。",
			},
		],
		agentHints: [
			{
				en: "When a skill matches the task, invoke the Skill tool before any explanatory response.",
				"zh-CN": "任务匹配技能时，先调用 Skill 工具，再进行解释或执行。",
			},
		],
		actions: [
			{
				label: { en: "Routines & skills", "zh-CN": "套路与技能" },
				description: {
					en: "Manage workflow automation and skill content.",
					"zh-CN": "管理工作流自动化与技能内容。",
				},
				href: "/routines",
			},
		],
	},
	{
		id: "mcp-and-hooks",
		category: "automation",
		tags: ["mcp", "hooks", "integrations", "tools"],
		title: { en: "MCP servers and hooks", "zh-CN": "MCP 服务器与钩子" },
		summary: {
			en: "MCP extends agent tools through external servers. Hooks connect NarraFork activity to scripts and integrations.",
			"zh-CN": "MCP 通过外部服务器扩展 AI 代理工具；钩子把 NarraFork 活动连接到脚本和集成系统。",
		},
		sections: [
			{
				title: { en: "MCP", "zh-CN": "MCP" },
				body: {
					en: "Configure MCP servers when agents need tools outside NarraFork's built-ins, such as proprietary systems, internal docs, or specialized APIs.",
					"zh-CN":
						"当 AI 代理需要内置工具之外的能力（如内部系统、私有文档、专用 API）时，配置 MCP 服务器。",
				},
			},
			{
				title: { en: "Hooks", "zh-CN": "钩子" },
				body: {
					en: "Use hooks for event-driven glue such as notifying another system, running audit scripts, or recording lifecycle events.",
					"zh-CN": "钩子适合事件驱动的胶水逻辑，例如通知外部系统、运行审计脚本或记录生命周期事件。",
				},
			},
		],
		workflow: [
			{
				en: "Start from the built-in tools; add MCP only for clear missing capabilities.",
				"zh-CN": "先使用内置工具；只有明确缺能力时再接 MCP。",
			},
			{
				en: "Give each server a narrow purpose and document expected credentials.",
				"zh-CN": "每个服务应有明确用途，并说明所需凭据。",
			},
			{
				en: "Test tools with a harmless query before enabling them in critical sessions.",
				"zh-CN": "关键会话使用前，先用无害查询测试工具。",
			},
		],
		bestPractices: [
			{
				en: "Prefer read-only MCP tools first; add write tools only after permission policy is clear.",
				"zh-CN": "优先接入只读 MCP 工具；写入工具需先明确权限策略。",
			},
			{
				en: "Keep hook scripts idempotent so repeated events do not corrupt state.",
				"zh-CN": "钩子脚本应具备幂等性，避免重复事件破坏状态。",
			},
		],
		pitfalls: [
			{
				en: "External tools can leak sensitive context if their server boundary is unclear.",
				"zh-CN": "外部工具边界不清时，可能泄露敏感上下文。",
			},
		],
		agentHints: [
			{
				en: "Use MCP tools only when their descriptions match the task; do not probe unknown external systems casually.",
				"zh-CN": "只有工具描述匹配任务时才使用 MCP；不要随意探测未知外部系统。",
			},
		],
		actions: [
			{
				label: { en: "MCP tools", "zh-CN": "MCP 工具" },
				description: {
					en: "Manage external MCP servers from the routines page.",
					"zh-CN": "在套路页面管理外部 MCP 服务器。",
				},
				href: "/routines",
			},
			{
				label: { en: "Gateway", "zh-CN": "IM 网关" },
				description: {
					en: "Configure message gateway integrations.",
					"zh-CN": "配置 IM 网关集成。",
				},
				href: "/settings/gateway",
			},
		],
	},
	{
		id: "terminal-and-containers",
		category: "runtime",
		tags: ["terminal", "container", "podman", "runtime"],
		title: { en: "Terminals and containers", "zh-CN": "终端与容器" },
		summary: {
			en: "Terminals provide interactive shells. Containers isolate project runtimes and allocate ports for services.",
			"zh-CN": "终端提供交互式 shell；容器隔离叙事线运行环境，并为服务分配端口。",
		},
		sections: [
			{
				title: { en: "Terminals", "zh-CN": "终端" },
				body: {
					en: "Use terminals for manual commands, debugging, server logs, or operations that need an interactive shell rather than an agent tool call.",
					"zh-CN":
						"终端适合手动命令、调试、查看服务日志，或需要交互式 shell 而非 Agent 工具调用的操作。",
				},
			},
			{
				title: { en: "Containers", "zh-CN": "容器" },
				body: {
					en: "Container support is optional and relies on Podman. It is useful when a project needs repeatable dependencies or isolated service processes.",
					"zh-CN": "容器能力是可选的，依赖 Podman；当叙事线需要可复现依赖或隔离服务进程时很有用。",
				},
			},
		],
		workflow: [
			{
				en: "Use agent Bash for short validated commands; use terminals for ongoing interactive work.",
				"zh-CN": "短命令和验证用 Agent Bash；持续交互工作用终端。",
			},
			{
				en: "Configure terminal runtime and shell before expecting stable interactive sessions.",
				"zh-CN": "期望稳定终端前，先配置终端运行时和 shell。",
			},
			{
				en: "Use containers when local dependencies are risky or inconsistent across machines.",
				"zh-CN": "本地依赖风险高或跨机器不一致时，使用容器。",
			},
		],
		bestPractices: [
			{
				en: "Keep long-running development servers in terminals so their logs remain visible.",
				"zh-CN": "把长期运行的开发服务器放在终端中，方便持续查看日志。",
			},
			{
				en: "Document project port assumptions before enabling container automation.",
				"zh-CN": "启用容器自动化前，先记录叙事线端口假设。",
			},
		],
		pitfalls: [
			{
				en: "Server restarts can mark old terminal sessions exited; check session state before relying on logs.",
				"zh-CN": "服务重启可能把旧终端标记为已退出；依赖日志前先确认会话状态。",
			},
		],
		agentHints: [
			{
				en: "Prefer Bash for non-interactive validation. Ask the user or use Terminal only when an interactive session is required.",
				"zh-CN": "非交互验证优先 Bash；只有需要交互式会话时才使用 Terminal 或请用户操作。",
			},
		],
		actions: [
			{
				label: { en: "Terminal settings", "zh-CN": "终端设置" },
				description: {
					en: "Configure terminal runtime and sessions.",
					"zh-CN": "配置终端运行时与会话。",
				},
				href: "/settings/terminals",
			},
			{
				label: { en: "Runtime", "zh-CN": "运行资源" },
				description: {
					en: "Check runtime and external dependencies.",
					"zh-CN": "检查运行资源与外部依赖。",
				},
				href: "/settings/runtime",
			},
		],
	},
	{
		id: "files-snapshots-and-sharing",
		category: "runtime",
		tags: ["files", "snapshot", "upload", "share", "storage"],
		title: { en: "Files, snapshots, uploads, and sharing", "zh-CN": "文件、快照、上传与分享" },
		summary: {
			en: "NarraFork tracks file changes, can restore snapshots, accepts uploads, and can generate temporary share links for artifacts.",
			"zh-CN": "NarraFork 会跟踪文件改动，可恢复快照，支持上传文件，并能为产物生成临时分享链接。",
		},
		sections: [
			{
				title: { en: "Snapshots", "zh-CN": "快照" },
				body: {
					en: "Snapshots help recover from unwanted edits and compare file states across narrator actions.",
					"zh-CN": "快照用于从错误编辑中恢复，也可对比叙述者操作前后的文件状态。",
				},
			},
			{
				title: { en: "Sharing", "zh-CN": "分享" },
				body: {
					en: "Share links are temporary and public to anyone with the URL, so share only intended artifacts.",
					"zh-CN": "分享链接有时效，但任何拿到 URL 的人都能访问，因此只分享明确允许外发的产物。",
				},
			},
		],
		workflow: [
			{
				en: "Use file tools and snapshots for code artifacts; use uploads to provide extra context to narrators.",
				"zh-CN": "代码产物用文件工具和快照；额外上下文可通过上传交给叙述者。",
			},
			{
				en: "Before sharing, inspect the artifact and remove secrets or private paths.",
				"zh-CN": "分享前检查产物，移除密钥和私有路径。",
			},
			{
				en: "Use storage settings to inspect large database or file growth.",
				"zh-CN": "通过储存空间设置检查数据库或文件体积增长。",
			},
		],
		bestPractices: [
			{
				en: "Use specific file paths for agent edits to avoid accidental unrelated changes.",
				"zh-CN": "Agent 编辑时尽量指定具体文件路径，避免无关改动。",
			},
			{
				en: "Share archives for multi-file outputs instead of many individual links.",
				"zh-CN": "多文件产物优先打包分享，而不是生成大量单文件链接。",
			},
		],
		pitfalls: [
			{
				en: "Temporary share links are not authentication-gated; treat the link itself as the secret.",
				"zh-CN": "临时分享链接不走登录鉴权；应把链接本身当作秘密。",
			},
		],
		agentHints: [
			{
				en: "Use ShareFile only when the user needs to download or preview an artifact, and mention what was shared.",
				"zh-CN": "只有用户需要下载或预览产物时才使用 ShareFile，并说明分享了什么。",
			},
		],
		actions: [
			{
				label: { en: "Storage", "zh-CN": "储存空间" },
				description: {
					en: "Inspect storage usage and cleanup options.",
					"zh-CN": "查看储存空间占用与清理选项。",
				},
				href: "/settings/storage",
			},
		],
	},
	{
		id: "search-and-navigation",
		category: "start",
		tags: ["search", "navigation", "recent-tabs"],
		title: { en: "Search, recent tabs, and navigation", "zh-CN": "搜索、最近访问与导航" },
		summary: {
			en: "Use global search for indexed chapters and messages, and use recent tabs to jump back to active projects or narrator sessions quickly.",
			"zh-CN": "使用全局搜索查找已索引的章节和消息，并用最近访问快速回到活跃叙事线或叙述者会话。",
		},
		sections: [
			{
				title: { en: "Global search", "zh-CN": "全局搜索" },
				body: {
					en: "Search is useful when you remember a message, decision, or title but not the exact project or narrator where it happened.",
					"zh-CN": "当你记得某条消息、决策或标题，却忘记具体叙事线/叙述者时，使用全局搜索。",
				},
			},
			{
				title: { en: "Recent tabs", "zh-CN": "最近访问" },
				body: {
					en: "Recent tabs keep active project and narrator contexts close at hand, including unread or working states.",
					"zh-CN": "最近访问会保留活跃叙事线和叙述者上下文，并显示未读或工作中状态。",
				},
			},
		],
		workflow: [
			{ en: "Search first when the exact location is unknown.", "zh-CN": "位置不明确时先搜索。" },
			{
				en: "Pin important tabs during multi-session work.",
				"zh-CN": "多会话协作时置顶重要标签。",
			},
			{
				en: "Clear idle narrators or project tabs to reduce sidebar noise.",
				"zh-CN": "清理空闲叙述者或叙事线标签，减少侧边栏噪音。",
			},
		],
		bestPractices: [
			{
				en: "Use distinctive narrator and project titles to make later search easier.",
				"zh-CN": "使用有辨识度的叙述者/叙事线标题，方便后续检索。",
			},
			{
				en: "Search messages before asking an agent to rediscover prior decisions.",
				"zh-CN": "让 Agent 重新调查历史决策前，先搜索相关消息。",
			},
		],
		pitfalls: [
			{
				en: "Search results reflect indexed content; newly generated content may need a moment to appear.",
				"zh-CN": "搜索结果来自索引；新生成内容可能需要短暂时间才出现。",
			},
		],
		agentHints: [
			{
				en: "If the user asks where something happened, use search tools or routes before guessing.",
				"zh-CN": "用户询问某事发生在哪里时，先使用搜索工具或页面，不要猜测。",
			},
		],
		actions: [
			{
				label: { en: "Search", "zh-CN": "搜索" },
				description: { en: "Find chapters and messages.", "zh-CN": "查找章节和消息。" },
				href: "/search",
			},
		],
	},
	{
		id: "reviews-and-quality",
		category: "agent",
		tags: ["review", "quality", "merge", "testing"],
		title: { en: "Reviews and quality gates", "zh-CN": "评审与质量关卡" },
		summary: {
			en: "Review workflows help check changes before they are accepted, merged, released, or used as examples for future agents.",
			"zh-CN": "评审流程用于在接受、合并、发布或沉淀为范例前检查变更质量。",
		},
		sections: [
			{
				title: { en: "Review chapters and agents", "zh-CN": "评审章节与评审 Agent" },
				body: {
					en: "Review agents focus on finding correctness, maintainability, security, migration, and test issues without rewriting the whole solution by default.",
					"zh-CN":
						"评审 Agent 默认专注发现正确性、可维护性、安全、迁移和测试问题，而不是重写整套方案。",
				},
			},
		],
		workflow: [
			{
				en: "Collect the changed files and intended behavior.",
				"zh-CN": "先收集变更文件和预期行为。",
			},
			{
				en: "Check correctness first, then maintainability, UX, security, and tests.",
				"zh-CN": "先查正确性，再查可维护性、用户体验、安全和测试。",
			},
			{
				en: "Separate blocking findings from non-blocking reminders.",
				"zh-CN": "区分阻塞问题和非阻塞提醒。",
			},
			{
				en: "Verify fixes with targeted commands before declaring review complete.",
				"zh-CN": "评审完成前，用针对性命令验证修复。",
			},
		],
		bestPractices: [
			{
				en: "Ask for review after implementation and before final merge or release.",
				"zh-CN": "实现完成后、最终合并或发布前发起评审。",
			},
			{
				en: "Keep review comments actionable: file, line, impact, and suggested direction.",
				"zh-CN": "评审意见要可执行：文件、位置、影响和建议方向。",
			},
		],
		pitfalls: [
			{
				en: "Do not block a review on generated migration files when the schema design itself is the relevant review target.",
				"zh-CN": "评审 schema 设计时，不要把尚未生成迁移文件作为阻塞项。",
			},
		],
		agentHints: [
			{
				en: "In review mode, prioritize concrete defects over broad refactoring preferences.",
				"zh-CN": "评审模式中优先报告具体缺陷，而不是泛泛的重构偏好。",
			},
		],
		actions: [
			{
				label: { en: "Narrators", "zh-CN": "叙述者" },
				description: {
					en: "Create or inspect review-focused sessions.",
					"zh-CN": "创建或查看评审相关会话。",
				},
				href: "/narrators",
			},
		],
	},
	{
		id: "providers-models-and-quotas",
		category: "admin",
		tags: ["providers", "models", "anthropic", "openai", "codex", "nug", "gemini", "quota"],
		title: { en: "Providers, models, and quotas", "zh-CN": "提供商、模型与额度" },
		summary: {
			en: "Configure AI providers, select models, manage credentials, and monitor usage so narrator work is reliable and cost-aware.",
			"zh-CN":
				"配置 AI 提供商、选择模型、管理凭据并监控使用历史和额度，让叙述者工作更可靠且可控成本。",
		},
		sections: [
			{
				title: { en: "Provider setup", "zh-CN": "提供商配置" },
				body: {
					en: "NarraFork supports multiple providers and adapter styles. Configure at least one working provider before expecting narrator sessions to run.",
					"zh-CN":
						"NarraFork 支持多个提供商和适配器；至少配置一个可用提供商后，叙述者会话才能稳定运行。",
				},
			},
			{
				title: { en: "Model choice", "zh-CN": "模型选择" },
				body: {
					en: "Use stronger models for architecture and review, faster or cheaper models for summaries and routine tasks when quality permits.",
					"zh-CN": "架构和评审优先强模型；总结和例行任务可在质量允许时选择更快或更低成本模型。",
				},
			},
		],
		workflow: [
			{
				en: "Add credentials in provider settings and refresh model lists.",
				"zh-CN": "在提供商设置中添加凭据并刷新模型列表。",
			},
			{
				en: "Set default models for normal work and summary work.",
				"zh-CN": "设置常规工作模型和摘要模型默认值。",
			},
			{
				en: "Monitor usage history and quotas before running many parallel sessions.",
				"zh-CN": "大量并行会话前，先查看使用历史和额度。",
			},
		],
		bestPractices: [
			{
				en: "Keep fallback providers available for outages or quota exhaustion.",
				"zh-CN": "保留备用提供商，应对故障或额度耗尽。",
			},
			{
				en: "Use model-specific strengths intentionally instead of one default for every task.",
				"zh-CN": "根据任务利用模型特长，不要所有任务都用同一个默认模型。",
			},
		],
		pitfalls: [
			{
				en: "A configured credential is not enough; verify the provider can list models or complete a small request.",
				"zh-CN": "填入凭据不等于可用；应确认能列出模型或完成小请求。",
			},
		],
		agentHints: [
			{
				en: "If model errors occur, report provider, model, and status clearly rather than retrying blindly.",
				"zh-CN": "遇到模型错误时，明确报告提供商、模型和状态，不要盲目重试。",
			},
		],
		actions: [
			{
				label: { en: "Providers", "zh-CN": "提供商" },
				description: { en: "Configure AI provider credentials.", "zh-CN": "配置 AI 提供商凭据。" },
				href: "/settings/providers",
			},
			{
				label: { en: "Models", "zh-CN": "模型" },
				description: {
					en: "Select default and available models.",
					"zh-CN": "选择默认模型与可用模型。",
				},
				href: "/settings/models",
			},
			{
				label: { en: "Usage", "zh-CN": "使用历史" },
				description: { en: "Inspect usage history and quotas.", "zh-CN": "查看使用历史与额度。" },
				href: "/settings/usage",
			},
		],
	},
	{
		id: "notifications-and-gateway",
		category: "admin",
		tags: ["notifications", "sound", "gateway", "webhook"],
		title: { en: "Notifications, sounds, and gateway", "zh-CN": "通知、声音与 IM 网关" },
		summary: {
			en: "Notifications keep humans aware of long-running AI work, permission requests, completions, failures, and external message gateway events.",
			"zh-CN": "通知帮助用户及时感知长时间 AI 工作、权限请求、完成、失败以及外部 IM 网关事件。",
		},
		sections: [
			{
				title: { en: "Notification channels", "zh-CN": "通知渠道" },
				body: {
					en: "Configure browser notifications, sound cues, and webhook-style integrations according to how your team monitors work.",
					"zh-CN": "根据团队监控方式配置浏览器通知、声音提醒和 webhook 类集成。",
				},
			},
			{
				title: { en: "Gateway", "zh-CN": "IM 网关" },
				body: {
					en: "The gateway connects external messaging flows to NarraFork sessions, useful for lightweight remote operations or bot-style usage.",
					"zh-CN": "IM 网关把外部消息流连接到 NarraFork 会话，适合轻量远程操作或机器人式使用。",
				},
			},
		],
		workflow: [
			{ en: "Enable essential browser notifications first.", "zh-CN": "先启用必要的浏览器通知。" },
			{
				en: "Add sound cues for events that require immediate human response.",
				"zh-CN": "对需要立刻响应的事件增加声音提醒。",
			},
			{
				en: "Test webhook or gateway settings with harmless messages.",
				"zh-CN": "用无害消息测试 webhook 或 IM 网关配置。",
			},
		],
		bestPractices: [
			{
				en: "Avoid alert fatigue: notify for permission requests, failures, and completion, not every minor event.",
				"zh-CN": "避免通知疲劳：权限请求、失败和完成应通知，琐碎事件不必都提醒。",
			},
			{
				en: "Use distinct sounds for blocking events versus informational events.",
				"zh-CN": "阻塞事件和信息事件使用不同声音。",
			},
		],
		pitfalls: [
			{
				en: "A noisy notification setup makes users ignore real permission requests.",
				"zh-CN": "过于嘈杂的通知会让用户忽略真正的权限请求。",
			},
		],
		agentHints: [
			{
				en: "When working in background, provide concise completion summaries because notifications may be the user's entry point back into the task.",
				"zh-CN": "后台任务完成时提供简洁总结，因为通知可能是用户回到任务的入口。",
			},
		],
		actions: [
			{
				label: { en: "Notifications", "zh-CN": "通知" },
				description: { en: "Configure notification behavior.", "zh-CN": "配置通知行为。" },
				href: "/settings/notifications",
			},
			{
				label: { en: "Gateway", "zh-CN": "IM 网关" },
				description: { en: "Configure external message gateway.", "zh-CN": "配置外部 IM 网关。" },
				href: "/settings/gateway",
			},
		],
	},
	{
		id: "settings-admin-and-updates",
		category: "admin",
		tags: ["settings", "admin", "users", "updates", "storage", "profile"],
		title: { en: "Settings, users, updates, and maintenance", "zh-CN": "设置、用户、更新与维护" },
		summary: {
			en: "Settings cover personal preferences and instance administration: users, runtime, storage, updates, appearance, server details, and profile data.",
			"zh-CN":
				"设置同时覆盖个人偏好和实例管理：用户、运行资源、储存空间、更新、外观、服务器信息和个人资料。",
		},
		sections: [
			{
				title: { en: "Personal settings", "zh-CN": "个人设置" },
				body: {
					en: "Profile, appearance, models, notifications, and agent behavior shape each user's daily experience.",
					"zh-CN": "个人资料、外观、模型、通知和 Agent 行为会影响每个用户的日常体验。",
				},
			},
			{
				title: { en: "Instance settings", "zh-CN": "实例设置" },
				body: {
					en: "Admins can manage providers, users, runtime, storage, terminal settings, server status, and update information.",
					"zh-CN": "管理员可管理提供商、用户、运行资源、储存空间、终端设置、服务器状态和更新信息。",
				},
			},
		],
		workflow: [
			{
				en: "Complete profile and appearance preferences first.",
				"zh-CN": "先完成个人资料和外观偏好。",
			},
			{
				en: "Admins should configure providers, runtime, storage, and users after first login.",
				"zh-CN": "管理员首次登录后应配置提供商、运行资源、储存空间和用户。",
			},
			{
				en: "Check changelogs and update status before planning maintenance windows.",
				"zh-CN": "安排维护窗口前，先查看更新日志和更新状态。",
			},
		],
		bestPractices: [
			{
				en: "Keep registration policy and admin user list intentional.",
				"zh-CN": "谨慎维护注册策略和管理员用户列表。",
			},
			{
				en: "Use storage diagnostics before deleting data; user data may be difficult to recover.",
				"zh-CN": "删除数据前先使用储存空间诊断；用户数据可能难以恢复。",
			},
			{
				en: "Read release notes before updating production-like instances.",
				"zh-CN": "更新生产或类生产实例前先阅读发布说明。",
			},
		],
		pitfalls: [
			{
				en: "Do not manually delete database files to fix migration issues unless the user explicitly requests a reset.",
				"zh-CN": "除非用户明确要求重置，否则不要通过手动删除数据库文件解决迁移问题。",
			},
		],
		agentHints: [
			{
				en: "For admin operations, explain potential data impact and avoid destructive actions without explicit authorization.",
				"zh-CN": "执行管理操作时说明潜在数据影响，未经明确授权不要做破坏性操作。",
			},
		],
		actions: [
			{
				label: { en: "Settings", "zh-CN": "设置" },
				description: { en: "Open the settings hub.", "zh-CN": "打开设置中心。" },
				href: "/settings",
			},
			{
				label: { en: "Users", "zh-CN": "用户" },
				description: { en: "Manage instance users.", "zh-CN": "管理实例用户。" },
				href: "/settings/users",
			},
			{
				label: { en: "About", "zh-CN": "关于" },
				description: { en: "Check version and changelog.", "zh-CN": "查看版本与更新日志。" },
				href: "/settings/about",
			},
		],
	},
];

function pick(text: LocalizedText, locale: LearningLocale): string {
	return pickLocalizedValue(text, locale);
}

function localizeAction(
	action: LearningAction,
	locale: LearningLocale,
): LearningDoc["actions"][number] {
	return {
		label: pick(action.label, locale),
		description: pick(action.description, locale),
		href: action.href,
	};
}

function localizeDoc(doc: LearningDocSource, locale: LearningLocale): LearningDoc {
	return {
		id: doc.id,
		category: doc.category,
		tags: doc.tags,
		title: pick(doc.title, locale),
		summary: pick(doc.summary, locale),
		sections: doc.sections.map((section) => ({
			title: pick(section.title, locale),
			body: pick(section.body, locale),
		})),
		workflow: doc.workflow.map((item) => pick(item, locale)),
		bestPractices: doc.bestPractices.map((item) => pick(item, locale)),
		pitfalls: doc.pitfalls.map((item) => pick(item, locale)),
		agentHints: doc.agentHints.map((item) => pick(item, locale)),
		actions: doc.actions.map((action) => localizeAction(action, locale)),
	};
}

function summarizeDoc(doc: LearningDocSource, locale: LearningLocale): LearningDocSummary {
	return {
		id: doc.id,
		category: doc.category,
		tags: doc.tags,
		title: pick(doc.title, locale),
		summary: pick(doc.summary, locale),
		actions: doc.actions.map((action) => localizeAction(action, locale)),
	};
}

function searchableText(doc: LearningDocSource, locale: LearningLocale): string {
	return [
		doc.id,
		doc.category,
		...doc.tags,
		pick(doc.title, locale),
		pick(doc.summary, locale),
		...doc.sections.flatMap((section) => [pick(section.title, locale), pick(section.body, locale)]),
		...doc.workflow.map((item) => pick(item, locale)),
		...doc.bestPractices.map((item) => pick(item, locale)),
		...doc.pitfalls.map((item) => pick(item, locale)),
		...doc.agentHints.map((item) => pick(item, locale)),
	]
		.join("\n")
		.toLowerCase();
}

export function getLearningCategories(localeInput?: string | null): LearningCategory[] {
	const locale = normalizeLocale(localeInput);
	return Object.entries(categories).map(([id, category]) => ({
		id,
		label: pick(category, locale),
		description: pick(category.description, locale),
	}));
}

export function getLearningDocSummaries(localeInput?: string | null): LearningDocSummary[] {
	const locale = normalizeLocale(localeInput);
	return docs.map((doc) => summarizeDoc(doc, locale));
}

export function getLearningDocs(localeInput?: string | null): LearningDoc[] {
	const locale = normalizeLocale(localeInput);
	return docs.map((doc) => localizeDoc(doc, locale));
}

export function getLearningDoc(id: string, localeInput?: string | null): LearningDoc | undefined {
	const locale = normalizeLocale(localeInput);
	const doc = docs.find((item) => item.id === id);
	return doc ? localizeDoc(doc, locale) : undefined;
}

export function searchLearningDocs(
	query: string,
	localeInput?: string | null,
): LearningDocSummary[] {
	const locale = normalizeLocale(localeInput);
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.trim())
		.filter(Boolean);
	if (terms.length === 0) return getLearningDocSummaries(locale);

	return docs
		.map((doc) => {
			const text = searchableText(doc, locale);
			const title = pick(doc.title, locale).toLowerCase();
			const score = terms.reduce((sum, term) => {
				if (!text.includes(term)) return sum;
				return sum + (title.includes(term) ? 4 : 1) + (doc.tags.includes(term) ? 3 : 0);
			}, 0);
			return { doc, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
		.map((item) => summarizeDoc(item.doc, locale));
}

export function learningDocExists(id: string): boolean {
	return docs.some((doc) => doc.id === id);
}
