/**
 * PostgreSQL error classification by SQLSTATE.
 *
 * WHY SQLSTATE AND NEVER THE MESSAGE
 * ----------------------------------
 * The human-readable message of a PostgreSQL error is localized, version-dependent, and wrapped
 * differently by every layer between the server and this process (Bun SQL, Drizzle, a transaction
 * helper). The SQLSTATE is the only stable identity an error has: five characters, defined by the
 * SQL standard and PostgreSQL's `errcodes.txt`, carried by every driver this project uses — but
 * NOT always under the same field name. node-pg and postgres.js expose it as `code`. Bun SQL
 * (verified against Bun 1.4.2 throwing for a real PostgreSQL 17) exposes it as `errno`, with
 * `code` carrying Bun's own error identity (`ERR_POSTGRES_SERVER_ERROR`) instead; `bun-types`
 * documents both fields on `PostgresError`. Drizzle forwards the driver error, sometimes nested
 * under `cause`. Classification therefore reads `code`, then `errno`, walking the `cause` chain —
 * and NOTHING else: a message that merely says "deadlock detected" without a SQLSTATE is
 * deliberately NOT retryable, and Bun's `ERR_*` code never matches the five-character pattern,
 * so it cannot be mistaken for a server verdict.
 *
 * THE THREE ANSWERS A WRITE PATH NEEDS
 * ------------------------------------
 *   retryable         The transaction failed through no fault of its content and may be replayed
 *                     WHOLE: serialization failure (40001), deadlock (40P01), lock not available
 *                     (55P03). Replaying anything else duplicates effects or hides a real bug.
 *   unique-violation  23505 — the write conflicts with a fact that already exists. This is NOT
 *                     an error to retry (replaying produces the same conflict forever) and NOT an
 *                     error to swallow: it is routed to the idempotency-aware path, which decides
 *                     whether "already exists" is the desired outcome. See `pg-retry.ts`.
 *   non-retryable / unrecognized  Everything else, including errors with no readable SQLSTATE.
 *                     Fail-closed: an error we cannot identify is never retried.
 */

export const PG_SERIALIZATION_FAILURE = "40001";
export const PG_DEADLOCK_DETECTED = "40P01";
export const PG_LOCK_NOT_AVAILABLE = "55P03";
export const PG_UNIQUE_VIOLATION = "23505";

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
	PG_SERIALIZATION_FAILURE,
	PG_DEADLOCK_DETECTED,
	PG_LOCK_NOT_AVAILABLE,
]);

/**
 * SQLSTATEs are five characters, digits and uppercase letters (PostgreSQL reports them
 * uppercase; e.g. `40P01`). Lowercase or padded values are NOT normalized — accepting them
 * silently would classify errors from a source whose shape nobody verified.
 */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * How deep `cause` chains are followed. Drizzle and transaction helpers wrap at most a level or
 * two; the bound exists so a cyclic `cause` (which some error helpers produce) terminates as
 * "unrecognized" instead of looping forever.
 */
const MAX_CAUSE_DEPTH = 8;

export type PgErrorKind = "retryable" | "unique-violation" | "non-retryable" | "unrecognized";

export interface PgErrorClassification {
	readonly kind: PgErrorKind;
	/** The SQLSTATE that produced the verdict, or null when none could be extracted. */
	readonly sqlstate: string | null;
}

/**
 * Extract the SQLSTATE from any driver/ORM error shape, or null when there is none.
 *
 * Only object `code` fields that match the SQLSTATE shape are read — Node system errors also
 * carry `code` (`ECONNREFUSED`, `ERR_*`), and none of those match the five-character pattern, so
 * a connection failure is correctly "unrecognized" rather than misclassified as a database
 * verdict it never received.
 */
export function extractSqlstate(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return null;
		const record = current as Record<string, unknown>;
		// node-pg / postgres.js shape first: `code` IS the SQLSTATE there. Bun SQL puts its
		// own identity in `code` (`ERR_POSTGRES_SERVER_ERROR`, which the pattern rejects)
		// and the server's SQLSTATE in `errno`, so the second read is what classifies real
		// Bun driver errors — without it EVERY Bun SQL error is "unrecognized".
		const code = record.code;
		if (typeof code === "string" && SQLSTATE_PATTERN.test(code)) return code;
		const errno = record.errno;
		if (typeof errno === "string" && SQLSTATE_PATTERN.test(errno)) return errno;
		current = record.cause;
	}
	return null;
}

/** Classify any thrown value. Unknown shapes classify as `unrecognized`, never as retryable. */
export function classifyPgError(error: unknown): PgErrorClassification {
	const sqlstate = extractSqlstate(error);
	if (sqlstate === null) return { kind: "unrecognized", sqlstate: null };
	if (sqlstate === PG_UNIQUE_VIOLATION) return { kind: "unique-violation", sqlstate };
	if (RETRYABLE_SQLSTATES.has(sqlstate)) return { kind: "retryable", sqlstate };
	return { kind: "non-retryable", sqlstate };
}

/** True only for 40001 / 40P01 / 55P03 — the errors whose transaction may be replayed whole. */
export function isRetryablePgError(error: unknown): boolean {
	return classifyPgError(error).kind === "retryable";
}

/**
 * True only for 23505. Kept separate from the retry decision ON PURPOSE: a unique violation is
 * information for the idempotency-aware caller, and must never be retried into a false success
 * by a generic retry loop.
 */
export function isPgUniqueViolation(error: unknown): boolean {
	return classifyPgError(error).kind === "unique-violation";
}
