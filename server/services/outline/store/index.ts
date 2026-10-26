/**
 * The one place that decides which backend serves outline reads and writes.
 *
 * Same rules as `services/knowledge/store.ts`: the configuration is parsed fail-closed (only the
 * exact string `postgres` selects PostgreSQL), the write selection must match the read selection
 * (one process reads and writes one database), and the PostgreSQL store is INJECTED by the
 * composition seam (`services/postgres-composition.ts`). Nothing here opens a connection; a
 * process that never selects PostgreSQL never loads one.
 *
 * The binding is `let` on purpose: ESM live bindings let the setter swap the store for every
 * importer without a forwarding wrapper.
 */
import { selectReadBackend } from "@server/db/backend/read-selector";
import {
	assertWriteBackendMatchesRead,
	selectWriteBackend,
} from "@server/db/backend/write-selector";
import type { OutlineStore } from "./port";
import { sqliteOutlineStore } from "./sqlite-store";

/**
 * Resolve the store for an explicit configuration: the pure core of the wiring. An explicit
 * `postgres` selection without an injected store throws; it never falls back to SQLite.
 */
export function resolveOutlineStore(
	config: { writeBackend?: unknown; readBackend?: unknown },
	injected: OutlineStore | undefined,
): OutlineStore {
	const write = selectWriteBackend(config.writeBackend, {
		postgresAvailable: injected !== undefined,
	});
	assertWriteBackendMatchesRead(write, selectReadBackend(config.readBackend));
	if (write.backend === "postgres") {
		if (!injected) {
			throw new Error("PostgreSQL outline backend selected but no store is available");
		}
		return injected;
	}
	return sqliteOutlineStore;
}

const initialOutlineStore = resolveOutlineStore(
	{ writeBackend: process.env.NF_WRITE_BACKEND, readBackend: process.env.NF_READ_BACKEND },
	undefined,
);

export let outlineStore: OutlineStore = initialOutlineStore;

/** Swap the store every importer sees (composition root and tests); `undefined` restores it. */
export function setOutlineStore(store: OutlineStore | undefined): void {
	outlineStore = store ?? initialOutlineStore;
}
