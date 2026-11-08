import type { Locale } from "@shared/i18n-locales";
import {
	NOTABLE_POINTS_TITLE,
	OUTLINE_PLAN_STRUCTURE,
	type PlanBackgroundProblem,
	type PlanBlockRole,
} from "@shared/outline-plan-structure";

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

/**
 * The plan's format (plan readability; the owner's template): a one-line title, the background
 * paragraph as the root's first block, big points with small points with their implementation
 * details, and the notable points last. An approver tracks many plans and knows each project
 * only roughly, so the background has to carry them into the plan; the details stay folded
 * behind one line. ExitPlanMode refuses a plan that breaks the format
 * (`@shared/outline-plan-structure`, the same numbers). Constant text (the prompt is cached).
 */
function structureRules(locale: Locale): string {
	const { rootChars, backgroundChars, pointChars, detailChars, maxChildren } =
		OUTLINE_PLAN_STRUCTURE;
	return zh(locale)
		? `计划按固定格式写。审批人同时跟着很多任务，对这个项目只是大概了解：列表里只看到标题，打开后先读背景，再顺着大点往下看；实施细节默认只显示一行，要看才展开。
   - 计划根：一行短标题（不超过 ${rootChars} 字），说清是哪件事。
   - 根下第一块：背景。一段话（不超过 ${backgroundChars} 字），不是任务，下面不挂子块（根下已有块时，用 OutlineEdit add 的 before 插到最前面）。让审批人想起这是在做什么、为什么做、做到哪一步，并能顺着它读懂后面的计划；简明精准，不写实施细节。
   - 接着是大点（阶段或工作方向），每个大点下面是小点（具体任务），都写成复选框任务（\`[ ]\`），前置用 \`depends::\`。大点、小点各只写一个要点（不超过 ${pointChars} 字）。验收可以作为一个大点，也可以写进背景。
   - 小点下面是实施细节：改哪里、怎么改、怎么验证，每条一个子块（不超过 ${detailChars} 字），更细的挂在它下面。
   - 根下最后一块：「${NOTABLE_POINTS_TITLE["zh-CN"]}」，下面每条一个子块：风险、不可逆的操作、需要审批人特别看一眼的地方。确实没有才省略这一块。
   - 一层不超过 ${maxChildren} 块，多了就分组。
   例如：
   \`\`\`
   - [ ] 历史读取超过 10 秒改为告警
     - 模型历史、工具结果回放和会话恢复读历史超过 10 秒就直接拒绝，慢磁盘上的会话会莫名失败。这次把固定时间拒绝改成告警：读取照常完成，慢的时候在日志和界面上说明原因。
     - [ ] 阶段 1：去掉固定时间拒绝
       - [ ] 清除模型历史链路的固定时间拒绝
         - history-build.ts：删除 deadline 传播和超时 reject，读完后比较耗时
         - loop.ts：删掉 HISTORY_READ_TIMEOUT 分支
     - [ ] 阶段 2：验收
       - [ ] 注入 15 秒延迟的读取照常返回，日志里有告警
     - ${NOTABLE_POINTS_TITLE["zh-CN"]}
       - HISTORY_READ_TIMEOUT 错误码保留一个版本，旧日志解析不报错
   \`\`\`
   不符合格式的计划，ExitPlanMode 会拒收并指出要改的块。`
		: `Write the plan in a fixed format. The approver tracks many tasks at once and knows this project only roughly: a list shows them the title, the plan opens on the background, and they follow the big points down from there; implementation details show one line until opened.
   - The plan root: a short one-line title (at most ${rootChars} characters) naming the work.
   - The root's first block: the background. One paragraph (at most ${backgroundChars} characters), not a task, with nothing under it (when the root has blocks already, OutlineEdit add with before puts it first). It brings back what this work is, why, and where it stands, so the approver can follow it into the plan; concise and precise, no implementation details.
   - Then the big points (phases or workstreams), each with its small points (concrete tasks) under it, as checkbox tasks (\`[ ]\`) with \`depends::\` for prerequisites. A big or small point is one idea (at most ${pointChars} characters). The acceptance can be a big point of its own or part of the background.
   - Under a small point, its implementation details: where, how, how it is checked, one child block each (at most ${detailChars} characters), finer ones under them.
   - The root's last block: "${NOTABLE_POINTS_TITLE.en}", one child block per item: risks, irreversible steps, what the approver should look at. Leave it out only when there is truly nothing.
   - At most ${maxChildren} blocks on one level; group them when there are more.
   For example:
   \`\`\`
   - [ ] Warn instead of failing on history reads over 10 seconds
     - Reading history for the model, tool-result replay and session restore fails outright after 10 seconds, so sessions on slow disks break for no visible reason. This turns the fixed-time refusal into a warning: reads complete, and a slow one is explained in the log and the UI.
     - [ ] Phase 1: remove the fixed-time refusal
       - [ ] Remove the fixed-time refusal from the model history path
         - history-build.ts: drop the deadline and the timeout reject; compare the elapsed time after the read
         - loop.ts: delete the HISTORY_READ_TIMEOUT branch
     - [ ] Phase 2: acceptance
       - [ ] A read delayed 15 seconds still answers, and the log has the warning
     - ${NOTABLE_POINTS_TITLE.en}
       - Keep the HISTORY_READ_TIMEOUT code for one release so old log parsers do not fail
   \`\`\`
   ExitPlanMode refuses a plan that breaks the format and names the blocks to fix.`;
}

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
2. ${structureRules(locale)}
3. 调研结论和已做的决定写进背景或它们所属的大点、小点；需要人决定的问题用 Ask 提问并附建议。
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
2. ${structureRules(locale)}
3. Findings and decisions go into the background or the points they belong to; ask a person with Ask (with your recommendation) when they must decide.
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
		return `${lead}：\`${root.address}\`（「${root.title}」）。根只写一行标题；用 OutlineEdit 在它下面按计划格式写：第一块是背景（一段话；根下已有块时用 add 的 before 插到最前面），然后是大点、小点（复选框任务）和小点下的实施细节，最后一块是「${NOTABLE_POINTS_TITLE["zh-CN"]}」。写完调用 ExitPlanMode，\`mode: "outline"\`。`;
	}
	const lead =
		how === "created"
			? "Entered plan mode; the plan root was created"
			: how === "resumed"
				? "Entered plan mode; continuing this session's plan that is not approved yet"
				: "Entered plan mode; re-planning this task tree";
	return `${lead}: \`${root.address}\` ("${root.title}"). Keep the root a one-line title; under it, write the plan in its format with OutlineEdit: the background paragraph first (add with before when the root has blocks already), then the big and small points (checkbox tasks) with the implementation details under the small points, and "${NOTABLE_POINTS_TITLE.en}" last. Then call ExitPlanMode with \`mode: "outline"\`.`;
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
	/** More than `blocks` blocks or `kib` KiB of text (review round 1 N2: either can be what). */
	| { kind: "tooLarge"; address: string; blocks: number; kib?: number }
	| { kind: "wrongMode"; address: string }
	/**
	 * Not in the plan format (plan readability; `@shared/outline-plan-structure`): the first
	 * problems, each naming its block (`key/sid`), and how many there are in all.
	 */
	| { kind: "structure"; address: string; issues: OutlinePlanStructureProblem[]; total: number };

