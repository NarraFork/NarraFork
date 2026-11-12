import { type Locale, type LocalizedValue, pickLocalizedValue } from "@shared/i18n-locales";
import { OUTLINE_NOTE_RULES } from "@shared/outline-note-structure";
import type { OutlineTaskNoticeChange } from "@shared/outline-task-notice";

// ─── Outline tasks ───
//
// The model-facing text of a session whose tasks live in the outline (task backend `outline`,
// `services/task-source/outline.ts`): the system-prompt section that replaces the Dynamic Spec
// instructions, the two built-in views (current tasks, behavior boundary), the continuation
// prompts, the interrupt note, the turn-end note, the compact context and the hint a `spec://`
// path gets. No `spec://` vocabulary: an outline session has none (its behavior boundary is the
// behavior page of its session space, outline plan PR 4).
//
// The system-prompt section is part of the frozen contract of a prefix epoch, so it holds only
// what does not change while a session runs (design §0, the three conventions); live task state
// reaches the model through the views (named context parts, updated when they change) and tool
// results. The views' text is deterministic (fixed order, no times): it is also their change key.
//
// Convention 1 states how a note under a task is written (task tree readability PR D, decision
// D53: conclusion, then evidence, then detail) with the numbers `OutlineEdit` checks
// (`@shared/outline-note-structure`): constants, so the text is the same every turn.

const { titleChars, noteChars, detailChars, maxChildren } = OUTLINE_NOTE_RULES;

/** One task as the outline prompts name it. */
export interface OutlineTaskPromptTask {
	/** The task's title (its first line, plain text). */
	text: string;
	/** `key/sid`, when known: what OutlineRead and OutlineEdit take. */
	address: string | null;
	/** Created by a person (`/goal`, the interface): the agent may not drop it on its own. */
	humanCreated: boolean;
}

const systemReminder: LocalizedValue<string> = {
	en: `<system-reminder>
# Outline

This session keeps its notes and tasks in the outline: read with OutlineRead and OutlineSearch, write with OutlineEdit. A task is a block with a checkbox: \`[ ]\` to do, \`[/]\` in progress, \`[x]\` done, \`[-]\` cancelled. Tasks you set yourself go in this session's space (\`session/\`). Three conventions:
1. Write what will be needed later into the outline: conclusions, decisions, pitfalls, plans. Write it under the task at hand, conclusion first: each block directly under a task is one conclusion in one line (at most ${noteChars} characters); its evidence (file:line, the commands you ran and their results) goes in blocks under that conclusion, and details under those (each at most ${detailChars} characters, at most ${maxChildren} blocks on one level). Do not record the process (what you looked at, what you tried): the conversation has it. No markdown headings: levels are the indentation. A task's title is one line (at most ${titleChars} characters) saying what done means. A finished task shows as its title and the first line under it, so when you tick a task done, its first block must say the result in one line.
2. When you start a task, tick it in progress; when it is done, tick it done. When a person has to decide something, ask them and give your recommendation.
3. When a tool says a change was handed to someone for confirmation, do the parts it does not affect first.

A task of a project's space is the team's. If you must stop with one unfinished and nobody is waiting on you in this conversation, leave a note under it before you end: where you stopped, what comes next, which branch and commit hold the code. The system may hand the task to a new session, which continues from your note; do not set it back to \`[ ]\` yourself.

Standing rules of behavior are not tasks. They live on this session's behavior page (alias \`behavior\` in \`session/\`). When the user asks you to record one, write it to that page with OutlineEdit (create the page with \`alias:: behavior\` if there is none), and only as the first tool call of that user turn; at any other time the page is read-only to you. This session has no \`spec://\`: the \`spec://\` paths the file tools mention do not apply here.

The system keeps two views in your context and updates them when they change: this session's current tasks (\`outline.tasks\`) and its behavior boundary (\`outline.behavior\`, which you must always follow).
</system-reminder>`,
	"zh-CN": `<system-reminder>
# 大纲

本会话的笔记和任务都在大纲里：用 OutlineRead、OutlineSearch 读，用 OutlineEdit 写。任务就是带复选框的块：\`[ ]\` 待办、\`[/]\` 进行中、\`[x]\` 完成、\`[-]\` 取消。你给自己定的任务写在本会话的空间里（\`session/\`）。三条约定：
1. 以后还用得到的写进大纲：结论、决定、坑、计划。写在手头的任务下面，按「结论 → 依据 → 细节」：任务下第一层每块是一行结论（不超过 ${noteChars} 字）；依据（文件:行、跑过的命令和结果）写成这条结论的子块，细节再往下一层（每块不超过 ${detailChars} 字，一层不超过 ${maxChildren} 块）。不写过程（先看了什么、又试了什么）：过程在会话记录里。不用 markdown 标题，层次用缩进表达。任务标题只写一行（不超过 ${titleChars} 字），说清做成什么算完成。完成的任务收起后只显示标题和它下面的第一行，所以勾完成时，任务下第一块要是一行结果。
2. 开始做一个任务就把它勾成进行中，做完勾成完成；需要人决定的，提问并附上你的建议。
3. 工具说改动「已交给某人确认」时，先做不受影响的部分。

项目空间里的任务是团队的。如果不得不停下而任务还没做完，这个对话里又没有人在等你，结束前在任务下留一段说明：停在哪、下一步是什么、代码在哪个分支哪个提交。系统可能把任务交给一个新会话，由它照你的说明接着做；不要自己把它改回 \`[ ]\`。

长期的行为规则不是任务，它们在本会话的行为边界页里（\`session/\` 中别名为 \`behavior\` 的页）。用户要求你记下一条时，用 OutlineEdit 写进这一页（还没有这一页就新建，并写上 \`alias:: behavior\`），而且只能作为该用户回合的第一个工具调用；其他时候这一页对你只读。本会话没有 \`spec://\`：文件工具说明里提到的 \`spec://\` 路径在这里都不适用。

系统在你的上下文里维护两个视图，有变化时更新：本会话的当前任务（\`outline.tasks\`）和行为边界（\`outline.behavior\`，务必遵守）。
</system-reminder>`,
};

