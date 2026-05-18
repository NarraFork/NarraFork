/**
 * Background task completion notification queue.
 *
 * Extracted into its own module (no db dependency) to avoid circular imports
 * between narrator-session and narrator-subagent.
 */

const MAX_BACKGROUND_RESULT_CHARS = 12_000;

export interface CompletedBgSubagentNotification {
	id: string;
	title: string;
	status: string;
	resultPreview: string;
	/** Capped full result used when waking an idle parent narrator. */
	result?: string;
	resultTruncated?: boolean;
}

function capResult(result: string | undefined): { result: string | undefined; truncated: boolean } {
	if (!result || result.length <= MAX_BACKGROUND_RESULT_CHARS) {
		return { result, truncated: false };
	}
	return {
		result: result.slice(0, MAX_BACKGROUND_RESULT_CHARS),
		truncated: true,
	};
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
	const capped = capResult(notification.result);
	list.push({
		...notification,
		result: capped.result,
		resultTruncated: notification.resultTruncated || capped.truncated,
	});
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

export function formatBackgroundCompletionNotifications(
	notifications: CompletedBgSubagentNotification[],
	options: { includeResult?: boolean } = {},
): string {
	const includeResult = options.includeResult === true;
	const lines = notifications.map((task) => {
		const header = `[System] Background agent "${task.title}" (ID: ${task.id}) ${task.status}.`;
		const fullResult = task.result ?? task.resultPreview;
		const resultText = includeResult
			? `Result:\n${fullResult || "(empty)"}${
					task.resultTruncated
						? `\n[Result truncated to ${MAX_BACKGROUND_RESULT_CHARS} characters. Use Await({ type: "agent", id: "${task.id}" }) to see the stored result.]`
						: ""
				}`
			: `Result preview: ${task.resultPreview || "(empty)"}`;
		return `${header}\n${resultText}\nUse Await({ type: "agent", id: "${task.id}" }) to see the full result, or Send({ id: "${task.id}", message }) to continue.`;
	});
	return lines.join("\n\n");
}