/** One way a plan breaks the format, about the block `address` (`key/sid`). */
export type OutlinePlanStructureProblem =
	| { kind: "root"; address: string; chars: number; lines: number }
	| { kind: "background"; address: string; problem: PlanBackgroundProblem }
	| { kind: "long"; address: string; chars: number; role: PlanBlockRole }
	| { kind: "flat"; address: string; children: number }
	| { kind: "notable"; address: string }
	| { kind: "notableEmpty"; address: string }
	| { kind: "noPoints"; address: string };

function structureProblemLine(locale: Locale, problem: OutlinePlanStructureProblem): string {
	const { rootChars, backgroundChars, pointChars, detailChars, maxChildren } =
		OUTLINE_PLAN_STRUCTURE;
	const at = `\`${problem.address}\``;
	if (zh(locale)) {
		switch (problem.kind) {
			case "root":
				return `- ${at}（计划根）有 ${problem.chars} 字${problem.lines > 1 ? `、${problem.lines} 行` : ""}：根只写一行短标题（不超过 ${rootChars} 字）；背景写成根下第一块的一段话，其余写成根下的大点。`;
			case "background":
				switch (problem.problem) {
					case "none":
						return `- ${at}（计划根）下面还没有背景：用 OutlineEdit 在根下加一块（add 指向计划根），用一段话（不超过 ${backgroundChars} 字）交代背景。`;
					case "task":
						return `- ${at} 是根下第一块，但它是任务：根下第一块必须是背景——一段不带复选框的话（不超过 ${backgroundChars} 字）。在它前面插入背景：OutlineEdit 的 add 指向计划根，带 before: "${problem.address}"。`;
					case "heading":
						return `- ${at} 是根下第一块，但它是标题：背景直接写成一段话（不超过 ${backgroundChars} 字），不用标题。`;
					case "notProse":
						return `- ${at} 是根下第一块，但它是代码块、表格或嵌入：背景要写成一段话（不超过 ${backgroundChars} 字）。在它前面插入背景：OutlineEdit 的 add 指向计划根，带 before: "${problem.address}"。`;
					case "empty":
						return `- ${at} 是根下第一块，但它是空的：在里面用一段话（不超过 ${backgroundChars} 字）写背景。`;
					case "children":
						return `- ${at} 是根下第一块，但它下面挂着子块：背景只是一段话，不挂子块。在它前面插入背景（OutlineEdit 的 add 指向计划根，带 before: "${problem.address}"），或把它的子块移到后面的大点里。`;
				}
				break;
			case "long":
				switch (problem.role) {
					case "background":
						return `- ${at}（背景）有 ${problem.chars} 字：背景只写一段简明的话（不超过 ${backgroundChars} 字），细节放进后面的大点、小点。`;
					case "point":
						return `- ${at} 有 ${problem.chars} 字：大点、小点各只写一个要点（不超过 ${pointChars} 字），说明写成它下面的实施细节。`;
					case "detail":
						return `- ${at} 有 ${problem.chars} 字：一条实施细节不超过 ${detailChars} 字，拆成几条，或把更细的挂在它下面。`;
				}
				break;
			case "flat":
				return `- ${at} 下面直接有 ${problem.children} 块：按阶段或主题分组，一层不超过 ${maxChildren} 块。`;
			case "notable":
				return `- ${at}（「${NOTABLE_POINTS_TITLE["zh-CN"]}」）不是根下最后一块：用 OutlineEdit 把它 move 到计划根（不带 after、before 就放在最后），只留一块，值得注意的点都写在它下面。`;
			case "notableEmpty":
				return `- ${at}（「${NOTABLE_POINTS_TITLE["zh-CN"]}」）下面还没有条目：每一点写成它下面的一个子块；确实没有就删掉这一块。`;
			case "noPoints":
				return `- ${at}（计划根）下面除了背景还没有大点：把计划写成根下的大点（阶段或工作方向），小点和实施细节写在它们下面。`;
		}
	}
	switch (problem.kind) {
		case "root":
			return `- ${at} (the plan root) has ${problem.chars} characters${problem.lines > 1 ? ` on ${problem.lines} lines` : ""}: make the root a short one-line title (at most ${rootChars} characters); write the background as one paragraph in the root's first block, and the rest as big points under the root.`;
		case "background":
			switch (problem.problem) {
				case "none":
					return `- ${at} (the plan root) has no background under it: add a block under the root with OutlineEdit (add: the plan root) holding one paragraph of background (at most ${backgroundChars} characters).`;
				case "task":
					return `- ${at} is the root's first block but a task: the first block must be the background, one paragraph without a checkbox (at most ${backgroundChars} characters). Insert it before this block: OutlineEdit add under the plan root with before: "${problem.address}".`;
				case "heading":
					return `- ${at} is the root's first block but a heading: write the background itself as one paragraph (at most ${backgroundChars} characters), not a heading.`;
				case "notProse":
					return `- ${at} is the root's first block but a code block, a table or an embed: the background is one paragraph (at most ${backgroundChars} characters). Insert it before this block: OutlineEdit add under the plan root with before: "${problem.address}".`;
				case "empty":
					return `- ${at} is the root's first block but empty: write the background in it as one paragraph (at most ${backgroundChars} characters).`;
				case "children":
					return `- ${at} is the root's first block but has blocks under it: the background is one paragraph with nothing under it. Insert it before this block (OutlineEdit add under the plan root with before: "${problem.address}"), or move its children into the big points.`;
			}
			break;
		case "long":
			switch (problem.role) {
				case "background":
					return `- ${at} (the background) has ${problem.chars} characters: keep it one concise paragraph (at most ${backgroundChars} characters) and move the details into the points.`;
				case "point":
					return `- ${at} has ${problem.chars} characters: a big or small point is one idea (at most ${pointChars} characters); write the explanation as implementation details under it.`;
				case "detail":
					return `- ${at} has ${problem.chars} characters: an implementation detail is at most ${detailChars} characters; split it, or put the finer parts under it.`;
			}
			break;
		case "flat":
			return `- ${at} has ${problem.children} blocks directly under it: group them by phase or topic, at most ${maxChildren} on one level.`;
		case "notable":
			return `- ${at} ("${NOTABLE_POINTS_TITLE.en}") is not the root's last block: OutlineEdit move it to the plan root with no after or before (that puts it last); keep one such block, with every notable point under it.`;
		case "notableEmpty":
			return `- ${at} ("${NOTABLE_POINTS_TITLE.en}") has nothing under it: write each point as a child block under it, or delete it when there is truly nothing.`;
		case "noPoints":
			return `- ${at} (the plan root) has no big point besides the background: write the plan as big points under the root (phases or workstreams), with the small points and details under them.`;
	}
	return `- ${at}`;
}

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
				? `计划 \`${problem.address}\` 太大，一次提交放不下（最多 ${problem.blocks} 块${problem.kib ? `、${problem.kib} KiB 文字` : ""}）。把它拆成里程碑，先提交第一个。`
				: `The plan \`${problem.address}\` is larger than one submission holds (at most ${problem.blocks} blocks${problem.kib ? ` and ${problem.kib} KiB of text` : ""}). Split it into milestones and submit the first one.`;
		case "wrongMode":
			return z
				? `本会话的计划在大纲里（\`${problem.address}\`），不用内联正文或计划文件。调用 ExitPlanMode 时传 \`mode: "outline"\`。`
				: `This session's plan is in the outline (\`${problem.address}\`), not inline text or a plan file. Call ExitPlanMode with \`mode: "outline"\`.`;
		case "structure": {
			const lines = problem.issues.map((issue) => structureProblemLine(locale, issue)).join("\n");
			const more = problem.total - problem.issues.length;
			return z
				? `计划 \`${problem.address}\` 还不符合计划格式，这次没有提交给用户：\n${lines}${more > 0 ? `\n- 另外还有 ${more} 处。` : ""}\n\n计划格式：根是一行标题；根下第一块是背景（一段话）；然后是大点（阶段或方向），大点下是小点，小点下是实施细节；最后一块是「${NOTABLE_POINTS_TITLE["zh-CN"]}」。用 OutlineEdit 改好后再调用 ExitPlanMode（mode: "outline"）。`
				: `The plan \`${problem.address}\` does not follow the plan format yet; nothing was submitted to the user:\n${lines}${more > 0 ? `\n- ${more} more like these.` : ""}\n\nThe format: the root is a one-line title; its first block is the background (one paragraph); then the big points (phases or workstreams), small points under them, implementation details under the small points; the last block is "${NOTABLE_POINTS_TITLE.en}". Fix the tree with OutlineEdit, then call ExitPlanMode again (mode: "outline").`;
		}
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
		/** The plan review's comments on the version returned (PR 8b), if it left any. */
		review?: OutlinePlanPromptReview | null;
	},
): string {
	const z = zh(locale);
	const review = input.review
		? z
			? `\n\n计划审查${input.feedback ? "也" : ""}留了 ${input.review.count} 条意见，记在 \`${input.review.address}\`：下一版${input.feedback ? "和用户的意见一并" : "里"}处理。`
			: `\n\nThe plan review ${input.feedback ? "also " : ""}left ${input.review.count} comment(s), under \`${input.review.address}\`: address them in the next version${input.feedback ? " along with the user's feedback" : ""}.`
		: "";
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
		? `[计划模式] 用户退回了你的计划。你仍处于计划模式。${feedback}${review}${edits}\n\n${next}不要写代码或做任何修改——必须先退出计划模式。`
		: `[PLAN MODE] The user returned your plan. You are STILL in plan mode.${feedback}${review}${edits}\n\n${next} Do NOT write code or make changes — you must exit plan mode first.`;
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
	/** The plan review's comments on the version approved (PR 8b), if it left any. */
	review?: OutlinePlanPromptReview | null;
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
	const review = input.review
		? z
			? `计划审查留了 ${input.review.count} 条意见，记在 \`${input.review.address}\`，用户看过后批准了计划。执行时逐条考虑：采纳的照着做，不采纳的在那条意见下写一句理由。`
			: `The plan review left ${input.review.count} comment(s), under \`${input.review.address}\`; the user saw them and approved the plan. Take each into account as you execute: follow the ones you adopt, and under any you do not, write one line saying why.`
		: "";
	return [lead, context, edits, review, task].filter(Boolean).join("\n\n");
}

