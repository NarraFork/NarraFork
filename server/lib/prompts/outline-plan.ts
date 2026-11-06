import type { Locale } from "@shared/i18n-locales";

// ─── Outline plans (outline P2 PR 8, D48) ───
//
// The model-facing text of plan mode in an outline session: the plan is a task tree in the
// outline (its root written by `EnterPlanMode`), `ExitPlanMode` submits the root, and the person
// returns it, executes it as a draft, or locks it and executes it. No plan files.

/** A plan root as the prompts name it. */
export interface OutlinePlanPromptRoot {
	/** `key/sid`. */
	address: string;
	title: string;
	/** The version the next submission will be (1 for the first). */
	version: number;
}

/**
 * A plan root as the plan-mode system prompt names it: its address only, which stays the same
 * while it is planned (review round 1 S4: the prompt is the front of the request prefix, and the
 * root's text is the agent's to rewrite).
 */
export interface OutlinePlanPromptAddress {
	address: string;
}

const zh = (locale: Locale) => locale === "zh-CN";

/** The plan-mode section of an outline session's system prompt (replaces the plan-file one). */
export function getOutlinePlanModeSystemReminder(
	locale: Locale,
	root: OutlinePlanPromptAddress | null,
	relaxed: boolean,
): string {
	const where = root
		? zh(locale)
			? `你的计划根是 \`${root.address}\`。`
			: `Your plan root is \`${root.address}\`.`
		: zh(locale)
			? "还没有计划根：先调用 EnterPlanMode。"
			: "There is no plan root yet: call EnterPlanMode first.";
	const limits = relaxed
		? zh(locale)
			? "宽松规划：工具照常可用，但要先把计划写进大纲、提交并获批，再动手实施。"
			: "Relaxed planning: tools stay available, but write the plan into the outline, submit it and get it approved before implementing."
		: zh(locale)
			? "规划阶段项目文件只读：不要用 Write、Edit 或修改文件的命令；大纲只能写本会话的空间。"
			: "Project files are read-only while planning: no Write, Edit or commands that modify files; in the outline you may write only this session's space.";
	return zh(locale)
		? `<system-reminder>
# 计划模式（大纲）

计划模式已激活。本会话的计划是大纲里的一棵任务树，不使用计划文件。${where}

${limits}

## 怎么写计划
1. 用 OutlineRead 读计划根，用 OutlineEdit 写在它下面。
2. 计划根的正文写目标和验收；步骤写成它下面的复选框任务（\`[ ]\`），可以分层（里程碑 → 步骤 → 子步骤），前置用 \`depends::\`。
3. 调研结论、决定、开放问题写成挂在计划下的普通块；需要人决定的用 Ask 提问并附建议。
4. 计划下出现的「退回意见」「审查意见」块是给你的意见，修改计划时要处理。

## 提交
写完后调用 ExitPlanMode（\`mode: "outline"\`，可选 \`summary\` 说明这一版改了什么）。人会看到这一版和上一版的对比，然后选择退回、按草稿执行或锁定后执行。批准后系统直接从第一个能开始的步骤续跑，不要把步骤再抄一遍。

不要对用户的意图做大的假设，需要时先提问。你的回合只应以提问或调用 ExitPlanMode 结束。
</system-reminder>`
		: `<system-reminder>
# Plan Mode (outline)

Plan mode is ACTIVE. This session's plan is a task tree in the outline; there is no plan file. ${where}

${limits}

## Writing the plan
1. Read the plan root with OutlineRead and write under it with OutlineEdit.
2. Write the goal and the acceptance in the root's text; write the steps as checkbox tasks (\`[ ]\`) under it, in levels if useful (milestones → steps → sub-steps), with \`depends::\` for prerequisites.
3. Findings, decisions and open questions go under the plan as plain blocks; ask a person with Ask (with your recommendation) when they must decide.
4. "Returned" and "Review" blocks under the plan are comments for you: address them when you revise it.

## Submitting
When the plan is ready, call ExitPlanMode (\`mode: "outline"\`, with an optional \`summary\` of what changed in this version). The person sees this version against the previous one and returns it, executes it as a draft, or locks it and executes it. Once approved, the system continues straight from the first step that can start: do not copy the steps anywhere.

Do not make large assumptions about the user's intent; ask when needed. Your turn should only end with a question or with ExitPlanMode.
</system-reminder>`;
}

