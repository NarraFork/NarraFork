/**
 * Parallel object-storage scan orchestration.
 *
 * Splits the per-table measurement work across read workers and merges the shards on the main
 * thread. When the pool cannot shard, one worker runs the serial scan. The server thread
 * does not.
 *
 * Determinism contract: a table is never split across shards, and `aggregateObjectStorage` re-sorts
 * every shard's tables by name before accumulating. The output is therefore field-for-field
 * identical to the single-worker serial scan regardless of how shards were distributed or which
 * finished first. `storage-scan-runner.test.ts` verifies this by running
 * `runParallelObjectStorageScan` twice — sharded, then with the pool disabled — and comparing
 * the results field for field.
 */

import type { Database } from "bun:sqlite";
import {
	DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS,
	runWithScanBudget,
} from "../../services/storage/database-storage-port";
import {
	aggregateObjectStorage,
	type DatabaseObjectStorageResult,
	type DatabaseStorageCategoryKey,
	type DatabaseStorageTableSummary,
	type DatabaseTableKind,
} from "../../services/storage-scan-queries";
import { logger } from "../logger";
import {
	DbReadTaskExecutionError,
	DbReadTaskTimeoutError,
	getConfiguredConcurrency,
	runEphemeralReadTask,
	runReadTask,
	WorkersUnavailableError,
} from "./pool";
import type { StorageScanContextResult, StorageScanTablesResult } from "./protocol";

export interface ParallelScanOptions {
	/** Kept for caller compatibility; no scan path queries this main-thread connection. */
	sqlite: Database;
	dbPath: string;
	mainBytes: number;
	onProgress?: (progress: { done: number; total: number; tableName: string }) => void;
	signal?: AbortSignal;
	/** One deadline for context, shards and worker-unavailable fallbacks, including queueing. */
	budgetMs?: number;
}

