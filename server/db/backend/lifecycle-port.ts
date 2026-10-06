/**
 * What a database backend must do to become usable, and to be shut down honestly.
 *
 * This is the boundary between "the server is starting up" (backend-independent) and "SQLite needs
 * its WAL consumed, its clean marker read, its migration SQL replayed" (very much not). Today only
 * the SQLite implementation exists; the point of writing the boundary down is that the engine-shaped
 * steps are named and typed HERE, so a second backend can answer "that concept does not exist for
 * me" instead of inheriting a stub that quietly reports a plausible-looking zero.
 *
 * THREE RULES THIS INTERFACE ENCODES
 * ---------------------------------
 * 1. Orchestration may be async; an atomic section may not. {@link DatabaseLifecyclePort.start} is
 *    a Promise because migrations legitimately await (resolving the migration folder, reading
 *    embedded SQL). Everything that must run inside a transaction stays synchronous inside the
 *    implementation — see `transaction-atomicity-contract.test.ts` for why an `await` between
 *    BEGIN and COMMIT is unsound on `bun:sqlite`.
 *
 * 2. The shutdown side is SYNCHRONOUS on purpose. {@link DatabaseLifecyclePort.finishCleanly} and
 *    {@link DatabaseLifecyclePort.abandonWithoutCleanMarker} are called from a `process.on("exit")`
 *    handler and from the tail of the graceful-shutdown sequence, neither of which can await. Making
 *    them async to accommodate a hypothetical networked backend would break both callers today in
 *    exchange for nothing; a backend that genuinely needs async teardown gets that work done in the
 *    async shutdown steps ABOVE this port, and leaves these two as the final synchronous act.
 *
 * 3. Exclusive access is NOT a storage-engine capability. See
 *    {@link DatabaseLifecyclePort.acquireExclusiveAccess}.
 */

import type { CapabilityResult, DatabaseBackendId } from "./capability";

/**
 * How the PREVIOUS process left the stored data, plus whether this module evaluation is a Bun
 * `--hot` reload rather than a real startup.
 *
 * `wasClean` is deliberately NOT a plain boolean on the port surface (see
 * {@link DatabaseLifecyclePort.start}): on SQLite it is a marker the previous process wrote, and an
 * engine with no such marker must be able to say "I cannot answer that" rather than report `false`,
 * which reads as "the last shutdown was dirty" and would trigger verification work forever.
 */
export interface DatabaseStartupState {
	readonly wasClean: boolean;
	readonly isHotReload: boolean;
}

/** Where the applied schema migrations came from, for the startup log. */
export interface MigrationRunOutcome {
	/** Engine-specific provenance label, e.g. `filesystem` / `embedded` for SQLite. */
	readonly source: string;
	/** Optional detail for the log — the resolved migration folder, a version, a batch id. */
	readonly detail?: string;
}

/**
 * What startup did about a repair an earlier verification pass had already confirmed was needed.
 *
 * Reported rather than merely logged so the decision is observable in a test. Note what is NOT
 * here: any notion of HOW the repair works. The SQLite self-healing runner (WAL checkpoint, then
 * `sqlite3 .recover` into a fresh file, then a verifying re-open) is engine-specific salvage of a
 * local file. It is deliberately not promoted into this interface, because a server-managed engine
 * repairs itself through its own tooling and an operator's backup policy — not by having NarraFork
 * rewrite its files. A backend without a self-healing path reports `notApplicable` instead of
 * pretending nothing was flagged.
 */
export type DatabaseRepairOutcome =
	/** Nothing was flagged, so there was nothing to act on. */
	| { readonly kind: "not_flagged" }
	/** A repair was owed but deliberately not run now. */
	| {
			readonly kind: "skipped";
			readonly reason: "hot_reload" | "budget_spent" | "attempt_counter_unwritable";
	  }
	/** The database was repaired before the first query. */
	| { readonly kind: "repaired"; readonly via: string }
	/** The repair ran and did not succeed. `abandoned` means no further attempt will be made. */
	| { readonly kind: "failed"; readonly abandoned: boolean };

export interface DatabaseStartupReport {
	readonly backendId: DatabaseBackendId;
	/**
	 * Whether the previous shutdown can be trusted, and whether this is a hot reload.
	 *
	 * A `CapabilityResult` because the "clean shutdown" concept is engine-specific; an engine that
	 * cannot answer must not be forced to guess. Callers that use it to skip verification treat an
	 * unsupported answer as "cannot skip", never as "was clean".
	 */
	readonly startup: CapabilityResult<DatabaseStartupState>;
	readonly migration: MigrationRunOutcome;
	readonly repair: CapabilityResult<DatabaseRepairOutcome>;
}

