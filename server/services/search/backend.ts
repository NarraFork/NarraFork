/**
 * Which search backend is in use.
 *
 * Phase 2 of the dual-database work wired the search port and its SQLite implementation;
 * phase 5 adds the PostgreSQL store. This module is where backend availability is stated
 * once, in code, so the honest answer is available to callers and tests instead of living
 * in a commit message.
 *
 * WHY A NAMED BACKEND AND AN EXPLICIT REFUSAL
 * ------------------------------------------
 * The failure this prevents is a "supported" backend that is really a half-wired one. If
 * asking for a backend fell back to SQLite, every test would pass, the app would start,
 * and search would silently be reading the wrong database — an outcome no assertion in
 * this repository would catch, because they all run whatever the default resolves to. So
 * a backend with no registered implementation THROWS. A missing search backend is a loud
 * startup failure, which is the correct shape for "you asked for something that does not
 * exist yet".
 *
 * Registration and reachability are separate claims. A backend appears in `SEARCH_STORES`
 * only when a store satisfying the port exists; whether that store can reach its database
 * is decided where the connection is wired (the PostgreSQL store binds late and fails
 * closed until then — see `postgres-store.ts`). The default stays SQLite.
 */

import { resolveDatabaseBackendConfig } from "../../db/postgres-runtime";
import { AppError } from "../../lib/errors";
import type { SearchStore } from "./port";
import { postgresSearchStore } from "./postgres-store";
import { sqliteSearchStore } from "./sqlite-store";

/** Backend identifiers the dual-database work recognizes as names. Being named here says
 *  nothing about being implemented — see `SEARCH_STORES`. */
export type SearchBackend = "sqlite" | "postgres";

/** The default backend. Changing it is a deployment decision, not a per-call one. */
export const DEFAULT_SEARCH_BACKEND: SearchBackend = "sqlite";

/**
 * Implemented stores, by backend.
 *
 * A partial record on purpose: the absence of a key is the machine-readable form of "not
 * implemented", so adding a backend is one entry here plus a store that satisfies the port,
 * and forgetting the store is a type error rather than a runtime fallback.
 */
const SEARCH_STORES: Partial<Record<SearchBackend, SearchStore>> = {
	sqlite: sqliteSearchStore,
	// Registered, which makes `resolveSearchStore("postgres")` answer. The store binds
	// its connection late (`bindPostgresSearchClient`) and fails closed until then —
	// registration is a type-level claim, reaching the database is a startup claim.
	postgres: postgresSearchStore,
};

/** Whether a backend has a real search implementation behind it. */
export function isSearchBackendImplemented(backend: SearchBackend): boolean {
	return SEARCH_STORES[backend] !== undefined;
}

/**
 * The store for a backend, or a hard failure.
 *
 * Called with no argument by production code, which pins the default. The parameter exists so
 * tests can assert the refusal without reaching into module internals.
 */
export function resolveSearchStore(backend: SearchBackend = DEFAULT_SEARCH_BACKEND): SearchStore {
	const store = SEARCH_STORES[backend];
	if (!store) {
		throw new AppError(
			`Search backend "${backend}" has no implementation. ` +
				`Implemented backends: ${Object.keys(SEARCH_STORES).join(", ")}.`,
			500,
			"SEARCH_BACKEND_UNAVAILABLE",
		);
	}
	return store;
}

/**
 * The process-wide search store.
 *
 * A module constant rather than a per-call lookup: the backend cannot change while the
 * process runs (the database connection is already fixed by then), and a constant keeps the
 * prepared-statement caches inside the store meaningful.
 *
 * The default follows the master database backend (`NF_DATABASE_BACKEND` /
 * settings `database.backend` — the same rule `server/db/index.ts` resolves), so a
 * PostgreSQL deployment can never silently keep searching SQLite. The PostgreSQL store
 * still fails closed until the startup composition binds its connection.
 */
function defaultSearchBackend(): SearchBackend {
	return resolveDatabaseBackendConfig().backend === "postgres"
		? "postgres"
		: DEFAULT_SEARCH_BACKEND;
}

export const searchStore: SearchStore = resolveSearchStore(defaultSearchBackend());