/** The system-prompt section of an outline session, in place of the Dynamic Spec section. */
export function getOutlineTaskSystemReminder(locale: Locale): string {
	return pickLocalizedValue(systemReminder, locale);
}

function taskLabel(task: OutlineTaskPromptTask, locale: Locale): string {
	const marker = task.humanCreated
		? locale === "zh-CN"
			? " [人建任务]"
			: " [set by a person]"
		: "";
	return task.address ? `\`${task.address}\` ${task.text}${marker}` : `${task.text}${marker}`;
}

const humanCreatedNote: LocalizedValue<string> = {
	en: "\n- Set by a person: do not cancel or rewrite it on your own; if it no longer fits, ask them.",
	"zh-CN": "\n- 人建任务：不要自行取消或改写；如果它已不合适，先问人。",
};

/**
 * The continuation of an ordinary session (it may ask its person, no pass ceiling): names one
 * task, says the system sent it and gives the four outcomes (`doing`), or the ways out of a wait
 * (`blocked`: every open task waits on a prerequisite or a person, design D27b).
 */
export function getOutlineContinuationPrompt(input: {
	status: "doing" | "blocked";
	task: OutlineTaskPromptTask;
	locale: Locale;
}): string {
	const { task, locale } = input;
	const label = taskLabel(task, locale);
	const note = task.humanCreated ? pickLocalizedValue(humanCreatedNote, locale) : "";
	if (input.status === "blocked") {
		return locale === "zh-CN"
			? `大纲任务续跑：所有任务都在等待（系统消息，不是用户发言）。\n\n本会话所有未完成的任务都在等待——等前置任务完成，或等人回答——时，系统自动发出这条消息。\n\n等待中的任务（仅这一条，本会话的其他任务仍在大纲里）：${label}\n\n请按实际情况选择：\n- 不需要人也能解除等待（调查、修复、换一条路）：在它下面加一个解阻任务，勾成进行中（\`[/]\`），立刻动手。\n- 需要人提供信息、权限或决定：先做完不需要人的部分，再用 Ask 提一个精确的问题并附上你的建议（问题记在任务下，回答回来会唤醒本会话），然后结束回合。\n- 已不符合当前实际：在保留原意图的前提下改写它或勾成取消（\`[-]\`），并说明原因。\n\n不要在之后的续跑里重复同一段等待说明。${note}`
			: `Outline task continuation: every task is waiting (system message, not the user speaking).\n\nThe system sends this when every open task of this session is waiting — on a prerequisite that is not finished, or on a person's answer.\n\nWaiting task (this one only; the session's other tasks are still in the outline): ${label}\n\nTake the path that fits:\n- The wait can be removed without a person (an investigation, a fix, another approach): add a task for that under it, tick it in progress (\`[/]\`) and work on it now.\n- It needs a person's information, permission or decision: finish every part that does not need them, then ask one precise question with your recommendation using Ask (it is recorded under the task, and the answer comes back to this session as a message), and end the turn.\n- It no longer matches reality: rewrite it or tick it cancelled (\`[-]\`), keeping the original intent, and say why.\n\nDo not repeat an explanation of the same wait on later continuations.${note}`;
	}
	return locale === "zh-CN"
		? `大纲任务续跑（系统消息，不是用户发言）。\n\n本会话在大纲里还有进行中的任务时，系统自动发出这条消息。它只说明该任务还没勾成完成——不代表系统判断你没做完，任务内容也可能已经过时。\n\n当前任务（仅这一条，本会话的其他任务仍在大纲里）：${label}\n\n请先判断这个任务的真实状态，再按实际情况选择其一：\n- 已经完成：用 OutlineEdit 把它勾成完成（\`[x]\`）。这就是本回合的有效结果，不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- 需要人提供信息、权限、决定，或需要人亲自操作：先做完不受阻的部分，再用 Ask 提一个精确的问题并附上你的建议（问题记在任务下，回答回来会唤醒本会话），然后结束回合。\n- 已不符合当前实际：在保留原意图的前提下改写它或勾成取消（\`[-]\`），并说明原因。${note}`
		: `Outline task continuation (system message, not the user speaking).\n\nThe system sends this while a task of this session is still in progress in the outline. It only means the task is not ticked done yet — not that the system judged your work unfinished, and the task may be out of date.\n\nCurrent task (this one only; the session's other tasks are still in the outline): ${label}\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: tick it done (\`[x]\`) with OutlineEdit. That is a valid result for this turn; do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- Needs a person's information, permission, decision, or an action only they can perform: finish every unblocked part, then ask one precise question with your recommendation using Ask (it is recorded under the task, and the answer comes back to this session as a message), and end the turn.\n- No longer matches reality: rewrite it or tick it cancelled (\`[-]\`), keeping the original intent, and say why.${note}`;
}

/**
 * The continuation of a run with a pass ceiling or without AskUserQuestion. With `task` null the
 * run has no task of its own and was continued on its turn budget only (an outline subagent,
 * design D27c).
 */
