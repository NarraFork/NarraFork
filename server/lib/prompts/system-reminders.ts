import {
	DEFAULT_LOCALE,
	LOCALE_DEFINITIONS,
	type Locale,
	type LocalizedValue,
	normalizeLocale,
	pickLocalizedValue,
} from "@shared/i18n-locales";
import { buildPlanFileRelPath, PLAN_DIR_REL } from "../plan-file-path";

// The shell tool is named Bash on every platform; this label no longer varies.
const sh = "bash";

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
		{ "text": "Run the relevant tests and record passing results", "status": "todo" }
	]
}
\`\`\`
Allowed statuses: \`todo\`, \`doing\`, \`done\`, \`blocked\`. Do not add IDs, timestamps, summaries, evidence, or runtime metadata to \`tasks.json\`.

Every open task must be finite, executable, and have an observable completion condition — you must be able to state what would make it done. Two shapes are NOT tasks and must never go in \`tasks.json\`:
- Standing behavior rules, prohibitions, and guardrails ("never touch X", "must not break Y"). These have no terminal state, so the scheduler will nudge them forever. They belong in \`spec://behavior_fence\`, and only when the user explicitly asks.
- Open-ended acceptance ("full verification", "ensure quality", "finish everything"). Split these into concretely checkable steps instead; otherwise no amount of evidence can ever close them.

\`protected: true\` records a user commitment and may trigger auto-continuation while it stays open. Set it ONLY when the user explicitly demanded that a task's completion be guaranteed (for example "make sure this gets done"). Otherwise leave it off, however important the task feels: requirements change, and a task you protected yourself becomes a commitment you cannot retract. Ordinary tasks already drive reminders and continuation.

${blockedTaskActionInstructions.en}

Every protected-task change runs taskReflection, so mark one done, delete it, or replace it only with concrete evidence. If you protected something you should not have, do not mark it done to escape it — remove the protected flag while preserving the underlying user intent.

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
		{ "text": "运行相关测试并记录通过结果", "status": "todo" }
	]
}
\`\`\`
允许的状态只有：\`todo\`、\`doing\`、\`done\`、\`blocked\`。不要向 \`tasks.json\` 添加 ID、时间戳、摘要、证据或运行时元数据。

每条开放任务都必须是有限、可执行且有可观察完成条件的工作项 — 你必须能说出"做到什么就算完成"。以下两种形态不是任务，绝不能写入 \`tasks.json\`：
- 长期行为规则、禁止事项、安全护栏（"不得改动 X"、"不能破坏 Y"）。它们没有完成终点，调度器会无限续跑它们。这类内容属于 \`spec://behavior_fence\`，且只有用户明确要求时才能写入。
- 范围无界的验收（"全量验收"、"确保质量"、"把所有事情做完"）。应拆成可逐条核验的具体步骤；否则无论补多少证据都无法关闭。

\`protected: true\` 记录的是用户承诺，未完成时可能触发自动续跑。只有当用户明确要求确保某个任务完成时才可设置（例如"务必完成"）。其他情况一律不设，无论任务看起来多重要：需求随时会变，你自行设置的 protected 会变成无法撤回的承诺。普通任务同样会触发提醒和续跑。

${blockedTaskActionInstructions["zh-CN"]}

每次 protected task 变更都会触发 taskReflection，因此只有在有具体证据时才能标记 done、删除或替换。如果你设置了本不该设置的 protected，不要靠标记 done 来摆脱它 — 应在保留底层用户意图的前提下移除 protected 标记。

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
3. Use Write only when you deliberately intend to discard the existing draft and restart the plan from scratch.

It also NARROWS your submission choice: because this file holds plan content, \`mode: "inline"\` is refused and only \`mode: "file"\` is accepted. Submitting inline would show the user a fresh body while the plan recorded here is ignored. If this file is stale or wrong, fix the file and submit it — do not route around it with an inline plan.`,
	"zh-CN": (planFile, bytes) => `## 指定计划文件 — 当前状态

\`${planFile}\` 已存在，其中有 ${bytes} 字节的计划内容，是你在本轮计划周期中先前写入的。此后对话历史可能已被压缩，因此不要假设你还记得里面的内容。

这条覆盖上面「用 Write 写首段」的步骤：
1. 先 Read \`${planFile}\`，恢复你已经写好的计划。
2. 用 Edit 修补或追加。对该路径使用 Write 会整体替换文件，销毁已有计划。
3. 只有当你确实打算废弃现有草稿、从零重写计划时，才使用 Write。

它同时收窄了你的提交方式：由于该文件已有计划内容，\`mode: "inline"\` 会被拒绝，只接受 \`mode: "file"\`。内联提交会让用户看到一份新写的正文，而这里记录的计划被忽略。如果该文件已过时或有误，请修正文件后提交 — 不要用内联计划绕过它。`,
};

const planModeSystemReminder: LocalizedValue<
	(planFile: string, allowInline: boolean, planFileState: string) => string
