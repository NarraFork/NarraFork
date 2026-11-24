import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
	aggregateObjectStorage,
	loadScanContext,
	measureTable,
	scanDatabaseObjectStorage,
} from "../../../services/storage-scan-queries";
import { logger } from "../../logger";
import { DbReadError } from "../errors";
import {
	DB_READ_QUEUE_MAX_BYTES,
	DB_READ_QUEUE_MAX_TASKS,
	DbReadTaskOverloadedError,
	drainDbWorkerPool,
	getConfiguredConcurrency,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runEphemeralReadTask,
	runReadTask,
	runTrackedEphemeralReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
	WorkersUnavailableError,
} from "../pool";
import type { StorageScanContextResult, StorageScanTablesResult } from "../protocol";
import { getDbReadAbortDiagnostics } from "../read-diagnostics";
import { shardTableNames } from "../storage-scan-runner";

/**
 * Build a database with enough shape to exercise the scan: several tables, indexes, a virtual FTS
 * table, and a table large enough that its byte total is non-trivial.
 */
function createFixtureDatabase(dbPath: string): void {
	const db = new Database(dbPath);
	const statements: Array<{ finalize(): void }> = [];
	try {
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
		statements.push(insertNarrator);
		const insertMessage = db.prepare(
			"INSERT INTO narrator_messages (id, content_json) VALUES (?, ?)",
		);
		statements.push(insertMessage);
		const insertDump = db.prepare("INSERT INTO api_requests (id, raw_dump_json) VALUES (?, ?)");
		statements.push(insertDump);
		const seed = db.transaction(() => {
			for (let i = 0; i < 200; i++) {
				insertNarrator.run(`n${i}`, `narrator ${i}`, i % 2 === 0 ? "idle" : "working");
				insertMessage.run(`m${i}`, JSON.stringify({ type: "text", text: "x".repeat(200) }));
				if (i % 3 === 0) insertDump.run(`a${i}`, "y".repeat(500));
			}
		});
		seed();
	} finally {
		// strict close requires every explicitly prepared statement to release its native handle.
		for (const statement of statements) statement.finalize();
		db.close(true);
	}
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
	writeFileSync(
		file,
		`import { parentPort } from "node:worker_threads";\nconst self = { onmessage: undefined };\nconst postMessage = (message) => parentPort.postMessage(message);\nparentPort.on("message", data => self.onmessage?.({ data }));\n${body}\npostMessage({ type: "ready" });\n`,
		"utf8",
	);
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

/** Counts successful tasks and exposes controlled failure/hanging paths without opening a database. */
const REUSABLE_WORKER_BODY = `
let posted = 0;
self.onmessage = (event) => {
	const { type, requestId, params } = event.data;
	if (type !== "task") return;
	if (params.kind === "storageScanContext") {
		postMessage({ type: "result", requestId, result: ++posted, durationMs: 0 });
		return;
	}
	postMessage({ type: "progress", requestId, tableName: "started", done: 0, total: 1 });
	if (params.tableNames?.[0] === "error")
		postMessage({ type: "error", requestId, code: "DB_READ_FAILED", message: "fixture task failed", durationMs: 0 });
	if (params.tableNames?.[0] === "exit") process.exit(3);
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

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "narrafork-scan-determinism-"));
		dbPath = join(home, "narrafork.db");
		createFixtureDatabase(dbPath);
	});

	afterEach(async () => {
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
			db.close(true);
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
			db.close(true);
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
			db.close(true);
		}
	});
});

describe("worker pool", () => {
	let home = "";
	let dbPath = "";

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "narrafork-db-pool-"));
		dbPath = join(home, "narrafork.db");
		createFixtureDatabase(dbPath);
		await resetDbWorkerPoolForTest();
	});

	afterEach(async () => {
		await drainDbWorkerPool({ timeoutMs: 20_000 });
		setDbWorkerSpecifiersForTest(null);
		delete process.env.NARRAFORK_DB_WORKER;
		delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		rmSync(home, { recursive: true, force: true });
	});

	test("wakes queued work after cancellation during cold startup", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
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

	test("settles successful and failed tasks with explicit cleanup and reuses their worker", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "reusable-worker.ts", REUSABLE_WORKER_BODY),
		]);
		expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(1);
		const controller = new AbortController();
		let unrelatedAborts = 0;
		controller.signal.addEventListener("abort", () => unrelatedAborts++);
		const add = spyOn(controller.signal, "addEventListener");
		const remove = spyOn(controller.signal, "removeEventListener");
		const abort = spyOn(AbortController.prototype, "abort");
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			for (let posted = 2; posted <= 9; posted++) {
				expect(
					await runReadTask(
						dbPath,
						{ kind: "storageScanContext" },
						{ signal: controller.signal, timeoutMs: 30_000 },
					),
				).toBe(posted);
				const taskTimer = timers.mock.calls.findLastIndex(
					([, ms]) => typeof ms === "number" && ms <= 30_000,
				);
				expect(clear).toHaveBeenCalledWith(timers.mock.results[taskTimer]?.value);
			}
			const failure = await runReadTask(
				dbPath,
				{ kind: "storageScanTables", tableNames: ["error"] },
				{ signal: controller.signal, timeoutMs: 30_000 },
			).catch((error: unknown) => error);
			expect(failure).toMatchObject({ code: "DB_READ_FAILED", message: "fixture task failed" });
			const taskTimers = timers.mock.calls.flatMap(([, ms], index) =>
				typeof ms === "number" && ms <= 30_000 ? [timers.mock.results[index]?.value] : [],
			);
			expect(taskTimers).toHaveLength(9);
			for (const timer of taskTimers) expect(clear).toHaveBeenCalledWith(timer);
			expect(add).toHaveBeenCalledTimes(9);
			expect(remove).toHaveBeenCalledTimes(9);
			for (let index = 0; index < add.mock.calls.length; index++) {
				const listener = add.mock.calls[index]?.[1];
				expect(add.mock.calls[index]).toEqual(["abort", listener, { once: true }]);
				expect(remove.mock.calls[index]).toEqual(["abort", listener]);
			}
			expect(abort).not.toHaveBeenCalled();
			controller.abort();
			expect(unrelatedAborts).toBe(1);
			expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(10);
			expect(abort).toHaveBeenCalledTimes(1);
			expect(getDbWorkerPoolStats()).toMatchObject({ workers: 1, busy: 0, queued: 0 });
		} finally {
			clear.mockRestore();
			timers.mockRestore();
			abort.mockRestore();
			remove.mockRestore();
			add.mockRestore();
		}
	});

	test.each([
		"exit",
		"postMessage",
		"abort",
		"timeout",
		"shutdown",
	] as const)("releases the dispatched task timer and listener after %s", async (failure) => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "cleanup-worker.ts", REUSABLE_WORKER_BODY),
		]);
		expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(1);
		const controller = new AbortController();
		const add = spyOn(controller.signal, "addEventListener");
		const remove = spyOn(controller.signal, "removeEventListener");
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		const started = Promise.withResolvers<void>();
		const post =
			failure === "postMessage"
				? spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
						throw new Error("fixture dispatch failed");
					})
				: undefined;
		try {
			const task = runReadTask(
				dbPath,
				{ kind: "storageScanTables", tableNames: [failure] },
				{
					signal: controller.signal,
					timeoutMs: failure === "timeout" ? 50 : 30_000,
					onProgress: () => started.resolve(),
				},
			).catch((error: unknown) => error);
			if (failure !== "exit" && failure !== "postMessage") {
				await started.promise;
				if (failure === "abort") controller.abort();
				else if (failure === "shutdown") void shutdownDbWorkerPool().catch(() => {});
				// Shared admission rechecks its absolute deadline; let its real timer expire.
			}
			expect(await task).toMatchObject({
				code:
					failure === "abort"
						? "DB_READ_ABORTED"
						: failure === "timeout"
							? "DB_READ_TASK_TIMEOUT"
							: failure === "postMessage"
								? "DB_READ_FAILED"
								: failure === "shutdown"
									? "DB_READ_UNAVAILABLE"
									: "DB_READ_WORKER_EXITED",
			});
			expect(add).toHaveBeenCalledTimes(1);
			expect(remove.mock.calls).toEqual([["abort", add.mock.calls[0]?.[1]]]);
			expect(timers.mock.calls.length).toBeGreaterThanOrEqual(1);
			for (const timer of timers.mock.results)
				if (timer.type === "return") expect(clear).toHaveBeenCalledWith(timer.value);
			expect(getDbWorkerPoolStats()).toMatchObject({ workers: 0, busy: 0 });
		} finally {
			post?.mockRestore();
			clear.mockRestore();
			timers.mockRestore();
			remove.mockRestore();
			add.mockRestore();
		}
	});

	test("retains the PG cancellation permit through ACK and native exit before replacement", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		const releasePath = join(home, "release-pg-ack");
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(
				home,
				"ack-worker.ts",
				`
			import { existsSync } from "node:fs";
			let posted = 0;
			self.onmessage = async (event) => {
				const { type, requestId, params } = event.data;
				if (type === "task") {
					if (params.kind === "storageScanContext")
						postMessage({ type: "result", requestId, result: ++posted, durationMs: 0 });
					else postMessage({ type: "progress", requestId, tableName: "started", done: 0, total: 1 });
				} else if (type === "cancel") {
					postMessage({ type: "progress", requestId, tableName: "cancelling", done: 0, total: 1 });
					while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(1);
					postMessage({ type: "result", requestId, result: "late result", durationMs: 0 });
				}
			};
			`,
			),
		]);
		expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(1);
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelling = Promise.withResolvers<void>();
		const add = spyOn(controller.signal, "addEventListener");
		const remove = spyOn(controller.signal, "removeEventListener");
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			const task = runReadTask(
				"fixture-postgres-source",
				{
					kind: "displayPageMessagesPostgres",
					messageIds: ["fixture-message"],
					ioBudget: 32,
					deadlineAt: Date.now() + 30_000,
				},
				{
					signal: controller.signal,
					timeoutMs: 30_000,
					onProgress: ({ tableName }) => {
						if (tableName === "started") started.resolve();
						if (tableName === "cancelling") cancelling.resolve();
					},
				},
			).catch((error: unknown) => error);
			await started.promise;
			controller.abort();
			await cancelling.promise;
			expect(timers).toHaveBeenCalledTimes(2);
			const taskTimer = timers.mock.results[0]?.value;
			const ackTimer = timers.mock.results[1]?.value;
			expect(timers.mock.calls[1]?.[1]).toBe(1000);
			expect(clear.mock.calls.filter(([timer]) => timer === taskTimer)).toHaveLength(0);
			expect(clear.mock.calls.filter(([timer]) => timer === ackTimer)).toHaveLength(0);
			expect(remove).not.toHaveBeenCalled();
			const queued = runReadTask(dbPath, { kind: "storageScanContext" });
			await Promise.resolve();
			expect(getDbWorkerPoolStats()).toMatchObject({ workers: 1, busy: 1, queued: 1 });
			writeFileSync(releasePath, "release");
			expect(await task).toMatchObject({ code: "DB_READ_ABORTED" });
			expect(await queued).toBe(1);
			expect(clear).toHaveBeenCalledWith(taskTimer);
			expect(remove).toHaveBeenCalledTimes(1);
			expect(clear.mock.calls.filter(([timer]) => timer === ackTimer)).toHaveLength(1);
			expect(getDbWorkerPoolStats()).toMatchObject({ workers: 1, busy: 0, queued: 0 });
		} finally {
			writeFileSync(releasePath, "release");
			clear.mockRestore();
			timers.mockRestore();
			remove.mockRestore();
			add.mockRestore();
		}
	});

	test.each([
		"abort",
		"timeout",
	] as const)("retires a PG worker without cancellation ACK after %s and advances the queue", async (cancellation) => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "unacknowledged-worker.ts", REUSABLE_WORKER_BODY),
		]);
		expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(1);
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const add = spyOn(controller.signal, "addEventListener");
		const remove = spyOn(controller.signal, "removeEventListener");
		const nativeClearTimeout = globalThis.clearTimeout;
		const nativeSetTimeout = globalThis.setTimeout;
		const ackArmed = Promise.withResolvers<Parameters<typeof clearTimeout>[0]>();
		const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: TimerHandler,
			ms?: number,
			...args: unknown[]
		) => {
			const timer = nativeSetTimeout(fn, ms, ...args);
			if (ms === 1000) ackArmed.resolve(timer);
			return timer;
		}) as typeof setTimeout);
		const clear = spyOn(globalThis, "clearTimeout");
		let ackTimer: Parameters<typeof clearTimeout>[0];
		try {
			const task = runReadTask(
				"fixture-postgres-source",
				{
					kind: "displayPageMessagesPostgres",
					messageIds: ["fixture-message"],
					ioBudget: 32,
					deadlineAt: Date.now() + 30_000,
				},
				{
					signal: controller.signal,
					timeoutMs: cancellation === "timeout" ? 50 : 30_000,
					onProgress: () => started.resolve(),
				},
			).catch((error: unknown) => error);
			await started.promise;
			if (cancellation === "abort") controller.abort();
			ackTimer = await ackArmed.promise;
			expect(clear.mock.calls.filter(([timer]) => timer === ackTimer)).toHaveLength(0);
			expect(remove).not.toHaveBeenCalled();
			const queued = runReadTask(dbPath, { kind: "storageScanContext" });
			await Promise.resolve();
			expect(getDbWorkerPoolStats().queued).toBe(1);
			// Fire the actual registered watchdog, without waiting for its production delay.
			const onAckTimeout = timers.mock.calls.find(([, ms]) => ms === 1000)?.[0];
			if (typeof onAckTimeout !== "function") throw new Error("ACK timer missing");
			nativeClearTimeout(ackTimer);
			onAckTimeout();
			// A termination request alone does not free the shared native slot.
			expect(getDbWorkerPoolStats().workers).toBe(1);
			expect(await task).toMatchObject({
				code: cancellation === "abort" ? "DB_READ_ABORTED" : "DB_READ_TASK_TIMEOUT",
			});
			expect(await queued).toBe(1);
			expect(remove.mock.calls).toEqual([["abort", add.mock.calls[0]?.[1]]]);
			expect(getDbWorkerPoolStats()).toMatchObject({ workers: 1, busy: 0, queued: 0 });
		} finally {
			// Leave a still-armed real watchdog intact so failed assertions cannot strand an owner.
			clear.mockRestore();
			timers.mockRestore();
			remove.mockRestore();
			add.mockRestore();
		}
	});

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
		expect(messages?.rowCount).toBeNull();
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
			db.close(true);
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
	test("ordinary work reaches shared capacity while the reserved worker stays available", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "4";
		const releasePath = join(home, "release-concurrent-tasks");
		const specifier = writeWorkerFixture(
			home,
			"barrier-worker.ts",
			`
	import { existsSync } from "node:fs";
	self.onmessage = async (event) => {
		if (event.data?.type !== "task") return;
		const { requestId, params } = event.data;
		postMessage({ type: "progress", requestId, tableName: params.tableNames[0], done: 0, total: 1 });
		while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(10);
		postMessage({ type: "result", requestId, result: params.tableNames[0], durationMs: 0 });
	};
	`,
		);
		setDbWorkerSpecifiersForTest([specifier]);
		const started = new Set<string>();
		const allStarted = Promise.withResolvers<void>();
		const names = ["narrators", "projects", "api_requests", "narrator_messages"];
		const tasks = names.map((name) =>
			runReadTask<string>(
				dbPath,
				{ kind: "storageScanTables", tableNames: [name] },
				{
					timeoutMs: 60_000,
					onProgress: ({ tableName }) => {
						started.add(tableName);
						if (started.size === 3) allStarted.resolve();
					},
				},
			),
		);
		const completed = Promise.all(tasks);
		try {
			// Readiness can take longer than 50ms on CI. Hold every task at a barrier instead
			// of sampling startup timing; three resident workers alone would not prove concurrency.
			await Promise.race([allStarted.promise, completed]);
			expect(started.size).toBe(3);
			expect(getDbWorkerPoolStats().workers).toBe(3);
			expect(getDbWorkerPoolStats()).toMatchObject({
				busy: 3,
				queued: 1,
				configuration: { concurrency: 4, reservedCapacity: 1, normalCapacity: 3 },
			});
		} finally {
			writeFileSync(releasePath, "release");
			await completed;
		}
		expect(await completed).toEqual(names);
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
		const failure = await runReadTask(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["narrator_messages"] },
			{ timeoutMs: 1 },
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/timed out/);
		expect(failure).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		const ok = await runReadTask<StorageScanContextResult>(dbPath, {
			kind: "storageScanContext",
		});
		expect(ok.pageSize).toBeGreaterThan(0);
	}, 60_000);

	test("ephemeral watchdog is classified and does not restart on another specifier", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "ephemeral-hang.ts", HANGING_WORKER_BODY),
			writeWorkerFixture(
				home,
				"ephemeral-must-not-run.ts",
				`
				self.onmessage = (event) => {
					postMessage({ type: "result", requestId: event.data.requestId, result: "restarted" });
				};
			`,
			),
		]);
		await expect(
			runEphemeralReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 200 }),
		).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
	}, 5000);

	test("ephemeral query failure does not retry another worker entry", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(
				home,
				"ephemeral-query-error.ts",
				`
				self.onmessage = (event) => {
					postMessage({ type: "error", requestId: event.data.requestId, message: "query failed" });
				};
			`,
			),
			writeWorkerFixture(
				home,
				"ephemeral-must-not-retry.ts",
				`
				self.onmessage = (event) => {
					postMessage({ type: "result", requestId: event.data.requestId, result: "restarted" });
				};
			`,
			),
		]);
		await expect(
			runEphemeralReadTask(dbPath, { kind: "storageScanContext" }),
		).rejects.toMatchObject({ name: "DbReadTaskExecutionError", message: "query failed" });
	}, 5000);

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
		await shutdownDbWorkerPool();
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
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "hanging-worker.ts", HANGING_WORKER_BODY),
		]);
		const blocker = runReadTask(dbPath, { kind: "storageScanContext" }, { timeoutMs: 10_000 });
		blocker.catch(() => {}); // Keep fixture cleanup handled even when a later assertion fails.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(getDbWorkerPoolStats().busy).toBe(1);

		const startedAt = Date.now();
		const queued = runReadTask(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["narrators"] },
			{ timeoutMs: 500 },
		);
		const failure = await queued.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toMatch(/timed out/);
		expect(failure).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeGreaterThanOrEqual(400);
		expect(elapsed).toBeLessThan(4_000);
		// The timed-out waiter must remove ITS OWN queue entry, or a later drain releases a dead slot.
		expect(getDbWorkerPoolStats().queued).toBe(0);

		blocker.catch(() => {});
		await shutdownDbWorkerPool();
		await expect(blocker).rejects.toThrow();
	}, 40_000);

	/** An abort must also cancel a task that has not been given a worker yet. */
	test("aborts a task while it is still waiting in the queue", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
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
		await shutdownDbWorkerPool();
		await expect(blocker).rejects.toThrow();
	}, 40_000);

	/** Shutdown must settle queued waiters too; dropping them reintroduces the hang. */
	test("shutdown rejects tasks still waiting in the queue", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
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
		await shutdownDbWorkerPool();
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
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
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

describe("read cancellation diagnostics", () => {
	let home = "";
	let dbPath = "";
	const receivedTaskWorker = `
	self.onmessage = (event) => {
		if (event.data?.type !== "task") return;
		postMessage({ type: "progress", requestId: event.data.requestId, tableName: event.data.requestId, done: 0, total: 1 });
	};
	`;
	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "narrafork-db-abort-diagnostics-"));
		dbPath = join(home, "private-source.db");
		writeFileSync(dbPath, "fake database source");
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		await resetDbWorkerPoolForTest();
	});
	afterEach(async () => {
		await drainDbWorkerPool({ timeoutMs: 20_000 });
		setDbWorkerSpecifiersForTest(null);
		delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		rmSync(home, { recursive: true, force: true });
	});

	test("pre-aborted ordinary, ephemeral and tracked reads have admission context without an ID", async () => {
		const controller = new AbortController();
		controller.abort(new Error("private cancellation reason"));
		const params = {
			kind: "selectRows",
			sql: "SELECT ?",
			params: ["private bind"],
			maxRows: 1,
		} as const;
		const options = { signal: controller.signal, diagnosticSource: "private caller label" };
		const tasks = [
			runReadTask(dbPath, { ...params, params: [...params.params] }, options),
			runEphemeralReadTask(dbPath, { ...params, params: [...params.params] }, options),
		];
		const tracked = runTrackedEphemeralReadTask(
			dbPath,
			{ ...params, params: [...params.params] },
			options,
		);
		tasks.push(tracked.result);
		for (const task of tasks) {
			const error = await task.catch((failure: unknown) => failure);
			expect(error).toBeInstanceOf(DbReadError);
			expect(error).toMatchObject({
				name: "DbReadError",
				code: "DB_READ_ABORTED",
				message: "database read task aborted",
			});
			expect(getDbReadAbortDiagnostics(error)).toEqual({ kind: "selectRows", phase: "admission" });
		}
		await tracked.released;
		expect(getDbWorkerPoolStats().tracked).toBe(0);
	});

	test("cancellation during ephemeral startup remains acquiring and has no allocated task ID", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "starting-worker.ts", `await new Promise(() => {});`),
		]);
		const controller = new AbortController();
		const task = runEphemeralReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{ signal: controller.signal, timeoutMs: 5000 },
		).catch((error: unknown) => error);
		await Bun.sleep(0);
		expect(getDbWorkerPoolStats()).toMatchObject({ starting: 1, tracked: 0 });
		controller.abort("private startup reason");
		const error = await task;
		expect(error).toMatchObject({ code: "DB_READ_ABORTED" });
		expect(getDbReadAbortDiagnostics(error)).toEqual({
			kind: "storageScanContext",
			phase: "acquiring",
		});
		expect(getDbWorkerPoolStats().busy).toBe(0);
	});

	test("queued cancellation has no allocated ID while the dispatched blocker retains its ID", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "queued-worker.ts", receivedTaskWorker),
		]);
		const started = Promise.withResolvers<string>();
		const blockerController = new AbortController();
		const blocker = runReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{
				signal: blockerController.signal,
				onProgress: ({ tableName }) => started.resolve(tableName),
				timeoutMs: 5000,
			},
		).catch((error: unknown) => error);
		const taskId = await started.promise;
		const controller = new AbortController();
		const queued = runReadTask(
			dbPath,
			{ kind: "storageScanTables", tableNames: ["private_table"] },
			{ signal: controller.signal, timeoutMs: 5000 },
		).catch((error: unknown) => error);
		await Promise.resolve();
		expect(getDbWorkerPoolStats().queued).toBe(1);
		controller.abort();
		expect(getDbReadAbortDiagnostics(await queued)).toEqual({
			kind: "storageScanTables",
			phase: "queued",
		});
		expect(getDbWorkerPoolStats().queued).toBe(0);
		blockerController.abort();
		expect(getDbReadAbortDiagnostics(await blocker)).toEqual({
			kind: "storageScanContext",
			phase: "running",
			taskId,
		});
	});

	test("tracked running cancellation correlates the actual posted ID without private inputs", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "running-worker.ts", receivedTaskWorker),
		]);
		const controller = new AbortController();
		const started = Promise.withResolvers<string>();
		const task = runTrackedEphemeralReadTask(
			dbPath,
			{
				kind: "selectRows",
				sql: "SELECT secret_payload FROM private_table WHERE token = ?",
				params: ["private bind"],
				maxRows: 1,
			},
			{
				signal: controller.signal,
				diagnosticSource: "private source label",
				onProgress: ({ tableName }) => started.resolve(tableName),
				timeoutMs: 5000,
			},
		);
		const result = task.result.catch((error: unknown) => error);
		const taskId = await started.promise;
		controller.abort({ sql: "private reason SQL", params: ["private reason bind"], dbPath });
		const error = await result;
		expect(error).toBeInstanceOf(DbReadError);
		expect(taskId).toMatch(/^dbr-[a-z0-9]+-[a-z0-9]+$/);
		expect(getDbReadAbortDiagnostics(error)).toEqual({
			kind: "selectRows",
			phase: "running",
			taskId,
		});
		expect(JSON.stringify(getDbReadAbortDiagnostics(error))).not.toContain("private");
		expect(JSON.stringify(error)).toBe('{"code":"DB_READ_ABORTED","name":"DbReadError"}');
		await task.released;
		expect(getDbWorkerPoolStats().tracked).toBe(0);
	});

	test("worker-returned cancellation uses the host domain and task ID, not remote error properties", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(
				home,
				"aborted-worker.ts",
				`
			self.onmessage = (event) => {
				if (event.data?.type !== "task") return;
				const { requestId } = event.data;
				postMessage({ type: "progress", requestId, tableName: requestId, done: 0, total: 1 });
				postMessage({ type: "error", requestId, code: "DB_READ_ABORTED", message: "database read task aborted", durationMs: 0,
					taskId: "dbr-forged-1", phase: "admission", domainTask: "private task", sql: "private SQL", remoteError: { reason: "private" } });
			};
			`,
			),
		]);
		let taskId = "";
		const error = await runReadTask(
			dbPath,
			{ kind: "domainRead", task: "readerProbe", input: null },
			{
				onProgress: ({ tableName }) => {
					taskId = tableName;
				},
				timeoutMs: 5000,
			},
		).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(DbReadError);
		expect(taskId).toMatch(/^dbr-[a-z0-9]+-[a-z0-9]+$/);
		expect(getDbReadAbortDiagnostics(error)).toEqual({
			kind: "domainRead",
			domainTask: "readerProbe",
			phase: "running",
			taskId,
		});
		expect(error).not.toHaveProperty("remoteError");
		expect(error).not.toHaveProperty("taskId");
	});

	test("deduplicated subscriptions cancel independently and retain the execution owner's diagnostics", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "shared-worker.ts", receivedTaskWorker),
		]);
		const controller = new AbortController();
		const started = Promise.withResolvers<string>();
		const owner = runReadTask(
			dbPath,
			{ kind: "domainRead", task: "readerProbe", input: null },
			{
				signal: controller.signal,
				dedupeKey: "shared-abort",
				timeoutMs: 5000,
				onProgress: ({ tableName }) => started.resolve(tableName),
			},
		).catch((error: unknown) => error);
		const waiterController = new AbortController();
		const waiter = runReadTask(
			dbPath,
			{ kind: "domainRead", task: "readerProbe", input: null },
			{ dedupeKey: "shared-abort", timeoutMs: 5000, signal: waiterController.signal },
		).catch((error: unknown) => error);
		const taskId = await started.promise;
		controller.abort();
		const ownerError = await owner;
		expect(ownerError).toMatchObject({ code: "DB_READ_ABORTED" });
		expect(getDbWorkerPoolStats()).toMatchObject({ inFlight: 1, busy: 1 });
		waiterController.abort();
		const waiterError = await waiter;
		expect(waiterError).toMatchObject({ code: "DB_READ_ABORTED" });
		expect(waiterError).not.toBe(ownerError);
		expect(getDbReadAbortDiagnostics(waiterError)).toEqual({
			kind: "domainRead",
			domainTask: "readerProbe",
			phase: "running",
			taskId,
		});
		await drainDbWorkerPool({ timeoutMs: 20_000 });
		expect(getDbWorkerPoolStats().inFlight).toBe(0);
	});

	test("cancellation after ID allocation but before post remains dispatching and does not post a task", async () => {
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(
				home,
				"counting-worker.ts",
				`
			let posted = 0;
			self.onmessage = (event) => {
				if (event.data?.type !== "task") return;
				postMessage({ type: "result", requestId: event.data.requestId, result: ++posted, durationMs: 0 });
			};
			`,
			),
		]);
		expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(1);
		const controller = new AbortController();
		let aborted = false;
		Object.defineProperty(controller.signal, "aborted", {
			// Binding an ID makes the worker busy before the final pre-post cancellation check.
			get: () => {
				if (!aborted && getDbWorkerPoolStats().busy === 1) {
					aborted = true;
					controller.abort("private pre-post reason");
				}
				return aborted;
			},
		});
		const posted = spyOn(Worker.prototype, "postMessage");
		try {
			const error = await runReadTask(
				dbPath,
				{ kind: "storageScanContext" },
				{ signal: controller.signal, timeoutMs: 5000 },
			).catch((failure: unknown) => failure);
			expect(error).toMatchObject({ code: "DB_READ_ABORTED" });
			expect(getDbReadAbortDiagnostics(error)).toEqual({
				kind: "storageScanContext",
				phase: "dispatching",
				taskId: expect.stringMatching(/^dbr-[a-z0-9]+-[a-z0-9]+$/),
			});
			expect(posted.mock.calls.filter(([message]) => message?.type === "task")).toHaveLength(0);
			expect(getDbWorkerPoolStats()).toMatchObject({ busy: 0, tracked: 0 });
			expect(await runReadTask(dbPath, { kind: "storageScanContext" })).toBe(1);
		} finally {
			posted.mockRestore();
		}
	});
});

describe("queue admission diagnostics", () => {
	let home = "";
	let dbPath = "";

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "narrafork-db-queue-diagnostics-"));
		dbPath = join(home, "fake.db");
		// The stand-in workers never open it: only the source-identity filesystem check runs.
		writeFileSync(dbPath, "fake database source");
		await resetDbWorkerPoolForTest();
	});

	afterEach(async () => {
		await drainDbWorkerPool({ timeoutMs: 20_000 });
		setDbWorkerSpecifiersForTest(null);
		delete process.env.NARRAFORK_DB_WORKER;
		delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		rmSync(home, { recursive: true, force: true });
	});

	test("queue admission diagnostics preserve the count boundary and rate-limit without payloads", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "diagnostic-hanging-worker.ts", HANGING_WORKER_BODY),
		]);
		const blockerController = new AbortController();
		const blocker = runReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{
				signal: blockerController.signal,
				timeoutMs: 30_000,
			},
		).catch((error: unknown) => error);
		const controllers: AbortController[] = [];
		const waiters: Array<Promise<unknown>> = [];
		const records: Array<Record<string, unknown>> = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, fields) => {
			if (message === "Database read queue admission rejected") records.push(fields ?? {});
		});
		let wallClock: { mockRestore(): void } | undefined;
		try {
			const readyBy = performance.now() + 2_000;
			while (!getDbWorkerPoolStats().busy && performance.now() < readyBy) await Bun.sleep(1);
			expect(getDbWorkerPoolStats().busy).toBe(1);
			for (let index = 0; index < (DB_READ_QUEUE_MAX_TASKS * 3) / 4; index++) {
				const controller = new AbortController();
				controllers.push(controller);
				waiters.push(
					runReadTask(
						dbPath,
						{ kind: "storageScanContext" },
						{
							signal: controller.signal,
							timeoutMs: 30_000,
						},
					).catch((error: unknown) => error),
				);
			}
			await Bun.sleep(0);
			expect(getDbWorkerPoolStats().queued).toBe((DB_READ_QUEUE_MAX_TASKS * 3) / 4);
			const queuedBytes = getDbWorkerPoolStats().queuedBytes;
			let now = Date.now() + 20_000;
			wallClock = spyOn(Date, "now").mockImplementation(() => now);
			const secret = "https://private.invalid/?token=private-queue-payload";
			const rejected = () =>
				runReadTask(
					dbPath,
					{
						kind: "selectRows",
						sql: "SELECT ? AS private_queue_template",
						params: [secret],
						maxRows: 1,
					},
					{ diagnosticSource: secret },
				);
			for (let index = 0; index < 8; index++) {
				const error = await rejected().catch((error: unknown) => error);
				expect(error).toBeInstanceOf(DbReadTaskOverloadedError);
				expect(error).toMatchObject({
					code: "DB_READ_TASK_OVERLOADED",
					name: "DbReadTaskOverloadedError",
					message: "Database read worker queue is full",
				});
			}
			expect(records).toHaveLength(5);
			expect(records[0]).toMatchObject({
				reason: "normal-count",
				taskKind: "selectRows",
				queued: (DB_READ_QUEUE_MAX_TASKS * 3) / 4,
				queuedBytes,
				maxQueued: DB_READ_QUEUE_MAX_TASKS,
				maxQueuedBytes: DB_READ_QUEUE_MAX_BYTES,
				workers: 1,
				busy: 1,
				retiring: 0,
				pendingSpawns: 0,
				concurrency: 2,
				rateLimitWindowMs: 10_000,
				rateLimitMaxLogs: 5,
			});
			now += 10_000;
			await expect(rejected()).rejects.toMatchObject({ code: "DB_READ_TASK_OVERLOADED" });
			expect(records).toHaveLength(6);
			expect(records.at(-1)?.suppressedSinceLastLog).toBe(3);
			const text = JSON.stringify(records);
			for (const privateText of [
				secret,
				"private_queue_template",
				dbPath,
				"sql",
				"params",
				"diagnosticSource",
			])
				expect(text).not.toContain(privateText);
			expect(getDbWorkerPoolStats()).toMatchObject({
				queued: (DB_READ_QUEUE_MAX_TASKS * 3) / 4,
				queuedBytes,
			});
		} finally {
			wallClock?.mockRestore();
			for (const controller of controllers) controller.abort();
			blockerController.abort();
			await Promise.all([...waiters, blocker]);
			warn.mockRestore();
		}
	});

	test("queue admission diagnostics preserve the inclusive byte boundary", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
		setDbWorkerSpecifiersForTest([
			writeWorkerFixture(home, "diagnostic-byte-worker.ts", HANGING_WORKER_BODY),
		]);
		const blockerController = new AbortController();
		const blocker = runReadTask(
			dbPath,
			{ kind: "storageScanContext" },
			{
				signal: blockerController.signal,
				timeoutMs: 30_000,
			},
		).catch((error: unknown) => error);
		const queuedController = new AbortController();
		const probeController = new AbortController();
		let probe: Promise<unknown> | undefined;
		let queued: Promise<unknown> | undefined;
		const records: Array<Record<string, unknown>> = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, fields) => {
			if (message === "Database read queue admission rejected") records.push(fields ?? {});
		});
		try {
			const readyBy = performance.now() + 2_000;
			while (!getDbWorkerPoolStats().busy && performance.now() < readyBy) await Bun.sleep(1);
			expect(getDbWorkerPoolStats().busy).toBe(1);
			probe = runReadTask(
				dbPath,
				{ kind: "storageScanTables", tableNames: [""] },
				{
					signal: probeController.signal,
					timeoutMs: 30_000,
				},
			).catch((error: unknown) => error);
			await Bun.sleep(0);
			const overhead = getDbWorkerPoolStats().queuedBytes;
			expect(overhead).toBeGreaterThan(0);
			probeController.abort();
			await probe;
			queued = runReadTask(
				dbPath,
				{
					kind: "storageScanTables",
					tableNames: ["private-queue-body".padEnd(6 * 1024 * 1024 - overhead, "x")],
				},
				{ signal: queuedController.signal, timeoutMs: 30_000 },
			).catch((error: unknown) => error);
			await Bun.sleep(0);
			expect(getDbWorkerPoolStats()).toMatchObject({
				queued: 1,
				queuedBytes: 6 * 1024 * 1024,
			});
			const error = await runReadTask(dbPath, { kind: "storageScanContext" }).catch(
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(DbReadError);
			expect(error).toMatchObject({ code: "DB_READ_OVERLOADED" });
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				reason: "normal-bytes",
				taskKind: "storageScanContext",
				queued: 1,
				queuedBytes: 6 * 1024 * 1024,
				busy: 1,
			});
			expect(JSON.stringify(records)).not.toContain("private-queue-body");
			expect(getDbWorkerPoolStats().queued).toBe(1);
		} finally {
			probeController.abort();
			queuedController.abort();
			blockerController.abort();
			await Promise.all([probe, queued, blocker]);
			warn.mockRestore();
		}
	});
});
