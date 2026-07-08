import type { Locale } from "../lib/prompt-i18n";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";

function formatTaskLine(prefix: string, text: string, protectedTask?: boolean): string {
	return `- ${prefix}: ${text}${protectedTask ? " [protected]" : ""}`;
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
		if (openTasks.length === 0) return null;

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
