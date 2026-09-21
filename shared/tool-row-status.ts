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

/**
 * Lifecycle phases a live tool status can occupy, ordered.
 *
 * Used to stop a late snapshot / upsert / reconnect catch-up from moving a tool
 * BACKWARDS after the client already observed a later phase. Without this, a
 * `message` upsert that still carries `running` overwrites a live-patched
 * `success`, and the spinner stays on the previous call until the next
 * structural reload — the "status lags by one tool call" symptom.
 *
 * `pending` shares rank 1 with `initializing`: it is a sibling outcome of the
 * permission gate ("waiting on a human"), not a later phase, and events that
 * set it are authoritative in their own right.
 *
 * Unknown statuses are absent on purpose: refusing them would freeze a card on
 * a state this frontend cannot spell.
 */
export const LIVE_TOOL_PHASE_RANK: Readonly<Record<string, number>> = {
	streaming: 0,
	initializing: 1,
	pending: 1,
	running: 2,
	// Anything terminal outranks everything: a completed tool must never reopen.
	success: 3,
	completed: 3,
	fail: 3,
	failed: 3,
	error: 3,
	cancelled: 3,
	canceled: 3,
	aborted: 3,
	denied: 3,
	timeout: 3,
};

/**
 * Whether moving from `existing` to `incoming` would take a tool BACKWARDS.
 *
 * Unknown statuses never count as a regression: refusing an unrecognised status
 * would silently freeze a card on a state this frontend does not understand.
 */
export function isLiveToolStatusRegression(existing: unknown, incoming: unknown): boolean {
	if (typeof existing !== "string" || typeof incoming !== "string") return false;
	const existingRank = LIVE_TOOL_PHASE_RANK[existing];
	const incomingRank = LIVE_TOOL_PHASE_RANK[incoming];
	if (existingRank === undefined || incomingRank === undefined) return false;
	return existingRank > incomingRank;
}

/** Loose shape of a tool lifecycle record (status + painted evidence + extras). */
export type ToolLifecycleRecord = {
	status?: unknown;
	durationMs?: unknown;
	outputJson?: unknown;
	startedAt?: unknown;
	completedAt?: unknown;
	errorMessage?: unknown;
	permissionDenyMessage?: unknown;
	_metadata?: unknown;
	/**
	 * Which attempt at this call the record describes (`allow-retry` inserts a new
	 * row with a higher number). Absent on live streaming entries and legacy rows.
	 */
	executionAttempt?: unknown;
	[key: string]: unknown;
};

/**
 * Fields that are EVIDENCE OF AN OUTCOME rather than description of the call.
 *
 * They belong to the status that produced them, which is what makes them special
 * in both directions: a stale in-flight snapshot must not erase them, and a NEW
 * attempt must not inherit them.
 */
const LIFECYCLE_EVIDENCE_KEYS = [
	"durationMs",
	"outputJson",
	"startedAt",
	"completedAt",
	"errorMessage",
	"permissionDenyMessage",
	"_metadata",
] as const;

/**
 * Read a tool record's execution attempt, or null when it carries none.
 *
 * Legacy rows and live streaming entries have no attempt number; absence must be
 * treated as "unknown", never as attempt 0, or every un-numbered snapshot would
 * look like an older attempt than a numbered one.
 */
function executionAttemptOf(record: ToolLifecycleRecord): number | null {
	const value = record.executionAttempt;
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Whether `incoming` describes a NEWER execution attempt of the same call.
 *
 * `allow-retry` inserts a fresh `narrator_tool_calls` row with a higher
 * `executionAttempt`, `status: "initializing"` and every result column cleared,
 * then that row is projected onto the same `tool_use` block. Judged as a plain
 * status move that is `fail → initializing`: a regression. Judged as a new
 * attempt, it is the authoritative present state.
 */
function isNewerExecutionAttempt(previous: ToolLifecycleRecord, incoming: ToolLifecycleRecord) {
	const previousAttempt = executionAttemptOf(previous);
	const incomingAttempt = executionAttemptOf(incoming);
	if (previousAttempt === null || incomingAttempt === null) return false;
	return incomingAttempt > previousAttempt;
}

/**
 * Merge one tool lifecycle record over another without allowing a status
 * regression to erase later evidence (duration, output, terminal stamps).
 *
 * `previous` is the already-loaded / live-patched side; `incoming` is a
 * snapshot that may be older (catch-up replay, projection upsert, message
 * published before `tool_completed` landed).
 *
 * ⚠️ A RETRY IS NOT A REGRESSION. When `incoming` carries a higher
 * `executionAttempt` it is a new attempt at the same call, not a stale view of the
 * old one: its cleared duration/output/stamps ARE the current truth, and
 * preserving the previous attempt's evidence would leave the user looking at the
 * failure they just asked to retry. Only same-attempt (or unknown-attempt) moves
 * are subject to the regression guard.
 */
export function mergeToolLifecycleRecord<
	P extends ToolLifecycleRecord,
	I extends ToolLifecycleRecord,
>(previous: P | undefined, incoming: I | undefined): P & I {
	if (!previous) return incoming as P & I;
	if (!incoming) return previous as P & I;
	if (isNewerExecutionAttempt(previous, incoming)) {
		// Descriptive fields (toolName, inputJson, ids) may legitimately be missing from
		// a sparse projection and are inherited. OUTCOME fields are not: the retry row
		// cleared them on purpose, and inheriting them is what made a retry look like it
		// had never happened.
		const retry = { ...previous, ...incoming } as Record<string, unknown>;
		for (const key of LIFECYCLE_EVIDENCE_KEYS) {
			if (!(key in incoming)) delete retry[key];
		}
		return retry as P & I;
	}
	const regression = isLiveToolStatusRegression(previous.status, incoming.status);
	const incomingStatusMissing = incoming.status == null || incoming.status === "";
	const keepPreviousStatus = regression || incomingStatusMissing;
	const merged = { ...incoming } as Record<string, unknown>;
	if (keepPreviousStatus && previous.status != null) merged.status = previous.status;
	// Terminal evidence belongs to the status that produced it. A stale `running`
	// snapshot must not drop the duration/output the live `success` already wrote.
	for (const key of LIFECYCLE_EVIDENCE_KEYS) {
		const incomingValue = incoming[key];
		const previousValue = previous[key];
		if (regression) {
			if (previousValue !== undefined) merged[key] = previousValue;
			continue;
		}
		if (incomingValue === undefined && previousValue !== undefined) {
			merged[key] = previousValue;
		}
	}
	return merged as P & I;
}
