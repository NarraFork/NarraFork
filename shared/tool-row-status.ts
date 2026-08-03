/**
 * tool-row-status.ts — which status a COMPACT ROW marks, and with what.
 *
 * A compact row is the one-line form a tool call takes in a fold: a low-LOD trace
 * row and a subagent card's recent-call row. Both render paths (the chunk
 * `CollapsibleTrace` and the vlist `RenderToolRun` / `RenderSubagent`) ask this
 * module, so the rule has ONE definition — two copies of it is exactly how the
 * recent-call row once ended up hard-coding a grey check while the trace row showed
 * nothing at all.
 *
 * ── WHY SUCCESS IS UNMARKED ───────────────────────────────────────────────────
 * Success is the default expectation, so a column of green checks carries no
 * information — it is the same glyph on almost every row, and it costs the reader
 * exactly the attention that a genuine failure needs. Rows therefore mark only
 * DEVIATION: still running, failed, or cancelled. A row that simply worked says so
 * by having nothing to say.
 *
 * This is deliberately NOT what a tool CARD header does: a card shows one call at a
 * time, so its check is a positive confirmation rather than one entry in a column.
 * The divergence is the point — do not "fix" the row back into agreement with the
 * header.
 *
 * Pure + framework-free: it returns a MARK KIND, and each render layer maps that to
 * its own icon set (the two layers cannot share components — vlist must not import
 * the chunk render path).
 */

/**
 * Statuses that mean "this call is still going".
 *
 * ENUMERATED rather than derived as "everything that is not terminal", which is the
 * safer direction for the unknown case. The two render paths used to disagree here:
 * the chunk `StatusIcon` drew nothing for a status it had never heard of, while the
 * vlist glyph spun for it. Spinning is the worse guess — a finished call whose status
 * this frontend cannot spell would spin FOREVER, an active claim that never resolves,
 * whereas drawing nothing merely admits we do not know.
 *
 * `streaming` is the first status a live call has (from `tool_use_chunk`, while the
 * model is still writing the arguments), so it belongs here or a brand-new row reads
 * as idle.
 */
export const IN_FLIGHT_TOOL_ROW_STATUSES: ReadonlySet<string> = new Set([
	"streaming",
	"running",
	"pending",
	"initializing",
]);

/**
 * Statuses that mean "finished", by outcome.
 *
 * Kept as an explicit set (rather than "not in flight") so an unrecognised status is
 * in NEITHER set and therefore gets no mark and no spinner.
 */
export const TERMINAL_TOOL_ROW_STATUSES: ReadonlySet<string> = new Set([
	"success",
	"completed",
	"fail",
	"failed",
	"error",
	"cancelled",
	"canceled",
	"aborted",
	"denied",
	"timeout",
]);

/**
 * Whether a row's status means "no longer running".
 *
 * Everything except a KNOWN in-flight status counts as terminal, so an absent, empty
 * or unrecognised status stops the elapsed counter instead of running it forever.
 */
export function isTerminalToolRowStatus(status: string | null | undefined): boolean {
	if (status == null || status === "") return true;
	return !IN_FLIGHT_TOOL_ROW_STATUSES.has(status);
}

/**
 * The mark a row draws for its status, or `null` for "draw nothing".
 *
 * `null` covers three genuinely different cases that all deserve silence:
 *  - SUCCESS — the default expectation (see the file header);
 *  - an unrecognised or empty status — a mark would be a guess;
 *  - no status at all (a reasoning step) — the row has no lifecycle.
 *
 * Callers must not reserve slot width when this returns null; a blank 12px gap on
 * every successful row is the same visual noise as the check it replaced.
 */
export type ToolRowStatusMark = "running" | "failed" | "cancelled";

export function resolveToolRowStatusMark(
	status: string | null | undefined,
): ToolRowStatusMark | null {
	if (status == null || status === "") return null;
	if (IN_FLIGHT_TOOL_ROW_STATUSES.has(status)) return "running";
	// Not in flight and not a status we recognise → no mark. Guessing "done" here is
	// what would put a green check (or a spinner) on a state nobody has interpreted.
	if (!TERMINAL_TOOL_ROW_STATUSES.has(status)) return null;
	if (status === "fail" || status === "failed" || status === "error" || status === "timeout") {
		return "failed";
	}
	if (
		status === "cancelled" ||
		status === "canceled" ||
		status === "aborted" ||
		status === "denied"
	) {
		return "cancelled";
	}
	// success / completed — deliberately unmarked.
	return null;
}

/** Whether this status draws a mark at all (i.e. whether to render a slot). */
export function hasToolRowStatusMark(status: string | null | undefined): boolean {
	return resolveToolRowStatusMark(status) !== null;
}
