import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	aggregateObjectStorage,
	loadScanContext,
	measureTable,
	scanDatabaseObjectStorage,
} from "../../../services/storage-scan-queries";
import {
	getConfiguredConcurrency,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
	WorkersUnavailableError,
} from "../pool";
import type { StorageScanContextResult, StorageScanTablesResult } from "../protocol";
import { shardTableNames } from "../storage-scan-runner";

/**
 * Build a database with enough shape to exercise the scan: several tables, indexes, a virtual FTS
 * table, and a table large enough that its byte total is non-trivial.
 */
function createFixtureDatabase(dbPath: string): void {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, status TEXT)");
	db.run("CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT)");
	db.run("CREATE TABLE api_requests (id TEXT PRIMARY KEY, raw_dump_json TEXT)");
	db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)");
	db.run("CREATE TABLE zzz_last (id TEXT PRIMARY KEY, payload TEXT)");
	db.run("CREATE INDEX idx_messages_content ON narrator_messages (content_json)");
	db.run("CREATE INDEX idx_narrators_status ON narrators (status)");
	db.run("CREATE VIRTUAL TABLE narrators_fts USING fts5(title, tokenize='trigram')");

	const insertNarrator = db.prepare("INSERT INTO narrators (id, title, status) VALUES (?, ?, ?)");
	const insertMessage = db.prepare(
		"INSERT INTO narrator_messages (id, content_json) VALUES (?, ?)",
	);
	const insertDump = db.prepare("INSERT INTO api_requests (id, raw_dump_json) VALUES (?, ?)");
	const seed = db.transaction(() => {
		for (let i = 0; i < 200; i++) {
			insertNarrator.run(`n${i}`, `narrator ${i}`, i % 2 === 0 ? "idle" : "working");
			insertMessage.run(`m${i}`, JSON.stringify({ type: "text", text: "x".repeat(200) }));
			if (i % 3 === 0) insertDump.run(`a${i}`, "y".repeat(500));
		}
	});
	seed();
	db.close();
}

/**
 * Write a stand-in worker entry and return its specifier.
 *
 * Real `new Worker` + real message protocol, only the task behaviour is fake. That keeps the failure
 * tests on the same code path production uses (spawn, ready handshake, close/error events) instead of
 * stubbing pool internals, which would prove nothing about the deadlock being guarded against.
 */
function writeWorkerFixture(dir: string, name: string, body: string): string {
	const file = join(dir, name);
	writeFileSync(file, `${body}\npostMessage({ type: "ready" });\n`, "utf8");
	return pathToFileURL(file).href;
}

/** Reports ready, then never answers a task: lets a task sit in flight for as long as the test needs. */
const HANGING_WORKER_BODY = `self.onmessage = () => {};`;

/** Reports ready, then kills its own thread on the first task, simulating a worker crash. */
const CRASHING_WORKER_BODY = `
self.onmessage = (event) => {
	if (event.data?.type === "task") process.exit(3);
};
`;

describe("shardTableNames", () => {
	test("spreads equal-cost tables evenly and preserves every table exactly once", () => {
		const names = ["a", "b", "c", "d", "e", "f", "g"];
		const shards = shardTableNames(names, 3);
		expect(shards.length).toBe(3);
		// All weights are equal here, so the greedy assignment must produce balanced shards.
		expect(shards.map((shard) => shard.length).sort()).toEqual([2, 2, 3]);
		expect(shards.flat().sort()).toEqual([...names].sort());
	});

	test("never creates more shards than tables, and handles empty input", () => {
		expect(shardTableNames(["only"], 8)).toEqual([["only"]]);
		expect(shardTableNames([], 4)).toEqual([]);
	});

	/**
	 * Regression guard for a sharding choice that produced zero speedup.
	 *
	 * With plain round-robin over the name-sorted table list, the three most expensive tables
	 * (`api_requests`, `narrator_messages`, `narrator_tool_calls`) landed on indices congruent mod 4
	 * and all went to the SAME shard — measured as 3731ms out of a 4574ms total, so the scan was no
	 * faster than serial. Cost-aware greedy assignment must keep them apart.
	 */
	test("keeps the expensive tables on separate shards", () => {
		const heavy = ["api_requests", "narrator_messages", "narrator_tool_calls"];
		// Interleave with enough cheap tables to reproduce the original stride problem.
		const cheap = Array.from({ length: 40 }, (_, i) => `cheap_${String(i).padStart(2, "0")}`);
		const shards = shardTableNames([...heavy, ...cheap].sort(), 4);

		for (const shard of shards) {
			expect(shard.filter((name) => heavy.includes(name)).length).toBeLessThanOrEqual(1);
		}
		expect(shards.flat().sort()).toEqual([...heavy, ...cheap].sort());
	});

	test("is deterministic across calls", () => {
		const names = ["narrator_tool_calls", "narrator_messages", "a", "b", "c", "api_requests"];
		expect(shardTableNames(names, 3)).toEqual(shardTableNames(names, 3));
	});
});

