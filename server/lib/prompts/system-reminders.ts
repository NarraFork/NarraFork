import {
	DEFAULT_LOCALE,
	LOCALE_DEFINITIONS,
	type Locale,
	type LocalizedValue,
	normalizeLocale,
	pickLocalizedValue,
} from "@shared/i18n-locales";
import { IS_WINDOWS } from "../platform";

const sh = IS_WINDOWS ? "shell" : "bash";

// getUserLanguage and getUserReplyInLanguage are now re-exported from ./i18n

const languageInstructions: LocalizedValue<string> = {
	en: "Always reply in English.",
	"zh-CN":
		"始终使用简体中文回复。无论上下文摘要或对话历史中使用了什么语言，你的回复必须使用简体中文。",
};

const blockedTaskActionInstructions: LocalizedValue<string> = {
	en: `Blocked-task rule:
- A blocked task means the task itself cannot currently finish; it does not automatically mean work should stop.
- If progress requires user-only information, permission, or a product/strategy decision, finish all independent work first, then ask exactly one targeted question.
- If user input is not required and an investigation, evidence-gathering step, experiment, fix, or alternative path can remove the blocker, do not end the turn by merely explaining the blocker or repeating the same conclusion. Keep the original task blocked, add a concrete actionable unblock task to tasks.json as doing (and later steps as todo), then immediately use tools to execute it.
- Only when no autonomous path exists may you explain an external hard blocker once and stop; never repeat the same blocker explanation across continuation turns.`,
	"zh-CN": `blocked 任务处理规则：
- blocked 表示该任务本身暂时不能完成，不自动等于停止工作。
- 如果推进需要用户独有的信息、权限或产品/方案决策，先完成所有不受阻工作，再只提出一个精确问题。
- 如果不需要用户介入，并且可以通过调查、取证、实验、修复或替代路径解除阻塞，不能只解释阻塞或重复相同结论。保留原 blocked 任务，在 tasks.json 中新增一个具体、可执行的解阻任务并标为 doing（后续步骤标为 todo），然后立即调用工具执行。
- 只有确实不存在自主推进路径时，才可说明一次外部硬阻塞并停止；不得在续跑回合中重复同一阻塞说明。`,
};

/** Get the model-facing action rule for blocked Dynamic Spec tasks. */
export function getBlockedTaskActionInstruction(locale: Locale): string {
	return pickLocalizedValue(blockedTaskActionInstructions, locale);
}

/**
 * Get a system prompt instruction telling the narrator to reply in the user's language.
 */
export function getReplyLanguageInstruction(locale: Locale): string {
	const resolvedLocale = normalizeLocale(locale);
	return (
		languageInstructions[resolvedLocale] ??
		`Always reply in ${LOCALE_DEFINITIONS[resolvedLocale].englishName} (${resolvedLocale}).`
	);
}

