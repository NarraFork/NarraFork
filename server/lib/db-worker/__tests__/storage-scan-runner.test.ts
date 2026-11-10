/**
 * Tests for `runParallelObjectStorageScan` itself.
 *
 * The pre-existing determinism test in `pool.test.ts` compares hand-sharded `measureTable` calls
 * against `scanDatabaseObjectStorage` — it never enters the orchestrator, the worker protocol, or
 * the fallback branch. These tests drive `runParallelObjectStorageScan` directly on both paths.
 *
 * Every test uses its own temporary database file. The real `~/.narrafork/narrafork.db` is never
 * opened.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS } from "../../../services/storage/database-storage-port";
import {
	type DatabaseObjectStorageResult,
	isSqliteBusyError,
	loadDbstatObjectBytes,
	loadScanContext,
	measureTable,
} from "../../../services/storage-scan-queries";
import * as pool from "../pool";
import { resetDbWorkerPoolForTest, shutdownDbWorkerPool } from "../pool";
import type { StorageScanContextResult } from "../protocol";
import { runParallelObjectStorageScan } from "../storage-scan-runner";

const MAIN_BYTES = 4_096 * 128;

function createFixtureDatabase(dbPath: string): void {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, status TEXT)");
	db.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
	db.run("CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, name TEXT, input_json TEXT)");
	db.run("CREATE TABLE api_requests (id TEXT PRIMARY KEY, raw_dump_json TEXT)");
	db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)");
	db.run("CREATE TABLE zzz_last (id TEXT PRIMARY KEY, payload TEXT)");
	db.run("CREATE INDEX idx_messages_content ON narrator_messages (content_json)");
	db.run("CREATE VIRTUAL TABLE narrators_fts USING fts5(title, tokenize='trigram')");

	const seed = db.transaction(() => {
		for (let i = 0; i < 150; i++) {
			db.prepare("INSERT INTO narrators VALUES (?, ?, ?)").run(`n${i}`, `narrator ${i}`, "idle");
			db.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run(
				`m${i}`,
				JSON.stringify({ type: "text", text: "x".repeat(180) }),
			);
			db.prepare("INSERT INTO narrator_tool_calls VALUES (?, ?, ?)").run(
				`tc${i}`,
				"bash",
				JSON.stringify({ command: "echo hi" }),
			);
			if (i % 3 === 0) {
				db.prepare("INSERT INTO api_requests VALUES (?, ?)").run(`a${i}`, "y".repeat(400));
			}
		}
	});
	seed();
	db.close();
}

/** Strip the orchestration metadata so the two paths can be compared field for field. */
function storageFields(result: {
	executedOn: string;
	workerCount: number;
	durationMs: number;
}): DatabaseObjectStorageResult {
	const {
		executedOn: _executedOn,
		workerCount: _workerCount,
		durationMs: _durationMs,
		...rest
	} = result;
	return rest as DatabaseObjectStorageResult;
}