describe("scan result determinism", () => {
	let home = "";
	let dbPath = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-scan-determinism-"));
		dbPath = join(home, "narrafork.db");
		createFixtureDatabase(dbPath);
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/**
	 * The core correctness guarantee: sharding the per-table work and merging out of order must
	 * produce byte-for-byte the same breakdown as the serial reference scan. Otherwise the settings
	 * page would show different numbers depending on which path ran.
	 */
	test("sharded + out-of-order merge equals the serial scan", () => {
		const db = new Database(dbPath, { readonly: true });
		try {
			const mainBytes = 4_096 * 100;
			const serial = scanDatabaseObjectStorage(db, mainBytes);

			const context = loadScanContext(db);
			const shards = shardTableNames(
				context.tables.map((table) => table.name),
				3,
			);
			// Measure per shard, then deliberately merge shards in REVERSE order to prove the result
			// does not depend on which shard reported first.
			const perShard = shards.map((tableNames) => {
				const byName = new Map(context.tables.map((table) => [table.name, table]));
				return tableNames
					.map((name) => byName.get(name))
					.filter((table): table is NonNullable<typeof table> => Boolean(table))
					.map((table) => measureTable(db, table, context));
			});
			const parallel = aggregateObjectStorage({
				mainBytes,
				pageSize: context.pageSize,
				pageCount: context.pageCount,
				rawFreelistBytes: context.rawFreelistBytes,
				dbstatSupported: context.dbstat.supported,
				dbstatBytesByName: context.dbstat.bytesByName,
				indexesByTable: context.indexesByTable,
				tableSummaries: [...perShard].reverse().flat(),
			});

			expect(parallel).toEqual(serial);
			// Sanity: the fixture must actually have measurable content, or the equality is vacuous.
			expect(serial.topTables.length).toBeGreaterThan(0);
			expect(serial.objectBytes).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	});

	test("topTables ordering is a total order, so the slice is stable", () => {
		const db = new Database(dbPath, { readonly: true });
		try {
			const first = scanDatabaseObjectStorage(db, 4_096 * 100);
			const second = scanDatabaseObjectStorage(db, 4_096 * 100);
			expect(first.topTables.map((table) => table.name)).toEqual(
				second.topTables.map((table) => table.name),
			);
		} finally {
			db.close();
		}
	});

	test("measuring an explicit table subset matches that table in a full scan", () => {
		const db = new Database(dbPath, { readonly: true });
		try {
			const full = scanDatabaseObjectStorage(db, 4_096 * 100);
			const subset = scanDatabaseObjectStorage(db, 4_096 * 100, {
				tableNames: ["narrator_messages"],
			});
			const fromFull = full.topTables.find((table) => table.name === "narrator_messages");
			const fromSubset = subset.topTables.find((table) => table.name === "narrator_messages");
			expect(fromSubset).toEqual(fromFull);
		} finally {
			db.close();
		}
	});
});

describe("worker pool", () => {
	let home = "";
	let dbPath = "";

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "narrafork-db-pool-"));
		dbPath = join(home, "narrafork.db");
		createFixtureDatabase(dbPath);
		resetDbWorkerPoolForTest();
	});

	afterEach(() => {
		shutdownDbWorkerPool();
		setDbWorkerSpecifiersForTest(null);
		delete process.env.NARRAFORK_DB_WORKER;
		delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		rmSync(home, { recursive: true, force: true });
	});

	test("wakes queued work after cancellation during cold startup", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
		const specifier = writeWorkerFixture(
			home,
			"delayed-ready-worker.ts",
			`
	let posted = 0;
	self.onmessage = (event) => {
		if (event.data?.type !== "task") return;
		postMessage({ type: "result", requestId: event.data.requestId, result: { posted: ++posted }, durationMs: 0 });
	};
	await new Promise((resolve) => setTimeout(resolve, 150));
	`,
		);
		setDbWorkerSpecifiersForTest([specifier]);
		const controller = new AbortController();
		const first = runReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{
				timeoutMs: 2000,
				signal: controller.signal,
			},
		).then(
			() => null,
			(error: unknown) => error,
		);
		const queued = runReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{
				timeoutMs: 1500,
			},
		).then(
			(value) => value,
			(error: unknown) => error,
		);
		// The first task owns the only startup reservation; the second must already be waiting.
		await Bun.sleep(20);
		expect(getDbWorkerPoolStats().queued).toBe(1);
		controller.abort();
		expect(await first).toBeInstanceOf(Error);
		// No third request is issued to nudge the pool. The cancelled request must not be posted.
		expect(await queued).toEqual({ posted: 1 });
		expect(getDbWorkerPoolStats().queued).toBe(0);
		expect(getDbWorkerPoolStats().busy).toBe(0);
	}, 5000);

	test("runs a scan-context task in a worker", async () => {
		const context = await runReadTask<StorageScanContextResult>(dbPath, {
			kind: "storageScanContext",
		});
		expect(context.pageSize).toBeGreaterThan(0);
		expect(context.tables.map((table) => table.name)).toContain("narrator_messages");
		// `dbstat` availability is a property of the SQLite BUILD, not a constant: it is compiled in
		// on Bun 1.4.2 and was absent from earlier ones. Asserting a fixed `false` here pinned the
		// runtime rather than the code and started failing on a Bun upgrade that changed nothing
		// about this worker. What the worker owes the caller is a truthful flag, so assert that the
		// flag matches what the very same probe reports on the main thread.
		const probe = new Database(dbPath, { readonly: true });
		try {
			expect(context.dbstatSupported).toBe(loadScanContext(probe).dbstat.supported);
		} finally {
			probe.close();
		}
	}, 60_000);

	test("measures a table shard in a worker", async () => {
		const result = await runReadTask<StorageScanTablesResult>(dbPath, {
			kind: "storageScanTables",
			tableNames: ["narrator_messages", "api_requests"],
		});
		expect(result.tables.map((table) => table.name).sort()).toEqual([
			"api_requests",
			"narrator_messages",
		]);
		const messages = result.tables.find((table) => table.name === "narrator_messages");
		expect(messages?.rowCount).toBe(200);
		expect(messages?.category).toBe("sessions");
		// `approxContentBytes` is the APPROXIMATE mode's output and is deliberately 0 when `dbstat`
		// is available (that path skips the extra `SUM(length(...))` full-table scan, since dbstat
		// already gives exact page-level sizes). The mode-independent claim is that the table was
		// measured to be non-empty, so assert on the total instead of on one mode's field.
		expect(messages?.totalBytes).toBeGreaterThan(0);
		expect(messages?.readFailed).toBeUndefined();
	}, 60_000);

	test("worker results match a direct main-thread measurement", async () => {
		const workerResult = await runReadTask<StorageScanTablesResult>(dbPath, {
			kind: "storageScanTables",
			tableNames: ["narrator_messages"],
		});
		const db = new Database(dbPath, { readonly: true });
		try {
			const context = loadScanContext(db);
			const table = context.tables.find((candidate) => candidate.name === "narrator_messages");
			if (!table) throw new Error("fixture table missing");
			const direct = measureTable(db, table, context);
			expect(workerResult.tables[0]).toEqual(direct);
		} finally {
			db.close();
		}
	}, 60_000);

	test("reports progress per measured table", async () => {
		const seen: Array<{ tableName: string; done: number; total: number }> = [];
		await runReadTask<StorageScanTablesResult>(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["narrators", "projects", "zzz_last"] },
			{ onProgress: (progress) => seen.push(progress) },
		);
		expect(seen.length).toBe(3);
		expect(seen.map((entry) => entry.done)).toEqual([1, 2, 3]);
		expect(seen.every((entry) => entry.total === 3)).toBe(true);
	}, 60_000);

	test("coalesces concurrent tasks that share a dedupe key", async () => {
		const [a, b] = await Promise.all([
			runReadTask<StorageScanContextResult>(
				dbPath,
				{ kind: "storageScanContext" },
				{ dedupeKey: "same" },
			),
			runReadTask<StorageScanContextResult>(
				dbPath,
				{ kind: "storageScanContext" },
				{ dedupeKey: "same" },
			),
		]);
		// Same object identity proves one execution was shared, not two runs producing equal data.
		expect(a).toBe(b);
	}, 60_000);

	/**
	 * Regression guard for a claim race that silently destroyed all parallelism.
	 *
	 * `acquireWorker` awaits worker readiness, and the caller awaits again before posting a task. When
	 * "is this worker free?" was decided by `busyWith` alone, every concurrent caller saw the same
	 * freshly spawned worker as idle and reused it — so a concurrency-4 pool ran exactly ONE worker
	 * and serialised everything (measured on a real database: four concurrent scans took 4x a single
	 * scan, i.e. a 1.00x speedup). Workers are now claimed synchronously at hand-out time.
	 */
	test("grows to the configured concurrency for simultaneous tasks", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "4";
		const tasks = ["narrators", "projects", "api_requests", "narrator_messages"].map((name) =>
			runReadTask<StorageScanTablesResult>(dbPath, {
				kind: "storageScanTables",
				tableNames: [name],
			}),
		);
		// Sample while the tasks are still in flight: all four must be resident simultaneously.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const peak = getDbWorkerPoolStats().workers;
		await Promise.all(tasks);
		expect(peak).toBe(4);
	}, 90_000);

	test("serves more concurrent tasks than workers by queueing", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		expect(getConfiguredConcurrency()).toBe(2);
		const results = await Promise.all(
			["narrators", "projects", "api_requests", "zzz_last", "narrator_messages"].map((name) =>
				runReadTask<StorageScanTablesResult>(dbPath, {
					kind: "storageScanTables",
					tableNames: [name],
				}),
			),
		);
		expect(results.length).toBe(5);
		expect(results.every((result) => result.tables.length === 1)).toBe(true);
		// The cap must be respected even though five tasks were in flight.
		expect(getDbWorkerPoolStats().workers).toBeLessThanOrEqual(2);
	}, 90_000);

	test("throws WorkersUnavailableError when disabled by env, so callers can fall back", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		await expect(runReadTask(dbPath, { kind: "storageScanContext" })).rejects.toBeInstanceOf(
			WorkersUnavailableError,
		);
	});

	test("treats a concurrency of zero as an opt-out", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "0";
		expect(getConfiguredConcurrency()).toBe(0);
		await expect(runReadTask(dbPath, { kind: "storageScanContext" })).rejects.toBeInstanceOf(
			WorkersUnavailableError,
		);
	});

	test("surfaces a task error without killing the pool", async () => {
		await expect(
			runReadTask(join(home, "does-not-exist.db"), { kind: "storageScanContext" }),
		).rejects.toThrow();
		// A failed task must not poison the pool: a subsequent valid task still succeeds.
		const ok = await runReadTask<StorageScanContextResult>(dbPath, {
			kind: "storageScanContext",
		});
		expect(ok.pageSize).toBeGreaterThan(0);
	}, 60_000);

	test("times out a task and stays usable afterwards", async () => {
		await expect(
			runReadTask(
				dbPath,
				{ kind: "storageScanTables", tableNames: ["narrator_messages"] },
				{ timeoutMs: 1 },
			),
		).rejects.toThrow(/timed out/);
		const ok = await runReadTask<StorageScanContextResult>(dbPath, {
			kind: "storageScanContext",
		});
		expect(ok.pageSize).toBeGreaterThan(0);
	}, 60_000);

	test("rejects an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runReadTask(dbPath, { kind: "storageScanContext" }, { signal: controller.signal }),
		).rejects.toThrow(/aborted/);
	}, 30_000);

	test("shutdown terminates workers and clears state", async () => {
		await runReadTask<StorageScanContextResult>(dbPath, { kind: "storageScanContext" });
		expect(getDbWorkerPoolStats().workers).toBeGreaterThan(0);
		shutdownDbWorkerPool();
		const stats = getDbWorkerPoolStats();
		expect(stats.workers).toBe(0);
		expect(stats.queued).toBe(0);
		expect(stats.inFlight).toBe(0);
	}, 60_000);

	/**
	 * Regression guard for a deadlock that hung the caller forever.
	 *
	 * A spawn failure used to be indistinguishable from "pool at capacity": `acquireWorker` returned
	 * null for both, and since the FIRST failure does not yet trip MAX_SPAWN_FAILURES the pool was
	 * still considered viable, so the task queued itself. But no live worker remained — the failed one
	 * was already retired — so nothing would ever call `drainQueue` again. Worse, the task timeout and
	 * abort listener were only armed AFTER a worker had been obtained, so the caller's `timeoutMs` was
	 * inert on this path: `runParallelObjectStorageScan` never reached its main-thread fallback, the
	 * SSE request never responded, and shutdown then blocked on HTTP drain (losing the clean-shutdown
	 * marker).
	 *
	 * This is a different path from the env-disabled test above, which short-circuits at the
	 * `runReadTask` entry before any spawn is attempted.
	 */
	test("spawn failure rejects with WorkersUnavailableError instead of hanging", async () => {
		setDbWorkerSpecifiersForTest([pathToFileURL(join(home, "no-such-worker.ts")).href]);
		const startedAt = Date.now();
		// A generous timeout that we expect NOT to be needed: if the pool queues instead of failing,
		// the assertion below fails on elapsed time even in the pathological "eventually" case.
		await expect(
			runReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 20_000 }),
		).rejects.toBeInstanceOf(WorkersUnavailableError);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(getDbWorkerPoolStats().queued).toBe(0);
	}, 40_000);

	test("a spawn failure does not permanently disable the pool on the first attempt", async () => {
		setDbWorkerSpecifiersForTest([pathToFileURL(join(home, "no-such-worker.ts")).href]);
		await expect(runReadTask(dbPath, { kind: "storageScanContext" })).rejects.toBeInstanceOf(
			WorkersUnavailableError,
		);
		// One failure must not latch `disabledReason`, otherwise a transient hiccup would cost every
		// later scan its worker path for the rest of the process' life.
		expect(getDbWorkerPoolStats().disabledReason).toBe(null);

		setDbWorkerSpecifiersForTest(null);
		const ok = await runReadTask<StorageScanContextResult>(dbPath, {
			kind: "storageScanContext",
		});
		expect(ok.pageSize).toBeGreaterThan(0);
	}, 60_000);

	test("repeated spawn failures disable the pool so callers stop paying for spawns", async () => {
		setDbWorkerSpecifiersForTest([pathToFileURL(join(home, "no-such-worker.ts")).href]);
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(runReadTask(dbPath, { kind: "storageScanContext" })).rejects.toBeInstanceOf(
				WorkersUnavailableError,
			);
		}
		expect(getDbWorkerPoolStats().disabledReason).toBe("worker_unavailable");
		// Restoring a good specifier must not resurrect the pool: only an explicit reset does.
		setDbWorkerSpecifiersForTest(null);
		await expect(runReadTask(dbPath, { kind: "storageScanContext" })).rejects.toBeInstanceOf(
			WorkersUnavailableError,
		);
	}, 60_000);

	/**
	 * A dying worker thread must fail its own in-flight task. Without the `close`/`error` handling in
	 * `retireWorker`, the pending entry would stay in the map and the caller would wait out its full
	 * timeout for a result that can never arrive.
	 */
	test("a worker that dies mid-task rejects that task promptly", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "crashing-worker.ts", CRASHING_WORKER_BODY),
		]);
		const startedAt = Date.now();
		await expect(
			runReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 20_000 }),
		).rejects.toThrow(/worker died/);
		// Rejected by the death signal, not by the timeout.
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		// The dead worker must also be gone from the pool rather than lingering as "busy".
		expect(getDbWorkerPoolStats().workers).toBe(0);
	}, 40_000);

	/**
	 * The abort path taken while a task is already posted (the listener branch), as opposed to the
	 * already-aborted fast path covered above.
	 */
	test("aborts a task that is already running in a worker", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "hanging-worker.ts", HANGING_WORKER_BODY),
		]);
		const controller = new AbortController();
		const task = runReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{ signal: controller.signal, timeoutMs: 20_000 },
		);
		// Give the pool time to spawn the worker and post the task, so the abort lands on the
		// in-flight listener rather than the synchronous pre-check.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(getDbWorkerPoolStats().busy).toBe(1);

		controller.abort();
		await expect(task).rejects.toThrow(/aborted/);
		// An aborted worker may still be mid-scan, so it is retired rather than reused.
		expect(getDbWorkerPoolStats().workers).toBe(0);
	}, 40_000);

	/**
	 * Queue waiting must be inside the timeout budget.
	 *
	 * Before the fix the timeout was armed only after a worker had been handed out, so a task parked
	 * behind a busy pool waited forever. The hanging fixture pins the single allowed worker, so the
	 * second task can only ever be in the queue.
	 */
	test("times out while waiting in the queue rather than waiting forever", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "hanging-worker.ts", HANGING_WORKER_BODY),
		]);
		const blocker = runReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(getDbWorkerPoolStats().busy).toBe(1);

		const startedAt = Date.now();
		const queued = runReadTask(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["narrators"] },
			{ timeoutMs: 500 },
		);
		await expect(queued).rejects.toThrow(/timed out/);
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeGreaterThanOrEqual(400);
		expect(elapsed).toBeLessThan(4_000);
		// The timed-out waiter must remove ITS OWN queue entry, or a later drain releases a dead slot.
		expect(getDbWorkerPoolStats().queued).toBe(0);

		blocker.catch(() => {});
		shutdownDbWorkerPool();
		await expect(blocker).rejects.toThrow();
	}, 40_000);

	/** An abort must also cancel a task that has not been given a worker yet. */
	test("aborts a task while it is still waiting in the queue", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "hanging-worker.ts", HANGING_WORKER_BODY),
		]);
		const blocker = runReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 150));

		const controller = new AbortController();
		const queued = runReadTask(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["narrators"] },
			{ signal: controller.signal, timeoutMs: 30_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(getDbWorkerPoolStats().queued).toBe(1);

		controller.abort();
		await expect(queued).rejects.toThrow(/aborted/);
		expect(getDbWorkerPoolStats().queued).toBe(0);

		blocker.catch(() => {});
		shutdownDbWorkerPool();
		await expect(blocker).rejects.toThrow();
	}, 40_000);

	/** Shutdown must settle queued waiters too; dropping them reintroduces the hang. */
	test("shutdown rejects tasks still waiting in the queue", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "hanging-worker.ts", HANGING_WORKER_BODY),
		]);
		const blocker = runReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 30_000 });
		await new Promise((resolve) => setTimeout(resolve, 150));
		const queued = runReadTask(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["narrators"] },
			{ timeoutMs: 30_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(getDbWorkerPoolStats().queued).toBe(1);

		blocker.catch(() => {});
		queued.catch(() => {});
		shutdownDbWorkerPool();
		await expect(queued).rejects.toBeInstanceOf(WorkersUnavailableError);
		await expect(blocker).rejects.toThrow();
	}, 40_000);

	/**
	 * Fairness invariant: queued tasks are served in submission order.
	 *
	 * This is the observable end of the bounded drain. The unbounded version released the WHOLE queue
	 * on every completion and all but one waiter re-queued at the tail — mostly harmless churn, but it
	 * is exactly the churn that makes ordering depend on scheduling accidents. Note this test does not
	 * by itself distinguish the two drains; it pins the guarantee the quota is there to keep.
	 */
	test("serves queued tasks in submission order", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
		const completions: string[] = [];
		const names = ["narrators", "projects", "api_requests", "zzz_last", "narrator_messages"];
		await Promise.all(
			names.map((name) =>
				runReadTask<StorageScanTablesResult>(dbPath, {
					kind: "storageScanTables",
					tableNames: [name],
				}).then((result) => {
					completions.push(result.tables[0]?.name ?? "missing");
				}),
			),
		);
		expect(completions).toEqual(names);
	}, 90_000);
});