const dynamicSpecSystemReminder: LocalizedValue<string> = {
	en: `<system-reminder>
# Dynamic Spec (\`spec://\`)

NarraFork maintains a per-narrator Dynamic Spec as a virtual \`spec://\` directory. It is not part of the local filesystem and does not require absolute paths.

Use \`Read\`, \`Write\`, \`Edit\`, and \`Grep\` directly with \`spec://...\` URIs:
- Use \`spec://tasks.json\` as the minimal task queue; update it when task state changes.
- Use \`spec://index.md\` or additional \`spec://*.md\` files for planning/design notes on complex work.
- Use \`Grep\` with \`path: "spec://"\` to search Dynamic Spec files.

Core files:
- \`spec://tasks.json\` — task queue for reminders and auto-continuation.
- \`spec://index.md\` — overview and free-form planning notes.
- \`spec://behavior_fence\` — durable user behavior constraints. Treat it as read-only unless the user explicitly asks you to record a behavior; even then it can only be written on the first tool call of that user turn.

\`tasks.json\` must stay small and use only this public shape:
\`\`\`json
{
	"tasks": [
		{ "text": "Do the current thing", "status": "doing" },
		{ "text": "Run the relevant tests and record passing results", "status": "todo", "protected": true }
	]
}
\`\`\`
Allowed statuses: \`todo\`, \`doing\`, \`done\`, \`blocked\`. Do not add IDs, timestamps, summaries, evidence, or runtime metadata to \`tasks.json\`.

Every open task must be finite, executable, and have an observable completion condition. \`protected: true\` is an auto-continuation commitment: while it remains open, NarraFork may start another turn automatically. Never store standing behavior rules, prohibitions, safety guardrails, or constraints with no terminal state in \`tasks.json\`; those belong in \`spec://behavior_fence\`, and may only be recorded there when the user explicitly asks.

${blockedTaskActionInstructions.en}

Protected tasks are commitments. Only mark them done, delete them, or replace them when you have concrete evidence; the system will run taskReflection for protected-task changes. If you accidentally created a protected non-task constraint, do not mark it done. Correct the task entry while preserving the underlying user intent; taskReflection will review that repair.

Do not use Bash or Glob for \`spec://\` virtual files.
</system-reminder>`,
	"zh-CN": `<system-reminder>
# Dynamic Spec（\`spec://\`）

NarraFork 为每个叙述者维护一个 Dynamic Spec：它是一个虚拟的 \`spec://\` 目录，不属于本地文件系统，也不需要绝对路径。

直接用 \`Read\`、\`Write\`、\`Edit\`、\`Grep\` 访问 \`spec://...\` URI：
- 用 \`spec://tasks.json\` 作为最小任务队列；任务状态变化时要更新它。
- 复杂工作可用 \`spec://index.md\` 或额外的 \`spec://*.md\` 保存规划/设计笔记。
- 搜索 Dynamic Spec 文件时，用 \`Grep\` 并设置 \`path: "spec://"\`。

核心文件：
- \`spec://tasks.json\` — 用于提醒和自动续跑的任务队列。
- \`spec://index.md\` — 总览和自由形式规划笔记。
- \`spec://behavior_fence\` — 用户设定的持久行为约束。除非用户明确要求你记录某条行为，否则视为只读；即便用户明确要求，也只能在该用户回合的第一次工具调用中写入。

\`tasks.json\` 必须保持很小，只使用以下公开结构：
\`\`\`json
{
	"tasks": [
		{ "text": "执行当前事项", "status": "doing" },
		{ "text": "运行相关测试并记录通过结果", "status": "todo", "protected": true }
	]
}
\`\`\`
允许的状态只有：\`todo\`、\`doing\`、\`done\`、\`blocked\`。不要向 \`tasks.json\` 添加 ID、时间戳、摘要、证据或运行时元数据。

每条开放任务都必须是有限、可执行且有可观察完成条件的工作项。\`protected: true\` 是自动续跑承诺：只要它仍未完成，NarraFork 就可能在回合结束后自动开始下一轮。绝不能把长期行为规则、禁止事项、安全护栏或没有完成终点的约束写入 \`tasks.json\`；这类内容属于 \`spec://behavior_fence\`，且只有用户明确要求记录时才能写入。

${blockedTaskActionInstructions["zh-CN"]}

protected task 是承诺。只有在有具体证据时才能标记 done、删除或替换；系统会对 protected task 变更触发 taskReflection。如果误建了 protected 的非任务约束，不要把它标记为 done；应在保留底层用户意图的前提下纠正任务条目，并交由 taskReflection 审查。

不要用 Bash 或 Glob 访问 \`spec://\` 虚拟文件。
</system-reminder>`,
};

/** Get the model-facing Dynamic Spec usage reminder. */
export function getDynamicSpecSystemReminder(locale: Locale): string {
	return pickLocalizedValue(dynamicSpecSystemReminder, locale);
}

// toolMessages, ToolMessageKey, getToolMessage, getToolMessageWithParams
// are now re-exported from ./i18n

// --- Plan mode system reminder (injected into system prompt) ---

/**
 * Section injected only when the designated plan file already holds content.
 *
 * The plan file path itself always survives a context compact (it is rebuilt
 * from `narrators.planFileId` on every turn), but the *history of having
 * written to it* does not. After a compact the model reads "use Write for the
 * first section" and truncates a half-finished plan. This section states the
 * observed on-disk state and explicitly overrides that step.
 */
