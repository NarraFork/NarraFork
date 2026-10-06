/**
 * Explicit, write-path backend intent. This module only selects a label; it never opens a
 * connection and must not be used for reads, migrations, FTS5, or project archives.
 *
 * WHY A SEPARATE SELECTOR FROM `read-selector.ts`
 * -----------------------------------------------
 * The parsing rules are deliberately IDENTICAL to the read side — fail-closed, only the exact
 * explicit value `postgres` selects PostgreSQL — but the two selections are made separately so
 * that a mismatch can be DETECTED rather than assumed away. One process must read and write the
 * same database: a read adapter on SQLite paired with a write path on PostgreSQL would split the
 * deployment into two stores that silently disagree. {@link assertWriteBackendMatchesRead} is the
 * check that makes that split a loud startup error instead of a quiet data fork.
 */

import type { ReadBackendSelection } from "./read-selector";

export type WriteBackendId = "sqlite" | "postgres";

export interface WriteBackendSelection {
	readonly backend: WriteBackendId;
	readonly write: true;
}

export interface WriteBackendAvailability {
	/** Injected by the future PostgreSQL write adapter; no probing happens here. */
	readonly postgresAvailable?: boolean;
}

const SQLITE_ALIASES = new Set(["sqlite", "sqlite3", "bun-sqlite"]);

/**
 * Parse untrusted configuration fail-closed. Only the exact, explicit value `postgres` selects
 * PostgreSQL; absent, empty, aliases, unknown, and mixed-case values remain SQLite.
 *
 * Selecting PostgreSQL while it is unavailable is an ERROR, never a silent fallback: a write
 * path that quietly lands on a different database than the operator configured is exactly the
 * read/write split this module exists to forbid.
 */
export function selectWriteBackend(
	value: unknown,
	availability: WriteBackendAvailability = {},
): WriteBackendSelection {
	const normalized = typeof value === "string" ? value : "";
	if (normalized === "postgres") {
		if (availability.postgresAvailable === false) {
			throw new Error("PostgreSQL write backend is explicitly selected but unavailable");
		}
		return { backend: "postgres", write: true };
	}
	if (SQLITE_ALIASES.has(normalized) || normalized === "") {
		return { backend: "sqlite", write: true };
	}
	return { backend: "sqlite", write: true };
}

/**
 * The one-database rule, enforced at the point both selections exist.
 *
 * This is a startup-time wiring check, not a per-request branch: call it once where the read
 * adapter and the write path are composed, and let the process refuse to boot on a mismatch.
 */
export function assertWriteBackendMatchesRead(
	write: WriteBackendSelection,
	read: ReadBackendSelection,
): void {
	if (write.backend !== read.backend) {
		throw new Error(
			`Write backend "${write.backend}" does not match read backend "${read.backend}": ` +
				"one process must read and write the same database",
		);
	}
}
