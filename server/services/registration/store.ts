/**
 * The one place that decides which backend serves registration writes.
 *
 * The choice follows the read side's `NF_READ_BACKEND` pattern, one level up: the
 * untrusted value is parsed by `selectWriteBackend` (fail-closed — absent, empty,
 * aliased or unknown values all resolve to SQLite, and only the exact string
 * `postgres` selects PostgreSQL), then checked against the read selection by
 * `assertWriteBackendMatchesRead`, because one process must read and write the same
 * database. Both checks run where the store is composed, so a mismatch or an
 * unavailable PostgreSQL is a loud startup error, never a silent fork between two
 * stores.
 *
 * The PostgreSQL store is INJECTED, mirroring `services/read/index.ts`: nothing here
 * opens a connection, and a process that never selects PostgreSQL never loads one.
 * Tests and the future production composition root supply the adapter built on their
 * own handle through `setRegistrationAccountStore`.
 *
 * The binding is a `let` on purpose: ESM live bindings let `setRegistrationAccountStore`
 * swap the store for every importer (including `lib/auth.ts`) without a forwarding
 * wrapper, while the default export stays the very same object the SQLite implementation
 * exports — the existing contract assertion (`registrationAccountStore` IS
 * `sqliteRegistrationAccountStore`) keeps its meaning.
 */
import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import type { RegistrationAccountStore } from "./account-store";
import { sqliteRegistrationAccountStore } from "./sqlite-account-store";

/**
 * Resolve the store for an explicit configuration — the pure core of the wiring,
 * exported so the selection rules are testable without re-importing modules under
 * different environments.
 *
 * `injected` is the only way PostgreSQL becomes reachable: the selector requires it
 * (`postgresAvailable: false` makes an explicit `postgres` selection throw), and the
 * resolved store IS the injected one. Fail-closed in both directions: no knob steers
 * registration to a second backend by accident, and an explicit selection with no
 * adapter to serve it is an error, not a fallback.
 */
export function resolveRegistrationAccountStore(
	config: { writeBackend?: unknown; readBackend?: unknown },
	injected: RegistrationAccountStore | undefined,
): RegistrationAccountStore {
	const write = selectWriteBackend(config.writeBackend, {
		postgresAvailable: injected !== undefined,
	});
	assertWriteBackendMatchesRead(write, selectReadBackend(config.readBackend));
	if (write.backend === "postgres") {
		if (!injected) {
			// Unreachable through the selector today (availability already threw), kept as the
			// invariant made explicit: selecting PostgreSQL without a store is never a fallback.
			throw new Error("PostgreSQL registration write backend selected but no store is available");
		}
		return injected;
	}
	return sqliteRegistrationAccountStore;
}

/** The store resolved from the process environment at module load. */
const initialRegistrationAccountStore = resolveRegistrationAccountStore(
	{ writeBackend: process.env.NF_WRITE_BACKEND, readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let registrationAccountStore: RegistrationAccountStore = initialRegistrationAccountStore;

/**
 * Swap the store every importer sees (test seam and future composition root).
 * `undefined` restores the environment-resolved default.
 */
export function setRegistrationAccountStore(store: RegistrationAccountStore | undefined): void {
	registrationAccountStore = store ?? initialRegistrationAccountStore;
}