export function getOutlineBoundedContinuationPrompt(input: {
	cause: "spec" | "maxTurns";
	task: (OutlineTaskPromptTask & { status: "doing" | "blocked" }) | null;
	/** Passes used so far, including the one being started. */
	passes: number;
	maxPasses: number | null;
	canAskUserQuestion: boolean;
	locale: Locale;
}): string {
	const { cause, task, passes, maxPasses, canAskUserQuestion, locale } = input;
	const isZh = locale === "zh-CN";
	const remaining = maxPasses === null ? null : Math.max(0, maxPasses - passes);
	const budget =
		remaining === null
			? ""
			: isZh
				? `\n\n剩余自动续跑次数：${remaining}。用完后本次运行会结束，所以不要把总结留到最后一趟。`
				: `\n\nSelf-continuations left: ${remaining}. When they run out this run ends, so do not save your summary for a later pass.`;
	const askAdvice = canAskUserQuestion
		? isZh
			? "需要人介入时，用 AskUserQuestion 提一个精确的问题并附上你的建议，然后结束回合。"
			: "When it needs a person, ask one precise question with your recommendation using AskUserQuestion, and end the turn."
		: isZh
			? "当前能力不允许 AskUserQuestion。需要外部信息、权限或决定时，写清已完成的部分、当前结论和所缺的东西，然后结束本次运行。"
			: "AskUserQuestion is unavailable under the current capability ceiling. If you need external information, permission, or a decision, state what you completed, your findings, and exactly what is missing, then end this run.";

	if (!task) {
		return isZh
			? `自动续跑（系统消息，不是用户发言）。\n\n上一趟用尽了单趟的回合预算，你还没有给出最终回复（这不是对你工作的评判），所以系统又给你一趟。从停下的地方接着做交给你的工作；做完后给出最终回复。\n\n${askAdvice}${budget}`
			: `Auto-continuation (system message — not the user speaking).\n\nThe previous pass spent its per-pass turn budget before you gave your final reply (not a judgement on your work), so the system granted another pass. Carry on with the work you were given from where you stopped; when it is finished, give your final reply.\n\n${askAdvice}${budget}`;
	}

	const label = taskLabel(task, locale);
	const note = task.humanCreated ? pickLocalizedValue(humanCreatedNote, locale) : "";
	const why = isZh
		? cause === "maxTurns"
			? "上一趟用尽了单趟的回合预算（不是你被判定做错了），而本会话在大纲里还有未完成的任务，所以系统又给你一趟。"
			: "本会话在大纲里还有未完成的任务，所以系统又给你一趟。这只说明任务还没勾成完成——不代表系统判断你没做完，任务内容也可能已经过时。"
		: cause === "maxTurns"
			? "The previous pass spent its per-pass turn budget (not a judgement on your work) while this session still had open tasks in the outline, so the system granted another pass."
			: "The system granted another pass because this session still has open tasks in the outline. That only means the task is not ticked done — not that your work was judged unfinished, and the task may be out of date.";

	if (task.status === "blocked") {
		return isZh
			? `大纲任务续跑：所有任务都在等待（系统消息，不是用户发言）。\n\n${why}\n\n等待中的任务（仅这一条，本会话的其他任务仍在大纲里）：${label}\n\n不需要人也能解除等待时，在它下面加一个解阻任务，勾成进行中，立刻动手。${askAdvice}${note}${budget}`
			: `Outline task continuation: every task is waiting (system message — not the user speaking).\n\n${why}\n\nWaiting task (this one only; the session's other tasks are still in the outline): ${label}\n\nWhen the wait can be removed without a person, add a task for that under it, tick it in progress and work on it now. ${askAdvice}${note}${budget}`;
	}
	return isZh
		? `大纲任务续跑（系统消息，不是用户发言）。\n\n${why}\n\n当前任务（仅这一条，本会话的其他任务仍在大纲里）：${label}\n\n请先判断这个任务的真实状态，再按实际情况选择其一：\n- 已经完成：用 OutlineEdit 勾成完成（\`[x]\`），并给出当前结论。不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- ${askAdvice}\n- 已不符合当前实际：在保留原意图的前提下改写它或勾成取消（\`[-]\`），并说明原因。${note}${budget}`
		: `Outline task continuation (system message — not the user speaking).\n\n${why}\n\nCurrent task (this one only; the session's other tasks are still in the outline): ${label}\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: tick it done (\`[x]\`) with OutlineEdit and state your conclusion. Do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- ${askAdvice}\n- No longer matches reality: rewrite it or tick it cancelled (\`[-]\`), keeping the original intent, and say why.${note}${budget}`;
}

function statusWord(status: "doing" | "todo" | "blocked", locale: Locale): string {
	if (locale === "zh-CN")
		return status === "doing" ? "进行中" : status === "todo" ? "待办" : "等待";
	return status === "doing" ? "doing" : status === "todo" ? "todo" : "waiting";
}

function taskLines(
	tasks: ReadonlyArray<OutlineTaskPromptTask & { status: "doing" | "todo" | "blocked" }>,
	locale: Locale,
): string {
	return tasks
		.map((task) => `- [${statusWord(task.status, locale)}] ${taskLabel(task, locale)}`)
		.join("\n");
}

/** The note the interrupt guard leaves after a user interrupt, listing the open tasks given. */
export function getOutlineInterruptNote(
	tasks: ReadonlyArray<OutlineTaskPromptTask & { status: "doing" | "todo" | "blocked" }>,
	locale: Locale,
): string {
	const lines = taskLines(tasks, locale);
	return locale === "zh-CN"
		? `刚才的运行被用户中断，这通常意味着方向有变化。本会话在大纲里仍有以下未完成的任务：\n\n${lines}\n\n这些任务可能已经过期或与用户最新意图不一致。回复用户的下一条消息时，以用户消息为准；如需调整计划，先用 OutlineEdit 改写或取消过期的任务（人建任务先问人），再继续执行。不要无视用户新指令而直接恢复旧任务。`
		: `The run was just interrupted by the user, which usually means the direction changed. This session still has these open tasks in the outline:\n\n${lines}\n\nThey may be stale or no longer match the user's latest intent. When the user's next message arrives, treat it as the source of truth; if the plan changed, rewrite or cancel the outdated tasks with OutlineEdit first (ask before dropping one a person set), then continue. Do not resume an old task over the user's new instruction.`;
}

