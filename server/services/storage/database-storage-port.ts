/**
 * The database capability the storage view needs, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * "How much space does the database occupy, and what is in it" was expressed directly as
 * `databaseCleanupService.scanDatabaseBreakdown()` — a SQLite-shaped call whose result is a
 * page/freelist/dbstat report. The storage scan therefore could not be reasoned about without
 * knowing which engine was underneath, and a second backend would have had to reproduce that
 * shape rather than the requirement.
 *
 * So the requirement is written here instead: a byte total, a serializable detail payload for
 * the settings page, cancellation, progress, and bounded output. This file imports nothing
 * dialect-specific — no driver, no Drizzle, no `server/db`, no schema, no worker protocol — and
 * a test asserts exactly that, because an accidental import here is how a "portable" contract
 * silently becomes a SQLite one.
 *
 * WHAT THE CONTRACT DELIBERATELY DOES NOT EXPOSE
 * ----------------------------------------------
 * No `Database`, `Statement`, Drizzle instance, connection string or worker handle crosses this
 * boundary. A caller can start a measurement, watch it, cancel it and read the result; it cannot
 * reach the engine. That is the whole point: the storage scan is the single heaviest read in the
 * product, and the reason it is safe today is that its execution strategy (read workers, shard
 * plan, main-thread fallback) is an implementation detail of one adapter.
 *
 * UNSUPPORTED MEANS UNSUPPORTED
 * -----------------------------
 * A backend that cannot answer must REJECT with {@link DatabaseStorageUnsupportedError}. It must
 * not return zeroes, empty category arrays, or a report with every table missing: a syntactically
 * perfect storage page claiming a multi-gigabyte database weighs nothing is strictly worse than
 * an honest "this backend cannot measure that", because an operator acts on the former. The same
 * rule already applies one level down, where a failed per-table read is reported as
 * `readFailed: true` rather than as a zero.
 */

// ── Capabilities ───────────────────────────────────────────────────────────

/**
 * What a backend can actually report.
 *
 * These flags are FALSIFIABLE, not decorative: the contract test asserts that a report contains
 * the corresponding section if and only if the flag is set, so a backend cannot claim a capability
 * it does not deliver (or hide one it does).
 */
export interface DatabaseStorageCapabilities {
	/** Backend identity, for logs and for the text an unsupported failure shows. */
	readonly backend: string;
	/**
	 * Can the backend measure its own storage at all? False means {@link DatabaseStoragePort.scanBreakdown}
	 * always rejects with {@link DatabaseStorageUnsupportedError}.
	 */
	readonly breakdown: boolean;
	/**
	 * Does the report account for space the engine holds but is not using (SQLite's freelist,
	 * another engine's dead tuples)? When false the report says nothing about reclaimable space —
	 * it does not say there is none.
	 */
	readonly freeSpaceAccounting: boolean;
	/** Does the report size what the cleanup actions would actually free? */
	readonly cleanupCandidates: boolean;
	/**
	 * Does the heavy part of the measurement run off the thread serving the request?
	 *
	 * Read at access time rather than frozen at construction: an adapter may lose its off-thread
	 * path at runtime (workers disabled by configuration, or shut down for a maintenance window)
	 * and must then report that honestly instead of continuing to claim it.
	 */
	readonly offRequestThreadScan: boolean;
}

// ── Limits ─────────────────────────────────────────────────────────────────

/**
 * Default wall-clock budget for one whole measurement.
 *
 * Deliberately far above every internal budget it contains (the read-worker pool allows 30s for
 * the schema task and 120s per table shard, and the serial main-thread fallback was measured at
 * ~4.9s over 116 tables on a 5.3 GB database). This is a backstop against a measurement that
 * never returns at all — not a performance target, and not a replacement for those budgets. Set
 * it lower only when a caller genuinely prefers "no answer" to "a late answer".
 */
export const DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS = 300_000;

/**
 * Output ceilings the report must respect, enforced by {@link enforceReportLimits}.
 *
 * The report is serialized into an HTTP response and into a cached job state, so its size has to
 * be bounded by contract rather than by whatever the backend happens to produce. A backend that
 * enumerated every table (this schema has ~120, and the licenses page shows what four digits of
 * rows does to a payload) would otherwise grow the response without anything saying it may not.
 */
export interface DatabaseStorageReportLimits {
	/** Largest tables carried in the report. */
	readonly maxTopTables: number;
	/** Failing table NAMES carried in the report. The count stays exact regardless. */
	readonly maxFailedTableNames: number;
}

export const DEFAULT_DATABASE_STORAGE_REPORT_LIMITS: DatabaseStorageReportLimits = Object.freeze({
	maxTopTables: 12,
	maxFailedTableNames: 20,
});

