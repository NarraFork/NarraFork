/**
 * The one place that decides which backend serves knowledge reads and writes.
 *
 * Mirrors `services/registration/store.ts` exactly: the untrusted configuration is
 * parsed by `selectWriteBackend` (fail-closed — absent, empty, aliased or unknown
 * values all resolve to SQLite, and only the exact string `postgres` selects
 * PostgreSQL), then checked against the read selection by
 * `assertWriteBackendMatchesRead`, because one process must read and write the same
 * database. Both checks run where the store is composed, so a mismatch or an
 * unavailable PostgreSQL is a loud startup error, never a silent fork between two
 * stores.
 *
 * The read side (`knowledgeReadStore`) follows the SAME selection through
 * `selectReadBackend`: a process that writes PostgreSQL but reads SQLite would be
 * the split this module exists to forbid, so both stores are injected together by
 * the composition seam and both default to the SQLite implementations.
 *
 * The PostgreSQL stores are INJECTED: nothing here opens a connection, and a process
 * that never selects PostgreSQL never loads one. Tests and the production
 * composition root supply the adapters built on their own handle through
 * `setKnowledgeWriteStore` / `setKnowledgeReadStore`.
 *
 * The bindings are `let` on purpose: ESM live bindings let the setters swap the
 * stores for every importer without a forwarding wrapper, while the defaults stay
 * the very same objects the SQLite implementations export.
 */
import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import type { KnowledgeReadStore } from "./read-store";
import { sqliteKnowledgeInjectionReads, sqliteKnowledgeReadStore } from "./sqlite-read-store";
import { sqliteKnowledgeWriteStore } from "./sqlite-write-store";
import type { KnowledgeWriteStore } from "./write-store";

/**
 * Resolve the store for an explicit configuration — the pure core of the wiring,
 * exported so the selection rules are testable without re-importing modules under
 * different environments.
 *
 * `injected` is the only way PostgreSQL becomes reachable: the selector requires it
 * (`postgresAvailable: false` makes an explicit `postgres` selection throw), and the
 * resolved store IS the injected one. Fail-closed in both directions.
 */
export function resolveKnowledgeWriteStore(
	config: { writeBackend?: unknown; readBackend?: unknown },
	injected: KnowledgeWriteStore | undefined,
): KnowledgeWriteStore {
	const write = selectWriteBackend(config.writeBackend, {
		postgresAvailable: injected !== undefined,
	});
	assertWriteBackendMatchesRead(write, selectReadBackend(config.readBackend));
	if (write.backend === "postgres") {
		if (!injected) {
			// Unreachable through the selector today (availability already threw), kept as
			// the invariant made explicit: selecting PostgreSQL without a store is never a
			// fallback.
			throw new Error("PostgreSQL knowledge write backend selected but no store is available");
		}
		return injected;
	}
	return sqliteKnowledgeWriteStore;
}

/** The store resolved from the process environment at module load. */
const initialKnowledgeWriteStore = resolveKnowledgeWriteStore(
	{ writeBackend: process.env.NF_WRITE_BACKEND, readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let knowledgeWriteStore: KnowledgeWriteStore = initialKnowledgeWriteStore;

/**
 * Swap the store every importer sees (test seam and future composition root).
 * `undefined` restores the environment-resolved default.
 */
export function setKnowledgeWriteStore(store: KnowledgeWriteStore | undefined): void {
	knowledgeWriteStore = store ?? initialKnowledgeWriteStore;
}

/**
 * Resolve the read store for an explicit configuration — the read-side twin of
 * {@link resolveKnowledgeWriteStore}, with the same fail-closed rule: an explicit
 * `postgres` selection with no injected adapter throws, never falls back to reading
 * SQLite while writes land in PostgreSQL.
 */
export function resolveKnowledgeReadStore(
	config: { readBackend?: unknown },
	injected: KnowledgeReadStore | undefined,
): KnowledgeReadStore {
	const read = selectReadBackend(config.readBackend, {
		postgresAvailable: injected !== undefined,
	});
	if (read.backend === "postgres") {
		if (!injected) {
			// Unreachable through the selector today (availability already threw), kept as
			// the invariant made explicit.
			throw new Error("PostgreSQL knowledge read backend selected but no store is available");
		}
		return injected;
	}
	return sqliteKnowledgeReadStore;
}

/** The read store resolved from the process environment at module load. */
const initialKnowledgeReadStore = resolveKnowledgeReadStore(
	{ readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let knowledgeReadStore: KnowledgeReadStore = initialKnowledgeReadStore;

/**
 * Swap the read store every importer sees (test seam and the production
 * composition root). `undefined` restores the environment-resolved default.
 * Always paired with `setKnowledgeReadStore`'s write counterpart in the seam —
 * one process reads and writes the same database.
 */
export function setKnowledgeReadStore(store: KnowledgeReadStore | undefined): void {
	knowledgeReadStore = store ?? initialKnowledgeReadStore;
}

/** The runtime injection callers still require synchronous results. Never route
 * those calls to SQLite after composition has selected a networked read store. */
export function synchronousKnowledgeInjectionReads(): typeof sqliteKnowledgeInjectionReads {
	if (knowledgeReadStore !== sqliteKnowledgeReadStore) {
		throw new Error(
			"Synchronous knowledge injection is unavailable on PostgreSQL; use the async knowledge read store",
		);
	}
	return sqliteKnowledgeInjectionReads;
}
