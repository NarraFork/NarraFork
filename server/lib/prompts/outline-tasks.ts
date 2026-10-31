import { type Locale, type LocalizedValue, pickLocalizedValue } from "@shared/i18n-locales";

// ─── Outline tasks ───
//
// The model-facing text of a session whose tasks live in the outline (task backend `outline`,
// `services/task-source/outline.ts`): the system-prompt section that replaces the Dynamic Spec
// instructions, the continuation prompts, the interrupt note, the compact task list and the
// hint a `spec://` path gets. No `spec://` vocabulary: an outline session cannot reach it.
//
// The system-prompt section is part of the frozen contract of a prefix epoch, so it holds only
// what does not change while a session runs (design §0, the three conventions); live task state
// reaches the model through the injections and tool results.

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
1. Write what will be needed later into the outline: conclusions, decisions, pitfalls, plans. Writing it under the task at hand is enough.
2. When you start a task, tick it in progress; when it is done, tick it done. When a person has to decide something, ask them and give your recommendation.
3. When a tool says a change was handed to someone for confirmation, do the parts it does not affect first.
</system-reminder>`,
	"zh-CN": `<system-reminder>
# 大纲

本会话的笔记和任务都在大纲里：用 OutlineRead、OutlineSearch 读，用 OutlineEdit 写。任务就是带复选框的块：\`[ ]\` 待办、\`[/]\` 进行中、\`[x]\` 完成、\`[-]\` 取消。你给自己定的任务写在本会话的空间里（\`session/\`）。三条约定：
1. 以后还用得到的写进大纲：结论、决定、坑、计划。写在手头的任务下面就行。
2. 开始做一个任务就把它勾成进行中，做完勾成完成；需要人决定的，提问并附上你的建议。
3. 工具说改动「已交给某人确认」时，先做不受影响的部分。
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
			? `大纲任务续跑：所有任务都在等待（系统消息，不是用户发言）。\n\n本会话所有未完成的任务都在等待——等前置任务完成，或等人回答——时，系统自动发出这条消息。\n\n等待中的任务（仅这一条，本会话的其他任务仍在大纲里）：${label}\n\n请按实际情况选择：\n- 不需要人也能解除等待（调查、修复、换一条路）：在它下面加一个解阻任务，勾成进行中（\`[/]\`），立刻动手。\n- 需要人提供信息、权限或决定：先做完不需要人的部分，再用 AskUserQuestion 提一个精确的问题并附上你的建议，然后结束回合。\n- 已不符合当前实际：在保留原意图的前提下改写它或勾成取消（\`[-]\`），并说明原因。\n\n不要在之后的续跑里重复同一段等待说明。${note}`
			: `Outline task continuation: every task is waiting (system message, not the user speaking).\n\nThe system sends this when every open task of this session is waiting — on a prerequisite that is not finished, or on a person's answer.\n\nWaiting task (this one only; the session's other tasks are still in the outline): ${label}\n\nTake the path that fits:\n- The wait can be removed without a person (an investigation, a fix, another approach): add a task for that under it, tick it in progress (\`[/]\`) and work on it now.\n- It needs a person's information, permission or decision: finish every part that does not need them, then ask one precise question with your recommendation using AskUserQuestion, and end the turn.\n- It no longer matches reality: rewrite it or tick it cancelled (\`[-]\`), keeping the original intent, and say why.\n\nDo not repeat an explanation of the same wait on later continuations.${note}`;
	}
	return locale === "zh-CN"
		? `大纲任务续跑（系统消息，不是用户发言）。\n\n本会话在大纲里还有进行中的任务时，系统自动发出这条消息。它只说明该任务还没勾成完成——不代表系统判断你没做完，任务内容也可能已经过时。\n\n当前任务（仅这一条，本会话的其他任务仍在大纲里）：${label}\n\n请先判断这个任务的真实状态，再按实际情况选择其一：\n- 已经完成：用 OutlineEdit 把它勾成完成（\`[x]\`）。这就是本回合的有效结果，不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- 需要人提供信息、权限、决定，或需要人亲自操作：先做完不受阻的部分，再用 AskUserQuestion 提一个精确的问题并附上你的建议，然后结束回合。\n- 已不符合当前实际：在保留原意图的前提下改写它或勾成取消（\`[-]\`），并说明原因。${note}`
		: `Outline task continuation (system message, not the user speaking).\n\nThe system sends this while a task of this session is still in progress in the outline. It only means the task is not ticked done yet — not that the system judged your work unfinished, and the task may be out of date.\n\nCurrent task (this one only; the session's other tasks are still in the outline): ${label}\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: tick it done (\`[x]\`) with OutlineEdit. That is a valid result for this turn; do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- Needs a person's information, permission, decision, or an action only they can perform: finish every unblocked part, then ask one precise question with your recommendation using AskUserQuestion, and end the turn.\n- No longer matches reality: rewrite it or tick it cancelled (\`[-]\`), keeping the original intent, and say why.${note}`;
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

/** The task list handed to the compact summarizer: the session's open tasks. */
export function getOutlineCompactContext(
	tasks: ReadonlyArray<OutlineTaskPromptTask & { status: "doing" | "todo" | "blocked" }>,
	locale: Locale,
): string {
	const lines = taskLines(tasks, locale);
	return locale === "zh-CN"
		? `本会话在大纲里的未完成任务：\n${lines}`
		: `Open tasks of this session in the outline:\n${lines}`;
}

const specUnavailable: LocalizedValue<string> = {
	en: "spec:// is not available in this session: its tasks and notes live in the outline. Read with OutlineRead or OutlineSearch and write with OutlineEdit (a task is a checkbox block; your own go in this session's space, session/). Nothing was read or written.",
	"zh-CN":
		"本会话不能使用 spec://：它的任务和笔记都在大纲里。请用 OutlineRead 或 OutlineSearch 读、用 OutlineEdit 写（任务是带复选框的块，你自己的任务写在本会话的空间 session/ 里）。本次没有读写任何内容。",
};

/** What a tool call naming a `spec://` path gets in an outline session. */
export function getOutlineSpecUnavailableHint(locale: Locale): string {
	return pickLocalizedValue(specUnavailable, locale);
}
