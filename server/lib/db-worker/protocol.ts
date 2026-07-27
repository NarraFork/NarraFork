/**
 * Wire protocol between the main thread and the database read-worker pool.
 *
 * Dependency-free on purpose: both sides import this, and the worker side must not transitively
 * reach `server/db/index.ts` (see storage-scan-queries.ts for why that would be destructive).
 */

/**
 * How long a worker gets to report `ready` once we believe its entry path is correct.
 *
 * Generous on purpose: this covers a cold thread start plus module evaluation on a loaded machine.
 */
export const DB_WORKER_READY_TIMEOUT_MS = 10_000;

/**
 * Ready budget while PROBING candidate entry paths in a compiled binary (see pool.ts).
 *
 * A wrong path is rejected by the module resolver almost immediately (measured: ~3ms to the `error`
 * event), so a probe never legitimately needs the full budget. Using the full one meant three bad
 * candidates could burn 30s before the pool even counted a single spawn failure.
 */
export const DB_WORKER_PROBE_READY_TIMEOUT_MS = 1_500;

/** Task names the worker can execute. Read-only by contract. */
export type DbReadTaskName = "storageScanContext" | "storageScanTables";

export interface StorageScanContextParams {
	kind: "storageScanContext";
}

export interface StorageScanContextResult {
	pageSize: number;
	pageCount: number;
	rawFreelistBytes: number;
	/** Table names in deterministic order, plus their kind. */
	tables: Array<{ name: string; kind: string }>;
	dbstatSupported: boolean;
	/** Serialized as entries because Map does not survive some structured-clone edge cases cleanly. */
	dbstatBytes: Array<[string, number]>;
	indexesByTable: Array<[string, string[]]>;
}

export interface StorageScanTablesParams {
	kind: "storageScanTables";
	/** The shard: which tables this worker should measure. */
	tableNames: string[];
}

export interface StorageScanTablesResult {
	tables: Array<{
		name: string;
		category: string;
		kind: string;
		rowCount: number | null;
		approxContentBytes: number;
		diskBytes: number;
		indexBytes: number;
		totalBytes: number;
	}>;
}

export type DbReadTaskParams = StorageScanContextParams | StorageScanTablesParams;

export interface DbWorkerRequest {
	type: "task";
	requestId: string;
	dbPath: string;
	params: DbReadTaskParams;
}

export interface DbWorkerShutdown {
	type: "shutdown";
}

export type DbWorkerInbound = DbWorkerRequest | DbWorkerShutdown;

export interface DbWorkerReady {
	type: "ready";
}

export interface DbWorkerProgress {
	type: "progress";
	requestId: string;
	/** Table just finished, for scan progress reporting. */
	tableName: string;
	done: number;
	total: number;
}

export interface DbWorkerSuccess {
	type: "result";
	requestId: string;
	// biome-ignore lint/suspicious/noExplicitAny: payload shape is task-specific
	result: any;
	durationMs: number;
}

export interface DbWorkerFailure {
	type: "error";
	requestId: string;
	message: string;
}

export type DbWorkerOutbound = DbWorkerReady | DbWorkerProgress | DbWorkerSuccess | DbWorkerFailure;
