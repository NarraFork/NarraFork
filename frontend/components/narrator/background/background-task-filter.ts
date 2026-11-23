/**
 * Default view filter for the background-task panel.
 *
 * A long-lived narrator accumulates many finished tasks and Watch observations,
 * which bury the work that is still running. By default the panel shows only
 * running work plus work that finished while the panel was open; older finished
 * rows and Watch observations each need their own opt-in.
 */

import type { BackgroundTaskListItem } from "@shared/background-task-list";
import { isBackgroundTaskActiveStatus } from "@shared/background-task-list";
import { isWatchCommand, parseWatchCommand, type WatchTargetType } from "@shared/watch-command";

export interface BackgroundTaskFilter {
	/** Also show rows that had already finished before the panel was opened. */
	showCompleted: boolean;
	/** Also show Watch observation rows. */
	showWatch: boolean;
}

export const DEFAULT_BACKGROUND_TASK_FILTER: BackgroundTaskFilter = {
	showCompleted: false,
	showWatch: false,
};

export interface BackgroundTaskFilterContext {
	/** Epoch ms when the panel was opened. */
	openedAt: number;
	/** Rows this panel has seen active since it was opened. */
	seenActiveIds: ReadonlySet<string>;
}

type FilterableTask = Pick<
	BackgroundTaskListItem,
	"id" | "command" | "status" | "effectiveStatus" | "completedAt"
>;

export function isWatchTask(task: Pick<BackgroundTaskListItem, "command">): boolean {
	return isWatchCommand(task.command);
}

/**
 * Finished after the panel was opened: either this panel saw it running (no
 * clock involved), or the server stamped its completion after the open time.
 */
export function finishedSinceOpen(task: FilterableTask, context: BackgroundTaskFilterContext) {
	if (context.seenActiveIds.has(task.id)) return true;
	if (!task.completedAt) return false;
	const completedAt = Date.parse(task.completedAt);
	return Number.isFinite(completedAt) && completedAt >= context.openedAt;
}

export function isBackgroundTaskVisible(
	task: FilterableTask,
	filter: BackgroundTaskFilter,
	context: BackgroundTaskFilterContext,
): boolean {
	if (isWatchTask(task) && !filter.showWatch) return false;
	if (filter.showCompleted) return true;
	if (isBackgroundTaskActiveStatus(task.effectiveStatus || task.status)) return true;
	return finishedSinceOpen(task, context);
}

export function filterBackgroundTasks<T extends FilterableTask>(
	tasks: readonly T[],
	filter: BackgroundTaskFilter,
	context: BackgroundTaskFilterContext,
): T[] {
	return tasks.filter((task) => isBackgroundTaskVisible(task, filter, context));
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
