/**
 * The SQLite implementation of {@link DatabaseLifecyclePort}.
 *
 * Everything in here is engine-shaped: an instance lock over a local data directory, a
 * clean-shutdown marker stored in `application_id`, a WAL to consume, migration SQL replayed from
 * `drizzle/`, `ALTER TABLE` patching for databases created by older builds, FTS5 virtual tables,
 * `PRAGMA optimize`, and a self-healing runner that can rewrite the file with the `sqlite3` CLI.
 *
 * This module is the reason the port exists. None of the above survives a move to a server-managed
 * engine, and NONE of it should be reimplemented there: a networked engine has no local file to
 * `.recover`, no `application_id` to stamp, and its own operator-owned backup/verify story. A future
 * backend answers `notApplicable` (see `capability.ts`) rather than inheriting a stub that reports a
 * plausible zero.
 *
 * ORDER IS THE CONTRACT, and it is preserved verbatim from the original `server/db/index.ts` body:
 *
 *   1. instance lock          — before any handle exists, so two processes never race the rest
 *   2. open the connection    — with the PRAGMA set the main-thread rules depend on
 *   3. consume the marker     — BEFORE any startup mutation, so a crash during steps 4-8 cannot
 *                               leave a stale "was clean" claim for the next boot
 *   4. act on a queued repair — a cheap marker read; the scan already happened in an earlier probe
 *   5. migrations             — awaited before column patching
 *   6. column patching        — ALTER TABLE for databases from older builds
 *   7. data backfills         — supplied by the caller (see {@link SqliteLifecycleOptions})
 *   8. FTS5 init              — MUST be last: it needs every table and column the steps above add,
 *                               and it consumes the `wasClean` flag read in step 3
 *   9. planner statistics     — real startups only; the stats are process-independent
 *
 * SYNCHRONY: `start()` is async because step 5 genuinely awaits (resolving the migration folder,
 * materialising embedded SQL), and step 7 awaits paginated data backfills. Every atomic section
 * inside those steps stays synchronous — see
 * `transaction-atomicity-contract.test.ts` for why an `await` between BEGIN and COMMIT is unsound on
 * `bun:sqlite`. The shutdown methods are synchronous because their callers cannot await.
 *
 * HOT RELOAD: Bun `--hot` re-evaluates modules inside a live process, so `start()` can run twice.
 * The globalThis-pinned state below makes the second run report `isHotReload: true` and skip the
 * work that is process-independent (the FTS unclean-shutdown rebuild, planner statistics) while
 * never registering a second timer or exit handler. The state keys are unchanged from the original
 * implementation so a reload across this refactor still recognises its own state.
 */

import type { Database } from "bun:sqlite";
// `@server/db/connection` rather than `../connection`, deliberately: the dialect-inventory guard
// detects the connection module by import PATH, and its pattern does not recognise the `../connection`
// spelling that is available from inside this directory. Using it would have made the guard blind to
// the very import that reveals this file opens a local SQLite file — a silent hole in the ledger,
// which is worse than the mixed import style.
import { getDbPath, openDatabase } from "@server/db/connection";
import {
	checkIntegrity,
	createWalUpkeepTick,
	optimizeDatabase,
	recoverWithCli,
	tryWalRecovery,
	WAL_UPKEEP_INTERVAL_MS,
} from "../../lib/db-resilience";
import { hotOnce, hotSafe, hotTimer } from "../../lib/hot-safe";
import { acquireInstanceLock, releaseInstanceLock } from "../../lib/instance-lock";
import { logger } from "../../lib/logger";
import { ensureColumns } from "../ensure-columns";
import { consumeCleanShutdownState, ensureFts, markCleanShutdown } from "../fts";
import {
	abandonAutomaticRepair,
	clearPendingDatabaseRepair,
	MAX_AUTOMATIC_REPAIR_ATTEMPTS,
	readPendingDatabaseRepair,
	recordAutomaticRepairAttempt,
	shouldAttemptAutomaticRepair,
} from "../integrity-state";
import { runMigrations } from "../run-migrations";
import { SQLITE_BACKEND_ID } from "./backend-ids";
import { type CapabilityResult, notApplicable, supported, supportedVoid } from "./capability";
import type {
	DatabaseLifecyclePort,
	DatabaseRepairOutcome,
	DatabaseStartupReport,
	DatabaseStartupState,
} from "./lifecycle-port";
import type { BackgroundUpkeepPlan, DatabaseUpkeepPort } from "./maintenance-port";