// ─── Plan review (outline P2 PR 8b, D48 Q1) ───
//
// The plan review (计划反思) of an outline plan leaves comments under the plan instead of sending
// it back: no concerns, and the plan is executed as a draft on the person's behalf (never
// locked); concerns, and they are written as one block under the root, and the person decides
// with them in view.

/** A plan review as the agent's prompts name it: how many comments, and where. */
export interface OutlinePlanPromptReview {
	count: number;
	/** The review's block (`key/sid`). */
	address: string;
}

/** The block a plan review's comments are written under (a child of the plan root). */
export function getOutlinePlanReviewTitle(locale: Locale, version: number): string {
	return zh(locale) ? `审查意见（第 ${version} 版）` : `Review (version ${version})`;
}

/** The prompt of a plan review: the plan as submitted, each block with its short id. */
export function getOutlinePlanReviewPrompt(
	locale: Locale,
	input: {
		requestId: string;
		/** The plan root (`key/sid`). */
		address: string;
		version: number;
		/** What the agent said changed in this version. */
		summary: string | null;
		/** The plan as an outline, each block labelled with `[sid]`. */
		plan: string;
		limits: { comments: number; chars: number };
	},
): string {
	const summary = input.summary
		? zh(locale)
			? `规划者说这一版改了：${input.summary}\n`
			: `What the planner says changed in this version: ${input.summary}\n`
		: "";
	return zh(locale)
		? `计划审查：大纲里的一份计划即将交给用户审批。你来审查它；批准或退回由用户决定，不由你决定。

待审查 ID：${input.requestId}
计划根：\`${input.address}\`（第 ${input.version} 版）
${summary}
提交的计划（每块前面是它的短 id）：
${input.plan}

检查：计划是否具体、可执行；是否符合用户的请求、范围合适；步骤的顺序是否可行、前置是否写明；是否还有本该先问用户的选择没定；背景能否让只大概了解这个项目的人想起这是在做什么；风险和不可逆的步骤是否写进了「${NOTABLE_POINTS_TITLE["zh-CN"]}」。

只调用一次 PlanReview 给出结论：
- \`verdict: "ok"\`，不带意见：你没有疑问。计划会替用户按草稿批准并开始执行。
- \`verdict: "concerns"\`，1 到 ${input.limits.comments} 条意见：每条只说一个问题，简短具体（不超过 ${input.limits.chars} 字）；针对计划里某一块时，用 \`target\` 写它的短 id（如上面方括号里的）。意见会写在计划下的「${getOutlinePlanReviewTitle(locale, input.version)}」块里，用户看着这些意见做决定；计划不会退回给规划者。

你最多有两轮。只调用 PlanReview，不调用其他工具。第一次调用被拒绝时，按工具结果在第二轮改正。不要调用 ExitPlanMode 或 OutlineEdit，也不要自己把意见写到别处。`
		: `Plan review: a plan in the outline is about to go to the user for approval. You review it; the user, not you, approves or returns it.

Pending review ID: ${input.requestId}
Plan root: \`${input.address}\` (version ${input.version})
${summary}
The plan as submitted (each block after its short id):
${input.plan}

Check that the plan is specific and actionable; that it matches what the user asked for, in scope; that its steps are in a workable order with their prerequisites stated; that no choice is left open the user should have made first; that its background lets someone who knows the project only roughly recall what this is; and that risks and irreversible steps are under "${NOTABLE_POINTS_TITLE.en}".

Give your verdict with one call of PlanReview:
- \`verdict: "ok"\` with no comments: you have no concerns. The plan is then approved as a draft on the user's behalf and executed.
- \`verdict: "concerns"\` with 1 to ${input.limits.comments} comments: one concern each, short and concrete (at most ${input.limits.chars} characters); when one is about a block of the plan, give its short id (as in the brackets above) as \`target\`. The comments are written under the plan as "${getOutlinePlanReviewTitle(locale, input.version)}", and the user decides with them in view; the plan is not sent back to the planner.

You have at most two rounds. Call only PlanReview, no other tool. If the first call is refused, correct it in the second round from the tool result. Do not call ExitPlanMode or OutlineEdit, and do not write the comments anywhere yourself.`;
}
