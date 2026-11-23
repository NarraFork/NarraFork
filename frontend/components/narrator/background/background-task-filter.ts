/**
 * View filter for the background-task panel.
 *
 * The panel splits rows into running work (top) and finished work (below a
 * divider), so recently finished agents stay one click away. Users narrow the
 * list by kind (agent / bash / Watch) and by a text search over the row's names.
 */

import type { BackgroundTaskListItem } from "@shared/background-task-list";
import { isBackgroundTaskActiveStatus } from "@shared/background-task-list";
import { isWatchCommand, parseWatchCommand, type WatchTargetType } from "@shared/watch-command";

export type BackgroundTaskKindFilter = "agent" | "bash" | "watch";

export const BACKGROUND_TASK_KIND_FILTERS: readonly BackgroundTaskKindFilter[] = [
	"agent",
	"bash",
	"watch",
];

export type BackgroundTaskKinds = Record<BackgroundTaskKindFilter, boolean>;

/** Watch observations are opt-in: active ones already show on the row they observe. */
export const DEFAULT_BACKGROUND_TASK_KINDS: BackgroundTaskKinds = {
	agent: true,
	bash: true,
	watch: false,
};

export interface BackgroundTaskFilter {
	kinds: BackgroundTaskKinds;
	query: string;
}

type FilterableTask = Pick<
	BackgroundTaskListItem,
	"type" | "command" | "status" | "effectiveStatus" | "title" | "alias" | "subagentType"
>;

export function isWatchTask(task: Pick<BackgroundTaskListItem, "command">): boolean {
	return isWatchCommand(task.command);
}

/** The kind toggle a row answers to; `null` (transfers) is never hidden by kind. */
export function backgroundTaskFilterKind(
	task: Pick<BackgroundTaskListItem, "type" | "command">,
): BackgroundTaskKindFilter | null {
	if (isWatchTask(task)) return "watch";
	if (task.type === "agent") return "agent";
	if (task.type === "bash") return "bash";
	return null;
}

/** Case-insensitive match of every whitespace-separated term against the row's names. */
export function matchesBackgroundTaskQuery(task: FilterableTask, query: string): boolean {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = [task.title, task.alias, task.command, task.subagentType]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

export function isBackgroundTaskVisible(task: FilterableTask, filter: BackgroundTaskFilter) {
	const kind = backgroundTaskFilterKind(task);
	if (kind && !filter.kinds[kind]) return false;
	return matchesBackgroundTaskQuery(task, filter.query);
}

export function isBackgroundTaskRunning(
	task: Pick<BackgroundTaskListItem, "status" | "effectiveStatus">,
): boolean {
	return isBackgroundTaskActiveStatus(task.effectiveStatus || task.status);
}

/** Visible rows split into running (shown first) and finished, keeping list order. */
export function splitBackgroundTasks<T extends FilterableTask>(
	tasks: readonly T[],
	filter: BackgroundTaskFilter,
): { running: T[]; finished: T[] } {
	const running: T[] = [];
	const finished: T[] = [];
	for (const task of tasks) {
		if (!isBackgroundTaskVisible(task, filter)) continue;
		(isBackgroundTaskRunning(task) ? running : finished).push(task);
	}
	return { running, finished };
}

/** `${type}:${id}` of what a watch observes, or of a row that can be observed. */
export function watchTargetKey(type: WatchTargetType, id: string): string {
	return `${type}:${id}`;
}

/** Active watch rows grouped by the target they observe, so the target row can show them. */
export function activeWatchesByTarget<T extends Pick<BackgroundTaskListItem, "command" | "status">>(
	tasks: readonly T[],
): Map<string, T[]> {
	const byTarget = new Map<string, T[]>();
	for (const task of tasks) {
		if (!isBackgroundTaskActiveStatus(task.status)) continue;
		const target = parseWatchCommand(task.command);
		if (!target) continue;
		const key = watchTargetKey(target.type, target.id);
		byTarget.set(key, [...(byTarget.get(key) ?? []), task]);
	}
	return byTarget;
}