/** Shared across `--hot` re-evaluations. Field names and key match the original implementation. */
interface SqliteLifecycleState {
	initialized: boolean;
	cleanMarked: boolean;
	sqlite: Database | undefined;
	walCheckpointTimer: ReturnType<typeof setInterval> | undefined;
}

const HOT_STATE_KEY = "narrafork.dbLifecycle";
const HOT_TIMER_KEY = "narrafork.walCheckpointTimer";
const HOT_EXIT_HANDLER_KEY = "narrafork.walExitHandler";

export interface SqliteLifecycleOptions {
	/**
	 * Idempotent data backfills, run between column patching and FTS initialisation.
	 *
	 * Passed in rather than implemented here, and typed with `Database` on purpose: these are
	 * product-level data migrations written in SQLite SQL (legacy narrator status values, trait
	 * arrays, handle folding, the knowledge-base seed). They are NOT lifecycle, so hard-coding them
	 * into the adapter would make the lifecycle boundary meaningless — and typing them with the
	 * driver's handle keeps them out of the backend-independent port surface, where a `Database`
	 * parameter would leak `bun:sqlite` into every future backend's signature.
	 *
	 * The contract this adapter provides is only the POSITION in the sequence: after every column
	 * exists (step 6) and before the search indexes are built from the resulting rows (step 8).
	 * Awaited before startup completes. Transactions must stay synchronous; yielding between
	 * pages is allowed. Safe to re-run; required backfills must throw to prevent unsafe startup.
	 */
	readonly applyDataBackfills?: (connection: Database) => void | Promise<void>;
}

export interface SqliteLifecycle extends DatabaseLifecyclePort, DatabaseUpkeepPort {
	/**
	 * The live connection.
	 *
	 * A getter, not a field: startup repair closes the handle and reopens it after
	 * `sqlite3 .recover` swaps the file, so anything that captured the pre-repair handle would be
	 * holding a closed connection to a replaced database.
	 *
	 * Throws before `start()` — a caller that reads this early would otherwise silently get
	 * `undefined` and fail much later with an unrelated message.
	 */
	readonly connection: Database;
	/** Install the periodic upkeep timer under hot-reload-safe ownership. Idempotent per process. */
	startBackgroundUpkeep(): CapabilityResult<BackgroundUpkeepPlan>;
}

