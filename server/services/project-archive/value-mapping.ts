/**
 * The value mapping between a main database and the portable archive, shared by
 * every main-store backend.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * These functions used to live in `sqlite-main-store.ts`, which imports the SQLite
 * handle — a module the PostgreSQL main store must never load. The mapping itself is
 * dialect-free: it speaks column TYPE NAMES (`SQLiteBoolean` / `PgBoolean`) and
 * archive values, nothing else. Keeping it here is what lets both stores agree on
 * the archive's on-disk types byte for byte.
 *
 * THE RULES (unchanged from the pre-split implementation)
 * -------------------------------------------------------
 * `toArchiveValue` — main → archive:
 *
 *   - JSON columns. Drizzle PARSES on read (`{ mode: "json" }` on SQLite, the
 *     `jsonText` codec on PostgreSQL), so an object arrives as an object and the
 *     archive's TEXT column needs it re-serialized. A value that is already a
 *     string passes through unchanged — `narrators.substatus` is a plain TEXT
 *     column holding JSON text, and stringifying it again would store `"\"[]\""`.
 *   - Booleans. The archive column is INTEGER 0/1; the conversion is explicit so
 *     the archive's on-disk type is the format's, not the driver's coercion.
 *   - `undefined` becomes `null`: absent and null are the same fact in the archive,
 *     and keeping `undefined` would let it reach a binding array as a hole.
 *
 * `toMainValue` — archive → main, the inverse:
 *
 *   - Boolean columns (`SQLiteBoolean` / `PgBoolean`) get a real coercion: a number
 *     is truthy-tested, a textual "0"/"1"/"true"/"false" from a hand-edited archive
 *     is parsed. SQLite stores the 0/1; PostgreSQL gets an actual boolean — each
 *     backend the shape its column expects, both from the same archive byte.
 *   - JSON columns need no inverse: the archive holds TEXT and the main column is
 *     TEXT on both backends (the PG `jsonText` codec is bypassed by the raw
 *     bindings, so the stored text is exactly the archive's text).
 */

import type { ArchiveValue } from "./main-store";

/** Flatten one main-database value to something the portable file can hold. */
export function toArchiveValue(value: unknown): ArchiveValue {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "string" || typeof value === "number") return value;
	if (value instanceof Date) return value.toISOString();
	return JSON.stringify(value);
}

/**
 * Coerce an archive value to what the main-database column expects, keyed on the
 * column's TYPE NAME so the function never touches a dialect's column class.
 */
export function toMainValue(column: { columnType: string }, value: ArchiveValue): ArchiveValue {
	if (value === null) return null;
	if (column.columnType === "SQLiteBoolean") {
		if (typeof value === "boolean") return value ? 1 : 0;
		if (typeof value === "number") return value === 0 ? 0 : 1;
		// A textual "0"/"1"/"true"/"false" from a hand-edited archive.
		return value === "0" || value.toLowerCase() === "false" ? 0 : 1;
	}
	if (column.columnType === "PgBoolean") {
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value !== 0;
		return !(value === "0" || value.toLowerCase() === "false");
	}
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}
