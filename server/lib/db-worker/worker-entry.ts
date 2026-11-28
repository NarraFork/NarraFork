/**
 * Database read-worker entry point.
 *
 * Runs heavy read tasks (storage scan, bounded SELECTs, display pages) on its OWN read-only
 * `bun:sqlite` connection, so the seconds-long scans never block the main thread's event loop.
 *
 * ## Import discipline (enforced by a test)
 *
 * This module and everything it imports must NOT reach `server/db/index.ts`. Doing so re-runs the
 * entire DB bootstrap inside this thread: a second read-write connection, duplicate
 * migrations/`ensureFts`, a duplicate WAL-checkpoint timer, and `consumeCleanShutdownState` — which
 * clears the clean-shutdown marker and makes the next startup think the process crashed. That is
 * why the query logic lives in `storage-scan-queries.ts`, which takes an explicit `Database`.
 *
 * The connection is opened `readonly` so this thread can never take the write lock or mutate data.
 */

import { Database } from "bun:sqlite";
import { parentPort } from "node:worker_threads";
import { readPublicationTerminalSnapshot } from "../../services/agent-runtime/publication-reader";
import { runBenchmarkRead } from "../../services/benchmark-read";
import {
	collectSessionAggregateStats,
	loadScanContext,
	measurementContextFromSnapshot,
	measureTable,
	type ScanTableRef,
	scanDatabaseObjectStorage,
	summarizeToolCallPayloads,
} from "../../services/storage-scan-queries";
import { RUNTIME_BUILD_ID } from "../runtime-target";
import { instrumentSqliteConnection, runInSqlTraceSpan, startSqlTraceSpan } from "../sql-trace";
import {
	runBlockBackfillSlice,
	runBlockIndexQueueSlice,
	runBlockProjectionSlice,
	runBlockReindexSlice,
	runBlockVerifySlice,
} from "./block-backfill-query";
import { readCompactSummary } from "./compact-summary-query";
import { DisplayPageReadError } from "./display-page-protocol";
import { runDisplayPageQuery } from "./display-page-query";
import { isDomainReadStreamTask } from "./domain-protocol";
import { runDomainRead, runDomainReadStream } from "./domain-task-registry";
import { DbReadError, readAborted, workerFailure } from "./errors";
import { readExecutionPolicySnapshot } from "./execution-policy-query";
import { workerFailureDetails } from "./failure";
import { readRevertSelectionBody } from "./file-revert-selection-body-query";
import { readKnowledgeEntryDetail } from "./knowledge-entry-query";
import { runPostgresDisplayPageQuery } from "./postgres-display-page-query";
import type {
	DbWorkerInbound,
	DbWorkerOutbound,
	StorageScanCleanupSummariesParams,
	StorageScanCleanupSummariesResult,
	StorageScanContextResult,
	StorageScanSessionPreviewParams,
	StorageScanSessionPreviewResult,
	StorageScanTablesParams,
	StorageScanTablesResult,
} from "./protocol";
import { assertSessionPreviewBudget } from "./protocol";
import { ReadBudgetMeter } from "./read-budget";
import { readRecallConversation } from "./recall-conversation-query";
import { readRecallToolCall } from "./recall-tool-call-query";
import { runSelectDigestBatch } from "./select-digest-batch";
import { runSelectChunks, runSelectValues } from "./select-extended";
import { runSelectRows } from "./select-rows";
import { createWorkerSqlDiagnostics } from "./sql-diagnostics";
import { readDatabaseCleanupContext } from "./storage-cleanup-context-query";
import { runStorageHistoryBody, runStorageHistoryRead } from "./storage-history-query";
import { readSubagentActivity } from "./subagent-activity-query";
import { readToolEditPreviewSnapshot } from "./tool-edit-preview-query";

if (!parentPort) throw new Error("Database reader requires a worker thread");
const port = parentPort;
const sqlDiagnostics = createWorkerSqlDiagnostics((event) => port.postMessage(event));

/** Cached read-only connections, keyed by path. A worker usually only ever sees one path. */
const connections = new Map<string, Database>();