// ─── Built-in views (outline plan PR 4, design §4.2) ───

/** What a waiting task waits for, as the views name it. */
export interface OutlineTaskWaitText {
	/** The first unfinished prerequisite: its address, and its title when it may be shown. */
	prerequisite: { address: string; title: string | null } | null;
	/** Unfinished prerequisites in all. */
	prerequisites: number;
	/** A question under the task is unanswered. */
	people: boolean;
}

/** One task as a view lists it. */
export interface OutlineViewTask extends OutlineTaskPromptTask {
	/** The task's own checkbox: a waiting task may be either. */
	checkbox: "todo" | "doing";
	wait: OutlineTaskWaitText | null;
}

const tasksViewText = {
	heading: {
		en: "Current tasks of this session in the outline (kept by the system, updated when they change):",
		"zh-CN": "本会话在大纲里的当前任务（由系统维护，有变化时更新）：",
	},
	doing: { en: "In progress:", "zh-CN": "进行中：" },
	delegated: {
		en: "Delegated to subagents (do not work on these yourself; each report comes back to you):",
		"zh-CN": "已交给子代理（不要自己再做；报告会交回给你）：",
	},
	waiting: { en: "Waiting:", "zh-CN": "等待中：" },
	next: { en: "Next:", "zh-CN": "下一个：" },
	assigned: {
		en: "Assigned to you, not started (set one in progress when you take it up):",
		"zh-CN": "指派给你、还没开始（要做时把它设成进行中）：",
	},
} satisfies Record<string, LocalizedValue<string>>;

export type OutlineTasksViewSection = "doing" | "delegated" | "waiting" | "next" | "assigned";

/** The first line of the current-tasks view. */
export function getOutlineTasksViewHeading(locale: Locale): string {
	return pickLocalizedValue(tasksViewText.heading, locale);
}

/** The line that opens a section of the current-tasks view. */
export function getOutlineTasksViewSection(
	section: OutlineTasksViewSection,
	locale: Locale,
): string {
	return pickLocalizedValue(tasksViewText[section], locale);
}

function waitNote(wait: OutlineTaskWaitText, locale: Locale): string {
	const zh = locale === "zh-CN";
	if (wait.prerequisite) {
		const { address, title } = wait.prerequisite;
		const named = title ? `\`${address}\` ${title}` : `\`${address}\``;
		const others = wait.prerequisites - 1;
		const more = others > 0 ? (zh ? ` 等 ${wait.prerequisites} 项` : ` and ${others} more`) : "";
		return zh ? ` ‹等前置：${named}${more}›` : ` ‹waiting on ${named}${more}›`;
	}
	return wait.people ? (zh ? " ‹等人回答›" : " ‹waiting for a person's answer›") : "";
}

/** One task line of a view: `- [/] \`key/sid\` title`, a person's mark, what it waits for. */
export function getOutlineViewTaskLine(task: OutlineViewTask, locale: Locale): string {
	const box = task.checkbox === "doing" ? "[/]" : "[ ]";
	return `- ${box} ${taskLabel(task, locale)}${task.wait ? waitNote(task.wait, locale) : ""}`;
}

/** The subagent a delegated task was handed to (outline P2 PR 9b), as the view names it. */
export interface OutlineViewAgent {
	/** Its narrator id: what Send, Stop and Await take. */
	id: string;
	/** Its title (the Agent call's description), when it has one. */
	title: string | null;
}

/**
 * One line of the view's "delegated" section: the task, then the subagent doing it, running (its
 * lease is live). `- [/] \`key/sid\` title — subagent "X" (\`id\`), running`.
 */
export function getOutlineViewDelegatedLine(
	task: OutlineTaskPromptTask,
	agent: OutlineViewAgent,
	locale: Locale,
): string {
	const zh = locale === "zh-CN";
	const name = agent.title
		? zh
			? `子代理「${agent.title}」（\`${agent.id}\`）`
			: `subagent "${agent.title}" (\`${agent.id}\`)`
		: zh
			? `子代理 \`${agent.id}\``
			: `subagent \`${agent.id}\``;
	return `- [/] ${taskLabel(task, locale)} — ${name}${zh ? "，运行中" : ", running"}`;
}

/** The last line of a current-tasks view that could not list everything. */
export function getOutlineTasksViewMore(count: number | null, locale: Locale): string {
	if (locale === "zh-CN") {
		return count === null
			? "另有更多任务，用 OutlineRead 读 `session/`。"
			: `另有 ${count} 条，用 OutlineRead 读 \`session/\`。`;
	}
	return count === null
		? "There are more tasks; read `session/` with OutlineRead."
		: `${count} more; read \`session/\` with OutlineRead.`;
}

const behaviorViewText = {
	heading: {
		en: "Behavior boundary (standing constraints the user set; always follow them)",
		"zh-CN": "行为边界（用户设定的长期约束，务必遵守）",
	},
	fence: {
		en: "From this session's old behavior fence (not moved to the behavior page yet):",
		"zh-CN": "来自本会话旧的行为护栏（尚未移到行为边界页）：",
	},
	sop: { en: "Plugin SOP:", "zh-CN": "插件 SOP：" },
} satisfies Record<string, LocalizedValue<string>>;

/** The first line of the behavior view. */
export function getOutlineBehaviorViewHeading(locale: Locale): string {
	return pickLocalizedValue(behaviorViewText.heading, locale);
}

