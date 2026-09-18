/**
 * Parallel object-storage scan orchestration.
 *
 * Splits the per-table measurement work across read workers and merges the shards on the main
 * thread. Falls back to a serial main-thread scan whenever workers are unusable, so the storage
 * settings page always produces a result.
 *
 * Determinism contract: a table is never split across shards, and `aggregateObjectStorage` re-sorts
 * every shard's tables by name before accumulating. The output is therefore field-for-field
 * identical to the serial fallback regardless of how shards were distributed or which finished
 * first. `storage-scan-runner.test.ts` verifies this by running `runParallelObjectStorageScan`
 * itself twice — once with workers enabled and once with them disabled so the fallback triggers —
 * and comparing the two results field for field.
 */

import type { Database } from "bun:sqlite";
import {
	aggregateObjectStorage,
	type DatabaseObjectStorageResult,
	type DatabaseStorageCategoryKey,
	type DatabaseStorageTableSummary,
	type DatabaseTableKind,
	scanDatabaseObjectStorage,
} from "../../services/storage-scan-queries";
import { logger } from "../logger";
import { getConfiguredConcurrency, runReadTask, WorkersUnavailableError } from "./pool";
import type { StorageScanContextResult, StorageScanTablesResult } from "./protocol";

export interface ParallelScanOptions {
	/** Shared main-thread connection, used only by the fallback path. */
	sqlite: Database;
	dbPath: string;
	mainBytes: number;
	onProgress?: (progress: { done: number; total: number; tableName: string }) => void;
	signal?: AbortSignal;
}

export interface ParallelScanOutcome extends DatabaseObjectStorageResult {
	/** How the scan actually ran, for logging and diagnostics. */
	executedOn: "workers" | "main-thread";
	workerCount: number;
	durationMs: number;
}

/**
 * Relative cost weights for tables known to dominate the scan.
 *
 * Measured on a 5.3 GB production database (total serial scan 4574ms):
 *   narrator_tool_calls 2037ms · narrator_messages 1100ms · api_requests 480ms
 *   narrator_messages_fts 347ms · everything else < 200ms each
 *
 * Cost is driven by row count × row width, which the scan cannot know before measuring — so these
 * weights encode the shape of the schema. A table not listed here gets weight 1; being wrong only
 * costs balance, never correctness.
 */
const TABLE_COST_WEIGHTS: Record<string, number> = {
	narrator_tool_calls: 2000,
	narrator_messages: 1100,
	api_requests: 480,
	narrator_messages_fts: 350,
	narrator_file_snapshots: 175,
	narrator_message_refs: 175,
	narrator_patches: 100,
};

function estimateTableCost(tableName: string): number {
	return TABLE_COST_WEIGHTS[tableName] ?? 1;
}

/**
 * Split table names into balanced shards, heaviest-first onto the currently lightest shard.
 *
 * Naive round-robin was measured to be actively harmful here: after the deterministic name sort, the
 * three most expensive tables (`api_requests`, `narrator_messages`, `narrator_tool_calls`) land on
 * indices that are all congruent mod 4, so a 4-way round-robin piled all of them into ONE shard
 * (3731ms of a 4574ms total) and delivered no speedup at all.
 *
 * Greedy longest-processing-time-first fixes that. Shard membership never affects the merged result
 * (see the determinism contract above), so this is purely a scheduling concern.
 */
export function shardTableNames(tableNames: string[], shardCount: number): string[][] {
	const count = Math.max(1, Math.min(shardCount, tableNames.length));
	const shards: Array<{ names: string[]; cost: number }> = Array.from({ length: count }, () => ({
		names: [],
		cost: 0,
	}));

	const ordered = [...tableNames].sort(
		// Heaviest first; ties broken by name so sharding stays deterministic run to run.
		(a, b) => estimateTableCost(b) - estimateTableCost(a) || a.localeCompare(b),
	);
	for (const name of ordered) {
		let lightest = shards[0];
		for (const shard of shards) {
			if (shard.cost < lightest.cost) lightest = shard;
		}
		lightest.names.push(name);
		lightest.cost += estimateTableCost(name);
	}

	return shards.filter((shard) => shard.names.length > 0).map((shard) => shard.names);
}

function toTableSummary(
	row: StorageScanTablesResult["tables"][number],
): DatabaseStorageTableSummary {
	// `readFailed` is now part of the wire type (see protocol.ts), so it is read directly rather
	// than through a cast. Kept as an explicit `=== true` comparison because the field is optional
	// on the wire: absent means "measured fine", and only a literal `true` means the accompanying
	// zeroes are UNKNOWNs rather than an empty table.
	const readFailed = row.readFailed === true;
	return {
		name: row.name,
		category: row.category as DatabaseStorageCategoryKey,
		kind: row.kind as DatabaseTableKind,
		rowCount: row.rowCount,
		approxContentBytes: row.approxContentBytes,
		diskBytes: row.diskBytes,
		indexBytes: row.indexBytes,
		totalBytes: row.totalBytes,
		...(readFailed ? { readFailed: true } : {}),
	};
}