describe("runParallelObjectStorageScan", () => {
	let home = "";
	let dbPath = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-scan-runner-"));
		dbPath = join(home, "narrafork.db");
		createFixtureDatabase(dbPath);
		resetDbWorkerPoolForTest();
	});

	afterEach(() => {
		mock.restore();
		shutdownDbWorkerPool();
		delete process.env.NARRAFORK_DB_WORKER;
		delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		rmSync(home, { recursive: true, force: true });
	});

	/**
	 * The module header claims worker and fallback output are field-for-field identical. This is the
	 * test that actually establishes it: both runs go through `runParallelObjectStorageScan`, one with
	 * workers enabled and one with them disabled so the `WorkersUnavailableError` fallback fires.
	 */
	test("worker path and fallback path produce identical results", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "3";
		const sqlite = new Database(dbPath, { readonly: true });
		try {
			const viaWorkers = await runParallelObjectStorageScan({
				sqlite,
				dbPath,
				mainBytes: MAIN_BYTES,
			});
			expect(viaWorkers.executedOn).toBe("workers");
			expect(viaWorkers.workerCount).toBeGreaterThan(1);

			process.env.NARRAFORK_DB_WORKER = "off";
			resetDbWorkerPoolForTest();
			const viaFallback = await runParallelObjectStorageScan({
				sqlite,
				dbPath,
				mainBytes: MAIN_BYTES,
			});
			expect(viaFallback.executedOn).toBe("worker-serial");
			expect(viaFallback.workerCount).toBe(1);

			expect(storageFields(viaWorkers)).toEqual(storageFields(viaFallback));
			// Not vacuous: the fixture must have measurable content.
			expect(viaFallback.objectBytes).toBeGreaterThan(0);
			expect(viaFallback.topTables.length).toBeGreaterThan(0);
			expect(viaFallback.readFailures.tableCount).toBe(0);
		} finally {
			sqlite.close();
		}
	}, 90_000);

	test("worker result matches a direct serial measurement of every table", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const sqlite = new Database(dbPath, { readonly: true });
		try {
			const viaWorkers = await runParallelObjectStorageScan({
				sqlite,
				dbPath,
				mainBytes: MAIN_BYTES,
			});
			const context = loadScanContext(sqlite);
			const direct = new Map(
				context.tables.map((table) => [table.name, measureTable(sqlite, table, context)]),
			);
			expect(viaWorkers.topTables.length).toBeGreaterThan(0);
			for (const table of viaWorkers.topTables) {
				const reference = direct.get(table.name);
				expect(reference).toBeDefined();
				expect(table).toEqual(reference as typeof table);
			}
		} finally {
			sqlite.close();
		}
	}, 90_000);

	test("reports overall table progress on the worker path", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const sqlite = new Database(dbPath, { readonly: true });
		const seen: Array<{ done: number; total: number }> = [];
		try {
			await runParallelObjectStorageScan({
				sqlite,
				dbPath,
				mainBytes: MAIN_BYTES,
				onProgress: (progress) => seen.push({ done: progress.done, total: progress.total }),
			});
			expect(seen.length).toBeGreaterThan(0);
			const total = seen[0].total;
			expect(seen.every((entry) => entry.total === total)).toBe(true);
			// Counts are translated to an overall 1..n sequence, so they must be strictly increasing.
			expect(seen.map((entry) => entry.done)).toEqual(seen.map((_, index) => index + 1));
			expect(seen.at(-1)?.done).toBe(total);
		} finally {
			sqlite.close();
		}
	}, 90_000);

	test("an aborted scan rejects instead of silently falling back to the main thread", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const sqlite = new Database(dbPath, { readonly: true });
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(
				runParallelObjectStorageScan({
					sqlite,
					dbPath,
					mainBytes: MAIN_BYTES,
					signal: controller.signal,
				}),
			).rejects.toMatchObject({ code: "DATABASE_STORAGE_SCAN_CANCELLED" });
		} finally {
			sqlite.close();
		}
	}, 60_000);

	/**
	 * Regression guard for the dedupe/abort interaction.
	 *
	 * The context task used to run with `dedupeKey: "storageScanContext"`, which makes concurrent
	 * callers share ONE execution promise in the pool. Aborting rejects that shared promise, so an
	 * unrelated caller — whose own signal is NOT aborted — saw a rejection it could not recognise as
	 * a cancellation and degraded into the serial main-thread scan (measured elsewhere at ~4.9s of
	 * event-loop freeze). The surviving caller must still complete on the worker path.
	 */
	test("one caller aborting does not push a concurrent caller onto the main thread", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "3";
		const sqlite = new Database(dbPath, { readonly: true });
		const abortedController = new AbortController();
		const survivorController = new AbortController();
		try {
			const aborted = runParallelObjectStorageScan({
				sqlite,
				dbPath,
				mainBytes: MAIN_BYTES,
				signal: abortedController.signal,
			});
			const survivor = runParallelObjectStorageScan({
				sqlite,
				dbPath,
				mainBytes: MAIN_BYTES,
				signal: survivorController.signal,
			});
			abortedController.abort();

			await expect(aborted).rejects.toThrow();
			const result = await survivor;
			expect(result.executedOn).toBe("workers");
			expect(result.objectBytes).toBeGreaterThan(0);
		} finally {
			sqlite.close();
		}
	}, 90_000);
});

