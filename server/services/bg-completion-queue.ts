/** Background-agent display formatting and a compatibility scheduling hint.
 * Result transactions own durable intents; publication.ts transfers them into the
 * sole mailbox. This module never owns or writes an independent content queue.
 */

import { runtimePublication } from "./agent-runtime/publication";

const MAX_BACKGROUND_RESULT_CHARS = 12_000;

export interface CompletedBgSubagentNotification {
	/** Initiating user of the completed execution, never inferred from its parent. */
	userId?: string | null;
	/** Real subagent narrator id (also the background task row id). */
	id: string;
	/**
	 * Readable alias for `id`. Every model-facing mention uses this — the raw
	 * nanoid is what made the model address agents by gibberish afterwards.
	 * Mirrors `SideCarDoneTask.alias`, which the bash flavour already had.
	 */
	alias?: string | null;
	title: string;
	status: string;
	resultPreview: string;
	/** Capped result included for both busy and idle parent narrators. */
	result?: string;
	resultTruncated?: boolean;
	/**
	 * The message inside the agent's own session that produced this result, so the
	 * reader can jump straight to it from the completion row (see
	 * `SideCarDoneTask.resultMessageId`).
	 *
	 * READER-ONLY: `formatBackgroundCompletionNotifications` deliberately never
	 * prints it. The model addresses agents by alias and has no use for a message
	 * id; emitting one would teach it to quote internal ids back at us — the same
	 * failure the alias work fixed.
	 */
	resultMessageId?: string | null;
}

/** Schedule transfer of an already committed background-agent publication. */
export function pushBgCompletionNotification(
	parentNarratorId: string,
	notification: CompletedBgSubagentNotification,
) {
	// The producer's result transaction owns the durable intent. No in-memory queue,
	// no second enqueue path: this compatibility call is a scheduling hint only.
	void parentNarratorId;
	void notification;
	runtimePublication.schedule();
}

/** Shared lifecycle wording for reader sidecars and model-facing notifications. */
export function backgroundAgentNoticePreview(
	task: CompletedBgSubagentNotification,
	locale = "en",
): string {
	const zh = locale === "zh-CN";
	if (task.status === "started" || task.status === "running") {
		return zh ? "子代理已开始执行。" : "Agent has started.";
	}
	return (
		task.result?.slice(0, MAX_BACKGROUND_RESULT_CHARS) ??
		(zh
			? "此通知未能读取结果，请查看子代理或使用 Await 获取已保存的结果。"
			: "This notice could not load the result. View the agent or use Await to inspect the stored result.")
	);
}

export function formatBackgroundCompletionNotifications(
	notifications: CompletedBgSubagentNotification[],
	options: { includeResult?: boolean } = {},
): string {
	const includeResult = options.includeResult !== false;
	const lines = notifications.map((task) => {
		// The id slot doubles as the selector the model is told to reuse, so it must
		// be the alias whenever one exists.
		const ref = task.alias ?? task.id;
		const header = `[System] Background agent "${task.title}" (ID: ${ref}) ${task.status}.`;
		if (task.status === "started" || task.status === "running") {
			return `${header}\n${backgroundAgentNoticePreview(task)}`;
		}
		const missing = task.result == null;
		const truncated =
			task.resultTruncated || (task.result?.length ?? 0) > MAX_BACKGROUND_RESULT_CHARS;
		const resultText = includeResult
			? missing
				? backgroundAgentNoticePreview(task)
				: `Result:\n${task.result?.slice(0, MAX_BACKGROUND_RESULT_CHARS) || "(empty)"}${
						truncated ? `\n[Result truncated to ${MAX_BACKGROUND_RESULT_CHARS} characters.]` : ""
					}`
			: `Result preview: ${task.resultPreview || "(empty)"}`;
		const supplement =
			!includeResult || missing || truncated
				? `\nUse Await({ type: "agent", id: "${ref}" }) to see the stored result.`
				: "";
		return `${header}\n${resultText}${supplement}\nUse Send({ id: "${ref}", message }) to continue.`;
	});
	return lines.join("\n\n");
}