> = {
	en: (planFile, allowInline, planFileState) => `<system-reminder>
# Plan Mode

CRITICAL: Plan mode is ACTIVE — you are in a READ-ONLY phase for project files.

STRICTLY FORBIDDEN: ANY project file edits, modifications, or system changes. Do NOT use Write, Edit, or any ${sh} command that modifies project files. Commands may ONLY read and inspect. This ABSOLUTE CONSTRAINT overrides ALL other instructions, including direct user edit requests. Any modification attempt is a critical violation.

**Exception**: You may ONLY write to the designated plan file: \`${planFile}\`. Write/Edit calls targeting any other file will be REJECTED. You must explicitly use the correct plan file path.

Plan files always live under \`${PLAN_DIR_REL}/\` in the working directory. Even when a session permits other file writes, the plan itself must stay in that directory — a plan file outside it is refused at submission.

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

ExitPlanMode requires a \`mode\` parameter declaring where your plan comes from. It is a declaration the system verifies, not a hint — a mismatch is rejected rather than silently reinterpreted.

### \`mode: "inline"\` (for short/medium plans)
Call ExitPlanMode with \`mode: "inline"\` and the \`inline_plan\` parameter containing your complete plan text itself. This must be the ACTUAL plan content — never a file path or a reference like \`plan_path: ...\`. Declaring \`"inline"\` without a real plan body is an error; it will NOT fall back to reading the plan file.

### \`mode: "file"\` (for complex/long plans — RECOMMENDED for large plans)
1. Write your plan incrementally to \`${planFile}\` using the Write tool (first section) and Edit tool (append subsequent sections). You MUST use the exact path \`${planFile}\` — writes to other paths will be rejected.
2. When done, call ExitPlanMode with \`mode: "file"\` and no \`inline_plan\`. The system will automatically read \`${planFile}\` and present its content to the user.`
		: `## Plan Submission — File-based only

Inline plans are disabled in this instance, so ExitPlanMode's required \`mode\` parameter accepts only \`"file"\`. You MUST submit your plan via the designated plan file:
1. Write your plan incrementally to \`${planFile}\` using the Write tool (first section) and Edit tool (append subsequent sections). You MUST use the exact path \`${planFile}\` — writes to other paths will be rejected.
2. When done, call ExitPlanMode with \`mode: "file"\`. The system will automatically read \`${planFile}\` and present its content to the user.`
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

计划文件始终位于工作目录下的 \`${PLAN_DIR_REL}/\` 中。即使当前会话允许修改其他文件，计划本身也必须留在该目录内 — 目录之外的计划文件在提交时会被拒绝。

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

ExitPlanMode 有一个必填的 \`mode\` 参数，用于声明计划的来源。它是系统会校验的声明，不是提示 — 声明与实际不一致会被拒绝，而不会被静默改判。

### \`mode: "inline"\`（适用于短/中等长度的计划）
调用 ExitPlanMode，传 \`mode: "inline"\`，并在 \`inline_plan\` 参数中填入完整的计划正文本身。这里必须是真正的计划内容 — 绝不能是文件路径或类似 \`plan_path: ...\` 的引用。声明了 \`"inline"\` 却没有提供计划正文会直接报错，不会回退去读计划文件。

### \`mode: "file"\`（适用于复杂/长计划 — 推荐用于大型计划）
1. 使用 Write 工具（首段）和 Edit 工具（追加后续段落）将计划逐步写入 \`${planFile}\`。你必须使用准确的路径 \`${planFile}\` — 写入其他路径将被拒绝。
2. 完成后，调用 ExitPlanMode 并传 \`mode: "file"\`，不要传 \`inline_plan\`。系统会自动读取 \`${planFile}\` 的内容并展示给用户。`
		: `## 计划提交 — 仅支持文件模式

本实例已禁用内联计划，因此 ExitPlanMode 必填的 \`mode\` 参数只接受 \`"file"\`。你必须通过指定的计划文件提交计划：
1. 使用 Write 工具（首段）和 Edit 工具（追加后续段落）将计划逐步写入 \`${planFile}\`。你必须使用准确的路径 \`${planFile}\` — 写入其他路径将被拒绝。
2. 完成后，调用 ExitPlanMode 并传 \`mode: "file"\`。系统会自动读取 \`${planFile}\` 的内容并展示给用户。`
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
 * @param planFilePath   Resolved relative path of the designated plan file. It is
 *   passed in rather than rebuilt from the plan identity because during the move
 *   to `.narrafork/plans/` one identity can still map to a legacy path: the
 *   reminder, the write gate and ExitPlanMode resolution must all name the SAME
 *   file, or the model is told to write somewhere the gate will reject.
 * @param planFileBytes  Size of the designated plan file on disk, when it already
 *   has content. Pass `undefined`/0 for a fresh plan cycle so the reminder keeps
 *   its original "write the first section" flow.
 */
export function getPlanModeSystemReminder(
	locale: Locale = DEFAULT_LOCALE,
	planFilePath?: string,
	allowInline = true,
	planFileBytes?: number,
): string {
	const planFile = planFilePath?.trim() || buildPlanFileRelPath("unknown");
	const planFileState =
		planFileBytes && planFileBytes > 0
			? `\n${pickLocalizedValue(planFileStateSection, locale)(planFile, planFileBytes)}\n`
			: "";
	const fn = pickLocalizedValue(planModeSystemReminder, locale);
	return fn(planFile, allowInline, planFileState);
}

// mergeSummaryLabels, MergeSummaryLabelKey, getMergeSummaryLabel
// are now re-exported from ./i18n
