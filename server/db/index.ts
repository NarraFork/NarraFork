/**
 * The database singleton: one startup sequence, and the handles every caller already uses.
 *
 * This module is now WIRING. The engine-shaped work — instance lock, clean-shutdown marker, WAL,
 * migrations, column patching, FTS5 initialisation, planner statistics, the self-healing repair
 * runner — lives behind the lifecycle port in `backend/`, and the product's data backfills live in
 * `data-backfills.ts`. What is left here is choosing the implementation and exposing the handles and
 * shutdown functions every caller already uses.
 *
 * TWO BACKENDS, ONE CHOICE, MADE HERE
 * -----------------------------------
 * The default is SQLite and everything above applies unchanged. An explicit PostgreSQL selection
 * (`NF_DATABASE_BACKEND=postgres` + `NF_DATABASE_URL`/`DATABASE_URL`, or settings
 * `database.backend` — see `postgres-runtime.ts` for the full fail-closed contract) takes the
 * other branch:
 *
 *   - the SAME instance lock is acquired first (it guards local worktrees, ports and terminals,
 *     not the database file);
 *   - the PostgreSQL runtime starts under the top-level await: connect probe, disk
 *     `drizzle-postgres` migration dispatch, `ensurePgFts` — a failure in any stage aborts module
 *     evaluation and the process never boots. There is NO silent fallback to SQLite;
 *   - no SQLite connection is opened at all, so the SQLite-only machinery (WAL upkeep, clean
 *     marker, integrity probe, vacuum window) neither runs nor pretends to: the maintenance port
 *     answers `notApplicable`, `startupShutdownState` reports "cannot skip verification", and
 *     `markDatabaseCleanShutdown()` releases the lock but reports false;
 *   - `db` / `sqlite` become fail-closed proxies that throw on any access. The business stores
 *     that have a PostgreSQL implementation are injected from the single composition seam
 *     (`services/postgres-composition.ts`, invoked by `main.ts`); everything still reading the
 *     SQLite handle fails loudly instead of quietly writing to a second database.
 *
 * The exported surface is unchanged on purpose (`db`, `sqlite`, `startupShutdownState`,
 * `markDatabaseCleanShutdown`, `releaseDatabaseInstanceLockOnly`), including the SYNCHRONY of the
 * two shutdown functions: they are called from `process.on("exit")` and from the tail of the
 * graceful shutdown, neither of which can await. `sqlite` also stays a plain binding rather than a
 * getter, because dozens of modules destructure it at import time.
 *
 * Top-level `await` is load-bearing: migrations must finish before the first query, and this module
 * is imported (directly or transitively) by everything that queries.
 */

import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { acquireInstanceLock, releaseInstanceLock } from "../lib/instance-lock";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import type { DatabaseMaintenancePort } from "./backend/maintenance-port";
import { createSqliteLifecycle, type SqliteLifecycle } from "./backend/sqlite-lifecycle";
import { createSqliteMaintenance } from "./backend/sqlite-maintenance";
import { getDbPath } from "./connection";
import { applySqliteDataBackfills } from "./data-backfills";
import {
	closePostgresRuntime as closePinnedPostgresRuntime,
	createPostgresMaintenanceRefusals,
	getOrStartPostgresRuntime,
	logPostgresStartup,
	type PostgresRuntime,
	resolveDatabaseBackendConfig,
} from "./postgres-runtime";
import * as relations from "./relations";
import * as schema from "./schema";

/**
 * Which database this process runs on. Resolved once, here, from the explicit configuration
 * channels — every other "which backend?" question (health endpoint, search store default,
 * startup gating) reads this value rather than re-parsing configuration.
 */
const databaseConfig = resolveDatabaseBackendConfig(process.env, settings.database);
export const activeDatabaseBackend = databaseConfig.backend;

const createMainDb = (client: Database) => drizzle({ client, schema: { ...schema, ...relations } });
type MainDb = ReturnType<typeof createMainDb>;

/**
 * Fail-closed stand-in for the SQLite handles while PostgreSQL is active.
 *
 * A proxy rather than a real connection: opening the file "just in case" would silently create
 * and migrate a second database that nothing should be writing to. Any access throws with the
 * reason and the remediation, which is exactly what an unwired code path deserves.
 */
function unavailableSqliteHandle<T>(handle: string): T {
	return new Proxy(
		{},
		{
			get: () => {
				throw new Error(
					`The SQLite "${handle}" handle does not exist while the PostgreSQL backend is ` +
						"active: no SQLite connection is opened in this mode. This code path is not " +
						"wired to PostgreSQL yet — the composition seam covers " +
						"register/knowledge/chapter/archive/search, and the remaining surfaces land " +
						"with the P2 composition batch.",
				);
			},
		},
	) as unknown as T;
}

let postgresRuntimeValue: PostgresRuntime | null = null;
let sqliteLifecycle: SqliteLifecycle | null = null;
let db: MainDb;
let sqlite: Database;
let startupShutdownState: { readonly wasClean: boolean; readonly isHotReload: boolean };
let databaseMaintenance: DatabaseMaintenancePort;