/**
 * Run the object-storage scan, preferring workers.
 *
 * On the worker path the main thread only builds the shard plan, forwards progress, and merges —
 * all cheap. The per-table `COUNT(*)` / `SUM(length(...))` scans (the multi-second part) happen
 * entirely off-thread.
 */
export async function runParallelObjectStorageScan(
	options: ParallelScanOptions,
): Promise<ParallelScanOutcome> {
	const startedAt = Date.now();
	const { sqlite, dbPath, mainBytes, onProgress, signal } = options;

	try {
		// One cheap task first: pragmas + schema listing, so the shard plan uses the same table
		// ordering the workers will see.
		// No dedupeKey on purpose. The pool's dedupe makes concurrent callers share ONE execution
		// promise, and an abort rejects that shared promise — so one admin closing the settings page
		// would reject the other admin's context task too. That caller's own signal is not aborted, so
		// it would not recognise the rejection as a cancellation and would silently degrade into the
		// serial main-thread scan (measured: ~4.9s of event-loop freeze) for everyone. This task is
		// only pragmas plus two schema queries, so paying for it twice is far cheaper than that.
		const context = await runReadTask<StorageScanContextResult>(
			dbPath,
			{ kind: "storageScanContext" },
			{ signal, timeoutMs: 30_000 },
		);

		const tableNames = context.tables.map((table) => table.name);
		const shards = shardTableNames(tableNames, getConfiguredConcurrency());
		const total = tableNames.length;
		let done = 0;

		const shardResults = await Promise.all(
			shards.map((tableNames) =>
				runReadTask<StorageScanTablesResult>(
					dbPath,
					{ kind: "storageScanTables", tableNames },
					{
						signal,
						onProgress: (progress) => {
							// Shards report their own 1..n counts; translate to overall progress.
							done += 1;
							onProgress?.({ done, total, tableName: progress.tableName });
						},
					},
				),
			),
		);

		const tableSummaries = shardResults.flatMap((shard) => shard.tables.map(toTableSummary));
		const aggregated = aggregateObjectStorage({
			mainBytes,
			pageSize: context.pageSize,
			pageCount: context.pageCount,
			rawFreelistBytes: context.rawFreelistBytes,
			dbstatSupported: context.dbstatSupported,
			dbstatBytesByName: new Map(context.dbstatBytes),
			indexesByTable: new Map(context.indexesByTable),
			tableSummaries,
		});

		return {
			...aggregated,
			executedOn: "workers",
			workerCount: shards.length,
			durationMs: Date.now() - startedAt,
		};
	} catch (err) {
		if (signal?.aborted) throw err;
		// A pool that was deliberately torn down is NOT an unavailable pool, and the main-thread
		// fallback is the worst possible response to it: `vacuumDatabase` shuts the pool down
		// precisely to clear readers out of the way, so falling back here would start a synchronous
		// whole-database scan in the instant VACUUM is about to take its exclusive lock — stalling
		// the event loop for seconds and risking SQLITE_BUSY on the VACUUM itself. Surface it and
		// let the caller decide; the settings page can simply be re-scanned after maintenance.
		if (err instanceof WorkersUnavailableError && err.reason === "pool_shutdown") {
			logger.info("Storage scan cancelled by database maintenance", { reason: err.reason });
			throw err;
		}
		// Degrade, never fail: a slow scan beats a broken settings page. Log at warn so a persistent
		// worker problem is visible rather than silently costing seconds of main-thread stalls.
		const reason = err instanceof Error ? err.message : String(err);
		if (err instanceof WorkersUnavailableError) {
			logger.info("Storage scan running on the main thread", { reason: err.reason });
		} else {
			logger.warn("Storage scan worker path failed; falling back to the main thread", { reason });
		}

		const result = scanDatabaseObjectStorage(sqlite, mainBytes, {
			onTableMeasured: (tableName, index, total) => {
				// The serial scan cannot be interrupted mid-query, but it can stop between tables. That
				// bounds a cancelled fallback to one table instead of the full multi-second scan.
				if (signal?.aborted) throw new Error("storage scan aborted");
				onProgress?.({ done: index, total, tableName });
			},
		});
		return {
			...result,
			executedOn: "main-thread",
			workerCount: 0,
			durationMs: Date.now() - startedAt,
		};
	}
}
