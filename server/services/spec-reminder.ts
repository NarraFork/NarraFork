import type { Locale } from "../lib/prompt-i18n";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";

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
				: "- 任务已全部标记完成。如果你还在继续新的工作，请更新 spec://tasks.json 反映当前进度（把新事项加为 doing/todo）。",
			"- 如果当前工作确实简单、无需拆分，可以忽略本提醒。",
			"- tasks.json 只保留 text/status/protected，不要添加 ID、时间戳、摘要或其他字段。",
		];
		return lines.join("\n");
	}
	const lines = [
		"Dynamic Spec reminder (spec://tasks.json has no active tasks):",
		neverCreated
			? "- You have not created any task in spec://tasks.json yet. If this is multi-step or non-trivial work, use Write/Edit to build a task list to track progress, e.g. one doing plus a few todo."
			: "- All tasks are marked done. If you are continuing with new work, update spec://tasks.json to reflect current progress (add the new items as doing/todo).",
		"- If the current work is genuinely simple and does not need to be broken down, you may ignore this reminder.",
		"- Keep tasks.json to only text/status/protected; do not add IDs, timestamps, summaries, or other fields.",
	];
	return lines.join("\n");
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
			//   - all tasks are done      -> nudge to refresh if still working
			return buildEmptyTasksNudge(compiled.tasks.length === 0, locale);
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
				"如任务被 blocked，请说明阻塞原因；如果需要用户决策，请使用 AskUserQuestion 请求指导。",
			].join("\n");
		}
		return [
			"Current Dynamic Spec reminder (compiled from spec://tasks.json):",
			...lines,
			"If task state changed, update spec://tasks.json with Read/Edit/Write. Do not add IDs, timestamps, or notes fields to tasks.json.",
			"If a task is blocked, explain the blocker; if user guidance is needed, use AskUserQuestion.",
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
