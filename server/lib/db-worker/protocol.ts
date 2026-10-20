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

import type { PublicationTerminalResultReadParams } from "../../services/agent-runtime/publication-result-read";
import type { DatabaseCleanupReadTask } from "../../services/database-cleanup-read";
import type { FileChangeBlobCatalogReadParams } from "../../services/file-change-blob-catalog-read";
import type { FileChangeRetentionInventoryReadParams } from "../../services/file-change-retention-inventory";
import type { CurrentDiffReadParams } from "../../services/git-current-diff-read";
import type { NarratorReadTransactionParams } from "../../services/narrator-read-transactions";
import type { ProjectArchiveReadParams } from "../../services/project-archive/archive-file-reader";
import type { RevertJournalReadTask } from "../../services/revert-journal-read-task";
import type { RevertPlanReadTask } from "../../services/revert-plan-read-task";
import type { RevertSelectionReadTask } from "../../services/revert-selection-read-task";
import type { WorkspaceRecoveryReadParams } from "../../services/workspace-recovery-read";
import type { WorktreeLifecycleReadParams } from "../../services/worktree-lifecycle-read";
import type {
	DisplayPageMessagesParams,
	PostgresDisplayPageMessagesParams,
} from "./display-page-protocol";

/** Task names the worker can execute. Read-only by contract. */
export type DbReadTaskName =
	| "revertSelectionReadV1"
	| "databaseCleanupReadV1"
	| "revertPlanReadV1"
	| "revertJournalReadV1"
	| "publication-terminal-result-v1"
	| "fileChangeBlobCatalogV1"
	| "fileChangeRetentionInventoryV1"
	| "workspace-recovery-effects-v1"
	| "selectRowsV1"
	| "projectArchiveReadV1"
	| "worktree-lifecycle-read-v1"
	| "narrator-read-transaction-v1"
	| "git-current-diff-read-v1"
	| "git-current-diff-validate-v1"
	| "storageScanContext"
	| "storageScanTables"
	| "storageScanSerial"
	| "storageScanCleanupSummaries"
	| "usageHistoryQuery"
	| "searchQuery"
	| "displayPageMessages"
	| "displayPageMessagesPostgres";

/** Shared search budgets; importing these must never bootstrap a database. */
export const SEARCH_QUERY_MAX_SQL_BYTES = 64 * 1024;
export const SEARCH_QUERY_MAX_PARAMS_BYTES = 128 * 1024;
export const SEARCH_QUERY_MAX_PARAMS = 256;
export const SEARCH_QUERY_MAX_ROWS = 10_000;
export const SEARCH_QUERY_MAX_BYTES = 4 * 1024 * 1024;

/** Internal server-built SELECT (optionally WITH); never caller-provided SQL. */
export interface SearchQueryParams {
	kind: "searchQuery";
	sql: string;
	params: Array<string | number | null>;
	maxRows: number;
}

/** Internal, server-built SELECT only. Never accepts SQL from an HTTP caller. */
export interface UsageHistoryQueryParams {
	kind: "usageHistoryQuery";
	sql: string;
	params: Array<string | number | null>;
	/** Selected field names in Drizzle selection order. */
	columns: string[];
	maxRows: number;
}

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
	/**
	 * Schema and dbstat snapshot from `storageScanContext`.
	 *
	 * When present the shard must not run `dbstat` again. Absent only for older callers and tests;
	 * the worker then loads context itself.
	 */
	context?: StorageScanContextResult;
}

/** One read-only connection measures every table. Used when sharded workers cannot run. */
export interface StorageScanSerialParams {
	kind: "storageScanSerial";
	mainBytes: number;
}

export interface StorageScanCleanupRelation {
	tableName: string;
	alias: string;
	narratorColumn: string;
	countAs?: "toolCalls" | "apiRequests";
}

/**
 * Cleanup-candidate byte totals. The narrator id lists are already decided on the main
 * thread; this task only runs the aggregates.
 */
export interface StorageScanCleanupSummariesParams {
	kind: "storageScanCleanupSummaries";
	archivedNarratorIds: string[];
	staleNarratorIds: string[];
	relations: StorageScanCleanupRelation[];
	toolCallCutoffIso: string;
}