/** The line before the behavior page in the behavior view. */
export function getOutlineBehaviorViewPage(address: string, locale: Locale): string {
	return locale === "zh-CN"
		? `来自本会话的行为边界页 \`${address}\`：`
		: `From this session's behavior page \`${address}\`:`;
}

/**
 * The note after a behavior page the view could not show whole: `count` blocks are shown with
 * only their start, or not at all.
 */
export function getOutlineBehaviorViewTruncated(
	address: string,
	count: number,
	locale: Locale,
): string {
	return locale === "zh-CN"
		? `‹没有全部列出：${count} 块只显示了开头或没有列出；完整内容用 OutlineRead 读 \`${address}\`›`
		: `‹not all shown: ${count} ${count === 1 ? "block is" : "blocks are"} shortened or left out; read \`${address}\` with OutlineRead for the whole page›`;
}

/**
 * The note after a behavior page cut to fit the spec fence while the outline is switched off. No
 * outline tool is offered then, so it points at nothing the agent would have to read: the person
 * sees the whole page in the outline.
 */
export function getOutlineBehaviorFenceTruncated(count: number, locale: Locale): string {
	return locale === "zh-CN"
		? `‹这一页有 ${count} 块在这里只显示了开头或没有列出；用户可以在大纲里看到整页›`
		: `‹${count} ${count === 1 ? "block" : "blocks"} of this page ${count === 1 ? "is" : "are"} shortened or left out here; the user can see the whole page in the outline›`;
}

/** The line before old fence text that was not moved to the page (its import did not happen). */
export function getOutlineBehaviorViewFence(locale: Locale): string {
	return pickLocalizedValue(behaviorViewText.fence, locale);
}

/** The line before the plugin's SOP in the behavior view. */
export function getOutlineBehaviorViewSop(locale: Locale): string {
	return pickLocalizedValue(behaviorViewText.sop, locale);
}

/** The first block of a fork's behavior page when the copy was cut at the commit limit. */
export function getOutlineBehaviorForkCutNote(
	copied: number,
	total: number,
	address: string,
	locale: Locale,
): string {
	return locale === "zh-CN"
		? `fork 时只复制了这一页 ${total} 块中的 ${copied} 块；其余的在行为边界页 \`${address}\`。`
		: `Only ${copied} of the ${total} blocks of this page were copied when the session was forked; the rest are on the behavior page \`${address}\`.`;
}

/** The title of a behavior page the system creates (the import of an old fence). */
export function getOutlineBehaviorPageTitle(locale: Locale): string {
	return locale === "zh-CN" ? "行为边界" : "Behavior boundary";
}

// ─── Compact context ───

/** A note the session wrote in the outline since its last compact (its address and first line). */
export interface OutlineCompactNote {
	address: string;
	text: string;
}

const compactText = {
	tasks: {
		en: "Open tasks of this session in the outline (keep each task's address `key/sid` in the summary):",
		"zh-CN": "本会话在大纲里的未完成任务（摘要里保留每个任务的地址 `key/sid`）：",
	},
	noTasks: {
		en: "This session has no open tasks in the outline.",
		"zh-CN": "本会话在大纲里没有未完成的任务。",
	},
	notes: {
		en: "Recorded decisions: notes this session wrote in the outline since the last compact (cite their addresses in the summary instead of restating them):",
		"zh-CN":
			"已记录的决定：本会话自上次压缩以来在大纲里记下的笔记（摘要里引用地址即可，不必复述）：",
	},
	ask: {
		en: 'In the summary, keep the address of every open task above, and add a section "Key decisions" listing only the decisions made in the conversation that are not recorded in the outline yet.',
		"zh-CN":
			"在摘要里：保留上面每个未完成任务的地址；另列一节「关键决定」，只写对话里做出、但还没记进大纲的决定。",
	},
	askNoTasks: {
		en: 'In the summary, add a section "Key decisions" listing only the decisions made in the conversation that are not recorded in the outline yet.',
		"zh-CN": "在摘要里另列一节「关键决定」，只写对话里做出、但还没记进大纲的决定。",
	},
} satisfies Record<string, LocalizedValue<string>>;

/** One task line of the compact context: its state, address, mark and what it waits for. */
export function getOutlineCompactTaskLine(task: OutlineViewTask, locale: Locale): string {
	const status = task.wait ? "blocked" : task.checkbox;
	return `- [${statusWord(status, locale)}] ${taskLabel(task, locale)}${task.wait ? waitNote(task.wait, locale) : ""}`;
}

/**
 * The compact summarizer's context for an outline session (design §4.2, decision 2026-11-02
 * "source C"): the open tasks with their addresses, the decisions already recorded in the outline,
 * and the request to keep the addresses and list the decisions not recorded yet.
 */
export function getOutlineCompactContext(
	input: { taskLines: readonly string[]; noteLines: readonly string[] },
	locale: Locale,
): string {
	const sections: string[] = [];
	sections.push(
		input.taskLines.length > 0
			? `${pickLocalizedValue(compactText.tasks, locale)}\n${input.taskLines.join("\n")}`
			: pickLocalizedValue(compactText.noTasks, locale),
	);
	if (input.noteLines.length > 0) {
		sections.push(
			`${pickLocalizedValue(compactText.notes, locale)}\n${input.noteLines.join("\n")}`,
		);
	}
	sections.push(
		pickLocalizedValue(
			input.taskLines.length > 0 ? compactText.ask : compactText.askNoTasks,
			locale,
		),
	);
	return sections.join("\n\n");
}

/** One note line of the compact context. */
export function getOutlineCompactNoteLine(note: OutlineCompactNote): string {
	return `- \`${note.address}\` ${note.text}`;
}

// ─── Turn end ───

/**
 * The one-line note a long turn leaves when it ends with a task still in progress that it never
 * touched (outline plan PR 4, decision 2026-11-02 Q4): no new turn starts; the model reads it
 * with the next one.
 */
