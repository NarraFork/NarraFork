/**
 * The SQLite implementation of {@link DatabaseMaintenancePort}.
 *
 * Four operations, each SQLite vocabulary with no counterpart on a server-managed engine:
 * `PRAGMA wal_checkpoint`, `PRAGMA optimize`, page/freelist accounting, and `VACUUM`. Plus the
 * `SQLITE_BUSY` / `SQLITE_LOCKED` string sniffing that every retry decision in the codebase used to
 * open-code — it lives here so the services above stay engine-agnostic.
 *
 * WHY A CONNECTION PROVIDER RATHER THAN A HANDLE
 * ---------------------------------------------
 * Startup repair CLOSES the connection and reopens it after `sqlite3 .recover` has swapped the file
 * on disk. Anything that captured the handle at construction time would keep a closed connection to
 * a replaced database, and the symptom would appear much later as an unrelated "database is closed"
 * during maintenance. The provider is read on every call instead.
 *
 * WHAT STAYS OUT
 * --------------
 * No retention policy, no row selection, no file-size stat, no worker-pool orchestration. Those are
 * product decisions and process-level concerns that belong to `database-cleanup-service.ts` and are
 * backend-independent; mixing them in here would make the port impossible to implement for another
 * engine without also reimplementing the product's cleanup rules.
 */

import type { Database } from "bun:sqlite";
import { logger } from "../../lib/logger";
import { readFreelistSummary } from "../../services/storage-scan-queries";
import { SQLITE_BACKEND_ID } from "./backend-ids";
import { type CapabilityResult, notApplicable, supported, supportedVoid } from "./capability";
import type {
	CheckpointRequest,
	DatabaseMaintenancePort,
	MaintenanceFailure,
	ReusableSpaceReport,
} from "./maintenance-port";

/**
 * Lock-contention signature.
 *
 * Both the code names and the message text, because `bun:sqlite` surfaces contention as
 * `SQLITE_BUSY` on some paths and as a bare "database is locked" message on others; matching only
 * one of them classified real conflicts as generic failures.
 */
const CONFLICT_PATTERN = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i;

export type SqliteConnectionProvider = () => Database;

export function createSqliteMaintenance(
	getConnection: SqliteConnectionProvider,
): DatabaseMaintenancePort {
	/**
	 * Resolve the connection, treating "not open" as an absent capability rather than a throw.
	 *
	 * Maintenance is called from admin routes and from cleanup paths that must degrade rather than
	 * fail: a checkpoint that cannot run because the lifecycle was never started is a reportable
	 * condition, not an exception to propagate into an HTTP 500.
	 */
	function connectionOrUnavailable():
		| { readonly ok: true; readonly connection: Database }
		| { readonly ok: false; readonly result: CapabilityResult<never> } {
		try {
			return { ok: true, connection: getConnection() };
		} catch (error) {
			return {
				ok: false,
				result: notApplicable(`no open SQLite connection: ${String(error)}`),
			};
		}
	}

	function classifyFailure(error: unknown): MaintenanceFailure {
		const message = String(error);
		return { kind: CONFLICT_PATTERN.test(message) ? "conflict" : "error", message };
	}

	return {
		backendId: SQLITE_BACKEND_ID,

		checkpoint(request: CheckpointRequest): CapabilityResult<{ ok: boolean }> {
			const resolved = connectionOrUnavailable();
			if (!resolved.ok) return resolved.result;
			// PASSIVE never blocks a reader/writer but also cannot shrink the file; TRUNCATE is what
			// actually returns WAL bytes to the filesystem and is therefore used around VACUUM.
			const mode = request.truncate ? "TRUNCATE" : "PASSIVE";
			try {
				resolved.connection.run(`PRAGMA wal_checkpoint(${mode})`);
				return supported({ ok: true });
			} catch (error) {
				// Best-effort by contract: report, never throw. Every caller uses this as a hardening
				// step around some other operation whose result must not be lost to a checkpoint hiccup.
				logger.warn("Database checkpoint failed", { mode, error: String(error) });
				return supported({ ok: false });
			}
		},

		refreshPlannerStatistics(): CapabilityResult<{ ok: boolean }> {
			const resolved = connectionOrUnavailable();
			if (!resolved.ok) return resolved.result;
			try {
				resolved.connection.run("PRAGMA optimize");
				return supported({ ok: true });
			} catch (error) {
				logger.warn("Database optimize failed", { error: String(error) });
				return supported({ ok: false });
			}
		},

		measureReusableSpace(mainBytes: number): CapabilityResult<ReusableSpaceReport> {
			const resolved = connectionOrUnavailable();
			if (!resolved.ok) return resolved.result;
			// Delegated to the shared storage-scan primitive rather than re-deriving the arithmetic:
			// it applies the same clamp against the real file size that the storage scan uses, so the
			// settings page and the VACUUM window cannot report different freelist sizes.
			return supported(readFreelistSummary(resolved.connection, mainBytes));
		},

		reclaimSpace(): CapabilityResult<void> {
			const resolved = connectionOrUnavailable();
			if (!resolved.ok) return resolved.result;
			// Throws on failure, unlike the best-effort methods above: a maintenance window that
			// silently did nothing is worse than an error, because the operator sat through the
			// outage and would be told it succeeded.
			resolved.connection.run("VACUUM");
			return supportedVoid();
		},

		classifyFailure,
	};
}
