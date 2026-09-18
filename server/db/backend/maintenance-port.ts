/**
 * Maintenance operations whose very existence depends on the storage engine.
 *
 * Everything here is an ENGINE-LEVEL housekeeping action on the stored bytes, as opposed to the
 * retention policy that decides WHICH ROWS to drop. That split is the whole point of the file:
 * `database-cleanup-service.ts` keeps owning "sessions older than 90 days", "dump payloads past the
 * cutoff", "tool-call payloads except file-history checkpoints" — those are product decisions and
 * they are backend-independent. What that service must stop owning is `PRAGMA wal_checkpoint`,
 * `PRAGMA optimize`, `VACUUM`, freelist page accounting and `SQLITE_BUSY` string sniffing, because
 * every one of those is SQLite vocabulary with no counterpart on a server-managed engine.
 *
 * WHY NOT JUST NO-OP THE MISSING ONES
 * -----------------------------------
 * Because the numbers are shown to an operator. `freelistBytes: 0` and `freedBytes: 0` read as "you
 * have nothing to reclaim", which is a confident answer that happens to be fabricated. The admin
 * VACUUM button already has the honest shape (a backend capability flag gates it), and this port
 * generalises it: an unavailable operation says which kind of unavailable it is and why, and the
 * caller decides whether to skip quietly or to surface a refusal.
 *
 * MAINTENANCE WINDOWS ARE NOT ORDINARY CRUD
 * ----------------------------------------
 * {@link DatabaseMaintenancePort.reclaimSpace} is the admin-confirmed maintenance window: on SQLite
 * it rewrites the entire file synchronously and normal HTTP/WS/agent activity pauses until it
 * finishes. It is exposed as its own capability precisely so nothing can reach it by accident from
 * a cleanup path or a cache-invalidation hook — the only caller is the explicitly confirmed admin
 * route, and the implementation serialises it behind the maintenance lock.
 *
 * Every method is synchronous. On `bun:sqlite` these ARE synchronous calls; wrapping them in
 * Promises would buy no concurrency and would only hide that the main thread is blocked. Callers
 * that need to await something (file sizes, terminating the read-worker pool) do that around the
 * port, not inside it.
 */

import type { CapabilityResult, DatabaseBackendId } from "./capability";

/** Why a write-side operation failed, in terms a caller can act on without knowing the engine. */
export type MaintenanceFailureKind =
	/** Another connection/transaction holds a conflicting lock. Retryable later. */
	| "conflict"
	/** The engine refused for any other reason. */
	| "error";

export interface MaintenanceFailure {
	readonly kind: MaintenanceFailureKind;
	readonly message: string;
}

/**
 * Flush pending writes so the stored bytes on disk are self-contained.
 *
 * SQLite: `PRAGMA wal_checkpoint`. `truncate: true` additionally shrinks the WAL file, which is
 * what makes reclaimed pages actually visible as freed disk space.
 */
export interface CheckpointRequest {
	readonly truncate: boolean;
}

/** Page-level space accounting: how much of the file is allocated but unused. */
export interface ReusableSpaceReport {
	readonly pageSize: number;
	readonly pageCount: number;
	/** Bytes held in already-allocated-but-free pages, i.e. reclaimable by a rewrite. */
	readonly freelistBytes: number;
}

export interface DatabaseMaintenancePort {
	readonly backendId: DatabaseBackendId;

	/**
	 * Flush pending writes. Best-effort by contract: a failure is reported, never thrown, because
	 * every caller uses this as a hardening step around some other operation and must not lose that
	 * operation's result to a checkpoint hiccup.
	 */
	checkpoint(request: CheckpointRequest): CapabilityResult<{ readonly ok: boolean }>;

	/**
	 * Refresh query-planner statistics.
	 *
	 * Bounded by the implementation so it cannot become a long main-thread stall on a large
	 * database. Best-effort, like {@link checkpoint}: stale statistics are a performance problem,
	 * not a correctness one.
	 */
	refreshPlannerStatistics(): CapabilityResult<{ readonly ok: boolean }>;

	/**
	 * Measure allocated-but-unused space.
	 *
	 * `mainBytes` is passed in because the caller already stat'ed the files and because the
	 * implementation clamps the page arithmetic against the real file size — a database whose
	 * header disagrees with its length must not report more free space than the file has.
	 *
	 * Pragmas only. A caller must never let this walk tables: this is called from the settings page
	 * and from around the VACUUM window, both of which would contend with the writer.
	 */
	measureReusableSpace(mainBytes: number): CapabilityResult<ReusableSpaceReport>;

	/**
	 * Rewrite the stored data to return reusable space to the filesystem.
	 *
	 * ⚠️ ADMIN-CONFIRMED MAINTENANCE WINDOW. On SQLite this is `VACUUM`: a full-file rewrite that
	 * holds an exclusive lock and blocks the JS thread for its whole duration. Callers must have an
	 * explicit operator confirmation and must not invoke it from an automatic cleanup path.
	 *
	 * Unlike the best-effort methods above this one THROWS on failure (after classifying the failure
	 * via {@link classifyFailure}), because a maintenance window that silently did nothing is worse
	 * than an error: the operator waited through the outage and would be told it succeeded.
	 */
	reclaimSpace(): CapabilityResult<void>;

	/**
	 * Classify an error thrown by this backend, so retry/status decisions stay engine-agnostic.
	 *
	 * This exists to delete `\/SQLITE_BUSY|SQLITE_LOCKED|database is locked\/i` from service code.
	 * That regex is correct for SQLite and meaningless elsewhere, and a service that keeps it will
	 * silently classify every conflict on another engine as a generic 500.
	 */
	classifyFailure(error: unknown): MaintenanceFailure;
}

/**
 * The periodic background upkeep a backend wants while the server runs.
 *
 * Kept separate from {@link DatabaseMaintenancePort} because it is a SCHEDULE, not an operation:
 * SQLite needs a periodic WAL checkpoint so the WAL cannot grow without bound, and a server-managed
 * engine needs nothing from us at all. Returning the interval and the tick body (rather than
 * starting a timer inside the implementation) keeps the timer under the caller's hot-reload-safe
 * ownership, which is what prevents a `--hot` cycle from accumulating duplicate timers.
 */
export interface BackgroundUpkeepPlan {
	readonly intervalMs: number;
	/** One tick. Synchronous and self-contained; must never throw. */
	readonly tick: () => void;
	/** For the startup log, e.g. `WAL checkpoint every 5m`. */
	readonly description: string;
}

export interface DatabaseUpkeepPort {
	readonly backendId: DatabaseBackendId;
	planBackgroundUpkeep(): CapabilityResult<BackgroundUpkeepPlan>;
}