export interface DatabaseLifecyclePort {
	readonly backendId: DatabaseBackendId;

	/**
	 * Take exclusive ownership of this NarraFork data directory.
	 *
	 * ⚠️ This must stay supported by EVERY backend, and it must not be mistaken for a SQLite
	 * single-writer workaround. SQLite's WAL is multi-process safe; the reason a second instance is
	 * refused is that two processes would fight over the LOCAL run resources — the container port
	 * pool, git worktrees under `.worktrees/`, PTY/terminal ownership, the update handoff. Moving the
	 * stored data to a server-managed engine changes none of that, so a backend that "does not need
	 * a lock" would be deleting a guard that was never about the database file.
	 *
	 * Bypass and force-takeover remain environment overrides handled inside the implementation
	 * (`NARRAFORK_ALLOW_MULTIPLE`, `NARRAFORK_FORCE_UNLOCK`), and a live holder makes this throw —
	 * that is a refusal to boot, not a capability question, which is why the return type is `void`
	 * rather than a `CapabilityResult`.
	 */
	acquireExclusiveAccess(): void;

	/**
	 * Everything that must happen before the first query: exclusive access, opening/connecting,
	 * consuming the previous shutdown state, acting on an already-confirmed repair, schema
	 * migrations, and any engine-side index initialisation whose ORDER relative to migrations
	 * matters.
	 *
	 * Async because migration resolution genuinely awaits. Calling it twice is defined behaviour
	 * (Bun `--hot` re-evaluates modules in a live process): the second call must not duplicate
	 * side effects — no second timer, no second exit handler, no repeated one-time rebuild — and it
	 * reports `isHotReload: true` so callers can skip work that is process-independent.
	 */
	start(): Promise<DatabaseStartupReport>;

	/**
	 * Record that this process shut down cleanly, and release exclusive access.
	 *
	 * SYNCHRONOUS by contract (see the module header). Idempotent: repeated calls must not write a
	 * second marker. Callers must invoke this ONLY after request drain and every teardown step
	 * succeeded — the marker asserts "teardown fully completed", and a false one lets the next
	 * startup trust data it should have verified.
	 *
	 * `notApplicable` is the correct answer for an engine with no such marker; it is NOT a failure,
	 * so callers must not report it as one.
	 */
	finishCleanly(): CapabilityResult<void>;

	/**
	 * Release exclusive access WITHOUT recording a clean shutdown.
	 *
	 * The degraded path: a teardown step failed or requests never drained, so the replacement
	 * process must be able to start, but nothing may claim the stored state is consistent.
	 * Synchronous, idempotent, and never throws — it runs from `process.on("exit")`.
	 */
	abandonWithoutCleanMarker(): void;
}

/**
 * Whether the stored data can be verified OUT OF BAND — without blocking the serving process.
 *
 * Separate from the maintenance port because the two answer different questions. Maintenance is
 * "reshape/reclaim what is there", which is inherently local-file work on SQLite. Verification is
 * "is what is there still intact", and on SQLite the only acceptable form is a read-only probe in
 * another PROCESS: `PRAGMA quick_check` is synchronous and reads every page, so running it in the
 * server would stall all HTTP/WS/agent traffic for as long as the scan takes (measured: 77s on a
 * 5.3 GB file).
 *
 * A server-managed engine verifies itself on its own schedule, so the honest answer there is
 * `notApplicable` — not a probe that always returns "ok", which would silently retire the whole
 * corruption-detection path while looking healthy.
 */
export interface DatabaseVerificationPort {
	readonly backendId: DatabaseBackendId;
	/**
	 * Whether scheduling an out-of-band verification pass makes sense for this backend.
	 *
	 * Returns a description of the probe rather than running it: the caller owns the schedule, the
	 * timeout, the output cap and the bookkeeping of a verdict.
	 */
	outOfBandProbe(): CapabilityResult<{
		/** Human-readable form for the startup log, e.g. `read-only subprocess probe`. */
		readonly description: string;
		/** True when the probe cannot write, checkpoint, or take the write lock. */
		readonly readOnly: boolean;
	}>;
}