export function getOutlineTurnEndNote(task: OutlineTaskPromptTask, locale: Locale): string {
	const label = taskLabel(task, locale);
	return locale === "zh-CN"
		? `系统备注：${label} 仍是进行中；做完了就用 OutlineEdit 勾成 [x]。`
		: `System note: ${label} is still in progress; when it is done, tick it [x] with OutlineEdit.`;
}

const specUnavailable: LocalizedValue<string> = {
	en: "spec:// is not available in this session: its tasks and notes live in the outline, and its behavior boundary is the behavior page of its session space (alias behavior in session/), which the system keeps in your context. Read with OutlineRead or OutlineSearch and write with OutlineEdit (a task is a checkbox block; your own go in this session's space, session/). Nothing was read or written.",
	"zh-CN":
		"本会话不能使用 spec://：它的任务和笔记都在大纲里，行为边界是会话空间里的行为边界页（session/ 中别名为 behavior 的页），系统会把它放在你的上下文里。请用 OutlineRead 或 OutlineSearch 读、用 OutlineEdit 写（任务是带复选框的块，你自己的任务写在本会话的空间 session/ 里）。本次没有读写任何内容。",
};

/** What a tool call naming a `spec://` path gets in an outline session. */
export function getOutlineSpecUnavailableHint(locale: Locale): string {
	return pickLocalizedValue(specUnavailable, locale);
}

const specMoved: LocalizedValue<string> = {
	en: "spec:// no longer applies in this session: its Dynamic Spec was moved into the outline. Its tasks are on the task page session/tasks, its old spec:// files are outline pages in session/ (titled by their file name), and its behavior boundary is the behavior page session/behavior. Read with OutlineRead or OutlineSearch and write with OutlineEdit. Nothing was read or written.",
	"zh-CN":
		"本会话不再使用 spec://：它的 Dynamic Spec 已搬进大纲。任务在任务页 session/tasks，原来的 spec:// 文件是 session/ 里的大纲页（以文件名为标题），行为边界是行为边界页 session/behavior。请用 OutlineRead 或 OutlineSearch 读、用 OutlineEdit 写。本次没有读写任何内容。",
};

/**
 * What a tool call naming a `spec://` path gets in a session the import moved into the outline
 * (outline P2 PR 12b2): where each kind of its old content is now.
 */
export function getOutlineSpecMovedHint(locale: Locale): string {
	return pickLocalizedValue(specMoved, locale);
}

// ─── The Dynamic Spec import's notice to the model (outline P2 PR 12b2) ───

/** One page an import wrote from a Dynamic Spec file. */
export interface SpecImportNoticePage {
	/** The file it came from (its page title). */
	title: string;
	/** `session/<sid>`. */
	address: string;
}

/**
 * The one history row a session gets after the import moved it into the outline: where its
 * tasks, notes and behavior boundary are now, and that `spec://` no longer applies. At most
 * `pages.length` page lines (the caller bounds them); `morePages` counts the rest.
 */
export function getSpecImportNotice(
	input: { tasks: number; pages: readonly SpecImportNoticePage[]; morePages: number },
	locale: Locale,
): string {
	const zh = locale === "zh-CN";
	const lines = input.pages.map((page) => `- spec://${page.title} → ${page.address}`);
	if (input.morePages > 0)
		lines.push(
			zh
				? `- 另有 ${input.morePages} 页，用 OutlineRead 读 session/ 查看`
				: `- ${input.morePages} more pages; read session/ with OutlineRead`,
		);
	const notes =
		lines.length > 0
			? zh
				? `\n\n原来的 spec:// 文件现在是这些大纲页：\n${lines.join("\n")}`
				: `\n\nThe old spec:// files are now these outline pages:\n${lines.join("\n")}`
			: "";
	return zh
		? `系统通知（不是用户发言）：本会话的 Dynamic Spec 已搬进大纲。任务现在在任务页 session/tasks（导入了 ${input.tasks} 个），行为边界是行为边界页 session/behavior，系统会把当前任务和行为边界放在你的上下文里。${notes}\n\n本会话不再使用 spec://：读用 OutlineRead 或 OutlineSearch，写用 OutlineEdit（任务是带复选框的块）。旧的 Dynamic Spec 文件保留，只读，不再更新。`
		: `System notice (not the user speaking): this session's Dynamic Spec was moved into the outline. Its tasks are now on the task page session/tasks (${input.tasks} imported), and its behavior boundary is the behavior page session/behavior; the system keeps the current tasks and the behavior boundary in your context.${notes}\n\nspec:// no longer applies in this session: read with OutlineRead or OutlineSearch, write with OutlineEdit (a task is a checkbox block). The old Dynamic Spec files are kept read-only and are no longer updated.`;
}

// ─── People's changes to the session's tasks (outline P2 PR 5) ───

/** One change a person made to a task of the session (the board, the outline editor). */
export type OutlineTaskEditChange = OutlineTaskNoticeChange;

export interface OutlineTaskEdit {
	/** `key/sid`. */
	address: string;
	title: string;
	/** Created by a person (`/goal`, the board). */
	humanCreated: boolean;
	locked: boolean;
	changes: OutlineTaskEditChange[];
}

/** The changes one person made, as a note lists them. */
export interface OutlineTaskEditGroup {
	/** The person's name (a username), never their words: the note is the system's. */
	person: string;
	edits: OutlineTaskEdit[];
}

const STATUS_WORDS: Record<string, LocalizedValue<string>> = {
	todo: { en: "to do", "zh-CN": "待办" },
	doing: { en: "in progress", "zh-CN": "进行中" },
	done: { en: "done", "zh-CN": "完成" },
	cancelled: { en: "cancelled", "zh-CN": "取消" },
};

