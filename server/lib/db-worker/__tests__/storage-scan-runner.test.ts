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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DatabaseObjectStorageResult,
	isSqliteBusyError,
	loadScanContext,
	measureTable,
} from "../../../services/storage-scan-queries";
import { resetDbWorkerPoolForTest, shutdownDbWorkerPool } from "../pool";
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
			expect(viaFallback.executedOn).toBe("main-thread");
			expect(viaFallback.workerCount).toBe(0);

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
			).rejects.toThrow(/abort/i);
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
		expect(healthy.rowCount).toBe(50);
		expect(healthy.totalBytes).toBeGreaterThan(0);

		writer.run("BEGIN EXCLUSIVE");
		writer.prepare("INSERT INTO narrator_messages VALUES (?, ?)").run("locking", "row");
		let locked: ReturnType<typeof measureTable>;
		try {
			locked = measureTable(reader, table, context);
		} finally {
			writer.run("ROLLBACK");
		}

		expect(locked.readFailed).toBe(true);
		// rowCount stays null — "unknown", never 0.
		expect(locked.rowCount).toBeNull();
		expect(locked.approxContentBytes).toBe(0);

		// Once the lock is released the same call succeeds again, proving the failure was contention.
		const recovered = measureTable(reader, table, context);
		expect(recovered.readFailed).toBeUndefined();
		expect(recovered.rowCount).toBe(50);

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
		expect(measured.rowCount).toBe(1);
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
		expect(measured.readFailed).toBe(true);
		expect(measured.rowCount).toBeNull();
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
		expect(measured.readFailed).toBe(true);
		// One attempt per measurement query, with no backoff sleeping. HOW MANY queries there are is
		// mode-dependent: the approximate path runs count + `SUM(length(...))`, while the dbstat path
		// runs only the count (page sizes come from dbstat, so the content scan is skipped). Hard-coding
		// 2 asserted the approximate mode rather than the no-retry rule, and broke on a Bun whose
		// bundled SQLite gained dbstat. The rule itself is "attempted exactly once each, no sleeping".
		expect(attempts).toBe(context.dbstat.supported ? 1 : 2);
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

		expect(measured.readFailed).toBe(true);
		// Retries share a 200ms sleep budget across both reads of the table, and each attempt is capped
		// by busy_timeout. A table that cannot be read must not stall the scan for seconds.
		expect(elapsed).toBeLessThan(1_500);

		reader.close();
		writer.close();
	}, 30_000);
});
