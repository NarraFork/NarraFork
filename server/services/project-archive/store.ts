/**
 * The one place that decides which backend the project archive reads the MAIN database from.
 *
 * Until batch E this was unconditionally SQLite — deliberately a constant, because a
 * half-wired selector reachable by configuration is exactly the silent failure Phase
 * 0's baseline guarded against. With a second main-store adapter in
 * `postgres-main-store.ts`, this module takes the same shape as
 * `services/knowledge/store.ts`: the untrusted configuration is parsed by
 * `selectWriteBackend` (fail-closed — absent, empty, aliased or unknown values all
 * resolve to SQLite, and only the exact string `postgres` selects PostgreSQL), then
 * checked against the read selection by `assertWriteBackendMatchesRead`, because one
 * process must read and write the same database. Both checks run where the store is
 * composed, so a mismatch or an unavailable PostgreSQL is a loud startup error,
 * never a silent fork between two stores.
 *
 * The PostgreSQL store is INJECTED: nothing here opens a connection, and a process
 * that never selects PostgreSQL never loads one. Tests and the future production
 * composition root supply the adapter built on their own handle through
 * `setProjectArchiveMainStore`.
 *
 * Note what does NOT change with the backend: the archive FILE stays SQLite either
 * way. It is a portable artifact users copy between machines, so
 * `server/lib/project-db.ts` and the archive reader remain `bun:sqlite` permanently,
 * and are registered as such in the dialect ledger.
 */
import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import type { ProjectArchiveMainStore } from "./main-store";
import { sqliteProjectArchiveMainStore } from "./sqlite-main-store";

/**
 * Resolve the store for an explicit configuration — the pure core of the wiring,
 * exported so the selection rules are testable without re-importing modules under
 * different environments.
 *
 * `injected` is the only way PostgreSQL becomes reachable: the selector requires it
 * (`postgresAvailable: false` makes an explicit `postgres` selection throw), and the
 * resolved store IS the injected one. Fail-closed in both directions.
 */
export function resolveProjectArchiveMainStore(
	config: { writeBackend?: unknown; readBackend?: unknown },
	injected: ProjectArchiveMainStore | undefined,
): ProjectArchiveMainStore {
	const write = selectWriteBackend(config.writeBackend, {
		postgresAvailable: injected !== undefined,
	});
	assertWriteBackendMatchesRead(write, selectReadBackend(config.readBackend));
	if (write.backend === "postgres") {
		if (!injected) {
			// Unreachable through the selector today (availability already threw), kept as
			// the invariant made explicit: selecting PostgreSQL without a store is never a
			// fallback.
			throw new Error("PostgreSQL archive main store selected but no store is available");
		}
		return injected;
	}
	return sqliteProjectArchiveMainStore;
}

/** The store resolved from the process environment at module load. */
const initialProjectArchiveMainStore = resolveProjectArchiveMainStore(
	{ writeBackend: process.env.NF_WRITE_BACKEND, readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let projectArchiveMainStore: ProjectArchiveMainStore = initialProjectArchiveMainStore;

/**
 * Swap the store every importer sees (test seam and future composition root).
 * `undefined` restores the environment-resolved default.
 */
export function setProjectArchiveMainStore(store: ProjectArchiveMainStore | undefined): void {
	projectArchiveMainStore = store ?? initialProjectArchiveMainStore;
}