export interface StorageScanByteSummary {
	count: number;
	approxBytes: number;
	oldestAt: string | null;
}

export interface StorageScanCleanupSummariesResult {
	archivedApproxBytes: number;
	staleApproxBytes: number;
	toolCalls: StorageScanByteSummary;
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
		/**
		 * True when this table could not be measured (typically SQLITE_BUSY against an exclusive
		 * writer). The accompanying zeroes then mean UNKNOWN, not empty.
		 *
		 * Declared here because the worker has always sent it and the main thread has always read
		 * it, while the wire type stayed silent — `storage-scan-runner.ts` had to recover it through
		 * a defensive cast, which this declaration replaced. An undeclared field both sides depend
		 * on is one refactor away from being dropped as dead weight, and dropping it turns "could
		 * not read" back into "weighs nothing".
		 *
		 * Optional rather than always-present: absent means "measured fine", so only a literal
		 * `true` marks the numbers as unknown.
		 */
		readFailed?: boolean;
	}>;
}

export interface SelectRowsParams {
	kind: "selectRowsV1";
	/** Server-built SQL only. The connection is read-only and query_only. */
	sql: string;
	params: Array<string | number | bigint | boolean | null | Uint8Array>;
	mode: "values" | "objects";
	/** Opt-in local timings for fixed diagnostic query sites; never SQL/bind metadata. */
	diagnosticTiming?: true;
}

export type DbReadTaskParams =
	| RevertSelectionReadTask
	| DatabaseCleanupReadTask
	| RevertPlanReadTask
	| RevertJournalReadTask
	| PublicationTerminalResultReadParams
	| FileChangeBlobCatalogReadParams
	| FileChangeRetentionInventoryReadParams
	| WorkspaceRecoveryReadParams
	| SelectRowsParams
	| ProjectArchiveReadParams
	| WorktreeLifecycleReadParams
	| NarratorReadTransactionParams
	| CurrentDiffReadParams
	| StorageScanContextParams
	| StorageScanTablesParams
	| StorageScanSerialParams
	| StorageScanCleanupSummariesParams
	| UsageHistoryQueryParams
	| SearchQueryParams
	| DisplayPageMessagesParams
	| PostgresDisplayPageMessagesParams;

export interface DbWorkerRequest {
	type: "task";
	requestId: string;
	dbPath: string;
	params: DbReadTaskParams;
}

export interface DbWorkerShutdown {
	type: "shutdown";
}

export interface DbWorkerCancel {
	type: "cancel";
	requestId: string;
}

export interface DbWorkerChunkAck {
	type: "chunkAck";
	requestId: string;
}

export interface DbWorkerCloseConnection {
	type: "closeConnection";
	requestId: string;
	dbPath: string;
}

export interface DbWorkerConnectionClosed {
	type: "connectionClosed";
	requestId: string;
}

export type DbWorkerInbound =
	| DbWorkerRequest
	| DbWorkerShutdown
	| DbWorkerCancel
	| DbWorkerChunkAck
	| DbWorkerCloseConnection;

export interface DbWorkerChunk {
	type: "chunk";
	requestId: string;
	rows: unknown[];
	bytes: number;
}

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

export function readWorkerDomExceptionName(
	error: unknown,
): "AbortError" | "TimeoutError" | undefined {
	return error instanceof DOMException &&
		(error.name === "AbortError" || error.name === "TimeoutError")
		? error.name
		: undefined;
}

export interface DbWorkerFailure {
	domExceptionName?: "AbortError" | "TimeoutError";
	applicationError?: {
		name: string;
		statusCode: number;
		messageCode?: import("../errors").AppErrorLocalization["messageCode"];
		messageParams?: import("../errors").AppErrorLocalization["messageParams"];
	};
	type: "error";
	requestId: string;
	message: string;
	/** Task-specific fail-closed diagnostics; never contains raw JSON. */
	code?: string;
}

export type DbWorkerOutbound =
	| DbWorkerReady
	| DbWorkerProgress
	| DbWorkerSuccess
	| DbWorkerFailure
	| DbWorkerChunk
	| DbWorkerConnectionClosed;
