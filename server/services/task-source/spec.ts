/**
 * The spec task source: tasks live in the narrator's own `spec://tasks.json`, the fence
 * in `spec://behavior_fence`.
 *
 * It only gathers the reads that used to sit in narrator-session and spec-reminder; logic
 * and copy are unchanged. Task selection is still `compileSpecTasks`; promotion still
 * writes a `system` revision and emits `spec:changed`; the injection bodies still come
 * from spec-reminder.
 */

import { getBlockedTaskActionInstruction, type Locale } from "../../lib/prompt-i18n";
import {
	buildBehaviorFenceBody,
	buildSpecCompactContext,
	buildSpecTaskDigestBody,
} from "../spec-reminder";
import {
	type CompiledSpecTasks,
	compileSpecTasks,
	parseSpecTasksDocument,
	type SpecTaskItem,
} from "../spec-task-service";
import { specVfsService } from "../spec-vfs-service";
import { buildSpecContinuationPrompt } from "../turn-continuation-decisions";
import type {
	ContinuationPromptInput,
	ContinuationTarget,
	ContinuationTask,
	InterruptGuardNote,
	NarratorTaskSource,
	OpenTaskList,
	OpenTaskView,
	TaskView,
} from "./types";

async function readCompiledTasks(narratorId: string) {
	const file = await specVfsService.readTasksFileForNarrator(narratorId);
	return { file, compiled: compileSpecTasks(parseSpecTasksDocument(file.content)) };
}

function isOpenSpecTask(task: SpecTaskItem): boolean {
	return task.status === "doing" || task.status === "todo" || task.status === "blocked";
}

function toTaskView(task: SpecTaskItem): TaskView {
	return { text: task.text, status: task.status, protected: task.protected === true };
}

/**
 * Read tasks.json for a continuation decision, promoting the first `todo` to `doing`
 * when nothing is in progress and the policy allows it.
 *
 * The promotion is a real write (a `system` revision, `spec:changed` on the event bus)
 * and happens before the mode is consulted, so it lands even when no continuation follows.
 */
async function loadCompiledSpecForContinuation(
	narratorId: string,
	promoteTodo: boolean,
): Promise<CompiledSpecTasks> {
	const file = await specVfsService.readTasksFileForNarrator(narratorId);
	let document = parseSpecTasksDocument(file.content);
	let compiled = compileSpecTasks(document);
	if (promoteTodo && !compiled.currentTask && compiled.nextTask) {
		let promoted = false;
		document = {
			tasks: document.tasks.map((task) => {
				if (!promoted && task.status === "todo") {
					promoted = true;
					return { ...task, status: "doing" as const };
				}
				return task;
			}),
		};
		const content = `${JSON.stringify(document, null, "\t")}\n`;
		await specVfsService.writeSpecFile(narratorId, "spec://tasks.json", content, {
			createdBy: "system",
			allowProtectedTaskMutation: true,
		});
		compiled = compileSpecTasks(document);
	}
	return compiled;
}

async function prepareSpecContinuation(
	narratorId: string,
	promoteTodo: boolean,
): Promise<ContinuationTarget> {
	const compiled = await loadCompiledSpecForContinuation(narratorId, promoteTodo);
	const chosen = compiled.currentTask ?? compiled.tasks.find((task) => task.status === "blocked");
	return {
		openTask: chosen
			? {
					text: chosen.text,
					protected: chosen.protected === true,
					status: chosen === compiled.currentTask ? ("doing" as const) : ("blocked" as const),
				}
			: null,
		protectedOpenCount: compiled.protectedOpenCount,
	};
}

