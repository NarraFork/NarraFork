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
	loadScanContext,
	measureTable,
	type ScanTableRef,
} from "../../services/storage-scan-queries";
import type {
	DbWorkerInbound,
	DbWorkerOutbound,
	StorageScanContextResult,
	StorageScanTablesResult,
} from "./protocol";

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
	tableNames: string[],
): StorageScanTablesResult {
	const sqlite = getConnection(dbPath);
	// Re-read the schema context in this thread: index/dbstat maps are connection-scoped and
	// cheap (pragmas + two schema queries, no table data).
	const context = loadScanContext(sqlite);
	const byName = new Map(context.tables.map((table) => [table.name, table]));
	const wanted: ScanTableRef[] = tableNames
		.map((name) => byName.get(name))
		.filter((table): table is ScanTableRef => Boolean(table));

	const tables = wanted.map((table, index) => {
		const summary = measureTable(sqlite, table, context);
		post({
			type: "progress",
			requestId,
			tableName: table.name,
			done: index + 1,
			total: wanted.length,
		});
		return summary;
	});
	return { tables };
}

self.onmessage = (event: MessageEvent<DbWorkerInbound>) => {
	const message = event.data;
	if (!message || typeof message !== "object") return;

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
	try {
		const result =
			message.params.kind === "usageHistoryQuery"
				? runUsageHistoryQuery(getConnection(message.dbPath), message.params)
				: message.params.kind === "storageScanContext"
					? runStorageScanContext(message.dbPath)
					: runStorageScanTables(message.dbPath, message.requestId, message.params.tableNames);
		post({
			type: "result",
			requestId: message.requestId,
			result,
			durationMs: Date.now() - startedAt,
		});
	} catch (err) {
		post({
			type: "error",
			requestId: message.requestId,
			message: err instanceof Error ? err.message : String(err),
		});
	}
};

// Aggregation deliberately stays on the main thread (see pool.ts): merging there, after every
// shard has returned, is what makes the result independent of shard completion order.
post({ type: "ready" });
