/**
 * subagent-tool-summary.ts — the tiny INPUT PROJECTION behind a subagent card's
 * "recent calls" rows.
 *
 * WHY THIS EXISTS
 * A child tool call's row used to show only the bare tool name (`Bash`, `Read`),
 * because the activity query deliberately does NOT select `input_json`: for
 * Write/Edit that column can hold an entire file (observed max 180KB in a real
 * 835k-row table), and CLAUDE.md forbids reading big fields on list/summary
 * paths.
 *
 * The fix is not "select the column after all" — it is to project a handful of
 * SHORT, whitelisted keys out of the JSON inside SQLite, so the big field never
 * crosses into JS. Each projected value is capped at
 * {@link MAX_SUBAGENT_SUMMARY_VALUE_CHARS} and the whole projection is skipped for
 * pathologically large blobs ({@link MAX_SUBAGENT_SUMMARY_INPUT_BYTES}).
 *
 * KEYS KEEP THEIR ORIGINAL INPUT NAMES (`file_path`, not `filePath`) ON PURPOSE.
 * This object is a *partial tool input*, not a new DTO: the frontend feeds it
 * straight back into `getSummary(toolName, input)` — the same formatter the main
 * tool card uses. Renaming the keys would force a translation layer and let the
 * row's wording drift from the card's. Verified on partial inputs: `Read` with
 * only `file_path` renders `component.tsx` (no phantom line range), `Bash`
 * without `description` falls back to `command`.
 */

/**
 * Whitelisted input keys, chosen to cover every tool whose row is worth
 * labelling while keeping the payload small (10 keys × 200 chars worst case).
 *
 * Deliberately omitted: `path`/`glob` (only decorate a search summary with
 * `in <dir>`), `wait_for_text`, `task_id`, and anything nested such as
 * `questions[0].header` — a nested read would need `json_each`, i.e. an unbounded
 * walk over the payload this module exists to avoid touching.
 */
export const SUBAGENT_SUMMARY_INPUT_KEYS = [
	"description",
	"file_path",
	"command",
	"id",
	"type",
	"pattern",
	"url",
	"mode",
	"query",
	"subagent_type",
] as const;

export type SubagentSummaryInputKey = (typeof SUBAGENT_SUMMARY_INPUT_KEYS)[number];

/**
 * A projected partial tool input. Every value is already length-capped; absent
 * keys mean "not present in the original input" (or "suppressed by the size
 * guard"), never "empty string".
 */
export type SubagentToolInputSummary = Partial<Record<SubagentSummaryInputKey, string>>;

/**
 * Per-value character cap.
 *
 * 200 leaves headroom above `getSummary`'s own 80-char truncation (so the
 * formatter, not the transport, decides the visible length) while bounding a
 * pathological multi-KB `description`.
 */
export const MAX_SUBAGENT_SUMMARY_VALUE_CHARS = 200;

/**
 * Byte ceiling on `input_json` before the projection is skipped entirely.
 *
 * Sized from real data rather than guessed: the largest `input_json` in an
 * 835,709-row table was 180KB (a big-file `Write`), and only 112 rows (0.013%)
 * exceeded 32KB. A 32KB cap would therefore have nulled the summary for exactly
 * the case the feature is for — a large file edit, where `file_path` is the one
 * thing worth showing. 256KB lets all observed real payloads through while still
 * bounding the JSON parse for a pathological multi-megabyte blob.
 */
export const MAX_SUBAGENT_SUMMARY_INPUT_BYTES = 262_144;

/**
 * Build the SQL expression that projects the whitelisted keys out of a JSON
 * column into a single JSON object string.
 *
 * Lives here, next to the keys and caps it enforces, so the query and any test
 * that inspects the raw projection share ONE definition — a copy in a test could
 * keep passing while the production expression drifted.
 *
 * Two guards precede the extract, both load-bearing:
 *  - `json_valid`: without it a single malformed row raises "malformed JSON" and
 *    aborts the ENTIRE statement, blanking every card's activity list.
 *  - `octet_length`: bounds the parse for a pathological blob.
 *
 * @param column SQL text for the JSON column (already quoted/qualified).
 */
export function buildSubagentSummarySqlExpr(column: string): string {
	const pairs = SUBAGENT_SUMMARY_INPUT_KEYS.map(
		(key) =>
			`'${key}', substr(json_extract(${column}, '$.${key}'), 1, ${MAX_SUBAGENT_SUMMARY_VALUE_CHARS})`,
	).join(", ");
	return `CASE WHEN ${column} IS NOT NULL
		AND octet_length(${column}) <= ${MAX_SUBAGENT_SUMMARY_INPUT_BYTES}
		AND json_valid(${column})
	THEN json_object(${pairs}) END`;
}

function capValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= MAX_SUBAGENT_SUMMARY_VALUE_CHARS) return trimmed;
	return trimmed.slice(0, MAX_SUBAGENT_SUMMARY_VALUE_CHARS);
}

/**
 * Read one whitelisted key as a short display string.
 *
 * Numbers/booleans are stringified (an `id` may arrive as a number); objects and
 * arrays are rejected rather than stringified, because a `{_truncated}` leaf or a
 * `Send` target array would serialize into noise that `getSummary` cannot format.
 */
function readSummaryValue(value: unknown): string | undefined {
	if (typeof value === "string") return capValue(value) || undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	return undefined;
}

/**
 * Project a full tool input down to the whitelisted short keys.
 *
 * Only the whitelisted keys are ever touched, so a 2MB `content` field costs
 * nothing here — this is what makes the function safe to call on the WS hot path
 * where the complete input is already in memory.
 */
export function projectSubagentToolInputSummary(input: unknown): SubagentToolInputSummary | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	const summary: SubagentToolInputSummary = {};
	for (const key of SUBAGENT_SUMMARY_INPUT_KEYS) {
		const value = readSummaryValue(record[key]);
		if (value !== undefined) summary[key] = value;
	}
	return hasSubagentToolInputSummary(summary) ? summary : null;
}

/**
 * Normalize an untrusted summary (SQL row projection or WS payload) into the
 * canonical shape, dropping unknown keys and re-applying the value cap.
 */
export function normalizeSubagentToolInputSummary(raw: unknown): SubagentToolInputSummary | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const summary: SubagentToolInputSummary = {};
	for (const key of SUBAGENT_SUMMARY_INPUT_KEYS) {
		const value = readSummaryValue(record[key]);
		if (value !== undefined) summary[key] = value;
	}
	return hasSubagentToolInputSummary(summary) ? summary : null;
}

/** Whether a projection carries anything worth rendering. */
export function hasSubagentToolInputSummary(
	summary: SubagentToolInputSummary | null | undefined,
): boolean {
	if (!summary) return false;
	for (const key of SUBAGENT_SUMMARY_INPUT_KEYS) {
		if (summary[key]) return true;
	}
	return false;
}

/**
 * Rebuild the partial tool input that `getSummary` consumes.
 *
 * Returns a plain object with the original input key names, which is exactly what
 * the formatter expects — no per-tool translation table to keep in sync.
 */
export function subagentSummaryToPartialInput(
	summary: SubagentToolInputSummary | null | undefined,
): Record<string, string> {
	const input: Record<string, string> = {};
	if (!summary) return input;
	for (const key of SUBAGENT_SUMMARY_INPUT_KEYS) {
		const value = summary[key];
		if (value) input[key] = value;
	}
	return input;
}
