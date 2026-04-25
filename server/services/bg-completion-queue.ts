/**
 * Background task completion notification queue.
 *
 * Extracted into its own module (no db dependency) to avoid circular imports
 * between narrator-session and narrator-subagent.
 */

export interface CompletedBgSubagentNotification {
	id: string;
	title: string;
	status: string;
	resultPreview: string;
}

let _bgCompletionQueue: Map<string, CompletedBgSubagentNotification[]> | undefined;
function getBgCompletionQueue() {
	if (!_bgCompletionQueue) _bgCompletionQueue = new Map();
	return _bgCompletionQueue;
}

export function pushBgCompletionNotification(
	parentNarratorId: string,
	notification: CompletedBgSubagentNotification,
) {
	const queue = getBgCompletionQueue();
	const list = queue.get(parentNarratorId) ?? [];
	list.push(notification);
	queue.set(parentNarratorId, list);
}

/**
 * Drain completed background subagent notifications for a parent narrator.
 * Used by getInjectedUserText to inform the agent about completed background tasks.
 */
export function drainCompletedBackgroundSubagents(
	parentNarratorId: string,
): CompletedBgSubagentNotification[] {
	const queue = getBgCompletionQueue();
	const list = queue.get(parentNarratorId);
	if (!list || list.length === 0) return [];
	queue.delete(parentNarratorId);
	return list;
}