function getConnection(identity: string, dbPath: string = identity): Database {
	const existing = connections.get(identity);
	if (existing) return sqlDiagnostics.instrument(existing);
	// Keep the existing trace wrapper inside this instance wrapper, unchanged.
	const db = sqlDiagnostics.instrument(
		instrumentSqliteConnection(new Database(dbPath, { readonly: true })),
	);
	db.run("PRAGMA query_only = ON");
	// Match the main connection's read tuning. No write pragmas: this handle is read-only.
	try {
		db.run("PRAGMA cache_size = -16000");
		db.run("PRAGMA temp_store = MEMORY");
		db.run("PRAGMA mmap_size = 268435456");
		// Fail fast instead of parking this thread inside SQLite's busy handler.
		db.run("PRAGMA busy_timeout = 250");
	} catch {
		// Tuning is best-effort; a working connection matters more.
	}
	connections.set(identity, db);
	return db;
}

function post(message: DbWorkerOutbound): void {
	port.postMessage(message);
}

function runStorageScanContext(dbPath: string): StorageScanContextResult {
	const sqlite = getConnection(dbPath);
	const context = loadScanContext(sqlite);
	return {
		pageSize: context.pageSize,
		pageCount: context.pageCount,
		rawFreelistBytes: context.rawFreelistBytes,
		tables: context.tables.map((table) => ({ name: table.name, kind: table.kind })),
		dbstatSupported: context.dbstat.supported,
		dbstatBytes: [...context.dbstat.bytesByName.entries()],
		indexesByTable: [...context.indexesByTable.entries()],
	};
}

function runStorageScanTables(
	dbPath: string,
	requestId: string,
	params: StorageScanTablesParams,
	signal: AbortSignal,
): StorageScanTablesResult {
	const sqlite = getConnection(dbPath);
	// A snapshot from the context task already walked dbstat. Loading it again would repeat that
	// full page scan once per shard.
	const context = params.context
		? measurementContextFromSnapshot(params.context)
		: loadScanContext(sqlite);
	const byName = new Map(context.tables.map((table) => [table.name, table]));
	const wanted: ScanTableRef[] = params.tableNames
		.map((name) => byName.get(name))
		.filter((table): table is ScanTableRef => Boolean(table));

	const tables: StorageScanTablesResult["tables"] = [];
	for (const [index, table] of wanted.entries()) {
		// A running statement cannot be interrupted. Stop before the next table.
		if (signal.aborted) throw new Error("storage scan aborted");
		const summary = measureTable(sqlite, table, context);
		post({
			type: "progress",
			requestId,
			tableName: table.name,
			done: index + 1,
			total: wanted.length,
		});
		tables.push(summary);
	}
	return { tables };
}

function runStorageScanSerial(
	dbPath: string,
	requestId: string,
	mainBytes: number,
	signal: AbortSignal,
) {
	const sqlite = getConnection(dbPath);
	return scanDatabaseObjectStorage(sqlite, mainBytes, {
		onTableMeasured: (tableName, index, total) => {
			if (signal.aborted) throw new Error("storage scan aborted");
			post({ type: "progress", requestId, tableName, done: index, total });
		},
	});
}

function runStorageScanCleanupSummaries(
	dbPath: string,
	params: StorageScanCleanupSummariesParams,
): StorageScanCleanupSummariesResult {
	const sqlite = getConnection(dbPath);
	return {
		archivedApproxBytes: collectSessionAggregateStats(
			sqlite,
			params.archivedNarratorIds,
			params.relations,
		).approxBytes,
		staleApproxBytes: collectSessionAggregateStats(
			sqlite,
			params.staleNarratorIds,
			params.relations,
		).approxBytes,
		toolCalls: summarizeToolCallPayloads(sqlite, params.toolCallCutoffIso),
	};
}

function runStorageScanSessionPreview(
	dbPath: string,
	params: StorageScanSessionPreviewParams,
	signal: AbortSignal,
): StorageScanSessionPreviewResult {
	assertSessionPreviewBudget(params);
	const sqlite = getConnection(dbPath);
	const aggregate = collectSessionAggregateStats(sqlite, params.narratorIds, params.relations);
	const sampleBytes = params.sampleNarratorIds.map((ids) => {
		if (signal.aborted) throw new Error("Session cleanup preview aborted");
		return collectSessionAggregateStats(sqlite, ids, params.relations).approxBytes;
	});
	return { aggregate, sampleBytes };
}