export function createSqliteLifecycle(options: SqliteLifecycleOptions = {}): SqliteLifecycle {
	const state = hotSafe<SqliteLifecycleState>(HOT_STATE_KEY, () => ({
		initialized: false,
		cleanMarked: false,
		sqlite: undefined,
		walCheckpointTimer: undefined,
	}));

	function connection(): Database {
		const current = state.sqlite;
		if (!current) {
			throw new Error("SQLite lifecycle has not been started — no connection is open yet");
		}
		return current;
	}

	function acquireExclusiveAccess(): void {
		// Idempotent for this process (the lock recognises its own pid + boot session), so calling
		// this and then `start()` is safe.
		acquireInstanceLock(getDbPath());
	}

	/**
	 * Act on a repair an EARLIER probe already confirmed was needed.
	 *
	 * Startup never scans: `PRAGMA quick_check` / `integrity_check` read every page and `bun:sqlite`
	 * is synchronous, so a scan here blocked the main thread before `Bun.serve()` bound the port
	 * (measured: 77s on a 5.3 GB file) — strictly worse than the corruption it guarded against,
	 * since WAL + `synchronous=NORMAL` already makes committed data crash-safe. All this does is
	 * read a small marker file.
	 *
	 * The attempt budget is what keeps one unrepairable database from becoming a permanently
	 * unbootable server: each attempt costs a full `integrity_check`, up to three synchronous
	 * `sqlite3` invocations AND a copy of the whole file. Once spent, the marker flips to `manual`,
	 * the server boots normally, and the background probe keeps reporting the real state.
	 */
	function runPendingRepair(isHotReload: boolean): DatabaseRepairOutcome {
		const dbPath = getDbPath();
		const pendingRepair = readPendingDatabaseRepair();
		if (!pendingRepair) return { kind: "not_flagged" };
		if (isHotReload) return { kind: "skipped", reason: "hot_reload" };

		if (!shouldAttemptAutomaticRepair(pendingRepair)) {
			logger.error("Database is flagged as corrupt and automatic repair is no longer attempted", {
				state: pendingRepair.state,
				attempts: pendingRepair.attempts,
				maxAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
				detectedAt: pendingRepair.detectedAt,
				details: pendingRepair.details,
				hint: `sqlite3 "${dbPath}" ".recover" | sqlite3 "${dbPath}.manual"`,
			});
			return { kind: "skipped", reason: "budget_spent" };
		}

		logger.error("Database was flagged as corrupt by a previous integrity check — repairing now", {
			mode: pendingRepair.mode,
			detectedAt: pendingRepair.detectedAt,
			details: pendingRepair.details,
			attempt: pendingRepair.attempts + 1,
			maxAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
		});

		// Consume the attempt BEFORE running it: recoverWithCli can be killed by its own execSync
		// timeout or take the process down with it, and an attempt that never records itself is an
		// attempt that repeats forever.
		const { repair: attempted, write } = recordAutomaticRepairAttempt(pendingRepair);
		if (!write.ok) {
			logger.error("Failed to persist the repair attempt counter — skipping automatic repair", {
				error: write.error,
				hint: `sqlite3 "${dbPath}" ".recover" | sqlite3 "${dbPath}.manual"`,
			});
			return { kind: "skipped", reason: "attempt_counter_unwritable" };
		}

		const walOk = tryWalRecovery(connection());
		// Confirm with the authoritative full integrity_check: a WAL checkpoint alone may be enough,
		// and this runs only on the rare confirmed-corruption path, so the scan cost is justified.
		let repaired = walOk && checkIntegrity(connection()).ok;
		let via = "wal_checkpoint";
		if (repaired) {
			logger.info("Database recovered after WAL checkpoint");
		} else {
			logger.warn("WAL recovery insufficient, attempting CLI .recover");
			connection().close();
			const recovered = recoverWithCli(dbPath);
			state.sqlite = openDatabase();
			repaired = recovered && checkIntegrity(connection()).ok;
			via = "sqlite3_cli_recover";
			if (repaired) logger.info("Database recovered via sqlite3 CLI .recover");
		}

		if (repaired) {
			clearPendingDatabaseRepair();
			return { kind: "repaired", via };
		}
		if (attempted.attempts >= MAX_AUTOMATIC_REPAIR_ATTEMPTS) {
			abandonAutomaticRepair(attempted);
			logger.error("Automatic recovery failed and is now abandoned — manual repair needed", {
				attempts: attempted.attempts,
				hint: `sqlite3 "${dbPath}" ".recover" | sqlite3 "${dbPath}.manual"`,
			});
			return { kind: "failed", abandoned: true };
		}
		// Budget remains: keep the marker pending so the next startup tries once more.
		logger.error("Automatic recovery failed — one more attempt will run on the next startup", {
			attempts: attempted.attempts,
			maxAttempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
			hint: `sqlite3 "${dbPath}" ".recover" | sqlite3 "${dbPath}.manual"`,
		});
		return { kind: "failed", abandoned: false };
	}

	async function start(): Promise<DatabaseStartupReport> {
		acquireExclusiveAccess();

		// Read the reload flag BEFORE anything marks this evaluation as initialised.
		const isHotReload = state.initialized;
		state.sqlite = openDatabase();
		state.cleanMarked = false;

		// Consume the previous process' marker before any startup mutation. If this process crashes
		// during migrations/backfills/FTS setup, the next startup must not reuse a stale marker.
		const { wasClean } = consumeCleanShutdownState(connection());

		const repair = runPendingRepair(isHotReload);

		let migrationSource: string;
		let migrationFolder: string;
		try {
			const migrationResult = await runMigrations(connection());
			migrationSource = migrationResult.source;
			migrationFolder = migrationResult.folder;
			if (migrationResult.source === "embedded") {
				logger.info("Database migrated from embedded migration data", {
					migrationsFolder: migrationResult.folder,
				});
			}
		} catch (err) {
			logger.error("Database migration failed on startup", {
				error: String(err),
				stack: (err as Error)?.stack,
			});
			throw err;
		}

		// Patch missing columns for databases created by older versions.
		ensureColumns(connection());

		await options.applyDataBackfills?.(connection());

		// FTS5 virtual tables and triggers — managed outside Drizzle (which cannot express FTS5).
		ensureFts(connection(), {
			skipUncleanShutdownRebuild: isHotReload,
			// consumeCleanShutdownState already cleared the marker, so ensureFts cannot re-read it.
			wasClean,
		});
		state.initialized = true;

		// Refresh query-planner statistics once on a real startup (skip hot reloads — the stats are
		// process-independent and this avoids redundant work on every --hot cycle). Bounded by
		// analysis_limit so it stays fast even on large tables.
		if (!isHotReload) {
			optimizeDatabase(connection());
		}

		// Guarantee the instance lock is released on process exit. Deliberately NOT the clean-shutdown
		// marker: this handler also fires after a crash, a forced process.exit(), or a degraded
		// graceful shutdown, and the marker asserts "teardown fully completed". Writing it here would
		// let the next startup skip verification even when the database was left in an unknown state.
		if (hotOnce(HOT_EXIT_HANDLER_KEY)) {
			process.on("exit", () => {
				abandonWithoutCleanMarker();
			});
		}

		return {
			backendId: SQLITE_BACKEND_ID,
			startup: supported<DatabaseStartupState>({ wasClean, isHotReload }),
			migration: { source: migrationSource, detail: migrationFolder },
			repair: supported(repair),
		};
	}

	function stopUpkeepTimer(): void {
		if (state.walCheckpointTimer) {
			clearInterval(state.walCheckpointTimer);
			state.walCheckpointTimer = undefined;
		}
	}

	function finishCleanly(): CapabilityResult<void> {
		stopUpkeepTimer();
		const current = state.sqlite;
		try {
			if (!state.cleanMarked && current) {
				markCleanShutdown(current);
				state.cleanMarked = true;
			}
			return state.cleanMarked
				? supportedVoid()
				: notApplicable("no open SQLite connection to stamp the clean-shutdown marker on");
		} catch (err) {
			logger.warn("Failed to mark database clean shutdown", { error: String(err) });
			// A failed marker write is a real failure of a supported capability, not an absent
			// capability. Reported as unsupported would tell the caller "this engine has no such
			// concept", which is the opposite of what happened.
			return { supported: false, code: "notImplemented", reason: String(err) };
		} finally {
			releaseInstanceLock();
		}
	}

	function abandonWithoutCleanMarker(): void {
		stopUpkeepTimer();
		releaseInstanceLock();
	}

	function planBackgroundUpkeep(): CapabilityResult<BackgroundUpkeepPlan> {
		const current = state.sqlite;
		if (!current) {
			return notApplicable("SQLite upkeep needs an open connection; start() has not run");
		}
		return supported<BackgroundUpkeepPlan>({
			intervalMs: WAL_UPKEEP_INTERVAL_MS,
			tick: createWalUpkeepTick(current),
			description: `WAL checkpoint every ${Math.round(WAL_UPKEEP_INTERVAL_MS / 60_000)}m, planner statistics every 6th tick`,
		});
	}

	function startBackgroundUpkeep(): CapabilityResult<BackgroundUpkeepPlan> {
		const plan = planBackgroundUpkeep();
		if (!plan.supported) return plan;
		// hotTimer clears the previous interval on Bun --hot reloads before creating a new one, so a
		// reload cannot accumulate duplicate checkpoint timers.
		state.walCheckpointTimer = hotTimer(HOT_TIMER_KEY, () =>
			setInterval(plan.value.tick, plan.value.intervalMs),
		);
		return plan;
	}

	return {
		backendId: SQLITE_BACKEND_ID,
		get connection() {
			return connection();
		},
		acquireExclusiveAccess,
		start,
		finishCleanly,
		abandonWithoutCleanMarker,
		planBackgroundUpkeep,
		startBackgroundUpkeep,
	};
}
