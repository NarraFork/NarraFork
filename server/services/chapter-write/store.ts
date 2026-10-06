/**
 * The one place that decides which backend serves chapter writes.
 *
 * Mirrors `services/knowledge/store.ts` exactly: the untrusted configuration is
 * parsed by `selectWriteBackend` (fail-closed — absent, empty, aliased or unknown
 * values all resolve to SQLite, and only the exact string `postgres` selects
 * PostgreSQL), then checked against the read selection by
 * `assertWriteBackendMatchesRead`, because one process must read and write the same
 * database. Both checks run where the store is composed, so a mismatch or an
 * unavailable PostgreSQL is a loud startup error, never a silent fork between two
 * stores.
 *
 * The PostgreSQL store is INJECTED: nothing here opens a connection, and a process
 * that never selects PostgreSQL never loads one. Tests and the future production
 * composition root supply the adapter built on their own handle through
 * `setChapterWriteStore`.
 *
 * The binding is a `let` on purpose: ESM live bindings let `setChapterWriteStore`
 * swap the store for every importer without a forwarding wrapper, while the default
 * stays the very same object the SQLite implementation exports.
 */
import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import { sqliteChapterWriteStore } from "./sqlite-write-store";
import type { ChapterWriteStore } from "./write-store";

/**
 * Resolve the store for an explicit configuration — the pure core of the wiring,
 * exported so the selection rules are testable without re-importing modules under
 * different environments.
 *
 * `injected` is the only way PostgreSQL becomes reachable: the selector requires it
 * (`postgresAvailable: false` makes an explicit `postgres` selection throw), and the
 * resolved store IS the injected one. Fail-closed in both directions.
 */
export function resolveChapterWriteStore(
	config: { writeBackend?: unknown; readBackend?: unknown },
	injected: ChapterWriteStore | undefined,
): ChapterWriteStore {
	const write = selectWriteBackend(config.writeBackend, {
		postgresAvailable: injected !== undefined,
	});
	assertWriteBackendMatchesRead(write, selectReadBackend(config.readBackend));
	if (write.backend === "postgres") {
		if (!injected) {
			// Unreachable through the selector today (availability already threw), kept as
			// the invariant made explicit: selecting PostgreSQL without a store is never a
			// fallback.
			throw new Error("PostgreSQL chapter write backend selected but no store is available");
		}
		return injected;
	}
	return sqliteChapterWriteStore;
}

/** The store resolved from the process environment at module load. */
const initialChapterWriteStore = resolveChapterWriteStore(
	{ writeBackend: process.env.NF_WRITE_BACKEND, readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let chapterWriteStore: ChapterWriteStore = initialChapterWriteStore;

/**
 * Swap the store every importer sees (test seam and future composition root).
 * `undefined` restores the environment-resolved default.
 */
export function setChapterWriteStore(store: ChapterWriteStore | undefined): void {
	chapterWriteStore = store ?? initialChapterWriteStore;
}