const activeTasks = new Map<string, AbortController>();
const acknowledgements = new Map<string, { sequence: number; resolve: () => void }>();
function emitChunk(
	requestId: string,
	chunk: import("./protocol").SelectChunk,
	signal: AbortSignal,
	deadlineAt: number,
	meter: ReadBudgetMeter,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			acknowledgements.delete(requestId);
		};
		const abort = () => {
			cleanup();
			reject(readAborted());
		};
		const timer = setTimeout(
			() => {
				cleanup();
				reject(new DbReadError("DB_READ_TASK_TIMEOUT", "database read consumer deadline expired"));
			},
			Math.max(0, deadlineAt - Date.now()),
		);
		acknowledgements.set(requestId, {
			sequence: chunk.sequence,
			resolve: () => {
				cleanup();
				resolve();
			},
		});
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		post({ type: "chunk", requestId, chunk, diagnostics: meter.snapshot() });
	});
}
port.on("message", async (message: DbWorkerInbound) => {
	if (!message || typeof message !== "object") return;
	if (message.type === "chunkAck") {
		const waiting = acknowledgements.get(message.requestId);
		if (waiting?.sequence === message.sequence) waiting.resolve();
		return;
	}
	if (message.type === "cancel") {
		activeTasks.get(message.requestId)?.abort();
		return;
	}
	if (message.type === "shutdown") {
		for (const task of activeTasks.values()) task.abort();
		for (const db of connections.values()) {
			try {
				db.close();
			} catch {
				/* Native exit remains the release confirmation. */
			}
		}
		connections.clear();
		process.exit(0);
	}
	if (message.type !== "task") return;
	const startedAt = Date.now();
	const controller = new AbortController();
	const meter = new ReadBudgetMeter();
	const deadlineAt = message.deadlineAt ?? startedAt + 30_000;
	const connection = () => getConnection(message.databaseId ?? message.dbPath, message.dbPath);
	const check = () => {
		if (controller.signal.aborted) throw readAborted();
		if (message.params.kind !== "displayPageMessagesPostgres" && Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "database read task timed out");
	};
	const emit = (chunk: import("./protocol").SelectChunk) =>
		emitChunk(message.requestId, chunk, controller.signal, deadlineAt, meter);
	activeTasks.set(message.requestId, controller);
	const sqlSpan = startSqlTraceSpan(
		"worker",
		`db-worker ${message.params.kind}`,
		undefined,
		message.traceParent,
	);
	try {
		check();
		const params = message.params;
		const result = await sqlDiagnostics.run(message.sqlDiagnostic, message.requestId, () =>
			runInSqlTraceSpan(sqlSpan, async () => {
				let result: unknown;
				switch (params.kind) {
					case "storageHistoryRead":
						result = runStorageHistoryRead(connection(), params);
						break;
					case "storageHistoryBody":
						result = runStorageHistoryBody(connection(), params);
						break;
					case "displayPageMessagesPostgres":
						result = await runPostgresDisplayPageQuery(
							message.dbPath,
							{ ...params, kind: "displayPageMessages" },
							controller.signal,
						);
						break;
					case "blockBackfillSlice":
						result = runBlockBackfillSlice(connection(), params);
						break;
					case "blockVerifySlice":
						result = runBlockVerifySlice(connection(), params);
						break;
					case "blockReindexSlice":
						result = runBlockReindexSlice(connection(), params);
						break;
					case "blockIndexQueueSlice":
						result = runBlockIndexQueueSlice(connection(), params);
						break;
					case "blockProjectionSlice":
						result = runBlockProjectionSlice(connection(), params);
						break;
					case "displayPageMessages":
						result = runDisplayPageQuery(connection(), params);
						break;
					case "selectRows":
						result = runSelectRows(connection(), params, meter);
						break;
					case "selectValues":
						result = runSelectValues(connection(), params, meter);
						break;
					case "selectChunks":
						result = await runSelectChunks(
							connection(),
							params,
							controller.signal,
							deadlineAt,
							emit,
							meter,
						);
						break;
					case "selectDigestBatch":
						result = runSelectDigestBatch(
							connection(),
							params,
							controller.signal,
							deadlineAt,
							meter,
						);
						break;
					case "domainRead": {
						let sequence = 0;
						result = isDomainReadStreamTask(params)
							? await runDomainReadStream(
									connection(),
									params,
									{
										signal: controller.signal,
										deadlineAt,
										emit: (bytes) =>
											emit({ columns: ["bytes"], rows: [[bytes]], sequence: sequence++ }),
									},
									meter,
								)
							: await runDomainRead(connection(), params, controller.signal, deadlineAt, meter);
						break;
					}
					case "benchmarkRead":
						result = runBenchmarkRead(connection(), params, controller.signal);
						break;
					case "compactSummary":
						result = readCompactSummary(connection(), params, controller.signal);
						break;
					case "executionPolicyFacts":
						result = readExecutionPolicySnapshot(
							connection(),
							params.narratorId,
							controller.signal,
						);
						break;
					case "toolEditPreview":
						result = readToolEditPreviewSnapshot(
							connection(),
							params.toolCallId,
							controller.signal,
						);
						break;
					case "recallToolCall":
						result = readRecallToolCall(connection(), params, controller.signal);
						break;
					case "recallConversation":
						result = readRecallConversation(connection(), params, controller.signal);
						break;
					case "revertSelectionBody":
						result = readRevertSelectionBody(connection(), params, controller.signal);
						break;
					case "publicationTerminalResult":
						result = readPublicationTerminalSnapshot(
							connection(),
							params.run,
							params.options,
							params.fromBlocks,
							controller.signal,
						);
						break;
					case "knowledgeEntryDetail":
						result = readKnowledgeEntryDetail(connection(), params.entryId, controller.signal);
						break;
					case "subagentActivity":
						result = readSubagentActivity(connection(), params, controller.signal);
						break;
					case "storageScanContext":
						result = runStorageScanContext(message.dbPath);
						break;
					case "storageScanTables":
						result = runStorageScanTables(
							message.dbPath,
							message.requestId,
							params,
							controller.signal,
						);
						break;
					case "storageScanSerial":
						result = runStorageScanSerial(
							message.dbPath,
							message.requestId,
							params.mainBytes,
							controller.signal,
						);
						break;
					case "storageScanCleanupSummaries":
						result = runStorageScanCleanupSummaries(message.dbPath, params);
						break;
					case "storageScanSessionPreview":
						result = runStorageScanSessionPreview(message.dbPath, params, controller.signal);
						break;
					case "databaseCleanupContext":
						result = readDatabaseCleanupContext(connection(), controller.signal);
						break;
					default:
						throw new DbReadError("DB_READ_UNSUPPORTED", "Unregistered database read task");
				}
				return result;
			}),
		);
		check();
		post({
			type: "result",
			requestId: message.requestId,
			result,
			durationMs: Date.now() - startedAt,
			diagnostics: meter.snapshot(),
		});
	} catch (err) {
		const unknownPgError =
			message.params.kind === "displayPageMessagesPostgres" &&
			!(err instanceof DisplayPageReadError);
		const sqliteRead = [
			"selectRows",
			"selectValues",
			"selectChunks",
			"selectDigestBatch",
			"domainRead",
		].includes(message.params.kind);
		post({
			type: "error",
			requestId: message.requestId,
			diagnostic: workerFailureDetails(err, false),
			...(unknownPgError
				? {
						message: "PostgreSQL read-only display worker failed",
						code: "DISPLAY_PAGE_READER_UNAVAILABLE",
					}
				: sqliteRead
					? workerFailure(err)
					: {
							message: err instanceof Error ? err.message : String(err),
							...(err && typeof err === "object" && "code" in err && typeof err.code === "string"
								? { code: err.code }
								: {}),
						}),
			diagnostics: meter.snapshot(),
		});
	} finally {
		sqlSpan?.end();
		activeTasks.delete(message.requestId);
	}
});

// Aggregation deliberately stays on the main thread (see pool.ts): merging there, after every
// shard has returned, is what makes the result independent of shard completion order.
post({ type: "ready", buildId: RUNTIME_BUILD_ID });
