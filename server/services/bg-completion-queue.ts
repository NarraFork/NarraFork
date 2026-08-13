/**
 * Background AGENT completion notifications.
 *
 * Extracted into its own module (no db dependency) to avoid circular imports
 * between narrator-session and narrator-subagent.
 *
 * Ordering note: entries land in the shared `parent-injection-queue`, not in a queue of
 * their own. This module keeps only what is specific to this producer — the result cap
 * and the model-facing formatting.
 */

import { pushPendingInjection } from "./parent-injection-queue";

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

/**
 * Enqueue a finished background agent.
 *
 * The result capping stays here (it is this producer's concern); the ORDER lives in
 * `parent-injection-queue`, which is shared with the bash and Send producers so that a
 * report sent before a task finished cannot be shown after it. See that module's header
 * for why ordering is established at enqueue rather than reconstructed from timestamps.
 */
export function pushBgCompletionNotification(
	parentNarratorId: string,
	notification: CompletedBgSubagentNotification,
) {
	const capped = capResult(notification.result);
	pushPendingInjection(parentNarratorId, {
		kind: "bg_agent",
		task: {
			...notification,
			result: capped.result,
			resultTruncated: notification.resultTruncated || capped.truncated,
		},
	});
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
