/**
 * The one place that decides which backend serves the session/MFA loop.
 *
 * The choice follows the registration store's pattern, because the two are one deployment
 * decision: the untrusted value is parsed by `selectWriteBackend` (fail-closed — absent,
 * empty, aliased or unknown values all resolve to SQLite, and only the exact string
 * `postgres` selects PostgreSQL), then checked against the read selection by
 * `assertWriteBackendMatchesRead`, because one process must read and write the same
 * database. Both checks run where the store is composed, so a mismatch or an unavailable
 * PostgreSQL is a loud startup error, never a silent fork between two stores.
 *
 * The PostgreSQL stores are INJECTED, mirroring `registration/store.ts`: nothing here
 * opens a connection, and a process that never selects PostgreSQL never loads one. Tests
 * and the production composition root supply adapters built on their own handle through
 * `setAuthSessionStore` / `setAuthMfaStore`.
 *
 * The two stores resolve from the SAME configuration in one call (`resolveAuthStores`):
 * a deployment that could put the session gate on one engine and the MFA factors on
 * another would have split the login loop in two. Both bindings are `let` on purpose:
 * ESM live bindings let the setters swap the store for every importer without a
 * forwarding wrapper, while the defaults stay the very same objects the SQLite
 * implementations export.
 */
import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import type { AuthMfaStore } from "./mfa-store";
import type { AuthSessionStore } from "./session-store";
import { sqliteAuthMfaStore } from "./sqlite-mfa-store";
import { sqliteAuthSessionStore } from "./sqlite-session-store";

/**
 * Both stores the auth loop needs, resolved together — the pure core of the wiring,
 * exported so the selection rules are testable without re-importing modules under
 * different environments.
 *
 * `injected` is the only way PostgreSQL becomes reachable: the selector requires it
 * (`postgresAvailable: false` makes an explicit `postgres` selection throw), and the
 * resolved stores ARE the injected ones. Fail-closed in both directions: no knob steers
 * the auth loop to a second backend by accident, and an explicit selection with no
 * adapter to serve it is an error, not a fallback.
 */
export function resolveAuthStores(
	config: { writeBackend?: unknown; readBackend?: unknown },
	injected: { session: AuthSessionStore; mfa: AuthMfaStore } | undefined,
): { session: AuthSessionStore; mfa: AuthMfaStore } {
	const write = selectWriteBackend(config.writeBackend, {
		postgresAvailable: injected !== undefined,
	});
	assertWriteBackendMatchesRead(write, selectReadBackend(config.readBackend));
	if (write.backend === "postgres") {
		if (!injected) {
			// Unreachable through the selector today (availability already threw), kept as the
			// invariant made explicit: selecting PostgreSQL without stores is never a fallback.
			throw new Error("PostgreSQL auth write backend selected but no stores are available");
		}
		return injected;
	}
	return { session: sqliteAuthSessionStore, mfa: sqliteAuthMfaStore };
}

/** The stores resolved from the process environment at module load. */
const initialAuthStores = resolveAuthStores(
	{ writeBackend: process.env.NF_WRITE_BACKEND, readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let authSessionStore: AuthSessionStore = initialAuthStores.session;
export let authMfaStore: AuthMfaStore = initialAuthStores.mfa;

/**
 * Swap the stores every importer sees (test seam and the composition root). `undefined`
 * restores the environment-resolved defaults. The pair is set together for the same
 * reason it is resolved together: half a swap is a split loop.
 */
export function setAuthStores(
	stores: { session: AuthSessionStore; mfa: AuthMfaStore } | undefined,
): void {
	authSessionStore = stores?.session ?? initialAuthStores.session;
	authMfaStore = stores?.mfa ?? initialAuthStores.mfa;
}