export interface ParallelScanOutcome extends DatabaseObjectStorageResult {
	/** How the scan actually ran, for logging and diagnostics. */
	executedOn: "workers" | "worker-serial" | "unavailable";
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
 * all cheap. With dbstat, per-table work is a lookup: row counts are not measured. Without
 * dbstat, the `SUM(length(...))` scans (the multi-second part) happen entirely off-thread.
 */
export async function runParallelObjectStorageScan(
	options: ParallelScanOptions,
): Promise<ParallelScanOutcome> {
	const startedAt = Date.now();
	const budgetMs = options.budgetMs ?? DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS;
	const scope = new AbortController();
	try {
		return await runWithScanBudget(budgetMs, options.signal, (linked) =>
			runObjectStorageScan(
				{ ...options, signal: AbortSignal.any([linked, scope.signal]) },
				startedAt,
				startedAt + budgetMs,
			),
		);
	} finally {
		// A failed shard must not leave its siblings consuming workers after the caller settles.
		scope.abort();
	}
}

async function runObjectStorageScan(
	options: ParallelScanOptions,
	startedAt: number,
	deadlineAt: number,
): Promise<ParallelScanOutcome> {
	const { dbPath, mainBytes, onProgress, signal } = options;
	const remainingMs = () => Math.max(0, deadlineAt - Date.now());
	let phase = "context";
	try {
		// Context includes a full dbstat walk, not just pragmas/schema. On a cold 26.8 GB
		// database it exceeded the former 30s cap, which threw away the work and restarted
		// the SAME walk in a serial task capped at 120s. Give it the scan's remaining budget.
		// No dedupeKey on purpose. The pool's dedupe makes concurrent callers share ONE execution
		// promise, and an abort rejects that shared promise — so one admin closing the settings page
		// would reject the other admin's context task too. That caller's own signal is not aborted, so
		// it would not recognise the rejection as a cancellation. Keep each caller's cancellation
		// independent; the context also contains the dbstat result, reused by all its shards.
		const context = await runReadTask<StorageScanContextResult>(
			dbPath,
			{ kind: "storageScanContext" },
			{ signal, timeoutMs: remainingMs() },
		);

		const tableNames = context.tables.map((table) => table.name);
		const shards = shardTableNames(tableNames, getConfiguredConcurrency());
		// The context step is unit 1, so a long dbstat walk is visible before the first table finishes.
		const total = tableNames.length + 1;
		const completedTables = new Set<string>();
		const report = (tableName: string) => {
			onProgress?.({ done: 1 + completedTables.size, total, tableName });
		};
		report("__dbstat__");

		phase = "tables";
		const shardScope = new AbortController();
		const shardSignal = AbortSignal.any([signal ?? shardScope.signal, shardScope.signal]);
		const shardResults = await Promise.all(
			shards.map((shardNames) =>
				runReadTask<StorageScanTablesResult>(
					dbPath,
					{ kind: "storageScanTables", tableNames: shardNames, context },
					{
						signal: shardSignal,
						timeoutMs: remainingMs(),
						onProgress: (progress) => {
							// One count per table. Parallel shards must not each add 1 for the same name,
							// and a shard's own 1..n counter is not the overall count.
							if (completedTables.has(progress.tableName)) return;
							completedTables.add(progress.tableName);
							report(progress.tableName);
						},
					},
				),
			),
		).finally(() => shardScope.abort());

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
		if (!(err instanceof WorkersUnavailableError)) {
			logger.warn("Storage scan read failed; not restarting the scan", {
				phase,
				durationMs: Date.now() - startedAt,
				reason: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
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
		// The sharded pool could not take the work. Measure on one worker instead of the server
		// thread: the serial scan is the same queries, and running them here freezes HTTP.
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn("Storage scan worker path failed; measuring on a single worker", { reason });
		try {
			const result = await runReadTask<DatabaseObjectStorageResult>(
				dbPath,
				{ kind: "storageScanSerial", mainBytes },
				{
					signal,
					timeoutMs: remainingMs(),
					onProgress: (progress) => onProgress?.(progress),
				},
			);
			return {
				...result,
				executedOn: "worker-serial",
				workerCount: 1,
				durationMs: Date.now() - startedAt,
			};
		} catch (serialErr) {
			if (signal?.aborted) throw serialErr;
			if (serialErr instanceof WorkersUnavailableError && serialErr.reason === "pool_shutdown") {
				throw serialErr;
			}
			// A real query error or watchdog is not worker unavailability. Restarting it on a
			// fresh worker only repeats the expensive read and can hide the failure as zeroes.
			if (!(serialErr instanceof WorkersUnavailableError)) throw serialErr;
			try {
				const result = await runEphemeralReadTask<DatabaseObjectStorageResult>(
					dbPath,
					{ kind: "storageScanSerial", mainBytes },
					{
						signal,
						timeoutMs: remainingMs(),
						onProgress: (progress) => onProgress?.(progress),
					},
				);
				return {
					...result,
					executedOn: "worker-serial",
					workerCount: 1,
					durationMs: Date.now() - startedAt,
				};
			} catch (ephemeralErr) {
				if (
					signal?.aborted ||
					ephemeralErr instanceof DbReadTaskTimeoutError ||
					ephemeralErr instanceof DbReadTaskExecutionError
				)
					throw ephemeralErr;
				logger.warn("Storage scan could not run off-thread; per-table breakdown is unavailable", {
					reason: ephemeralErr instanceof Error ? ephemeralErr.message : String(ephemeralErr),
				});
				return {
					pageSize: 0,
					pageCount: 0,
					freelistBytes: 0,
					objectBytes: 0,
					scanMode: "approximate",
					categories: [],
					topTables: [],
					readFailures: { tableCount: 1, tableNames: [] },
					executedOn: "unavailable",
					workerCount: 0,
					durationMs: Date.now() - startedAt,
				};
			}
		}
	}
}
