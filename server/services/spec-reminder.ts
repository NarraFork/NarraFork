import {
	renderSideCarBodyToText,
	type SideCarBody,
	type SideCarTaskEntry,
} from "@shared/sidecar-body";
import type { Locale } from "../lib/prompt-i18n";
import { getSideCarModelTemplates } from "../lib/sidecar-templates";
import { compileSpecTasks, parseSpecTasksDocument } from "./spec-task-service";
import { specVfsService } from "./spec-vfs-service";

export const SPEC_TASKS_REORGANIZE_THRESHOLD = 30;

/**
 * Build the STRUCTURED Dynamic Spec digest for a narrator, or null when the spec
 * cannot be read.
 *
 * This is the single source of truth for "which tasks does the digest mention, and
 * which of the four shapes is it". Both projections derive from it:
 * `renderSideCarBodyToText` produces the model-facing text (which
 * `buildSpecToolResultReminder` below still returns, unchanged) and
 * `presentSideCarBody` produces the reader-facing lines.
 */
export async function buildSpecTaskDigestBody(narratorId: string): Promise<SideCarBody | null> {
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
			return { kind: "tasks", variant: compiled.tasks.length === 0 ? "emptyNever" : "emptyDone" };
		}
		if (compiled.tasks.length > SPEC_TASKS_REORGANIZE_THRESHOLD) {
			return {
				kind: "tasks",
				variant: "tooMany",
				taskCount: compiled.tasks.length,
				threshold: SPEC_TASKS_REORGANIZE_THRESHOLD,
			};
		}

		// Selection order (and the 4-line budget) is load-bearing: the digest is
		// injected on most tool results, so it stays short enough to not crowd out the
		// tool output it rides along with.
		const tasks: SideCarTaskEntry[] = [];
		if (compiled.currentTask) {
			tasks.push({
				role: "doing",
				text: compiled.currentTask.text,
				...(compiled.currentTask.protected ? { protected: true } : {}),
			});
		} else if (compiled.nextTask) {
			tasks.push({
				role: "next",
				text: compiled.nextTask.text,
				...(compiled.nextTask.protected ? { protected: true } : {}),
			});
		}
		const blocked = openTasks.filter((task) => task.status === "blocked");
		for (const task of blocked.slice(0, 3)) {
			tasks.push({
				role: "blocked",
				text: task.text,
				...(task.protected ? { protected: true } : {}),
			});
		}
		const upcoming = openTasks.filter(
			(task) => task.status === "todo" && task !== compiled.nextTask,
		);
		for (const task of upcoming.slice(0, Math.max(0, 4 - tasks.length))) {
			tasks.push({ role: "todo", text: task.text, ...(task.protected ? { protected: true } : {}) });
		}
		return { kind: "tasks", variant: "current", tasks };
	} catch {
		return null;
	}
}

/**
 * The model-facing Dynamic Spec digest text.
 *
 * A thin projection of {@link buildSpecTaskDigestBody} — one selection of tasks,
 * two renderings. Kept as a function of its own because the wording is asserted
 * directly by `spec-reminder.test.ts`, which therefore doubles as the byte-parity
 * check on the structured path.
 */
export async function buildSpecToolResultReminder(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	const body = await buildSpecTaskDigestBody(narratorId);
	if (!body) return null;
	return renderSideCarBodyToText("living_work_spec", body, getSideCarModelTemplates(locale));
}

/**
 * Build the STRUCTURED behavior fence from spec://behavior_fence, or null when the
 * fence is empty/whitespace (an empty fence must never inject anything).
 */
export async function buildBehaviorFenceBody(narratorId: string): Promise<SideCarBody | null> {
	try {
		const file = await specVfsService.readSpecFile(narratorId, "spec://behavior_fence");
		const content = file.content.trim();
		if (!content) return null;
		return { kind: "prose", text: content };
	} catch {
		return null;
	}
}

/**
 * The model-facing behavior-fence reminder. A projection of
 * {@link buildBehaviorFenceBody}; the heading comes from the `sidecar.*` templates.
 */
export async function buildBehaviorFenceReminder(
	narratorId: string,
	locale: Locale,
): Promise<string | null> {
	const body = await buildBehaviorFenceBody(narratorId);
	if (!body) return null;
	return renderSideCarBodyToText("behavior_fence", body, getSideCarModelTemplates(locale));
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
