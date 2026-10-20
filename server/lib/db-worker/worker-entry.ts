/**
 * Database read-worker entry point.
 *
 * Runs whole-database read tasks (currently the storage-settings scan) on its OWN read-only
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
import {
	collectSessionAggregateStats,
	loadScanContext,
	measurementContextFromSnapshot,
	measureTable,
	type ScanTableRef,
	scanDatabaseObjectStorage,
	summarizeToolCallPayloads,
} from "../../services/storage-scan-queries";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { DisplayPageReadError } from "./display-page-protocol";
import { runDisplayPageQuery } from "./display-page-query";
import { runPostgresDisplayPageQuery } from "./postgres-display-page-query";
import type {
	DbWorkerInbound,
	DbWorkerOutbound,
	DbWorkerRequest,
	StorageScanCleanupSummariesParams,
	StorageScanCleanupSummariesResult,
	StorageScanContextResult,
	StorageScanTablesParams,
	StorageScanTablesResult,
} from "./protocol";
import { readWorkerDomExceptionName } from "./protocol";
import { runSearchQuery } from "./search-query";
import { streamSelectRows } from "./select-rows";
import { runUsageHistoryQuery } from "./usage-history-query";

declare const self: Worker;

/** Cached read-only connections, keyed by path. A worker usually only ever sees one path. */
const connections = new Map<string, Database>();

function getConnection(dbPath: string): Database {
	const existing = connections.get(dbPath);
	if (existing) return existing;
	const db = new Database(dbPath, { readonly: true });
	// Match the main connection's read tuning. No write pragmas: this handle is read-only.
	try {
		db.run("PRAGMA query_only = ON");
		db.run("PRAGMA foreign_keys = ON");
		db.run("PRAGMA cache_size = -16000");
		db.run("PRAGMA temp_store = MEMORY");
		db.run("PRAGMA mmap_size = 268435456");
		// Fail fast instead of parking this thread inside SQLite's busy handler.
		db.run("PRAGMA busy_timeout = 250");
	} catch {
		// Tuning is best-effort; a working connection matters more.
	}
	connections.set(dbPath, db);
	return db;
}

