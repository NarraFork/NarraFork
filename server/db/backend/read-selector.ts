/**
 * Explicit, read-only backend intent. This module only selects a label; it never opens a
 * connection and must not be used for writes, migrations, FTS5, or project archives.
 */
export type ReadBackendId = "sqlite" | "postgres";

export interface ReadBackendSelection {
	readonly backend: ReadBackendId;
	readonly readOnly: true;
}

export interface ReadBackendAvailability {
	/** Injected by the future PostgreSQL read adapter; no probing happens here. */
	readonly postgresAvailable?: boolean;
}

const SQLITE_ALIASES = new Set(["sqlite", "sqlite3", "bun-sqlite"]);

/**
 * Parse untrusted configuration fail-closed. Only the exact, explicit value `postgres` selects
 * PostgreSQL; absent, empty, aliases, unknown, and mixed-case values remain SQLite.
 */
export function selectReadBackend(
	value: unknown,
	availability: ReadBackendAvailability = {},
): ReadBackendSelection {
	const normalized = typeof value === "string" ? value : "";
	if (normalized === "postgres") {
		if (availability.postgresAvailable === false) {
			throw new Error("PostgreSQL read backend is explicitly selected but unavailable");
		}
		return { backend: "postgres", readOnly: true };
	}
	if (SQLITE_ALIASES.has(normalized) || normalized === "") {
		return { backend: "sqlite", readOnly: true };
	}
	return { backend: "sqlite", readOnly: true };
}