/** What `EnterPlanMode` returns in an outline session. */
export function getOutlinePlanEnterOutput(
	locale: Locale,
	root: OutlinePlanPromptRoot,
	how: "created" | "resumed" | "replanning",
): string {
	if (zh(locale)) {
		const lead =
			how === "created"
				? "已进入计划模式，计划根已建好"
				: how === "resumed"
					? "已进入计划模式，接着改本会话还没批准的计划"
					: "已进入计划模式，重新规划这棵任务树";
		return `${lead}：\`${root.address}\`（「${root.title}」）。用 OutlineEdit 在它下面写目标、验收和步骤（复选框任务），写完调用 ExitPlanMode，\`mode: "outline"\`。`;
	}
	const lead =
		how === "created"
			? "Entered plan mode; the plan root was created"
			: how === "resumed"
				? "Entered plan mode; continuing this session's plan that is not approved yet"
				: "Entered plan mode; re-planning this task tree";
	return `${lead}: \`${root.address}\` ("${root.title}"). Write the goal, the acceptance and the steps (checkbox tasks) under it with OutlineEdit, then call ExitPlanMode with \`mode: "outline"\`.`;
}

/** The reminder a tool call in relaxed planning gets: where the plan goes. */
export function getOutlinePlanRelaxedReminder(locale: Locale, address: string | null): string {
	const where = address ? `\`${address}\`` : zh(locale) ? "计划根" : "the plan root";
	return zh(locale)
		? `提醒：你仍在计划模式。计划写在大纲里 ${where} 下面，写完调用 ExitPlanMode（mode: "outline"）获批后再实施。`
		: `Reminder: you are still in plan mode. The plan goes in the outline under ${where}; call ExitPlanMode (mode: "outline") and get it approved before implementing.`;
}

/** Why an outline plan could not be submitted (ExitPlanMode refused; still in plan mode). */
export type OutlinePlanSubmitProblem =
	| { kind: "noRoot" }
	| { kind: "notPlanning"; address: string }
	| { kind: "notFound"; address: string }
	| { kind: "tooLarge"; address: string; blocks: number }
	| { kind: "wrongMode"; address: string };

export function getOutlinePlanSubmitProblem(
	locale: Locale,
	problem: OutlinePlanSubmitProblem,
): string {
	const z = zh(locale);
	switch (problem.kind) {
		case "noRoot":
			return z
				? "本会话没有正在规划的计划根。先调用 EnterPlanMode 建计划根，把计划写在它下面，再调用 ExitPlanMode。"
				: "This session has no plan being planned. Call EnterPlanMode to create the plan root, write the plan under it, then call ExitPlanMode.";
		case "notPlanning":
			return z
				? `\`${problem.address}\` 不是本会话正在规划的计划根（可能已批准、被勾掉或不是任务）。调用 EnterPlanMode 重新开始规划。`
				: `\`${problem.address}\` is not a plan this session is planning (it may be approved, ticked off, or not a task). Call EnterPlanMode to start planning again.`;
		case "notFound":
			return z
				? `找不到 \`${problem.address}\`（可能被删除了）。调用 EnterPlanMode 重新开始规划。`
				: `\`${problem.address}\` was not found (it may have been deleted). Call EnterPlanMode to start planning again.`;
		case "tooLarge":
			return z
				? `计划 \`${problem.address}\` 超过 ${problem.blocks} 块，一次提交放不下。把它拆成里程碑，先提交第一个。`
				: `The plan \`${problem.address}\` has more than ${problem.blocks} blocks, more than one submission holds. Split it into milestones and submit the first one.`;
		case "wrongMode":
			return z
				? `本会话的计划在大纲里（\`${problem.address}\`），不用内联正文或计划文件。调用 ExitPlanMode 时传 \`mode: "outline"\`。`
				: `This session's plan is in the outline (\`${problem.address}\`), not inline text or a plan file. Call ExitPlanMode with \`mode: "outline"\`.`;
	}
}

/** The block a returned plan's feedback is written as, under the plan root. */
export function getOutlinePlanReturnedNote(
	locale: Locale,
	version: number,
	feedback: string,
): string {
	return zh(locale)
		? `退回意见（第 ${version} 版）：${feedback}`
		: `Returned (version ${version}): ${feedback}`;
}