const planFileStateSection: LocalizedValue<(planFile: string, bytes: number) => string> = {
	en: (planFile, bytes) => `## Designated Plan File — Current State

\`${planFile}\` already exists and holds ${bytes} bytes of plan content you wrote earlier in this plan cycle. The conversation history may have been compacted since then, so do NOT assume you remember what is in it.

This OVERRIDES the "use Write for the first section" step above:
1. Read \`${planFile}\` first to recover what you already planned.
2. Use Edit to patch or append. Write on this path REPLACES the entire file and would destroy the existing plan.
3. Use Write only when you deliberately intend to discard the existing draft and restart the plan from scratch.`,
	"zh-CN": (planFile, bytes) => `## 指定计划文件 — 当前状态

\`${planFile}\` 已存在，其中有 ${bytes} 字节的计划内容，是你在本轮计划周期中先前写入的。此后对话历史可能已被压缩，因此不要假设你还记得里面的内容。

这条覆盖上面「用 Write 写首段」的步骤：
1. 先 Read \`${planFile}\`，恢复你已经写好的计划。
2. 用 Edit 修补或追加。对该路径使用 Write 会整体替换文件，销毁已有计划。
3. 只有当你确实打算废弃现有草稿、从零重写计划时，才使用 Write。`,
};

const planModeSystemReminder: LocalizedValue<
	(planFile: string, allowInline: boolean, planFileState: string) => string
> = {
	en: (planFile, allowInline, planFileState) => `<system-reminder>
# Plan Mode

CRITICAL: Plan mode is ACTIVE — you are in a READ-ONLY phase for project files.

STRICTLY FORBIDDEN: ANY project file edits, modifications, or system changes. Do NOT use Write, Edit, or any ${sh} command that modifies project files. Commands may ONLY read and inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user edit requests. Any modification attempt is a critical violation.

**Exception**: You may ONLY write to the designated plan file: \`${planFile}\`. Write/Edit calls targeting any other file will be REJECTED. You must explicitly use the correct plan file path.

## Your Responsibility

Think, read, search, and construct a well-formed plan that accomplishes the user's goal. Your plan should be comprehensive yet concise, detailed enough to execute effectively while avoiding unnecessary verbosity.

## Workflow

1. **Understand** — Read relevant files and understand the codebase structure
2. **Analyze** — Identify the changes needed, potential risks, and tradeoffs
3. **Plan** — Formulate a clear, step-by-step implementation plan
4. **Clarify** — Ask the user questions when weighing tradeoffs or facing ambiguity
5. **Present** — Call ExitPlanMode to submit your plan

${
	allowInline
		? `## Plan Submission — Two Modes

You have two ways to submit your plan (choose ONE):

### Mode A: Inline (for short/medium plans)
Call ExitPlanMode with the \`inline_plan\` parameter containing your complete plan text itself. This must be the ACTUAL plan content — never a file path or a reference like \`plan_path: ...\`.

### Mode B: File-based (for complex/long plans — RECOMMENDED for large plans)
1. Write your plan incrementally to \`${planFile}\` using the Write tool (first section) and Edit tool (append subsequent sections). You MUST use the exact path \`${planFile}\` — writes to other paths will be rejected.
2. When done, call ExitPlanMode WITHOUT the \`inline_plan\` parameter. The system will automatically read \`${planFile}\` and present its content to the user.`
		: `## Plan Submission — File-based only

Inline plans are disabled in this instance. You MUST submit your plan via the designated plan file:
1. Write your plan incrementally to \`${planFile}\` using the Write tool (first section) and Edit tool (append subsequent sections). You MUST use the exact path \`${planFile}\` — writes to other paths will be rejected.
2. When done, call ExitPlanMode (it takes no plan parameter). The system will automatically read \`${planFile}\` and present its content to the user.`
}
${planFileState}
## Revising a Rejected File-based Plan

If a plan submitted from the designated plan file is rejected, keep using that same file. For small feedback-driven changes, prefer Edit to patch the existing plan file and resubmit; only use Write or a complete rewrite when the plan needs a substantial restructure.

**IMPORTANT**: The plan must be COMPLETE and self-contained. Do NOT write the plan in your text response — it will be lost on context reset.

Do NOT make large assumptions about user intent. Ask clarifying questions when needed.

