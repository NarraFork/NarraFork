/**
 * Shared PostgreSQL error factories for the write-path tests.
 *
 * Lives in `__tests__/` on purpose: it is test-only code, and that directory is the one the
 * dialect inventory guard exempts, so a factory here can never be mistaken for production-shaped
 * database access.
 */

/** node-pg / postgres.js shape: an `Error` whose `code` field IS the SQLSTATE. */
export function bunPgError(code: string, message: string): Error {
	return Object.assign(new Error(message), {
		name: "PostgresError",
		code,
		severity: "ERROR",
		detail: "Key (id)=(abc) already exists.",
		constraint: "widgets_pkey",
	});
}

/** node-pg shape: an `Error` with the same `code` field, fewer extras. */
export function nodePgError(code: string, message: string): Error {
	return Object.assign(new Error(message), {
		code,
		severity: "ERROR",
		routine: "_bt_check_unique",
	});
}

/**
 * The VERIFIED Bun SQL shape (Bun 1.4.2 against a real PostgreSQL 17): the SQLSTATE
 * lives in `errno`, while `code` carries Bun's own identity. A classifier that reads
 * only `code` calls every real Bun driver error "unrecognized" — which is how the
 * registration write path's 23505 translation failed until the real-container run
 * caught it. `sqlstate` here is the server's code (e.g. "23505").
 */
export function bunSqlError(sqlstate: string, message: string): Error {
	return Object.assign(new Error(message), {
		name: "PostgresError",
		code: "ERR_POSTGRES_SERVER_ERROR",
		errno: sqlstate,
		severity: "ERROR",
		detail: "Key (id)=(abc) already exists.",
		constraint: "widgets_pkey",
	});
}

/** Drizzle's transaction abort path: wrapper message, driver error on `cause`. */
export function drizzleWrap(inner: unknown): Error {
	return Object.assign(new Error("Failed query: INSERT INTO widgets …"), {
		name: "DrizzleError",
		cause: inner,
	});
}
