/** Background-agent display formatting and a compatibility scheduling hint.
 * Result transactions own durable intents; publication.ts transfers them into the
 * sole mailbox. This module never owns or writes an independent content queue.
 */

import { runtimePublication } from "./agent-runtime/publication";

const MAX_BACKGROUND_RESULT_CHARS = 12_000;

export interface CompletedBgSubagentNotification {
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
	/** Capped full result used when waking an idle parent narrator. */
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

export function formatBackgroundCompletionNotifications(
	notifications: CompletedBgSubagentNotification[],
	options: { includeResult?: boolean } = {},
): string {
	const includeResult = options.includeResult === true;
	const lines = notifications.map((task) => {
		// The id slot doubles as the selector the model is told to reuse, so it must
		// be the alias whenever one exists.
		const ref = task.alias ?? task.id;
		const header = `[System] Background agent "${task.title}" (ID: ${ref}) ${task.status}.`;
		const fullResult = task.result ?? task.resultPreview;
		const resultText = includeResult
			? `Result:\n${fullResult || "(empty)"}${
					task.resultTruncated
						? `\n[Result truncated to ${MAX_BACKGROUND_RESULT_CHARS} characters. Use Await({ type: "agent", id: "${ref}" }) to see the stored result.]`
						: ""
				}`
			: `Result preview: ${task.resultPreview || "(empty)"}`;
		return `${header}\n${resultText}\nUse Await({ type: "agent", id: "${ref}" }) to see the full result, or Send({ id: "${ref}", message }) to continue.`;
	});
	return lines.join("\n\n");
}