// ── Errors ─────────────────────────────────────────────────────────────────

/** The backend cannot answer this question at all. Never signalled by an empty or zeroed result. */
export class DatabaseStorageUnsupportedError extends Error {
	readonly code = "DATABASE_STORAGE_UNSUPPORTED";
	constructor(
		readonly backend: string,
		readonly capability: keyof Omit<DatabaseStorageCapabilities, "backend">,
	) {
		super(`database backend "${backend}" does not support ${capability}`);
		this.name = "DatabaseStorageUnsupportedError";
	}
}

/**
 * The caller's signal aborted the measurement.
 *
 * Distinct from the timeout below because the two mean opposite things to a caller: a cancellation
 * was requested and needs no report, whereas an exhausted budget is a failure the operator should
 * be told about. Collapsing them made a cancelled scan and a hung one indistinguishable.
 */
export class DatabaseStorageScanCancelledError extends Error {
	readonly code = "DATABASE_STORAGE_SCAN_CANCELLED";
	constructor() {
		super("database storage measurement cancelled");
		this.name = "DatabaseStorageScanCancelledError";
	}
}

/** The measurement did not finish inside its budget. */
export class DatabaseStorageScanTimedOutError extends Error {
	readonly code = "DATABASE_STORAGE_SCAN_TIMEOUT";
	constructor(readonly budgetMs: number) {
		super(`database storage measurement exceeded its ${budgetMs}ms budget`);
		this.name = "DatabaseStorageScanTimedOutError";
	}
}

// ── The port ───────────────────────────────────────────────────────────────

export interface DatabaseStorageScanProgress {
	/** Units finished so far. Monotonic within one scan. */
	done: number;
	total: number;
	/**
	 * Name of the unit just finished, for the progress line the UI renders.
	 *
	 * A short label by contract. Anything a backend could produce in bulk belongs in the report,
	 * where the limits above apply.
	 */
	tableName: string;
}

export interface DatabaseStorageScanOptions {
	/** Cancels the measurement. Rejects with {@link DatabaseStorageScanCancelledError}. */
	signal?: AbortSignal;
	/**
	 * Coarse progress, invoked as units complete. Callers coalesce, so an adapter is free to call
	 * this often; it must not be treated as a delivery guarantee for every unit.
	 */
	onProgress?: (progress: DatabaseStorageScanProgress) => void;
	/** Overrides {@link DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS}. `0` means "already exhausted". */
	budgetMs?: number;
}

export interface DatabaseStorageReport {
	/** Total bytes the backend's own storage occupies. */
	sizeBytes: number;
	/**
	 * Backend-shaped, JSON-serializable detail for the storage page.
	 *
	 * Intentionally loose: what "inside the database" means is exactly the part that differs
	 * between engines, and inventing a lowest-common-denominator schema for it would either lose
	 * SQLite's page accounting or fabricate fields a second backend cannot fill. What IS fixed is
	 * that it is plain data (no handles, no lazy accessors) and that it respects
	 * {@link DatabaseStorageReportLimits}.
	 */
	details: Record<string, unknown>;
	/**
	 * True when part of the measurement could not be read.
	 *
	 * Numbers in an incomplete report are lower bounds, and the parts that failed are UNKNOWN
	 * rather than empty. Callers that present a total must say so.
	 */
	incomplete: boolean;
}

export interface DatabaseStoragePort {
	/** Read at access time; see {@link DatabaseStorageCapabilities.offRequestThreadScan}. */
	readonly capabilities: DatabaseStorageCapabilities;
	/**
	 * Measure the database.
	 *
	 * Rejects with {@link DatabaseStorageUnsupportedError} when `capabilities.breakdown` is false,
	 * {@link DatabaseStorageScanCancelledError} when the caller's signal aborts, and
	 * {@link DatabaseStorageScanTimedOutError} when the budget runs out. Any other rejection is a
	 * genuine failure and is passed through unchanged.
	 */
	scanBreakdown(options?: DatabaseStorageScanOptions): Promise<DatabaseStorageReport>;
}

// ── Budget enforcement ─────────────────────────────────────────────────────

/**
 * Run a measurement under a wall-clock budget, cancelling the WORK when it expires.
 *
 * Lives in the port, not in an adapter, because `budgetMs` is a promise the contract makes to
 * callers: "this call always settles". An adapter-local implementation would make the guarantee
 * true of whichever backend happened to implement it and quietly false of the next one — which is
 * exactly what the contract test caught when a second backend ignored the budget and returned a
 * perfectly good report for a call whose budget had already expired. This is the one piece of
 * behaviour every adapter shares, in the same way the registration slice shares its redemption
 * rules while sharing no storage code.
 *
 * Cancelling the work rather than merely rejecting the caller matters: an abandoned measurement
 * keeps read workers (or, on a fallback path, the request thread) busy producing a result nobody
 * is waiting for. The linked signal also forwards the caller's own abort, so an adapter has
 * exactly one signal to understand.
 *
 * Dialect-free: `AbortController` and `setTimeout` only.
 */
