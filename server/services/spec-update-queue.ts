/**
 * Spec-update sidecar queue.
 *
 * When the user saves a spec file via the UI, a lightweight notification is
 * queued here keyed by narratorId. A working narrator drains it at the next
 * `after_tools` sidecar boundary; an idle narrator drains it when the next
 * user message is fed (no auto-wake to avoid unnecessary model cost).
 */

import type { Locale } from "../lib/prompt-i18n";

/** Hard cap so rapid UI saves can't blow up a narrator's context. */
const MAX_QUEUED_SPEC_UPDATES = 10;
/** Per-update preview cap. */
const MAX_SPEC_UPDATE_CONTENT_CHARS = 2_000;

export interface PendingSpecUpdate {
	uri: string;
	path: string;
	revisionId: string | null;
	updatedBy: "user" | "assistant" | "system";
	/** Short content preview (only for non-tasks files). */
	preview: string | null;
	/** For tasks.json: compiled summary of open tasks after save. */
	taskSummary: string | null;
	/** True when the user emptied tasks.json — the update IS "all tasks are gone". */
	cleared?: boolean;
	/** True when the user reset the whole Dynamic Spec namespace to defaults. */
	reset?: boolean;
	timestamp: string;
}

let _specUpdateQueue: Map<string, PendingSpecUpdate[]> | undefined;
function getSpecUpdateQueue() {
	if (!_specUpdateQueue) _specUpdateQueue = new Map();
	return _specUpdateQueue;
}

/** Queue a spec update notification for a narrator. */
export function pushSpecUpdateForNarrator(narratorId: string, update: PendingSpecUpdate): void {
	const queue = getSpecUpdateQueue();
	const list = queue.get(narratorId) ?? [];
	list.push({
		...update,
		preview:
			update.preview && update.preview.length > MAX_SPEC_UPDATE_CONTENT_CHARS
				? `${update.preview.slice(0, MAX_SPEC_UPDATE_CONTENT_CHARS)}…[truncated]`
				: update.preview,
	});
	if (list.length > MAX_QUEUED_SPEC_UPDATES) {
		list.splice(0, list.length - MAX_QUEUED_SPEC_UPDATES);
	}
	queue.set(narratorId, list);
}

/** Drain all pending spec updates for a narrator. */
export function drainSpecUpdatesForNarrator(narratorId: string): PendingSpecUpdate[] {
	const queue = getSpecUpdateQueue();
	const list = queue.get(narratorId);
	if (!list || list.length === 0) return [];
	queue.delete(narratorId);
	return list;
}

/** Whether a narrator has any queued spec updates waiting. */
export function hasQueuedSpecUpdates(narratorId: string): boolean {
	const list = getSpecUpdateQueue().get(narratorId);
	return !!list && list.length > 0;
}

function formatSingleUpdate(update: PendingSpecUpdate, isZh: boolean): string {
	const lines: string[] = [];
	if (update.reset) {
		lines.push(
			isZh
				? `用户通过 UI 重置了整个 Dynamic Spec（${update.timestamp}）：所有任务、笔记与 behavior_fence 均已恢复默认/清空。不要再依据早先上下文重建旧任务，等待用户的新指令。`
				: `User reset the entire Dynamic Spec via UI (${update.timestamp}): all tasks, notes and the behavior fence are back to defaults/empty. Do not reconstruct old tasks from earlier context — wait for the user's next instruction.`,
		);
		return lines.join("\n");
	}
	if (update.cleared) {
		lines.push(
			isZh
				? `用户通过 UI 清空了 ${update.uri}（${update.timestamp}）：任务列表现在为空，此前的开放任务已全部移除。停止继续之前的任务，不要凭记忆恢复它们；等待用户的下一条指令。`
				: `User emptied ${update.uri} via UI (${update.timestamp}): the task list is now empty and every previously open task was removed. Stop pursuing earlier tasks and do not resurrect them from memory — wait for the user's next instruction.`,
		);
		return lines.join("\n");
	}
	if (isZh) {
		lines.push(`用户通过 UI 更新了 ${update.uri}（${update.timestamp}）。`);
	} else {
		lines.push(`User updated ${update.uri} via UI (${update.timestamp}).`);
	}
	if (update.taskSummary) {
		lines.push(update.taskSummary);
	} else if (update.preview) {
		if (isZh) {
			lines.push(`内容预览：\n${update.preview}`);
		} else {
			lines.push(`Content preview:\n${update.preview}`);
		}
	}
	return lines.join("\n");
}

/** Format queued spec updates as one sidecar injection block. */
export function formatSpecUpdateSideCars(updates: PendingSpecUpdate[], locale: Locale): string {
	const isZh = locale === "zh-CN";
	const header = isZh
		? "[系统] 用户通过 Spec 面板更新了以下文件，请注意同步你的工作计划："
		: "[System] The user updated the following spec files via the Spec panel — align your plan accordingly:";
	const body = updates.map((u) => formatSingleUpdate(u, isZh)).join("\n\n");
	return `${header}\n\n${body}`;
}
