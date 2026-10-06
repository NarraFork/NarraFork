/**
 * Opaque keyset cursor for the global execution log.
 *
 * `startedAt` is `narrator_tool_calls.started_at` (the generated fallback chain),
 * paired with `id` so rows sharing a timestamp still have a total order. Kept
 * opaque so the pagination key can change without breaking stored links, and
 * length-bounded so a hostile value cannot make decoding expensive.
 */
export interface ExecutionLogCursor {
	startedAt: string;
	id: string;
}

interface EncodedExecutionLogCursor extends ExecutionLogCursor {
	v: 1;
}

const MAX_CURSOR_LENGTH = 512;
const MAX_VALUE_LENGTH = 128;

/**
 * Accepts the ISO shapes actually present in this column.
 *
 * `started_at` falls back to `created_at`, and rows written by different code
 * paths over time carry either millisecond precision or none, so requiring
 * `.sssZ` (as the usage-history cursor does) would reject valid cursors for the
 * older half of the table.
 */
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isValidTimestamp(value: string): boolean {
	if (value.length > MAX_VALUE_LENGTH || !UTC_ISO_PATTERN.test(value)) return false;
	return Number.isFinite(Date.parse(value));
}

function isValidId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_VALUE_LENGTH;
}

export function encodeExecutionLogCursor(cursor: ExecutionLogCursor): string {
	if (!isValidTimestamp(cursor.startedAt) || !isValidId(cursor.id)) {
		throw new Error("Invalid execution log cursor");
	}
	const payload: EncodedExecutionLogCursor = { v: 1, ...cursor };
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeExecutionLogCursor(value: string | undefined): ExecutionLogCursor | null {
	if (!value || value.length > MAX_CURSOR_LENGTH) return null;

	try {
		const json = Buffer.from(value, "base64url").toString("utf8");
		const parsed = JSON.parse(json) as Partial<EncodedExecutionLogCursor>;
		if (
			parsed.v !== 1 ||
			typeof parsed.startedAt !== "string" ||
			typeof parsed.id !== "string" ||
			!isValidTimestamp(parsed.startedAt) ||
			!isValidId(parsed.id)
		) {
			return null;
		}
		return { startedAt: parsed.startedAt, id: parsed.id };
	} catch {
		return null;
	}
}
