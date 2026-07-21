import { z } from "zod/v4";

/**
 * Shared numeric-parameter handling for agent tools.
 *
 * Models occasionally emit slightly-off numeric arguments: floats where an
 * integer is expected, string-encoded numbers ("100"), values outside the
 * documented range, or 0/negative sentinels. Rather than hard-failing schema
 * validation (which wastes a whole turn), tools should accept these inputs
 * leniently and normalize them at execution time.
 *
 * `looseNumber` provides the permissive schema; `normalizeNumber` applies the
 * per-parameter range/rounding at runtime.
 */

/**
 * Permissive optional-number schema. Accepts string-encoded numbers and floats
 * via coercion. Deliberately omits `.int()/.min()/.max()` so that out-of-range
 * or non-integer inputs do not fail validation — clamping is done in
 * `normalizeNumber` at execution time instead.
 *
 * `z.coerce.number()` is still a `ZodNumber`, so the derived JSON Schema stays
 * `{ type: "number" }` for tools that rely on Zod→JSON-Schema conversion.
 */
export function looseNumber(describe?: string) {
	const schema = z.coerce.number().optional();
	return describe ? schema.describe(describe) : schema;
}

export interface NormalizeNumberOptions {
	/** Lower bound (inclusive). Applied after rounding, skipped for the sentinel. */
	min?: number;
	/** Upper bound (inclusive). Applied after rounding, skipped for the sentinel. */
	max?: number;
	/** Round to the nearest integer. Defaults to true. */
	integer?: boolean;
	/**
	 * A special value that, when matched (after rounding), is returned as-is
	 * and bypasses min/max clamping (e.g. read.limit uses -1 for "read all").
	 */
	sentinel?: number;
	/** Value returned when the input is missing or not a finite number. */
	fallback?: number;
}

/**
 * Normalize a raw numeric tool argument into a sane value.
 *
 * - Non-finite / unparseable input → `fallback` (default undefined).
 * - Rounds to an integer unless `integer: false`.
 * - Returns `sentinel` untouched (no clamping) when matched.
 * - Otherwise clamps to `[min, max]` when those bounds are provided.
 */
export function normalizeNumber(
	raw: unknown,
	opts: NormalizeNumberOptions = {},
): number | undefined {
	const { min, max, integer = true, sentinel, fallback } = opts;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;

	let value = integer ? Math.round(n) : n;
	if (sentinel != null && value === sentinel) return sentinel;

	if (min != null) value = Math.max(min, value);
	if (max != null) value = Math.min(max, value);
	return value;
}