if (databaseConfig.backend === "postgres") {
	// The instance lock is acquired BEFORE any database work, exactly as on the SQLite path —
	// it has never been about the database file (see lifecycle-port.ts): two processes would
	// fight over the container port pool, `.worktrees/`, PTY ownership and the update handoff,
	// and moving the stored data to a server-managed engine changes none of that.
	acquireInstanceLock(getDbPath());
	// Hot-reload safe: Bun --hot re-evaluates this module in a live process, and the pinned
	// runtime keeps the second evaluation from leaking a client and re-running DDL.
	const started = await getOrStartPostgresRuntime(databaseConfig);
	postgresRuntimeValue = started.runtime;
	if (!started.isHotReload) logPostgresStartup(started.runtime, databaseConfig);
	// "Cannot skip verification" — never wasClean: true. PostgreSQL has no clean-shutdown
	// marker to consume, and reporting one would retire the integrity story silently.
	startupShutdownState = { wasClean: false, isHotReload: started.isHotReload };
	databaseMaintenance = createPostgresMaintenanceRefusals();
	db = unavailableSqliteHandle("db");
	sqlite = unavailableSqliteHandle("sqlite");
} else {
	if (databaseConfig.ignoredPostgresUrl) {
		// Deliberately no URL in this log line — it carries credentials.
		logger.warn(
			"A PostgreSQL connection URL is present in the environment but the database backend " +
				`is SQLite; the URL is ignored. Set NF_DATABASE_BACKEND=postgres to opt in.`,
		);
	}
	const lifecycle = createSqliteLifecycle({ applyDataBackfills: applySqliteDataBackfills });
	sqliteLifecycle = lifecycle;

	/**
	 * Engine-level maintenance for this process' connection.
	 *
	 * Reads the connection through the lifecycle on every call rather than capturing it: startup
	 * repair closes and reopens the handle after `sqlite3 .recover` swaps the file, so a captured
	 * handle would be a closed connection to a replaced database.
	 */
	databaseMaintenance = createSqliteMaintenance(() => lifecycle.connection);

	const startupReport = await lifecycle.start();

	/**
	 * How the PREVIOUS process exited, plus whether this module evaluation is a Bun --hot reload.
	 *
	 * Consumed by the background integrity probe (main.ts) to decide whether verification is
	 * needed: a clean shutdown means the on-disk state is trustworthy and no scan is warranted.
	 *
	 * An unsupported answer degrades to "cannot skip verification" — never to `wasClean: true`. A
	 * backend that cannot report how it was last closed must not be treated as having closed
	 * cleanly, because that silently retires the whole corruption-detection path.
	 */
	startupShutdownState = startupReport.startup.supported
		? ({
				wasClean: startupReport.startup.value.wasClean,
				isHotReload: startupReport.startup.value.isHotReload,
			} as const)
		: ({ wasClean: false, isHotReload: false } as const);

	// Periodic WAL checkpoint to bound WAL growth, plus an occasional planner-statistics refresh.
	// The lifecycle owns the timer in hot-reload-safe state so a --hot cycle cannot accumulate
	// duplicates.
	{
		const upkeep = lifecycle.startBackgroundUpkeep();
		if (!upkeep.supported) {
			logger.info("Database background upkeep not scheduled", {
				code: upkeep.code,
				reason: upkeep.reason,
			});
		}
	}

	sqlite = lifecycle.connection;
	db = createMainDb(sqlite);
}

/**
 * The live PostgreSQL runtime, or null on the SQLite backend.
 *
 * This is the handle the single composition seam (`services/postgres-composition.ts`) injects
 * into every PostgreSQL-capable store, and what the graceful shutdown closes.
 */
export const postgresRuntime = postgresRuntimeValue;

// `sqlite` is exported in its own statement at the END of this module on purpose: the
// dialect-inventory guard pins that exact spelling to prove the native handle still has
// exactly one export site, and merging it into the list above would defeat the pin.
export { databaseMaintenance, db, startupShutdownState };

/**
 * Persist the clean-shutdown marker and release the instance lock. This is intentionally the only
 * marker-writing path: callers must invoke it only after request drain and every teardown step have
 * succeeded. Returns whether the marker was durable.
 *
 * An unsupported result is reported as `false` — the caller's question is "can the next startup
 * trust this?", and both "this engine has no such marker" and "the write failed" answer it the same
 * way. On PostgreSQL there is no marker to write; the instance lock is still released so an
 * update-handoff replacement can start.
 */
export function markDatabaseCleanShutdown(): boolean {
	if (sqliteLifecycle) return sqliteLifecycle.finishCleanly().supported;
	releaseInstanceLock();
	return false;
}

/**
 * Release the instance lock WITHOUT writing the clean-shutdown marker.
 *
 * Used on the degraded graceful-shutdown path (a teardown step timed out or failed, or requests
 * never drained). We still stop the periodic upkeep timer and release the lock so an
 * update-handoff replacement can start, but we deliberately leave the clean marker unset so the
 * next startup verifies rather than trusting a shutdown we could not prove was consistent.
 */
export function releaseDatabaseInstanceLockOnly(): void {
	if (sqliteLifecycle) {
		sqliteLifecycle.abandonWithoutCleanMarker();
		return;
	}
	releaseInstanceLock();
}

/**
 * Close the PostgreSQL runtime: stop accepting new operations, then close the client.
 *
 * Called as a bounded graceful-shutdown step from `main.ts`, after HTTP/WS drain. A no-op on
 * the SQLite backend, so the SQLite teardown sequence is neither extended nor bypassed.
 */
export async function closePostgresRuntime(): Promise<void> {
	await closePinnedPostgresRuntime();
}

// See the note at the export list above: this exact spelling is pinned by the
// dialect-inventory guard, so it stays a separate statement at the end of the module.
export { sqlite };