describe("object scan deadlines and fallback", () => {
	const context: StorageScanContextResult = {
		pageSize: 4096,
		pageCount: 1,
		rawFreelistBytes: 0,
		tables: [
			{ name: "a", kind: "table" },
			{ name: "b", kind: "table" },
		],
		dbstatSupported: true,
		dbstatBytes: [["a", 4096]],
		indexesByTable: [],
	};
	let sqlite: Database;
	beforeEach(() => {
		sqlite = new Database(":memory:");
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	});
	afterEach(() => {
		mock.restore();
		sqlite.close();
		delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	});
	const timeout = () => new pool.DbReadTaskTimeoutError("database read task timed out");
	const scan = (budgetMs?: number) =>
		runParallelObjectStorageScan({
			sqlite,
			dbPath: "must-not-open.db",
			mainBytes: MAIN_BYTES,
			budgetMs,
		});

	test("context gets the full scan budget; shards get only what remains after a slow context", async () => {
		let now = 1000;
		spyOn(Date, "now").mockImplementation(() => now);
		const run = spyOn(pool, "runReadTask").mockImplementation(
			async <T>(...args: Parameters<typeof pool.runReadTask>): Promise<T> => {
				if (args[1].kind === "storageScanContext") {
					now += 35_000; // Past the old 30s limit, without waiting 35s in a test.
					return context as T;
				}
				return { tables: [] } as T;
			},
		);
		const result = await scan();
		expect(result.executedOn).toBe("workers");
		expect(run.mock.calls[0][2]?.timeoutMs).toBe(DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS);
		expect(run.mock.calls).toHaveLength(3);
		for (const call of run.mock.calls.slice(1)) {
			expect(call[2]?.timeoutMs).toBe(DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS - 35_000);
		}
	});

	test("context timeout does not restart the full walk as a serial scan", async () => {
		const error = timeout();
		const run = spyOn(pool, "runReadTask").mockRejectedValue(error);
		const ephemeral = spyOn(pool, "runEphemeralReadTask").mockRejectedValue(error);
		await expect(scan()).rejects.toBe(error);
		expect(run).toHaveBeenCalledTimes(1);
		expect(ephemeral).not.toHaveBeenCalled();
	});

	test("failed shard cancels its siblings without restarting the scan", async () => {
		const error = timeout();
		const signals: AbortSignal[] = [];
		const run = spyOn(pool, "runReadTask")
			.mockResolvedValueOnce(context)
			.mockImplementation((_path, _params, options) => {
				const signal = options?.signal;
				if (!signal) throw new Error("missing cancellation signal");
				signals.push(signal);
				if (signals.length === 1) return Promise.reject(error);
				return new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			});
		const ephemeral = spyOn(pool, "runEphemeralReadTask").mockRejectedValue(error);
		await expect(scan()).rejects.toBe(error);
		expect(run).toHaveBeenCalledTimes(3);
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(ephemeral).not.toHaveBeenCalled();
	});

	test("whole-scan budget cancels a hung context and settles without fallback", async () => {
		let signal: AbortSignal | undefined;
		const run = spyOn(pool, "runReadTask").mockImplementation((_path, _params, options) => {
			signal = options?.signal;
			return new Promise<never>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		await expect(scan(10)).rejects.toMatchObject({ code: "DATABASE_STORAGE_SCAN_TIMEOUT" });
		expect(signal?.aborted).toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
	});

	test("serial watchdog failure is not retried on an ephemeral worker", async () => {
		const error = timeout();
		const run = spyOn(pool, "runReadTask")
			.mockRejectedValueOnce(new pool.WorkersUnavailableError("disabled"))
			.mockRejectedValue(error);
		const ephemeral = spyOn(pool, "runEphemeralReadTask").mockRejectedValue(error);
		await expect(scan()).rejects.toBe(error);
		expect(run).toHaveBeenCalledTimes(2);
		expect(ephemeral).not.toHaveBeenCalled();
	});

	test("ephemeral watchdog failure is not reported as an empty breakdown", async () => {
		const error = timeout();
		spyOn(pool, "runReadTask").mockRejectedValue(new pool.WorkersUnavailableError("disabled"));
		spyOn(pool, "runEphemeralReadTask").mockRejectedValue(error);
		await expect(scan()).rejects.toBe(error);
	});

	test("ephemeral query failure is not hidden as an empty breakdown", async () => {
		const error = new pool.DbReadTaskExecutionError("query failed");
		spyOn(pool, "runReadTask").mockRejectedValue(new pool.WorkersUnavailableError("disabled"));
		spyOn(pool, "runEphemeralReadTask").mockRejectedValue(error);
		await expect(scan()).rejects.toBe(error);
	});

	test("worker-unavailable fallbacks share the original deadline", async () => {
		let now = 1000;
		spyOn(Date, "now").mockImplementation(() => now);
		const run = spyOn(pool, "runReadTask").mockImplementation(() => {
			now += 40_000;
			return Promise.reject(new pool.WorkersUnavailableError("disabled"));
		});
		const ephemeral = spyOn(pool, "runEphemeralReadTask").mockResolvedValue({
			pageSize: 4096,
			pageCount: 1,
			freelistBytes: 0,
			objectBytes: 4096,
			scanMode: "dbstat",
			categories: [],
			topTables: [],
			readFailures: { tableCount: 0, tableNames: [] },
		});
		const result = await scan();
		expect(result.executedOn).toBe("worker-serial");
		expect(run.mock.calls[1][2]?.timeoutMs).toBe(DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS - 40_000);
		expect(ephemeral.mock.calls[0][2]?.timeoutMs).toBe(
			DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS - 80_000,
		);
	});
});

describe("read failures are not reported as empty tables", () => {
	let home = "";
	let dbPath = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-scan-busy-"));
		dbPath = join(home, "narrafork.db");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	test("classifies SQLITE_BUSY as retryable and other errors as not", () => {
		expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
		expect(isSqliteBusyError(Object.assign(new Error("x"), { code: "SQLITE_BUSY" }))).toBe(true);
		expect(isSqliteBusyError(new Error("no such table: nope"))).toBe(false);
	});

	/**
	 * The bug this guards: `measureTable` used to catch every read error and return zeroes, so a
	 * table locked by a concurrent writer (VACUUM holds an exclusive lock for its whole duration)
	 * rendered as a perfectly normal "0 bytes, 0 rows" row. The scan then produced a syntactically
	 * valid report in which the whole database appeared to weigh nothing, with no error shown.
	 */
	test("marks a table locked by an exclusive writer as readFailed instead of empty", () => {
		// Rollback-journal mode so an exclusive write transaction really blocks readers. In WAL mode
		// readers proceed against the snapshot and there is nothing to contend with.
		const writer = new Database(dbPath);
		writer.run("PRAGMA journal_mode = DELETE");
		writer.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
		const seed = writer.transaction(() => {
			for (let i = 0; i < 50; i++) {
				writer
					.prepare("INSERT INTO narrator_messages VALUES (?, ?)")
					.run(`m${i}`, "payload".repeat(20));
			}
		});
		seed();

		const reader = new Database(dbPath, { readonly: true });
		// Same tuning as the worker connection, so BUSY surfaces quickly instead of parking the thread.
		reader.run("PRAGMA busy_timeout = 50");
		const context = loadScanContext(reader);
		const table = context.tables.find((candidate) => candidate.name === "narrator_messages");
		if (!table) throw new Error("fixture table missing");

		// Baseline: an uncontended read reports real numbers and no failure flag.
		//
		// Asserted on `totalBytes`, not `approxContentBytes`: the latter is the APPROXIMATE mode's
		// output and is legitimately 0 when the SQLite build provides `dbstat` (that path skips the
		// extra `SUM(length(...))` scan because dbstat already has exact page sizes). dbstat presence
		// is a property of the build — compiled in on Bun 1.4.2, absent from earlier ones — so a
		// mode-specific assertion here pinned the runtime instead of the behaviour under test.
		const healthy = measureTable(reader, table, context);
		expect(healthy.readFailed).toBeUndefined();
		// The breakdown does not count rows. Bytes come from dbstat, or from SUM(length) when it is absent.
		expect(healthy.rowCount).toBeNull();
		expect(healthy.totalBytes).toBeGreaterThan(0);

		writer.run("BEGIN EXCLUSIVE");
		writer.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run("locking", "row");
		let locked: ReturnType<typeof measureTable>;
		try {
			locked = measureTable(reader, table, context);
		} finally {
			writer.run("ROLLBACK");
		}

		expect(locked.rowCount).toBeNull();
		if (context.dbstat.supported) {
			// Bytes were already taken from dbstat. There is no per-table query left to hit the lock.
			expect(locked.readFailed).toBeUndefined();
			expect(locked.totalBytes).toBe(healthy.totalBytes);
		} else {
			expect(locked.readFailed).toBe(true);
			expect(locked.approxContentBytes).toBe(0);
		}

		const recovered = measureTable(reader, table, context);
		expect(recovered.readFailed).toBeUndefined();
		expect(recovered.rowCount).toBeNull();
		expect(recovered.totalBytes).toBeGreaterThan(0);

		reader.close();
		writer.close();
	}, 30_000);

	/**
	 * A transient lock must be retried, not reported as a failure.
	 *
	 * The retry backoff sleeps synchronously (these queries are synchronous), so a real writer cannot
	 * release its lock mid-call from a timer. The contention is therefore injected: the first N
	 * attempts of each measurement query raise SQLITE_BUSY, later attempts run for real.
	 */
	function withInjectedBusyFailures(db: Database, failuresPerQuery: number): Database {
		const attempts = new Map<string, number>();
		return new Proxy(db, {
			get(target, property, receiver) {
				if (property !== "prepare") return Reflect.get(target, property, receiver);
				return (sql: string, ...rest: unknown[]) => {
					// biome-ignore lint/suspicious/noExplicitAny: forwarding to bun:sqlite
					const statement = (target.prepare as any)(sql, ...rest);
					if (!/^SELECT (COUNT|COALESCE)/i.test(sql.trim())) return statement;
					return new Proxy(statement, {
						get(stmtTarget, stmtProperty, stmtReceiver) {
							if (stmtProperty !== "get") {
								return Reflect.get(stmtTarget, stmtProperty, stmtReceiver);
							}
							return (...args: unknown[]) => {
								const seen = attempts.get(sql) ?? 0;
								attempts.set(sql, seen + 1);
								if (seen < failuresPerQuery) {
									throw Object.assign(new Error("database is locked"), {
										code: "SQLITE_BUSY",
									});
								}
								// biome-ignore lint/suspicious/noExplicitAny: forwarding to bun:sqlite
								return (stmtTarget.get as any)(...args);
							};
						},
					});
				};
			},
		}) as Database;
	}

	test("retries a transient BUSY and then succeeds without flagging a failure", () => {
		const writer = new Database(dbPath);
		writer.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
		writer.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run("m0", "body-".repeat(10));
		writer.close();

		const reader = new Database(dbPath, { readonly: true });
		const context = loadScanContext(reader);
		const table = context.tables.find((candidate) => candidate.name === "narrator_messages");
		if (!table) throw new Error("fixture table missing");

		// One BUSY per query, so the first retry succeeds. A single-attempt implementation would have
		// reported this table as empty.
		const flaky = withInjectedBusyFailures(reader, 1);
		const measured = measureTable(flaky, table, context);
		expect(measured.readFailed).toBeUndefined();
		expect(measured.rowCount).toBeNull();
		// `totalBytes` rather than `approxContentBytes`, for the same build-dependent reason as above:
		// the approximate field is 0 by design in dbstat mode. The claim being made is "the retried
		// read produced a real measurement", which the total carries in either mode.
		expect(measured.totalBytes).toBeGreaterThan(0);
		reader.close();
	}, 30_000);

	test("gives up after the retry budget and reports the table as unread, not empty", () => {
		const writer = new Database(dbPath);
		writer.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
		writer.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run("m0", "body");
		writer.close();

		const reader = new Database(dbPath, { readonly: true });
		const context = loadScanContext(reader);
		const table = context.tables.find((candidate) => candidate.name === "narrator_messages");
		if (!table) throw new Error("fixture table missing");

		// More failures than the retry schedule allows (2 retries => 3 attempts per query).
		const measured = measureTable(withInjectedBusyFailures(reader, 5), table, context);
		expect(measured.rowCount).toBeNull();
		// dbstat mode issues no per-table query, so injected BUSY never fires. Approximate mode
		// still has the SUM(length) scan, and that one must be reported as unread rather than empty.
		if (context.dbstat.supported) expect(measured.readFailed).toBeUndefined();
		else expect(measured.readFailed).toBe(true);
		reader.close();
	}, 30_000);

	test("does not retry an error that retrying cannot fix", () => {
		const writer = new Database(dbPath);
		writer.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
		writer.close();

		const reader = new Database(dbPath, { readonly: true });
		const context = loadScanContext(reader);
		const table = context.tables.find((candidate) => candidate.name === "narrator_messages");
		if (!table) throw new Error("fixture table missing");

		let attempts = 0;
		const broken = new Proxy(reader, {
			get(target, property, receiver) {
				if (property !== "prepare") return Reflect.get(target, property, receiver);
				return (sql: string) => {
					if (!/^SELECT (COUNT|COALESCE)/i.test(sql.trim())) {
						// biome-ignore lint/suspicious/noExplicitAny: forwarding to bun:sqlite
						return (target.prepare as any)(sql);
					}
					attempts += 1;
					throw new Error("no such column: bogus");
				};
			},
		}) as Database;

		const startedAt = Date.now();
		const measured = measureTable(broken, table, context);
		expect(measured.rowCount).toBeNull();
		// dbstat mode does not query the table. Approximate mode runs one SUM(length) and does not
		// retry a non-BUSY error.
		if (context.dbstat.supported) {
			expect(measured.readFailed).toBeUndefined();
			expect(attempts).toBe(0);
		} else {
			expect(measured.readFailed).toBe(true);
			expect(attempts).toBe(1);
		}
		expect(Date.now() - startedAt).toBeLessThan(200);
		reader.close();
	}, 30_000);

	test("keeps the total retry cost bounded when the lock is never released", () => {
		const writer = new Database(dbPath);
		writer.run("PRAGMA journal_mode = DELETE");
		writer.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
		writer.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run("m0", "body");

		const reader = new Database(dbPath, { readonly: true });
		reader.run("PRAGMA busy_timeout = 20");
		const context = loadScanContext(reader);
		const table = context.tables.find((candidate) => candidate.name === "narrator_messages");
		if (!table) throw new Error("fixture table missing");

		writer.run("BEGIN EXCLUSIVE");
		writer.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run("m1", "body");
		const startedAt = Date.now();
		const measured = measureTable(reader, table, context);
		const elapsed = Date.now() - startedAt;
		writer.run("ROLLBACK");

		if (context.dbstat.supported) {
			expect(measured.readFailed).toBeUndefined();
			expect(measured.totalBytes).toBeGreaterThan(0);
		} else {
			expect(measured.readFailed).toBe(true);
		}
		// Approximate mode retries share a 200ms sleep budget, and each attempt is capped by
		// busy_timeout. A table that cannot be read must not stall the scan for seconds. dbstat mode
		// does not query the table, so it returns immediately.
		expect(elapsed).toBeLessThan(1_500);

		reader.close();
		writer.close();
	}, 30_000);
});

describe("dbstat object byte accounting", () => {
	test("native aggregate matches page SUM for tables, indexes, FTS and overflow pages", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT);
				CREATE INDEX idx_payloads_body ON payloads(body);
				CREATE VIRTUAL TABLE payloads_fts USING fts5(body);
			`);
			sqlite.prepare("INSERT INTO payloads(body) VALUES (?)").run("溢出页".repeat(20_000));
			sqlite.exec("INSERT INTO payloads_fts(body) SELECT body FROM payloads");
			const pages = sqlite
				.query("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name")
				.all() as Array<{ name: string; bytes: number }>;
			const overflow = sqlite
				.query("SELECT COUNT(*) AS n FROM dbstat WHERE pagetype = 'overflow'")
				.get() as { n: number };
			expect(overflow.n).toBeGreaterThan(0);
			const prepare = spyOn(sqlite, "prepare");
			const result = loadDbstatObjectBytes(sqlite);
			expect(result.supported).toBe(true);
			expect(result.bytesByName).toEqual(new Map(pages.map(({ name, bytes }) => [name, bytes])));
			expect(result.bytesByName.get("idx_payloads_body")).toBeGreaterThan(0);
			expect(result.bytesByName.get("payloads_fts_data")).toBeGreaterThan(0);
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(prepare.mock.calls[0][0]).toContain("aggregate = TRUE");
			prepare.mockRestore();
		} finally {
			sqlite.close();
		}
	});

	for (const unsupported of ["aggregate", "schema", "dbstat"]) {
		test(`retains fallback when ${unsupported} is unavailable`, () => {
			const sqlite = new Database(":memory:");
			const prepare = sqlite.prepare.bind(sqlite);
			const calls = spyOn(sqlite, "prepare").mockImplementation((sql, ...args) => {
				if (sql.includes(unsupported)) throw new Error(`no such ${unsupported}`);
				return prepare(sql, ...args);
			});
			try {
				sqlite.exec("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT)");
				sqlite.query("INSERT INTO payloads(body) VALUES (?)").run("hello");
				const result = loadDbstatObjectBytes(sqlite);
				expect(result.supported).toBe(unsupported !== "dbstat");
				if (result.supported) expect(result.bytesByName.get("payloads")).toBeGreaterThan(0);
				else expect(result.bytesByName.size).toBe(0);
				expect(calls).toHaveBeenCalledTimes(unsupported === "aggregate" ? 2 : 3);
			} finally {
				calls.mockRestore();
				sqlite.close();
			}
		});
	}
});
