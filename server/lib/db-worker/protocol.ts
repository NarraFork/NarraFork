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

import type { PublicationRun } from "../../services/agent-runtime/publication-outbox";
import type { AgentTerminalResultReadOptions } from "../../services/agent-runtime/publication-result";
import type { BenchmarkReadParams } from "../../services/benchmark-read";
import type {
	BlockBackfillSliceParams,
	BlockIndexQueueSliceParams,
	BlockProjectionSliceParams,
	BlockReindexSliceParams,
	BlockVerifySliceParams,
} from "./block-backfill-query";
import type { RecallConversationParams } from "./recall-conversation-query";
import type { RecallToolCallParams } from "./recall-tool-call-query";
import type { StorageHistoryBodyParams, StorageHistoryReadParams } from "./storage-history-query";
import type { SubagentActivityParams } from "./subagent-activity-query";

export type { StorageHistoryBodyParams, StorageHistoryBodyResult } from "./storage-history-query";

import type {
	DisplayPageMessagesParams,
	PostgresDisplayPageMessagesParams,
} from "./display-page-protocol";

/** Task names the worker can execute. Read-only by contract. */
export type DbReadTaskName =
	| "compactSummary"
	| "storageScanContext"
	| "storageScanTables"
	| "storageScanSerial"
	| "storageScanCleanupSummaries"
	| "storageScanSessionPreview"
	| "revertSelectionBody"
	| "databaseCleanupContext"
	| "selectRows"
	| "executionPolicyFacts"
	| "toolEditPreview"
	| "knowledgeEntryDetail"
	| "selectDigestBatch"
	| "selectValues"
	| "selectChunks"
	| "domainRead"
	| "displayPageMessages"
	| "displayPageMessagesPostgres"
	| "blockBackfillSlice"
	| "blockVerifySlice"
	| "blockReindexSlice"
	| "blockIndexQueueSlice"
	| "blockProjectionSlice"
	| "recallToolCall"
	| "recallConversation"
	| "storageHistoryRead"
	| "subagentActivity"
	| "storageHistoryBody"
	| "publicationTerminalResult"
	| "benchmarkRead";

/** Shared observation thresholds, never rejection or truncation limits. No database bootstrap. */
export const SELECT_ROWS_MAX_SQL_BYTES = 64 * 1024;
export const SELECT_ROWS_MAX_PARAMS_BYTES = 128 * 1024;
export const SELECT_ROWS_MAX_PARAMS = 4096;
export const SELECT_ROWS_MAX_ROWS = 10_000;
export const SELECT_ROWS_MAX_BYTES = 4 * 1024 * 1024;

/** Internal server-built SELECT (optionally WITH); never caller-provided SQL. */
export interface SelectRowsParams {
	kind: "selectRows";
	sql: string;
	params: Array<string | number | null>;
	maxRows: number;
}

/** Rows in selection order; `columns` are the SQL result names (possibly duplicated). */
export interface SelectRowsResult {
	columns: string[];
	rows: unknown[][];
}

export interface RevertSelectionInspectionSource {
	id: string;
	refId: string;
	narratorId: string;
	contentBytes: number;
	bodyRevision: number | null;
	stateRevision: number | null;
}

export interface RevertSelectionBodyParams extends RevertSelectionInspectionSource {
	kind: "revertSelectionBody";
	blockReads: boolean;
}

export interface SelectDigestBatchEntry {
	ordinal: number;
	query: string;
	params: readonly ReadBind[];
	digest: string;
	rows: number;
	bytes: number;
}
export type EncodedSelectDigestBatchEntry = Omit<SelectDigestBatchEntry, "params"> & {
	params: EncodedReadBind[];
};
export interface SelectDigestBatchParams {
	kind: "selectDigestBatch";
	entries: EncodedSelectDigestBatchEntry[];
}
export interface SelectDigestBatchResult {
	matches: boolean;
	entries: Array<{ ordinal: number; matches: boolean }>;
}
export type ReadBind = string | number | null | boolean | bigint | Uint8Array;
export type EncodedReadBind =
	| string
	| number
	| null
	| { type: "bigint"; value: string }
	| { type: "blob"; value: Uint8Array };
export interface SelectValuesParams {
	kind: "selectValues" | "selectChunks";
	sql: string;
	params: EncodedReadBind[];
	maxRows: number;
}
/** Chunk targets; an oversized row owns its ACK-controlled chunk. */
export const SELECT_CHUNK_MAX_ROWS = 128;
export const SELECT_CHUNK_MAX_BYTES = 256 * 1024;
export interface SelectChunk extends SelectRowsResult {
	sequence: number;
}
export interface SelectChunksResult {
	rowCount: number;
	bytes: number;
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

/** Hard task budgets, including duplicated ids across the total and sample groups. */
export const SESSION_PREVIEW_MAX_SAMPLES = 10;
export const SESSION_PREVIEW_MAX_ID_ENTRIES = 10_000;
export const SESSION_PREVIEW_MAX_ID_LENGTH = 64;
export const SESSION_PREVIEW_MAX_RELATIONS = 32;
export const SESSION_PREVIEW_MAX_RELATION_FIELD_LENGTH = 64;

export interface StorageScanSessionPreviewParams {
	kind: "storageScanSessionPreview";
	narratorIds: string[];
	sampleNarratorIds: string[][];
	relations: StorageScanCleanupRelation[];
}

export class SessionPreviewBudgetError extends Error {
	readonly code = "DATABASE_CLEANUP_PREVIEW_BUDGET_EXCEEDED";

