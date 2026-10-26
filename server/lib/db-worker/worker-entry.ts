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
import {
	collectSessionAggregateStats,
	loadScanContext,
	measurementContextFromSnapshot,
	measureTable,
	type ScanTableRef,
	scanDatabaseObjectStorage,
	summarizeToolCallPayloads,
} from "../../services/storage-scan-queries";
import {
	runBlockBackfillSlice,
	runBlockIndexQueueSlice,
	runBlockProjectionSlice,
	runBlockReindexSlice,
	runBlockVerifySlice,
} from "./block-backfill-query";
import { DisplayPageReadError } from "./display-page-protocol";
import { runDisplayPageQuery } from "./display-page-query";
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
import { runSelectRows } from "./select-rows";

declare const self: Worker;

/** Cached read-only connections, keyed by path. A worker usually only ever sees one path. */
const connections = new Map<string, Database>();

function getConnection(dbPath: string): Database {
	const existing = connections.get(dbPath);
	if (existing) return existing;
	const db = new Database(dbPath, { readonly: true });
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
self.onmessage = async (event: MessageEvent<DbWorkerInbound>) => {
	const message = event.data;
	if (!message || typeof message !== "object") return;

	if (message.type === "cancel") {
		activeTasks.get(message.requestId)?.abort();
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
		const params = message.params;
		const result =
			params.kind === "displayPageMessagesPostgres"
				? await runPostgresDisplayPageQuery(
						message.dbPath,
						{ ...params, kind: "displayPageMessages" },
						controller.signal,
					)
				: params.kind === "blockBackfillSlice"
					? runBlockBackfillSlice(getConnection(message.dbPath), params)
					: params.kind === "blockVerifySlice"
						? runBlockVerifySlice(getConnection(message.dbPath), params)
						: params.kind === "blockReindexSlice"
							? runBlockReindexSlice(getConnection(message.dbPath), params)
							: params.kind === "blockIndexQueueSlice"
								? runBlockIndexQueueSlice(getConnection(message.dbPath), params)
								: params.kind === "blockProjectionSlice"
									? runBlockProjectionSlice(getConnection(message.dbPath), params)
									: params.kind === "displayPageMessages"
										? runDisplayPageQuery(getConnection(message.dbPath), params)
										: params.kind === "selectRows"
											? runSelectRows(getConnection(message.dbPath), params)
											: params.kind === "storageScanContext"
												? runStorageScanContext(message.dbPath)
												: params.kind === "storageScanSerial"
													? runStorageScanSerial(
															message.dbPath,
															message.requestId,
															params.mainBytes,
															controller.signal,
														)
													: params.kind === "storageScanCleanupSummaries"
														? runStorageScanCleanupSummaries(message.dbPath, params)
														: params.kind === "storageScanSessionPreview"
															? runStorageScanSessionPreview(
																	message.dbPath,
																	params,
																	controller.signal,
																)
															: runStorageScanTables(
																	message.dbPath,
																	message.requestId,
																	params,
																	controller.signal,
																);
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