function openBlockedContinuationPrompt(blocked: ContinuationTask, locale: Locale): string {
	const actionInstruction = getBlockedTaskActionInstruction(locale);
	// `actionInstruction` already classifies the blocker and covers both branches, so
	// this copy only adds what it cannot: that the message is system-generated, the tool
	// name for asking, and that a stale entry may be rewritten. Restating its branches
	// here (an earlier revision did) just made the prompt longer and self-repeating.
	const prompt =
		locale === "zh-CN"
			? `Dynamic Spec blocked 任务续跑（系统消息，不是用户发言）。\n\n系统在 spec://tasks.json 有 blocked 条目时自动发出这条消息。\n\nblocked 任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：${blocked.text}${blocked.protected ? " [protected]" : ""}\n\n${actionInstruction}\n\n需要用户介入时，用 AskUserQuestion 提问并结束回合；不要靠反复改写 tasks.json 或重跑同样的调查来绕开。如果该条目已不符合当前实际，可在保留用户原意图的前提下改写或删除它，并说明原因。改动 tasks.json 时先读取再就地修改，不要按本消息重写整个文件。`
			: `Dynamic Spec blocked-task continuation (system message, not the user speaking).\n\nThe system emits this whenever spec://tasks.json has a \`blocked\` entry.\n\nBlocked task (this one only — not the full task list; your other tasks are still in spec://tasks.json): ${blocked.text}${blocked.protected ? " [protected]" : ""}\n\n${actionInstruction}\n\nWhen the blocker needs the user, ask with AskUserQuestion and end the turn; do not work around it by rewriting tasks.json or re-running the same investigation. If the entry no longer matches reality, rewrite or remove it while preserving the user's original intent, and say why. When you change tasks.json, read it first and edit in place; do not rewrite the file from this message.`;
	return prompt;
}

function openDoingContinuationPrompt(current: ContinuationTask, locale: Locale): string {
	const protectedNote = current.protected
		? locale === "zh-CN"
			? "\n- protected：只有具备具体验收证据才能标记 done，该变更会触发 taskReflection。"
			: "\n- Protected: mark it done only with concrete completion evidence; that change runs taskReflection."
		: "";
	// ⚠️ Compiled from tasks.json, not written by the user, and emitted purely because a
	// `doing` entry is still open — so it has to say so.
	//
	// The wording it replaces restated the task and ordered the model to continue ("Do not
	// ask the user whether to continue"), which is indistinguishable from the user insisting
	// the work is unfinished. Three observed failure modes came from that:
	//
	//  1. Work done, tasks.json not yet updated → the model reads the restated task as "you
	//     are not done" and reworks code that was already correct.
	//  2. The task needs the user (one was titled "需用户跑") → being told to act rather than
	//     ask, the model edited tasks and got nudged again, 37 times in one session.
	//  3. The task no longer matches reality → with no licence to say so, it grinds a stale
	//     objective.
	//
	// Hence: state provenance, then enumerate the legitimate outcomes. The list must not be
	// framed as "ways to END the turn" — "keep working" is one of the branches.
	//
	// It also names ONE task while tasks.json may hold many, so it says so. A model that
	// reads this single line as the whole file concludes its other entries were lost and
	// "restores" them by rewriting tasks.json — destroying the entries that were fine.
	const prompt =
		locale === "zh-CN"
			? `Dynamic Spec 自动续跑（系统消息，不是用户发言）。\n\n系统在 spec://tasks.json 仍有 doing 条目时自动发出这条消息。它只说明该条目尚未标记完成 —— 不代表系统判断你没做完，条目内容也可能已经过时。\n\n当前任务（仅这一条，不是完整任务列表；其余任务仍在 spec://tasks.json 中）：${current.text}${current.protected ? " [protected]" : ""}\n\n请先判断该任务的真实状态，再按实际情况选择其一：\n- 已经完成：在 spec://tasks.json 标记 done。这就是本回合的有效结果，不要因为这条提醒去返工已经正确的改动。\n- 未完成且能自主推进：继续执行。\n- 需要用户提供信息、权限、决策，或需要用户亲自操作：先做完不受阻的部分，再用 AskUserQuestion 提出一个精确问题并结束回合。\n- 已不符合当前实际：在保留用户原意图的前提下改写或删除该条目，并说明原因。\n\n改动 spec://tasks.json 时先读取再就地修改，不要按本消息重写整个文件。${protectedNote}`
			: `Dynamic Spec auto-continuation (system message, not the user speaking).\n\nThe system emits this whenever spec://tasks.json still has a \`doing\` entry. It only means the entry is not marked finished — not that the system judged your work incomplete, and its content may be out of date.\n\nCurrent task (this one only — not the full task list; your other tasks are still in spec://tasks.json): ${current.text}${current.protected ? " [protected]" : ""}\n\nDecide what is actually true of this task, then take exactly one of these paths:\n- Already done: mark it done in spec://tasks.json. That is a valid result for this turn; do not rework a change that was already correct.\n- Unfinished and you can advance it: keep working.\n- Needs the user's information, permission, decision, or an action only they can perform: finish every unblocked part, then ask one precise question with AskUserQuestion and end the turn.\n- No longer matches reality: rewrite or remove the entry while preserving the user's original intent, and say why.\n\nWhen you change spec://tasks.json, read it first and edit in place; do not rewrite the file from this message.${protectedNote}`;
	return prompt;
}

