/**
 * tool-display-duration.ts — WHICH number a tool call shows as "how long it took".
 *
 * A finished call has TWO defensible durations, and the difference is not small:
 *
 *   `durationMs`     — the whole span the loop attributes to this call. For a tool
 *                      with a `streamStartedAt` it is `now - streamStartedAt` minus
 *                      the execution time of preceding tools in the turn (see
 *                      `loop.ts`'s tool_result branch). So it INCLUDES the time the
 *                      call spent waiting on a permission gate, a reflection gate,
 *                      or simply queued behind an earlier sibling.
 *   `execDurationMs` — the tool's own `execute()` span, stashed in
 *                      `_metadata.execDurationMs` whenever the two differ.
 *
 * For bash the gap is routinely 10-20x: a `git diff` that runs in 1.2s but sat
 * behind a danger-reflection gate for 19s reports 20s. "20s" next to a shell
 * command reads as a slow command, which sends the reader looking for a
 * performance problem that does not exist. The waiting is real and worth seeing —
 * it lives in the timing popover's phase breakdown, where it is labelled as
 * waiting rather than silently folded into one figure.
 *
 * ⚠️ WHY THIS IS A SHARED MODULE. The rule used to be an inline ternary inside
 * `measure-tool-call.ts`, so only the expanded CARD applied it. The folded trace
 * row painted raw `durationMs`, and one call therefore reported two different
 * durations depending on the LOD the reader happened to be at — the card said 1s
 * and the row beside it said 20s. One function, two call sites.
 *
 * Pure + framework-free.
 */

/**
 * Tool categories whose `durationMs` is known to absorb waiting time.
 *
 * Restricted to `bash` deliberately, matching the chunked card's original
 * `getBashExecDurationMs`: bash is where the two figures diverge by enough to
 * mislead, and it is the category whose `execDurationMs` is reliably written.
 * Widening this is a behaviour change for every other tool's displayed duration,
 * so it should be a deliberate decision with its own evidence, not a side effect.
 */
const EXEC_DURATION_PREFERRED_CATEGORIES: ReadonlySet<string> = new Set(["bash"]);

/**
 * The duration to PAINT for a tool call, or null when none is known.
 *
 * Callers pass the raw fields; the precedence is:
 *   1. `execDurationMs`, for a category where it is the honest figure;
 *   2. `durationMs`, the full attributed span;
 *   3. null — no duration at all. Never 0: a fabricated "0ms" reads as a real
 *      measurement of an instant call.
 *
 * The lifecycle stamps are untouched by this: the popover's "Total" still reports
 * the complete span, because that is what it claims to report.
 */
export function resolveToolDisplayDurationMs(source: {
	category?: string | null;
	execDurationMs?: number | null;
	durationMs?: number | null;
}): number | null {
	const preferExec =
		source.category != null && EXEC_DURATION_PREFERRED_CATEGORIES.has(source.category);
	if (preferExec && source.execDurationMs != null) return source.execDurationMs;
	return source.durationMs ?? null;
}
