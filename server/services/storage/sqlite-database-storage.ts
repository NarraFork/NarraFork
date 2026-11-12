/**
 * The SQLite implementation of {@link DatabaseStoragePort}.
 *
 * All of the measurement itself already lives in `database-cleanup-service` (page/freelist
 * accounting, sharded or serial read-worker scans, per-table BUSY handling). Measurement never
 * falls back to the server thread. This adapter reimplements none of it. What it adds is the part the
 * contract promises and the existing service does not:
 *
 *   - a single wall-clock budget for the whole measurement, so a caller always settles;
 *   - normalized failure identity — cancellation and budget exhaustion are distinguishable,
 *     which they were not when both surfaced as a bare `Error("...aborted")`;
 *   - honest capability reporting based on the shared read-worker pool's availability;
 *   - the report's output ceilings.
 *
 * `scanMode` reports the underlying worker's probe. `dbstat` availability is a property of the
 * SQLite build, NOT a constant: the `SUM(length(...))` approximate path remains live for older
 * runtimes and custom builds, but still runs off-thread. If the shared pool is unavailable the
 * service may use a dedicated worker; if no isolated execution is available the scan fails rather
 * than blocking the request thread. A timed-out query is not worker unavailability and is not
 * restarted. The report states which measurement mode actually ran.
 */

import { getDbWorkerAvailability } from "@server/lib/db-worker/pool";
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
		// Report shared-pool availability at access time: env, zero concurrency or repeated
		// startup failures can disable it. An unavailable pool may use a dedicated worker or fail,
		// but measurement never moves onto this thread.
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
		const breakdown = await runWithScanBudget(budgetMs, options.signal, async (linked) => {
			// Cleanup imports narrator-service, which imports storage-service and this port's store.
			// Loading it only when scanning breaks that initialization cycle in every import order.
			const { databaseCleanupService } = await import("@server/services/database-cleanup-service");
			// The import itself cannot be cancelled; do not start a scan if it settled too late.
			linked.throwIfAborted();
			return databaseCleanupService.scanDatabaseBreakdown({
				onProgress: options.onProgress,
				signal: linked,
			});
		});

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
