import { getBlockedTaskActionInstruction, type Locale } from "../lib/prompt-i18n";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";

export const SPEC_TASKS_REORGANIZE_THRESHOLD = 30;

function formatTaskLine(prefix: string, text: string, protectedTask?: boolean): string {
	return `- ${prefix}: ${text}${protectedTask ? " [protected]" : ""}`;
}

/**
 * Build the nudge injected when the narrator has no active task (no doing/todo/blocked).
 * `neverCreated` distinguishes "never created any task" from "all tasks are done".
 * Both keep an explicit escape hatch so simple/one-off work is not nagged.
 */
function buildEmptyTasksNudge(neverCreated: boolean, locale: Locale): string {
	if (locale === "zh-CN") {
		const lines = [
			"Dynamic Spec 提醒（spec://tasks.json 当前没有进行中的任务）：",
			neverCreated
				? "- 你还没有在 spec://tasks.json 建立任何任务。如果当前是多步骤或较复杂的工作，请用 Write/Edit 建立任务清单来跟踪进度，例如一条 doing + 若干 todo。"
				: "- 上一阶段任务已全部完成。现在开始下一轮工作前，请先重新审视当前目标和上下文，整理 spec://tasks.json：清理已完成的普通任务，保留 protected task 的用户意图，并只保留当前阶段必要且精简的 doing/todo/blocked 任务。",
			neverCreated
				? "- 如果当前工作确实简单、无需拆分，可以忽略本提醒。"
				: "- 整理完成后再继续当前工作；不要为了保留历史而堆积已完成任务。",
			"- tasks.json 只保留 text/status/protected，不要添加 ID、时间戳、摘要或其他字段。",
		];
		return lines.join("\n");
	}
	const lines = [
		"Dynamic Spec reminder (spec://tasks.json has no active tasks):",
		neverCreated
			? "- You have not created any task in spec://tasks.json yet. If this is multi-step or non-trivial work, use Write/Edit to build a task list to track progress, e.g. one doing plus a few todo."
			: "- The previous phase is complete. Before starting the next round of work, reassess the current goal and context, then reorganize spec://tasks.json: remove completed ordinary tasks, preserve protected-task intent, and keep only a concise set of necessary doing/todo/blocked tasks for the current phase.",
		neverCreated
			? "- If the current work is genuinely simple and does not need to be broken down, you may ignore this reminder."
			: "- Continue the work only after the task list is refreshed; do not retain completed tasks merely as history.",
		"- Keep tasks.json to only text/status/protected; do not add IDs, timestamps, summaries, or other fields.",
	];
	return lines.join("\n");
}

function buildTooManyTasksNudge(taskCount: number, locale: Locale): string {
	if (locale === "zh-CN") {
		return [
			`Dynamic Spec 整理提醒（spec://tasks.json 当前有 ${taskCount} 条任务，超过 ${SPEC_TASKS_REORGANIZE_THRESHOLD} 条）：`,
			"- 请先重新整理任务清单，再继续执行：合并重复或高度相关的任务，删除已过期的普通任务，拆分过大的任务，并确保当前阶段只有必要的 doing/todo/blocked 任务。",
			"- protected task 的用户意图必须保留；不要通过改写、删除或替换 protected task 来绕过目标。",
			"- tasks.json 只保留 text/status/protected，不要添加 ID、时间戳、摘要或其他字段。",
		].join("\n");
	}
	return [
		`Dynamic Spec reorganization reminder (spec://tasks.json has ${taskCount} tasks, exceeding ${SPEC_TASKS_REORGANIZE_THRESHOLD}):`,
		"- Reorganize the task list before continuing: merge duplicate or closely related tasks, remove obsolete ordinary tasks, split oversized tasks, and keep only the necessary doing/todo/blocked tasks for the current phase.",
		"- Preserve protected-task intent; do not rewrite, delete, or replace a protected task to bypass its goal.",
		"- Keep tasks.json to only text/status/protected; do not add IDs, timestamps, summaries, or other fields.",
	].join("\n");
}