function editStatusWord(status: string, locale: Locale): string {
	return pickLocalizedValue(STATUS_WORDS[status] ?? { en: status, "zh-CN": status }, locale);
}

function changeText(change: OutlineTaskEditChange, locale: Locale): string {
	const zh = locale === "zh-CN";
	switch (change.kind) {
		case "added":
			return zh ? "新加" : "added";
		case "deleted":
			return zh ? "删除" : "deleted";
		case "unchecked":
			return zh ? "去掉了复选框，不再是任务" : "no longer a task (checkbox removed)";
		case "moved":
			return zh ? "移动了位置" : "moved";
		case "locked":
			return zh ? "锁定" : "locked";
		case "unlocked":
			return zh ? "解锁" : "unlocked";
		case "fields":
			return zh ? "改了前置或截止日期" : "prerequisites or due date changed";
		case "assigned":
			return change.to
				? zh
					? `交给 @${change.to}`
					: `handed to @${change.to}`
				: zh
					? "交回本会话（去掉指派）"
					: "handed back to this session (assignee removed)";
		case "status": {
			if (change.to === "todo" && (change.from === "done" || change.from === "cancelled"))
				return zh ? "重开（回到待办）" : "reopened (back to to do)";
			return zh
				? `改成${editStatusWord(change.to, locale)}`
				: `set to ${editStatusWord(change.to, locale)}`;
		}
		case "rejected": {
			const reason = change.reason
				? zh
					? `，理由：${change.reason}`
					: `; reason: ${change.reason}`
				: "";
			return zh
				? `退回了你把它标为${editStatusWord(change.status, locale)}的改动${reason}。它仍未完成，接着做`
				: `rejected your marking it ${editStatusWord(change.status, locale)}${reason}. It is still open; carry on with it`;
		}
		// Team activity's changes (P2 PR 10b): its own text words them (`prompts/outline-team.ts`);
		// people's edits never carry them, so these words are only a fallback.
		case "notes":
			return zh ? `加了 ${change.n} 条笔记` : `${change.n} notes added`;
		case "reports":
			return zh ? `挂回了 ${change.n} 份报告` : `${change.n} reports attached`;
		case "answers":
			return zh ? `回答了 ${change.n} 个提问` : `${change.n} questions answered`;
		case "claimable":
			return zh ? "放进了可领取池" : "put in the claim pool";
		case "overlap":
			return zh ? `也在改 ${change.path}` : `also changing ${change.path}`;
		// Team events' changes (P2 PR 10a): worded by `getOutlineTeamEventsNote`; a fallback too.
		case "assignedHere":
			return zh ? "指派给了本会话" : "assigned to this session";
		case "created":
			return zh ? "本会话建的" : "created by this session";
		case "unblocked":
			return zh
				? change.by === "done"
					? "一个前置已完成"
					: "一个前置被取消了"
				: change.by === "done"
					? "a prerequisite was finished"
					: "a prerequisite was cancelled";
	}
}

/**
 * The notice people's changes to the session's tasks leave for the agent: a system notice (not
 * the user speaking), grouped by who made them, one line per task with its address. Only what the
 * outline holds: names, task titles, the changes. Delivered at the next tool boundary while the
 * agent works, else ahead of its next turn.
 */
export function getOutlineTaskEditNote(
	groups: readonly OutlineTaskEditGroup[],
	more: number,
	locale: Locale,
): string {
	const zh = locale === "zh-CN";
	const blocks = groups.map((group) => {
		const lines = group.edits.map((edit) => {
			const marks = [
				edit.humanCreated ? (zh ? "人建" : "set by a person") : null,
				edit.locked ? (zh ? "已锁定" : "locked") : null,
			].filter(Boolean);
			const tail = marks.length > 0 ? ` (${marks.join(zh ? "，" : ", ")})` : "";
			const what = edit.changes.map((c) => changeText(c, locale)).join(zh ? "；" : "; ");
			return `- \`${edit.address}\` ${edit.title}${tail}${zh ? "：" : ": "}${what}`;
		});
		return `${zh ? `${group.person}：` : `${group.person}:`}\n${lines.join("\n")}`;
	});
	if (more > 0)
		blocks.push(zh ? `还有 ${more} 处改动未列出。` : `${more} more changes not listed.`);
	return zh
		? `系统通知（不是用户发言）：有人在界面上改了本会话的任务。\n\n${blocks.join("\n\n")}\n\n请据此调整你的工作；要确认细节就用 OutlineRead 读这些任务。`
		: `System notice (not the user speaking): people changed tasks of this session in the interface.\n\n${blocks.join("\n\n")}\n\nAdjust your work to these changes; read the tasks with OutlineRead if you need the details.`;
}

// ─── Tasks this session created, finished elsewhere (outline P2 PR 9b) ───

/** One task a session created that someone else finished, as the notice names it. */
export interface OutlineTaskFinishedEntry {
	/** `key/sid`. */
	address: string;
	title: string;
	status: "done" | "cancelled";
	/** Created by a person (`/goal`, the board). */
	humanCreated: boolean;
}

/**
 * The notice a session gets when tasks it created are ticked done or cancelled by another
 * session or a person (design §2.7): a system notice (not the user speaking), one line per task
 * with its address, who finished it, where the result is and that it may be reopened. Only what
 * the outline holds. `by` is the finisher as the caller names it (a session, a person, the
 * system); `more` counts tasks of the same commit not listed.
 */
