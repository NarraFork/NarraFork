/**
 * The SQLite implementation of {@link DatabaseStoragePort}.
 *
 * All of the measurement itself already lives in `database-cleanup-service` (page/freelist
 * accounting, the sharded read-worker scan, the serial main-thread fallback, per-table BUSY
 * handling). This adapter deliberately reimplements none of it. What it adds is the part the
 * contract promises and the existing service does not:
 *
 *   - a single wall-clock budget for the whole measurement, so a caller always settles;
 *   - normalized failure identity — cancellation and budget exhaustion are distinguishable,
 *     which they were not when both surfaced as a bare `Error("...aborted")`;
 *   - honest capability reporting, including losing `offRequestThreadScan` when the read-worker
 *     pool is disabled or has been torn down for a maintenance window;
 *   - the report's output ceilings.
 *
 * The SQLite-specific fallbacks are preserved exactly as they are, on purpose:
 *
 *   - `scanMode` is whatever the underlying scan probed. `dbstat` availability is a property of the
 *     SQLite build, NOT a constant: it is compiled in on Bun 1.4.2 (verified by querying it) and was
 *     absent from earlier builds, so the `SUM(length(...))` approximate path remains live for older
 *     runtimes and custom builds. Which mode ran is reported in the detail rather than assumed here.
 *   - when read workers are unavailable the scan degrades to the serial main-thread scan rather than
 *     failing.
 *
 * Neither is something this adapter should decide differently — a slow report beats a broken
 * settings page, and a report that says which mode produced it is what makes the numbers
 * interpretable.
 */

import { getDbWorkerAvailability } from "@server/lib/db-worker/pool";
import { databaseCleanupService } from "@server/services/database-cleanup-service";
import {
	type DatabaseStorageCapabilities,
	type DatabaseStoragePort,
	type DatabaseStorageReport,
	type DatabaseStorageScanOptions,
	DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS,
	enforceReportLimits,
	runWithScanBudget,
} from "./database-storage-port";

const BACKEND = "sqlite";

export const sqliteDatabaseStoragePort: DatabaseStoragePort = {
	get capabilities(): DatabaseStorageCapabilities {
		// A getter, not a frozen object: `offRequestThreadScan` is a runtime fact. The pool is
		// disabled by env, by a zero concurrency, after repeated spawn failures, and it is torn
		// down outright by `vacuumDatabase`. Reporting a stale `true` in those states would claim
		// the request thread is protected at exactly the moments it is not.
		const workers = getDbWorkerAvailability();
		return {
			backend: BACKEND,
			breakdown: true,
			// SQLite's freelist is reported from `PRAGMA freelist_count`, independently of whether
			// per-table measurement succeeded.
			freeSpaceAccounting: true,
			cleanupCandidates: true,
			offRequestThreadScan: workers.available,
		};
	},

	async scanBreakdown(options: DatabaseStorageScanOptions = {}): Promise<DatabaseStorageReport> {
		const budgetMs = options.budgetMs ?? DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS;
		const breakdown = await runWithScanBudget(budgetMs, options.signal, (linked) =>
			databaseCleanupService.scanDatabaseBreakdown({
				onProgress: options.onProgress,
				signal: linked,
			}),
		);

		return enforceReportLimits({
			// The SQLite file set IS the database's footprint, and it is exact even when individual
			// tables could not be measured — so `incomplete` below never makes this number a lower
			// bound, it only qualifies the per-table detail.
			sizeBytes: breakdown.mainBytes + breakdown.walBytes + breakdown.shmBytes,
			details: breakdown as unknown as Record<string, unknown>,
			incomplete: breakdown.readFailures.tableCount > 0,
		});
	},
};
