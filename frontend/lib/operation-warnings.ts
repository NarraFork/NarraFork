/**
 * Shared reading and presentation of non-fatal warnings returned alongside a
 * successful mutation.
 *
 * Several chapter operations answer `{ success: true, warning }` or
 * `{ ...chapter, warnings }`: the operation went through, but something the user
 * has to act on happened on the way — a source worktree kept because its
 * snapshot could not be verified, a fork rebuilt from recorded file edits rather
 * than the parent's exact bytes, chapters skipped by a batch cleanup. Every call
 * site used to invalidate its queries and close, dropping the payload, so the
 * only place that information existed was a server log.
 *
 * Extraction is separated from display so the shape-tolerance can be tested
 * without a DOM: responses are typed as loose API entities at the call sites,
 * and the same helper has to cope with `warning: string`, `warnings: string[]`
 * and a mixed array from batch endpoints.
 */

import { notifications } from "@mantine/notifications";

/** Cap on warnings rendered in one notification body. */
export const MAX_WARNING_ITEMS = 20;
/** Cap on the rendered body length, applied after the item cap. */
export const MAX_WARNING_CHARS = 2_000;

function pushWarning(into: string[], value: unknown): void {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) into.push(trimmed);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) pushWarning(into, item);
	}
}

/**
 * Collect the warnings carried by a mutation result.
 *
 * Accepts both the singular `warning` (merge, unmerge) and plural `warnings`
 * (fork, split) fields, in that order, and de-duplicates: an unmerge joins its
 * own warnings into one string, and a batch caller may pass several results
 * whose warnings coincide.
 */
export function extractWarnings(result: unknown): string[] {
	if (!result || typeof result !== "object") return [];
	const record = result as Record<string, unknown>;
	const collected: string[] = [];
	pushWarning(collected, record.warning);
	pushWarning(collected, record.warnings);
	return [...new Set(collected)];
}

/**
 * Render a list of warnings as a notification body.
 *
 * Bounded on both item count and characters: warnings quote server-side detail
 * (paths, git errors, snapshot ids) whose length is not under frontend control,
 * and an unbounded body would push the notification past the viewport and hide
 * the earlier — usually more important — entries.
 */
export function formatWarningList(warnings: string[]): string {
	const shown = warnings.slice(0, MAX_WARNING_ITEMS);
	const omitted = warnings.length - shown.length;
	let body = shown.join("\n");
	if (body.length > MAX_WARNING_CHARS) body = `${body.slice(0, MAX_WARNING_CHARS)}…`;
	return omitted > 0 ? `${body}\n… +${omitted}` : body;
}

/**
 * Show warnings from a successful operation, or do nothing when there are none.
 *
 * `autoClose: false` is deliberate and applies to every caller: each of these
 * warnings describes state left behind on disk or work that did not survive an
 * operation, so it has to stay until dismissed rather than expire while the user
 * is looking elsewhere.
 */
export function showOperationWarnings(title: string, warnings: string[]): boolean {
	if (warnings.length === 0) return false;
	notifications.show({
		color: "yellow",
		title,
		message: formatWarningList(warnings),
		autoClose: false,
	});
	return true;
}

/** Show the warnings a mutation result carries, if any. Returns whether it showed one. */
export function notifyResultWarnings(title: string, result: unknown): boolean {
	return showOperationWarnings(title, extractWarnings(result));
}

/**
 * Pull the `skipped` chapter ids out of a batch cleanup report.
 *
 * The report names skipped chapters by id only, so resolving them to titles is
 * the caller's job — it holds the list the user selected from.
 */
export function extractSkippedIds(result: unknown): string[] {
	if (!result || typeof result !== "object") return [];
	const skipped = (result as Record<string, unknown>).skipped;
	if (!Array.isArray(skipped)) return [];
	return skipped.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/** Pull `errors: [{ chapterId, error }]` out of a batch cleanup report. */
export function extractCleanupErrors(result: unknown): Array<{ chapterId: string; error: string }> {
	if (!result || typeof result !== "object") return [];
	const errors = (result as Record<string, unknown>).errors;
	if (!Array.isArray(errors)) return [];
	const out: Array<{ chapterId: string; error: string }> = [];
	for (const entry of errors) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.chapterId !== "string") continue;
		out.push({
			chapterId: record.chapterId,
			error: typeof record.error === "string" ? record.error : "",
		});
	}
	return out;
}