export async function buildSpecToolResultReminder(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	try {
		const file = await specVfsService.readTasksFileForNarrator(narratorId);
		const compiled = compileSpecTasks(parseSpecTasksDocument(file.content));
		const openTasks = compiled.tasks.filter(
			(task) => task.status === "doing" || task.status === "todo" || task.status === "blocked",
		);
		if (openTasks.length === 0) {
			// No active task. Rather than staying silent (which lets a session run
			// indefinitely without ever tracking its work), nudge the model to build
			// or refresh spec://tasks.json. Two situations, two tones:
			//   - never created any task  -> nudge to create one
			//   - all tasks are done      -> ask for a concise next-phase reorganization
			return buildEmptyTasksNudge(compiled.tasks.length === 0, locale);
		}
		if (compiled.tasks.length > SPEC_TASKS_REORGANIZE_THRESHOLD) {
			return buildTooManyTasksNudge(compiled.tasks.length, locale);
		}

		const lines: string[] = [];
		if (compiled.currentTask) {
			lines.push(
				formatTaskLine("doing", compiled.currentTask.text, compiled.currentTask.protected),
			);
		} else if (compiled.nextTask) {
			lines.push(formatTaskLine("next", compiled.nextTask.text, compiled.nextTask.protected));
		}
		const blocked = openTasks.filter((task) => task.status === "blocked");
		for (const task of blocked.slice(0, 3)) {
			lines.push(formatTaskLine("blocked", task.text, task.protected));
		}
		const upcoming = openTasks.filter(
			(task) => task.status === "todo" && task !== compiled.nextTask,
		);
		for (const task of upcoming.slice(0, Math.max(0, 4 - lines.length))) {
			lines.push(formatTaskLine("todo", task.text, task.protected));
		}

		if (locale === "zh-CN") {
			return [
				"当前 Dynamic Spec 提醒（由 spec://tasks.json 编译生成）：",
				...lines,
				"如任务状态已变化，请用 Read/Edit/Write 更新 spec://tasks.json；不要在 tasks.json 中添加 ID、时间戳或说明字段。",
				getBlockedTaskActionInstruction(locale),
			].join("\n");
		}
		return [
			"Current Dynamic Spec reminder (compiled from spec://tasks.json):",
			...lines,
			"If task state changed, update spec://tasks.json with Read/Edit/Write. Do not add IDs, timestamps, or notes fields to tasks.json.",
			getBlockedTaskActionInstruction(locale),
		].join("\n");
	} catch {
		return null;
	}
}

/**
 * Build the behavior-fence reminder from spec://behavior_fence. Returns null when the
 * fence is empty/whitespace (empty fence must never inject anything).
 */
export async function buildBehaviorFenceReminder(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	try {
		const file = await specVfsService.readSpecFile(narratorId, "spec://behavior_fence");
		const content = file.content.trim();
		if (!content) return null;
		return locale === "zh-CN"
			? `行为护栏（用户设定的行为约束，务必遵守）：\n${content}`
			: `Behavior fence (durable behavior constraints set by the user — you must obey them):\n${content}`;
	} catch {
		return null;
	}
}

export async function buildSpecCompactContext(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	try {
		const file = await specVfsService.readTasksFileForNarrator(narratorId);
		const compiled = compileSpecTasks(parseSpecTasksDocument(file.content));
		if (compiled.tasks.length === 0) return null;
		const lines = compiled.tasks.map((task) => {
			const protectedFlag = task.protected ? " [protected]" : "";
			return `- [${task.status}] ${task.text}${protectedFlag}`;
		});
		return locale === "zh-CN"
			? `当前 Dynamic Spec 任务：\n${lines.join("\n")}`
			: `Current Dynamic Spec tasks:\n${lines.join("\n")}`;
	} catch {
		return null;
	}
}