function specContinuationPrompt(input: ContinuationPromptInput): string {
	if (input.form === "bounded") {
		return buildSpecContinuationPrompt({
			cause: input.cause,
			task: input.task,
			passes: input.passes,
			maxPasses: input.maxPasses,
			canAskUserQuestion: input.canAskUserQuestion,
			locale: input.locale,
		});
	}
	return input.task.status === "doing"
		? openDoingContinuationPrompt(input.task, input.locale)
		: openBlockedContinuationPrompt(input.task, input.locale);
}

function specInterruptGuardNote(
	openTasks: readonly OpenTaskView[],
	locale: Locale,
): InterruptGuardNote {
	const isZh = locale === "zh-CN";
	const taskLines = openTasks
		.map((task) => `- [${task.status}] ${task.text}${task.protected ? " [protected]" : ""}`)
		.join("\n");
	const content = isZh
		? `刚才的运行被用户中断，这通常意味着方向有变化。当前 spec://tasks.json 中仍有以下开放任务：\n\n${taskLines}\n\n这些任务可能已经过期或与用户最新意图不一致。回复用户的下一条消息时，以用户消息为准；如需调整计划，先更新/删除过期任务（protected 任务变更会触发 taskReflection），再继续执行。不要无视用户新指令而直接恢复旧任务。`
		: `The run was just interrupted by the user, which usually means the direction changed. spec://tasks.json still has these open tasks:\n\n${taskLines}\n\nThey may be stale or no longer match the user's latest intent. When the user's next message arrives, treat it as the source of truth; update or remove outdated tasks first if the plan changed (protected task changes trigger taskReflection), then continue. Do not resume an old task over the user's new instruction.`;
	const body = {
		kind: "tasks" as const,
		variant: "current" as const,
		tasks: openTasks.map((task) => ({
			role:
				task.status === "doing"
					? ("doing" as const)
					: task.status === "blocked"
						? ("blocked" as const)
						: ("todo" as const),
			text: task.text,
			...(task.protected ? { protected: true as const } : {}),
		})),
	};
	return { content, body };
}

/** The spec task source for one narrator. Stateless: every read goes to tasks.json. */
export function createSpecTaskSource(narratorId: string): NarratorTaskSource {
	return {
		backend: "spec",
		narratorId,
		async currentTask() {
			const { compiled } = await readCompiledTasks(narratorId);
			return compiled.currentTask ? toTaskView(compiled.currentTask) : null;
		},
		async nextTask() {
			const { compiled } = await readCompiledTasks(narratorId);
			return compiled.nextTask ? toTaskView(compiled.nextTask) : null;
		},
		async openTasks(): Promise<OpenTaskList> {
			const { file, compiled } = await readCompiledTasks(narratorId);
			return {
				tasks: compiled.tasks
					.filter(isOpenSpecTask)
					.map((task) => toTaskView(task) as OpenTaskView),
				revision: file.revisionId ?? null,
			};
		},
		async protectedOpenCount() {
			const { compiled } = await readCompiledTasks(narratorId);
			return compiled.protectedOpenCount;
		},
		prepareContinuation: ({ promoteTodo }) => prepareSpecContinuation(narratorId, promoteTodo),
		continuationPrompt: specContinuationPrompt,
		taskDigest: () => buildSpecTaskDigestBody(narratorId),
		behaviorFence: () => buildBehaviorFenceBody(narratorId),
		compactContext: (locale) => buildSpecCompactContext(narratorId, locale),
		interruptGuardNote: specInterruptGuardNote,
	};
}