export function getOutlineTaskFinishedNote(
	input: { by: string; entries: readonly OutlineTaskFinishedEntry[]; more: number },
	locale: Locale,
): string {
	const zh = locale === "zh-CN";
	const lines = input.entries.map((entry) => {
		const mark = entry.humanCreated ? (zh ? "（人建）" : " (set by a person)") : "";
		const what = zh
			? entry.status === "done"
				? `已被${input.by}勾成完成`
				: `已被${input.by}取消`
			: entry.status === "done"
				? `ticked done by ${input.by}`
				: `cancelled by ${input.by}`;
		return `- \`${entry.address}\` ${entry.title}${mark}${zh ? "：" : ": "}${what}`;
	});
	if (input.more > 0)
		lines.push(
			zh
				? `- 同一次改动还结束了你建的 ${input.more} 个任务，未列出。`
				: `- ${input.more} more tasks this session created were finished in the same change (not listed).`,
		);
	return zh
		? `系统通知（不是用户发言）：本会话在大纲里建的任务在别处结束了。\n\n${lines.join("\n")}\n\n结果和报告在各自的任务下面，用 OutlineRead 读；不满意可以重开（设回待办）。`
		: `System notice (not the user speaking): tasks this session created in the outline were finished elsewhere.\n\n${lines.join("\n")}\n\nThe results and any reports are under each task; read them with OutlineRead. If one does not meet what you wanted, reopen it (set it to do).`;
}

// ─── Team events: assigned, a prerequisite ended, created tasks ended (outline P2 PR 10a) ───

/** A task assigned to the session by name, as the team notice names it. */
export interface OutlineTeamAssignedEntry {
	/** `key/sid`. */
	address: string;
	title: string;
	humanCreated: boolean;
}

/** A task of the session whose prerequisite was ended, as the team notice names it. */
export interface OutlineTeamUnblockedEntry {
	address: string;
	title: string;
	prerequisite: { address: string; title: string; status: "done" | "cancelled" };
	/** It still waits for something else (another prerequisite, a person, a confirmation). */
	stillWaiting: boolean;
}

/**
 * The notice a session gets when one commit of someone else concerns it in more than one way
 * (design §D.2 「合并」: one row per commit and session): tasks assigned to it by name, tasks of its
 * own whose prerequisite was ended, tasks it created that were ended. A system notice (not the
 * user speaking), in the past tense: it says what happened in that commit, and the session reads
 * the tasks for what they are now. `by` is who made the commit, as the caller names them; `more`
 * counts what the commit's limit left out.
 */
export function getOutlineTeamEventsNote(
	input: {
		by: string;
		assigned: readonly OutlineTeamAssignedEntry[];
		unblocked: readonly OutlineTeamUnblockedEntry[];
		finished: readonly OutlineTaskFinishedEntry[];
		more: number;
	},
	locale: Locale,
): string {
	const zh = locale === "zh-CN";
	const sep = zh ? "：" : ": ";
	const blocks: string[] = [];
	if (input.assigned.length > 0) {
		const lines = input.assigned.map((entry) => {
			const mark = entry.humanCreated ? (zh ? "（人建）" : " (set by a person)") : "";
			return `- \`${entry.address}\` ${entry.title}${mark}`;
		});
		blocks.push(
			[
				zh
					? `${input.by}把这些任务指派给了本会话（还没开始；要做时把它设成进行中）：`
					: `Assigned to this session by ${input.by} (not started; set one in progress when you take it up):`,
				...lines,
			].join("\n"),
		);
	}
	if (input.unblocked.length > 0) {
		const lines = input.unblocked.map((entry) => {
			const p = entry.prerequisite;
			// Its title only when the session may read it (the caller leaves it empty otherwise).
			const named = p.title ? `\`${p.address}\` ${p.title}` : `\`${p.address}\``;
			const what = zh
				? p.status === "done"
					? `它的前置 ${named} 已完成`
					: `它的前置 ${named} 被取消了，先看看这个任务还要不要做`
				: p.status === "done"
					? `its prerequisite ${named} was ticked done`
					: `its prerequisite ${named} was cancelled; check whether this task is still needed`;
			const rest = entry.stillWaiting
				? zh
					? "；它还在等别的"
					: "; it still waits for something else"
				: zh
					? "；它不再等了"
					: "; it no longer waits";
			return `- \`${entry.address}\` ${entry.title}${sep}${what}${rest}`;
		});
		blocks.push(
			[
				zh
					? `${input.by}结束了本会话任务的前置：`
					: `Prerequisites of this session's tasks were ended by ${input.by}:`,
				...lines,
			].join("\n"),
		);
	}
	if (input.finished.length > 0) {
		const lines = input.finished.map((entry) => {
			const mark = entry.humanCreated ? (zh ? "（人建）" : " (set by a person)") : "";
			const what = zh
				? entry.status === "done"
					? "已勾成完成"
					: "已取消"
				: entry.status === "done"
					? "ticked done"
					: "cancelled";
			return `- \`${entry.address}\` ${entry.title}${mark}${sep}${what}`;
		});
		blocks.push(
			[
				zh
					? `${input.by}结束了本会话建的任务（结果和报告在各自的任务下面；不满意可以重开）：`
					: `Tasks this session created were ended by ${input.by} (the results and any reports are under each task; reopen one that does not meet what you wanted):`,
				...lines,
			].join("\n"),
		);
	}
	if (input.more > 0)
		blocks.push(
			zh
				? `同一次改动里还有 ${input.more} 处与本会话有关，未列出。`
				: `${input.more} more changes of the same commit concern this session (not listed).`,
		);
	return zh
		? `系统通知（不是用户发言）：大纲里与本会话有关的任务有了变化。\n\n${blocks.join("\n\n")}\n\n动手前先用 OutlineRead 读这些任务，以它们现在的样子为准。`
		: `System notice (not the user speaking): tasks in the outline that concern this session changed.\n\n${blocks.join("\n\n")}\n\nRead the tasks with OutlineRead before acting on them: what they are now decides.`;
}