export async function runWithScanBudget<T>(
	budgetMs: number,
	signal: AbortSignal | undefined,
	operation: (linked: AbortSignal) => Promise<T>,
): Promise<T> {
	if (signal?.aborted) throw new DatabaseStorageScanCancelledError();

	const controller = new AbortController();
	let expired = false;
	const onCallerAbort = () => controller.abort();
	signal?.addEventListener("abort", onCallerAbort, { once: true });

	// A non-positive budget means it is ALREADY gone. `setTimeout(…, 0)` would still let the
	// operation run a turn — and on a fast backend, run to completion — so the abort has to happen
	// synchronously here. Treating `0` as "no budget" is how an unbounded scan slips back in.
	if (budgetMs <= 0) {
		expired = true;
		controller.abort();
	}
	const timer =
		budgetMs > 0
			? setTimeout(() => {
					expired = true;
					controller.abort();
				}, budgetMs)
			: undefined;

	try {
		const result = await operation(controller.signal);
		// A backend that ignores the signal can still return successfully after the budget expired.
		// Honouring the budget only when the backend cooperates would make it advisory, so the
		// result is discarded here rather than handed back as if it had been in time.
		if (expired) throw new DatabaseStorageScanTimedOutError(budgetMs);
		if (signal?.aborted) throw new DatabaseStorageScanCancelledError();
		return result;
	} catch (error) {
		// Order matters: an expired budget aborts the same signal a cancellation does, so the
		// timeout has to be recognised before the abort could be read as the caller's.
		if (expired) throw new DatabaseStorageScanTimedOutError(budgetMs);
		// Classified by the SIGNAL, never by the message. Text matching would be both incomplete
		// (the paths below spell their aborts several different ways) and dangerous in the other
		// direction: an unrelated failure whose message happens to contain "aborted" would be
		// reported as a cancellation, i.e. silently swallowed. If the caller did not ask to stop,
		// this is a real failure and it propagates unchanged.
		if (signal?.aborted) throw new DatabaseStorageScanCancelledError();
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onCallerAbort);
	}
}

// ── Limit enforcement ──────────────────────────────────────────────────────

/** Which parts of a report the port had to cut down, so the truncation is never silent. */
export interface DatabaseStorageReportTruncation {
	topTables?: { kept: number; dropped: number };
	failedTableNames?: { kept: number; dropped: number };
}

function clampArray<T>(value: unknown, max: number): { list: T[]; dropped: number } | null {
	if (!Array.isArray(value) || value.length <= max) return null;
	return { list: value.slice(0, max) as T[], dropped: value.length - max };
}

/**
 * Apply {@link DatabaseStorageReportLimits} to a report, reporting what was cut.
 *
 * A pure function rather than adapter-internal trimming, for two reasons: every adapter has to
 * obey the same ceilings (so the rule belongs to the contract, not to one implementation), and it
 * is the only part of the limit story that can be tested without a database.
 *
 * Never mutates its input. The report is handed to a shared cache that other requests read, so
 * trimming in place would rewrite a payload someone else is already holding.
 */
export function enforceReportLimits(
	report: DatabaseStorageReport,
	limits: DatabaseStorageReportLimits = DEFAULT_DATABASE_STORAGE_REPORT_LIMITS,
): DatabaseStorageReport {
	const details = { ...report.details };
	const truncation: DatabaseStorageReportTruncation = {};

	const topTables = clampArray(details.topTables, limits.maxTopTables);
	if (topTables) {
		details.topTables = topTables.list;
		truncation.topTables = { kept: topTables.list.length, dropped: topTables.dropped };
	}

	const failures = details.readFailures;
	if (failures && typeof failures === "object" && !Array.isArray(failures)) {
		const record = failures as Record<string, unknown>;
		const names = clampArray<string>(record.tableNames, limits.maxFailedTableNames);
		if (names) {
			// `tableCount` is left alone on purpose: it is the true total, and the whole point of
			// keeping it exact is that the UI can say "20 of 137 shown" rather than under-reporting.
			details.readFailures = { ...record, tableNames: names.list };
			truncation.failedTableNames = { kept: names.list.length, dropped: names.dropped };
		}
	}

	if (Object.keys(truncation).length > 0) details.truncatedByPortLimits = truncation;
	return { ...report, details };
}