	constructor(detail: string) {
		super(`Session cleanup preview ${detail}`);
		this.name = "SessionPreviewBudgetError";
	}
}

/** Pure preflight on both sides of postMessage; reject, never truncate a deletion plan. */
export function assertSessionPreviewBudget(params: StorageScanSessionPreviewParams): void {
	if (
		!Array.isArray(params.sampleNarratorIds) ||
		params.sampleNarratorIds.length > SESSION_PREVIEW_MAX_SAMPLES
	) {
		throw new SessionPreviewBudgetError("sample limit exceeded");
	}
	if (
		!Array.isArray(params.narratorIds) ||
		!Array.isArray(params.relations) ||
		params.relations.length > SESSION_PREVIEW_MAX_RELATIONS
	) {
		throw new SessionPreviewBudgetError("relation or id list limit exceeded");
	}
	let idEntries = params.narratorIds.length;
	for (const ids of params.sampleNarratorIds) {
		if (!Array.isArray(ids)) throw new SessionPreviewBudgetError("invalid sample id list");
		idEntries += ids.length;
	}
	if (idEntries > SESSION_PREVIEW_MAX_ID_ENTRIES) {
		throw new SessionPreviewBudgetError("id entry limit exceeded");
	}
	for (const ids of [params.narratorIds, ...params.sampleNarratorIds]) {
		for (const id of ids) {
			if (typeof id !== "string" || id.length > SESSION_PREVIEW_MAX_ID_LENGTH) {
				throw new SessionPreviewBudgetError("id length limit exceeded");
			}
		}
	}
	for (const relation of params.relations) {
		if (!relation || typeof relation !== "object") {
			throw new SessionPreviewBudgetError("invalid relation");
		}
		for (const field of [relation.tableName, relation.alias, relation.narratorColumn]) {
			if (typeof field !== "string" || field.length > SESSION_PREVIEW_MAX_RELATION_FIELD_LENGTH) {
				throw new SessionPreviewBudgetError("relation field length limit exceeded");
			}
		}
		if (
			relation.countAs !== undefined &&
			relation.countAs !== "toolCalls" &&
			relation.countAs !== "apiRequests"
		) {
			throw new SessionPreviewBudgetError("invalid relation counter");
		}
	}
}

export interface StorageScanSessionPreviewResult {
	aggregate: {
		narrators: number;
		messages: number;
		toolCalls: number;
		apiRequests: number;
		approxBytes: number;
	};
	sampleBytes: number[];
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

export type DbReadTaskParams =
	| BenchmarkReadParams
	| { kind: "compactSummary"; narratorId: string; messageId: string; fromBlocks: boolean }
	| RecallToolCallParams
	| RecallConversationParams
	| StorageHistoryReadParams
	| SubagentActivityParams
	| StorageHistoryBodyParams
	| {
			kind: "publicationTerminalResult";
			run: PublicationRun;
			options: AgentTerminalResultReadOptions;
			fromBlocks: boolean;
	  }
	| BlockBackfillSliceParams
	| BlockVerifySliceParams
	| BlockReindexSliceParams
	| BlockIndexQueueSliceParams
	| BlockProjectionSliceParams
	| StorageScanContextParams
	| StorageScanTablesParams
	| StorageScanSerialParams
	| StorageScanCleanupSummariesParams
	| StorageScanSessionPreviewParams
	| RevertSelectionBodyParams
	| { kind: "databaseCleanupContext" }
	| SelectRowsParams
	| { kind: "executionPolicyFacts"; narratorId: string }
	| { kind: "toolEditPreview"; toolCallId: string }
	| { kind: "knowledgeEntryDetail"; entryId: string }
	| SelectDigestBatchParams
	| SelectValuesParams
	| import("./domain-protocol").DomainReadParams
	| DisplayPageMessagesParams
	| PostgresDisplayPageMessagesParams;

export interface DbWorkerRequest {
	type: "task";
	requestId: string;
	dbPath: string;
	databaseId?: string;
	deadlineAt?: number;
	params: DbReadTaskParams;
	/** SQL trace span that issued the task; the worker attributes its SQL to a child span. */
	traceParent?: string;
	/** Ephemeral, host-owned session secret. Never logged or echoed in responses. */
	sqlDiagnostic?: import("./sql-diagnostics").SqlDiagnosticConfig;
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
	sequence: number;
}
export type DbWorkerInbound =
	| DbWorkerRequest
	| DbWorkerShutdown
	| DbWorkerCancel
	| DbWorkerChunkAck;

export interface DbWorkerReady {
	type: "ready";
	/** null is source development; frozen runtimes require an exact identity. */
	buildId: string | null;
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
	/** Numeric observations outside the business DTO. */
	diagnostics?: import("./read-budget").ReadBudgetSnapshot;
}

export interface DbWorkerFailure {
	type: "error";
	requestId: string;
	message: string;
	/** Task-specific fail-closed diagnostics; never contains raw JSON. */
	code?: string;
	diagnostic?: ReturnType<typeof import("./failure").workerFailureDetails>;
	statusCode?: number;
	errorType?: "AppError" | "NotFoundError" | "ValidationError" | "ForbiddenError";
	messageCode?: import("@shared/error-catalog").ErrorMessageCode;
	messageParams?: import("@shared/error-catalog").ErrorMessageParams;
	diagnostics?: import("./read-budget").ReadBudgetSnapshot;
}
export interface DbWorkerChunk {
	type: "chunk";
	requestId: string;
	chunk: SelectChunk;
	diagnostics?: import("./read-budget").ReadBudgetSnapshot;
}
export type DbWorkerOutbound =
	| import("./sql-diagnostics").SqlDiagnosticEvent
	| DbWorkerReady
	| DbWorkerProgress
	| DbWorkerSuccess
	| DbWorkerFailure
	| DbWorkerChunk;