/** The tool result of a returned plan in an outline session. */
export function getOutlinePlanReturnedMessage(
	locale: Locale,
	input: {
		feedback: string | null;
		noteAddress: string | null;
		rootAddress: string;
		/** What the person changed in the plan while deciding, as diff lines; empty: nothing. */
		edits?: string;
		/** The plan's root was gone when it was returned (deleted, unticked, moved off). */
		gone?: boolean;
	},
): string {
	const z = zh(locale);
	const note = input.noteAddress
		? z
			? `意见已记在计划下：\`${input.noteAddress}\`。`
			: `It is recorded under the plan: \`${input.noteAddress}\`.`
		: "";
	const feedback = input.feedback
		? z
			? `\n\n用户的意见：${input.feedback}${note ? `\n\n${note}` : ""}`
			: `\n\nThe user's feedback: ${input.feedback}${note ? `\n\n${note}` : ""}`
		: "";
	const edits = input.edits
		? z
			? `\n\n用户在审批时改了计划：\n\n${input.edits}`
			: `\n\nThe user changed the plan while deciding:\n\n${input.edits}`
		: "";
	const next = input.gone
		? z
			? `计划 \`${input.rootAddress}\` 已经不在了（被删除、取消勾选或移走）。调用 EnterPlanMode 重新开始规划，然后再次调用 ExitPlanMode（mode: "outline"）。`
			: `The plan \`${input.rootAddress}\` is gone (deleted, its checkbox taken away, or moved off). Call EnterPlanMode to start planning again, then call ExitPlanMode again (mode: "outline").`
		: z
			? `按意见修改 \`${input.rootAddress}\` 下的计划，然后再次调用 ExitPlanMode（mode: "outline"）。`
			: `Revise the plan under \`${input.rootAddress}\` accordingly, then call ExitPlanMode again (mode: "outline").`;
	return z
		? `[计划模式] 用户退回了你的计划。你仍处于计划模式。${feedback}${edits}\n\n${next}不要写代码或做任何修改——必须先退出计划模式。`
		: `[PLAN MODE] The user returned your plan. You are STILL in plan mode.${feedback}${edits}\n\n${next} Do NOT write code or make changes — you must exit plan mode first.`;
}

/** The message that starts executing an approved outline plan. */
export function getOutlinePlanApprovedPrompt(input: {
	locale: Locale;
	/** How it was approved; `null` delegate: nobody confirms step changes for the locker. */
	approval: { kind: "draft" } | { kind: "locked"; delegate: string | null };
	root: { address: string; title: string };
	/** The task started for the session (the first that can start), or null. */
	task: { address: string | null; title: string; status: "doing" | "blocked" } | null;
	/** What the person changed in the plan while deciding, as diff lines; empty: nothing. */
	edits: string;
	/** The context was reset onto the plan before this message. */
	compact: boolean;
}): string {
	const z = zh(input.locale);
	const how =
		input.approval.kind === "draft"
			? z
				? "按草稿批准：步骤可以随实际情况调整，每处改动都留在时间轴上"
				: "approved as a draft: adjust the steps as the work requires; every change stays on the timeline"
			: z
				? `已锁定后批准：改步骤（增删、改写、调整顺序、取消步骤、整个计划完成）会转成待确认，交给锁定人${
						input.approval.delegate ? `或代确认的会话「${input.approval.delegate}」` : ""
					}；进展、发现和把叶子步骤拆成子步骤照常直写`
				: `locked and approved: changing the steps (adding, removing, rewriting, reordering, cancelling a step, the whole plan done) waits for the locker's confirmation${
						input.approval.delegate ? ` or that of the session "${input.approval.delegate}"` : ""
					}; progress, findings and splitting a leaf step into sub-steps are written directly`;
	const lead = z
		? `计划 \`${input.root.address}\`（「${input.root.title}」）已${how}。`
		: `The plan \`${input.root.address}\` ("${input.root.title}") is ${how}.`;
	const context = input.compact
		? z
			? "上下文已重置，计划在系统提示的 Conversation Context 里，也可以用 OutlineRead 读。"
			: "The context was reset; the plan is in the system prompt under Conversation Context, and OutlineRead reads it."
		: "";
	const edits = input.edits
		? z
			? `用户在审批时改了计划：\n\n${input.edits}\n\n按改后的计划执行。`
			: `The user changed the plan while deciding:\n\n${input.edits}\n\nExecute the plan as changed.`
		: "";
	const task = input.task
		? input.task.status === "doing"
			? z
				? `从这一步开始（已为你领取，勾成了进行中）：${input.task.address ? `\`${input.task.address}\` ` : ""}${input.task.title}。做完勾成完成，系统会接着点名下一个能开始的步骤。`
				: `Start with this step (started for you, ticked in progress): ${input.task.address ? `\`${input.task.address}\` ` : ""}${input.task.title}. Tick it done when it is done; the system then names the next step that can start.`
			: z
				? `计划里的步骤都在等待（等前置或等人回答）。第一个在等的是：${input.task.address ? `\`${input.task.address}\` ` : ""}${input.task.title}。能自己解除就在它下面加一个解阻任务并开始；需要人决定就用 Ask 提问。`
				: `Every step of the plan is waiting (on a prerequisite or a person's answer). The first waiting one is ${input.task.address ? `\`${input.task.address}\` ` : ""}${input.task.title}. If you can remove the wait yourself, add an unblocking task under it and start it; if a person must decide, ask with Ask.`
		: z
			? "计划里没有能开始的步骤：读一下计划，按实际情况继续。"
			: "No step of the plan can be started: read the plan and continue as the situation requires.";
	return [lead, context, edits, task].filter(Boolean).join("\n\n");
}
