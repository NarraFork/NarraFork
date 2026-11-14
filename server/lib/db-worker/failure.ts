import { RUNTIME_BUILD_ID } from "../runtime-target";

/** No driver text or arbitrary user-controlled code crosses the SQLite error boundary. */
export function safeSqliteCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^SQLITE_[A-Z_]{1,64}$/.test(code) ? code : undefined;
}

export function isSqliteLockError(error: unknown): boolean {
	const code = safeSqliteCode(error);
	return code !== undefined && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code);
}

/** Source mode accepts older fixtures; frozen processes never dispatch to an unproven build. */
export function assertWorkerBuildId(buildId: unknown): void {
	if (RUNTIME_BUILD_ID !== null && buildId !== RUNTIME_BUILD_ID) {
		throw Object.assign(new Error("Database worker build identity mismatch"), {
			code: "DB_WORKER_BUILD_MISMATCH",
		});
	}
}

const WORKER_ERROR_TYPES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"AbortError",
	"TimeoutError",
	"SystemError",
	"SQLiteError",
	"PostgresError",
	"ResolveMessage",
	"BuildMessage",
	"DisplayPageReadError",
	"WorkerStartupError",
	"WorkerCleanupError",
	"TaskQueueError",
	"WorkerPoolError",
	"DbReadTaskOverloadedError",
	"DbReadTaskTimeoutError",
	"DbReadTaskExecutionError",
	"WorkersUnavailableError",
]);
const WORKER_ERROR_CODES = new Set([
	"TIMEOUT",
	"EXITED",
	"ERR_WORKER_INIT_FAILED",
	"ERR_WORKER_PATH",
	"ERR_WORKER_OUT_OF_MEMORY",
	"ERR_MODULE_NOT_FOUND",
	"MODULE_NOT_FOUND",
	"ERR_INVALID_ARG_TYPE",
	"DB_WORKER_BUILD_MISMATCH",
	"DB_READ_TASK_OVERLOADED",
	"DB_READ_TASK_TIMEOUT",
	"DISPLAY_PAGE_READER_UNAVAILABLE",
	"TASK_QUEUE_FULL",
	"TASK_QUEUE_TIMEOUT",
	"TASK_QUEUE_CLOSED",
	"WORKER_POOL_CLOSED",
	"WORKER_POOL_UNAVAILABLE",
	"SQLITE_ERROR",
	"SQLITE_INTERNAL",
	"SQLITE_PERM",
	"SQLITE_ABORT",
	"SQLITE_BUSY",
	"SQLITE_BUSY_RECOVERY",
	"SQLITE_BUSY_SNAPSHOT",
	"SQLITE_BUSY_TIMEOUT",
	"SQLITE_LOCKED",
	"SQLITE_LOCKED_SHAREDCACHE",
	"SQLITE_LOCKED_VTAB",
	"SQLITE_NOMEM",
	"SQLITE_READONLY",
	"SQLITE_INTERRUPT",
	"SQLITE_IOERR",
	"SQLITE_CORRUPT",
	"SQLITE_NOTFOUND",
	"SQLITE_FULL",
	"SQLITE_CANTOPEN",
	"SQLITE_PROTOCOL",
	"SQLITE_EMPTY",
	"SQLITE_SCHEMA",
	"SQLITE_TOOBIG",
	"SQLITE_CONSTRAINT",
	"SQLITE_CONSTRAINT_CHECK",
	"SQLITE_CONSTRAINT_FOREIGNKEY",
	"SQLITE_CONSTRAINT_NOTNULL",
	"SQLITE_CONSTRAINT_PRIMARYKEY",
	"SQLITE_CONSTRAINT_UNIQUE",
	"SQLITE_CONSTRAINT_TRIGGER",
	"SQLITE_MISMATCH",
	"SQLITE_MISUSE",
	"SQLITE_NOLFS",
	"SQLITE_AUTH",
	"SQLITE_FORMAT",
	"SQLITE_RANGE",
	"SQLITE_NOTADB",
	"SQLITE_NOTICE",
	"SQLITE_WARNING",
]);

/** Project errors AND received diagnostics onto finite scalar categories; never retain raw text. */
export function workerFailureDetails(error: unknown, _startup: boolean) {
	try {
		const value = error as {
			name?: unknown;
			errorType?: unknown;
			code?: unknown;
			error?: unknown;
			cause?: unknown;
		} | null;
		// Compiled-worker startup wraps the last native failure in an Error cause. Inspect at
		// most one level, without retaining/traversing nested diagnostics or error text.
		const nested = value?.error ?? value?.cause;
		const candidate = nested instanceof Error ? (nested as typeof value) : value;
		const name = candidate?.name ?? candidate?.errorType;
		const code = candidate?.code ?? value?.code;
		return {
			errorType: typeof name === "string" && WORKER_ERROR_TYPES.has(name) ? name : "WorkerError",
			code: typeof code === "string" && WORKER_ERROR_CODES.has(code) ? code : undefined,
		};
	} catch {
		// Diagnostic getters/proxies must not replace the original failure or prevent cleanup.
		return { errorType: "WorkerError", code: undefined };
	}
}