function post(message: DbWorkerOutbound): void {
	postMessage(message);
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

async function executeReadTask(message: DbWorkerRequest, signal: AbortSignal): Promise<unknown> {
	const { params, dbPath, requestId } = message;
	switch (params.kind) {
		case "revertSelectionReadV1":
			return (
				await import("../../services/revert-selection-read-task")
			).executeRevertSelectionReadTask(getConnection(dbPath), params, signal, (rows, bytes) =>
				sendChunk(requestId, rows, bytes),
			);
		case "databaseCleanupReadV1":
			return (await import("../../services/database-cleanup-read")).executeDatabaseCleanupReadTask(
				getConnection(dbPath),
				params,
			);
		case "revertPlanReadV1":
			return (await import("../../services/revert-plan-read-task")).executeRevertPlanReadTask(
				getConnection(dbPath),
				params,
			);
		case "revertJournalReadV1":
			return (await import("../../services/revert-journal-read-task")).executeRevertJournalReadTask(
				getConnection(dbPath),
				params,
			);
		case "publication-terminal-result-v1":
			return (
				await import("../../services/agent-runtime/publication-result-read")
			).runPublicationTerminalResultRead(getConnection(dbPath), params, signal);
		case "fileChangeBlobCatalogV1":
			return (
				await import("../../services/file-change-blob-catalog-read")
			).executeFileChangeBlobCatalogRead(getConnection(dbPath), params);
		case "fileChangeRetentionInventoryV1":
			return (
				await import("../../services/file-change-retention-inventory")
			).executeFileChangeRetentionInventoryRead(getConnection(dbPath), params, signal);
		case "workspace-recovery-effects-v1":
			return (await import("../../services/workspace-recovery-read")).runWorkspaceRecoveryRead(
				getConnection(dbPath),
				params,
				signal,
			);
		case "projectArchiveReadV1":
			return (
				await import("../../services/project-archive/archive-file-reader")
			).readProjectArchive(getConnection(dbPath), params);
		case "worktree-lifecycle-read-v1":
			return (await import("../../services/worktree-lifecycle-read")).runWorktreeLifecycleRead(
				getConnection(dbPath),
				params,
				signal,
			);
		case "narrator-read-transaction-v1":
			return (await import("../../services/narrator-read-transactions")).runNarratorReadTransaction(
				getConnection(dbPath),
				params,
				signal,
			);
		case "git-current-diff-read-v1":
		case "git-current-diff-validate-v1":
			return (await import("../../services/git-current-diff-read")).runCurrentDiffRead(
				getConnection(dbPath),
				params,
				signal,
			);
		case "selectRowsV1":
			return streamSelectRows(getConnection(dbPath), params, signal, (rows, bytes) =>
				sendChunk(requestId, rows, bytes),
			);
		case "displayPageMessagesPostgres":
			return runPostgresDisplayPageQuery(
				dbPath,
				{ ...params, kind: "displayPageMessages" },
				signal,
			);
		case "displayPageMessages":
			return runDisplayPageQuery(getConnection(dbPath), params);
		case "searchQuery":
			return runSearchQuery(getConnection(dbPath), params);
		case "usageHistoryQuery":
			return runUsageHistoryQuery(getConnection(dbPath), params);
		case "storageScanContext":
			return runStorageScanContext(dbPath);
		case "storageScanSerial":
			return runStorageScanSerial(dbPath, requestId, params.mainBytes, signal);
		case "storageScanCleanupSummaries":
			return runStorageScanCleanupSummaries(dbPath, params);
		case "storageScanTables":
			return runStorageScanTables(dbPath, requestId, params, signal);
		default: {
			const _exhaustive: never = params;
			throw new Error("Unknown database read task");
		}
	}
}

const activeTasks = new Map<string, AbortController>();
const chunkAcknowledgements = new Map<string, () => void>();

async function sendChunk(requestId: string, rows: unknown[], bytes: number): Promise<void> {
	await new Promise<void>((resolve) => {
		chunkAcknowledgements.set(requestId, resolve);
		post({ type: "chunk", requestId, rows, bytes });
	});
}
self.onmessage = async (event: MessageEvent<DbWorkerInbound>) => {
	const message = event.data;
	if (!message || typeof message !== "object") return;

	if (message.type === "closeConnection") {
		connections.get(message.dbPath)?.close();
		connections.delete(message.dbPath);
		post({ type: "connectionClosed", requestId: message.requestId });
		return;
	}
	if (message.type === "chunkAck") {
		chunkAcknowledgements.get(message.requestId)?.();
		chunkAcknowledgements.delete(message.requestId);
		return;
	}
	if (message.type === "cancel") {
		activeTasks.get(message.requestId)?.abort();
		chunkAcknowledgements.get(message.requestId)?.();
		chunkAcknowledgements.delete(message.requestId);
		return;
	}
	if (message.type === "shutdown") {
		for (const db of connections.values()) {
			try {
				db.close();
			} catch {
				// best effort
			}
		}
		connections.clear();
		process.exit(0);
	}

	if (message.type !== "task") return;

	const startedAt = Date.now();
	const controller = new AbortController();
	activeTasks.set(message.requestId, controller);
	try {
		const result = await executeReadTask(message, controller.signal);
		post({
			type: "result",
			requestId: message.requestId,
			result,
			durationMs: Date.now() - startedAt,
		});
	} catch (err) {
		const unknownPgError =
			message.params.kind === "displayPageMessagesPostgres" &&
			!(err instanceof DisplayPageReadError);
		post({
			type: "error",
			requestId: message.requestId,
			domExceptionName: readWorkerDomExceptionName(err),
			...(err instanceof AppError
				? {
						applicationError: {
							name:
								err instanceof NotFoundError
									? "NotFoundError"
									: err instanceof ForbiddenError
										? "ForbiddenError"
										: err instanceof ValidationError
											? "ValidationError"
											: "AppError",
							statusCode: err.statusCode,
							messageCode: err.messageCode,
							messageParams: err.messageParams,
						},
					}
				: {}),
			message: unknownPgError
				? "PostgreSQL read-only display worker failed"
				: err instanceof Error
					? err.message
					: String(err),
			...(unknownPgError
				? { code: "DISPLAY_PAGE_READER_UNAVAILABLE" }
				: err && typeof err === "object" && "code" in err && typeof err.code === "string"
					? { code: err.code }
					: {}),
		});
	} finally {
		activeTasks.delete(message.requestId);
	}
};

// Aggregation deliberately stays on the main thread (see pool.ts): merging there, after every
// shard has returned, is what makes the result independent of shard completion order.
post({ type: "ready" });