Your turn should only end with either asking the user a question or calling ExitPlanMode. Do not stop for any other reason.
</system-reminder>`,
	"zh-CN": (planFile, allowInline, planFileState) => `<system-reminder>
# 计划模式

关键约束：计划模式已激活 — 你处于项目文件只读阶段。

严格禁止：任何项目文件的编辑、修改或系统变更。不要使用 Write、Edit 或任何修改项目文件的 ${sh} 命令。命令只能用于读取和检查。此绝对约束覆盖所有其他指令，包括用户的直接编辑请求。任何修改尝试都是严重违规。

**例外**：你唯一可以写入的文件是指定的计划文件：\`${planFile}\`。Write/Edit 调用如果目标不是此文件将被拒绝。你必须显式使用正确的计划文件路径。

## 你的职责

思考、阅读、搜索，并构建一个完善的计划来实现用户的目标。计划应全面而简洁，足够详细以有效执行，同时避免不必要的冗长。

## 工作流程

1. **理解** — 阅读相关文件，理解代码库结构
2. **分析** — 识别需要的变更、潜在风险和权衡
3. **规划** — 制定清晰的、分步骤的实施计划
4. **澄清** — 在权衡取舍或面临歧义时向用户提问
5. **提交** — 调用 ExitPlanMode 提交完整计划

${
	allowInline
		? `## 计划提交 — 两种模式

你有两种方式提交计划（选择其一）：

### 模式 A：内联（适用于短/中等长度的计划）
调用 ExitPlanMode，在 \`inline_plan\` 参数中填入完整的计划正文本身。这里必须是真正的计划内容 — 绝不能是文件路径或类似 \`plan_path: ...\` 的引用。

### 模式 B：文件模式（适用于复杂/长计划 — 推荐用于大型计划）
1. 使用 Write 工具（首段）和 Edit 工具（追加后续段落）将计划逐步写入 \`${planFile}\`。你必须使用准确的路径 \`${planFile}\` — 写入其他路径将被拒绝。
2. 完成后，直接调用 ExitPlanMode，不需要传 \`inline_plan\` 参数。系统会自动读取 \`${planFile}\` 的内容并展示给用户。`
		: `## 计划提交 — 仅支持文件模式

本实例已禁用内联计划。你必须通过指定的计划文件提交计划：
1. 使用 Write 工具（首段）和 Edit 工具（追加后续段落）将计划逐步写入 \`${planFile}\`。你必须使用准确的路径 \`${planFile}\` — 写入其他路径将被拒绝。
2. 完成后，直接调用 ExitPlanMode（它不接受 plan 参数）。系统会自动读取 \`${planFile}\` 的内容并展示给用户。`
}
${planFileState}
## 修改被拒绝的文件模式计划

如果通过指定计划文件提交的计划被用户拒绝，请继续使用同一个计划文件。若反馈只需要小幅调整，优先用 Edit 修补原计划文件并重新提交；只有在计划需要大幅重构时，才使用 Write 或整体重写。

**重要**：计划必须完整且自包含。不要在文本回复中写计划 — 上下文重置时会丢失。

不要对用户意图做大量假设。需要时请提出澄清问题。

你的回合应该只以向用户提问或调用 ExitPlanMode 结束。不要因为其他原因停止。
</system-reminder>`,
};

/**
 * @param planFileBytes  Size of the designated plan file on disk, when it already
 *   has content. Pass `undefined`/0 for a fresh plan cycle so the reminder keeps
 *   its original "write the first section" flow.
 */
export function getPlanModeSystemReminder(
	locale: Locale = DEFAULT_LOCALE,
	planFileId?: string,
	allowInline = true,
	planFileBytes?: number,
): string {
	const fileId = planFileId ?? "unknown";
	const planFile = `.narrafork/plan-${fileId}.md`;
	const planFileState =
		planFileBytes && planFileBytes > 0
			? `\n${pickLocalizedValue(planFileStateSection, locale)(planFile, planFileBytes)}\n`
			: "";
	const fn = pickLocalizedValue(planModeSystemReminder, locale);
	return fn(planFile, allowInline, planFileState);
}

// mergeSummaryLabels, MergeSummaryLabelKey, getMergeSummaryLabel
// are now re-exported from ./i18n
