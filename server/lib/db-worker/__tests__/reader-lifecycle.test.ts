import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker as NodeWorker } from "node:worker_threads";
import {
	consumeReadDomainTask,
	consumeReadSqlValues,
	readNativeRows,
} from "../../../db/worker-read";
import { WorkerHandle } from "../../worker-runtime/lifecycle";
import { getReadDatabaseIdentity, resumeReadDatabase } from "../database-identity";
import {
	assertDbReadersReady,
	closeReadDatabase,
	DB_READ_QUEUE_MAX_TASKS,
	drainDbWorkerPool,
	getDbWorkerAvailability,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	resumeDbWorkerPool,
	runEphemeralReadTask,
	runReadTask,
	runTrackedEphemeralReadTask,
	setDbWorkerSpecifiersForTest,
} from "../pool";
import type { DbWorkerInbound } from "../protocol";

let home: string;
let path: string;
let db: Database;
let oldConcurrency: string | undefined;
const strict = { executionPolicy: "worker-required" as const };
const sql =
	"WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t WHERE x<600) SELECT x FROM t";
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "nf-reader-life-"));
	path = join(home, "test.db");
	db = new Database(path);
	db.run("PRAGMA journal_mode=WAL");
	db.run("CREATE TABLE marker (value TEXT)");
	db.run("INSERT INTO marker VALUES ('original')");
	oldConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	resetDbWorkerPoolForTest();
});
afterEach(async () => {
	await drainDbWorkerPool({ timeoutMs: 5000 });
	db.close();
	rmSync(home, { recursive: true, force: true });
	if (oldConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = oldConcurrency;
});

describe("owned ephemeral readers", () => {
	test("domain reads time out before a delayed worker exit without releasing its ownership", async () => {
		const stopping = Promise.withResolvers<number>();
		const exit = Promise.withResolvers<number>();
		class DelayedExitWorker extends EventEmitter {
			postMessage(message: DbWorkerInbound) {
				if (message.type === "task")
					queueMicrotask(() =>
						this.emit("message", {
							type: "result",
							requestId: message.requestId,
							result: { metadata: { kind: "missing" }, bytes: 0, chunks: 0 },
							durationMs: 0,
						}),
					);
			}
		}
		const spawn = spyOn(WorkerHandle, "thread").mockImplementation(() => {
			const worker = new DelayedExitWorker();
			queueMicrotask(() => worker.emit("message", { type: "ready" }));
			return new WorkerHandle(worker as unknown as NodeWorker, exit.promise, () => {
				stopping.resolve(Date.now());
			});
		});
		setDbWorkerSpecifiersForTest(["delayed-exit"]);
		const deadlineAt = Date.now() + 250;
		const result = consumeReadDomainTask(
			db,
			"composerDocument",
			{
				narratorId: "n1",
				messageId: "missing",
				blockReads: false,
			},
			() => {},
			{ deadlineAt },
		).catch((error: unknown) => error);
		try {
			expect(await Promise.race([stopping.promise, result])).toBeLessThan(deadlineAt);
			const beforeExit = await Promise.race([result, Bun.sleep(500).then(() => "still pending")]);
			const trackedBeforeExit = getDbWorkerPoolStats().tracked;
			exit.resolve(0);
			const afterExit = await result;
			expect(afterExit).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
			expect(beforeExit).toBe(afterExit);
			expect(trackedBeforeExit).toBe(1);
		} finally {
			exit.resolve(0);
			spawn.mockRestore();
			setDbWorkerSpecifiersForTest(null);
		}
	});

	test("startup cancellation keeps the release receipt pending until actual exit", async () => {
		const terminated = deferred();
		const workers: PendingExitWorker[] = [];
		class PendingExitWorker extends EventEmitter {
			constructor() {
				super();
				workers.push(this);
			}
			postMessage(): void {
				throw new Error("fixture startup failure");
			}
			terminate() {
				terminated.resolve();
			}
			confirmExit() {
				this.emit("exit", 0);
			}
		}
		const spawn = spyOn(WorkerHandle, "thread").mockImplementation(() => {
			const worker = new PendingExitWorker();
			const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
			return new WorkerHandle(worker as unknown as NodeWorker, exited, () => worker.terminate());
		});
		setDbWorkerSpecifiersForTest(["first-entry", "second-entry"]);
		const controller = new AbortController();
		const task = runTrackedEphemeralReadTask(
			path,
			{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
			{ signal: controller.signal, timeoutMs: 1000 },
		);
		const result = task.result.catch((error) => error);
		let released = false;
		void task.released.then(() => {
			released = true;
		});
		try {
			await terminated.promise;
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(workers).toHaveLength(1);
			expect(getDbWorkerPoolStats()).toMatchObject({
				starting: 1,
				reservation: { shared: { claimed: 1, starting: 1 } },
			});
			controller.abort();
			expect(released).toBe(false);
			workers[0].confirmExit();
			expect(await result).toMatchObject({ code: "DB_READ_ABORTED" });
			await task.released;
			expect(getDbWorkerPoolStats().tracked).toBe(0);
		} finally {
			for (const worker of workers) worker.confirmExit();
			spawn.mockRestore();
			setDbWorkerSpecifiersForTest(null);
		}
	});
	test("success and query failure release actual threads without closing shared admission", async () => {
		const success = runTrackedEphemeralReadTask(path, {
			kind: "selectRows",
			sql: "SELECT value FROM marker",
			params: [],
			maxRows: 1,
		});
		expect(await success.result).toEqual({ columns: ["value"], rows: [["original"]] });
		await success.released;
		expect(getDbWorkerPoolStats().tracked).toBe(0);
		const failure = runTrackedEphemeralReadTask(path, {
			kind: "selectRows",
			sql: "SELECT missing_column FROM marker",
			params: [],
			maxRows: 1,
		});
		await expect(failure.result).rejects.toMatchObject({
			name: "DbReadTaskExecutionError",
			code: "SQLITE_ERROR",
		});
		await failure.released;
		expect(getDbWorkerPoolStats().tracked).toBe(0);
		expect(getDbWorkerAvailability().available).toBe(true);
		expect(getReadDatabaseIdentity(path).open).toBe(true);
	});
	test("cancellation of an ACK-blocked task has an independent physical release receipt", async () => {
		const entered = deferred();
		const held = deferred();
		const controller = new AbortController();
		const task = runTrackedEphemeralReadTask(
			path,
			{ kind: "selectChunks", sql, params: [], maxRows: 1000 },
			{
				signal: controller.signal,
				onChunk: async () => {
					entered.resolve();
					await held.promise;
				},
			},
		);
		const result = task.result.catch((error) => error);
		await entered.promise;
		controller.abort();
		expect(await result).toMatchObject({ code: "DB_READ_ABORTED" });
		await task.released;
		held.resolve();
		expect(getDbWorkerPoolStats().tracked).toBe(0);
		expect(getReadDatabaseIdentity(path).open).toBe(true);
	});
	test("strict owned tasks reject disabled workers and cannot share a deduplicated execution", async () => {
		const previous = process.env.NARRAFORK_DB_WORKER;
		try {
			process.env.NARRAFORK_DB_WORKER = "off";
			const task = runTrackedEphemeralReadTask(path, {
				kind: "selectRows",
				sql: "SELECT 1",
				params: [],
				maxRows: 1,
			});
			await expect(task.result).rejects.toMatchObject({ code: "DB_READ_UNAVAILABLE" });
			await task.released;
			expect(getDbWorkerPoolStats().tracked).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
		const shared = runTrackedEphemeralReadTask(
			path,
			{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
			{ dedupeKey: "not-owned" },
		);
		await expect(shared.result).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		await shared.released;
	});
});

describe("bounded chunk reads", () => {
	test("ACK waits for consumption and each chunk is capped before insertion", async () => {
		const entered = deferred();
		const consume = deferred();
		let chunks = 0;
		let count = 0;
		let max = 0;
		const result = consumeReadSqlValues(
			db,
			sql,
			[],
			async (chunk) => {
				expect(chunk.sequence).toBe(chunks++);
				max = Math.max(max, chunk.rows.length);
				count += chunk.rows.length;
				if (chunk.sequence === 0) {
					entered.resolve();
					await consume.promise;
				}
			},
			strict,
		);
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(chunks).toBe(1);
		expect(getDbWorkerPoolStats().busy).toBe(1);
		consume.resolve();
		expect((await result).rowCount).toBe(600);
		expect(count).toBe(600);
		expect(max).toBe(128);
		expect(chunks).toBe(5);
	});
	test("oversized single row owns its ACK-blocked chunk and cumulative bytes remain complete", async () => {
		const entered = deferred();
		const held = deferred();
		const chunks: unknown[][][] = [];
		const work = consumeReadSqlValues(
			db,
			"SELECT zeroblob(262145) AS value UNION ALL SELECT zeroblob(3)",
			[],
			async (chunk) => {
				chunks.push(chunk.rows);
				if (chunk.sequence === 0) {
					entered.resolve();
					await held.promise;
				}
			},
			strict,
		);
		await entered.promise;
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(chunks).toHaveLength(1);
			expect(chunks[0]).toHaveLength(1);
			expect((chunks[0][0][0] as Uint8Array).byteLength).toBe(262145);
			expect(getDbWorkerPoolStats().busy).toBe(1);
		} finally {
			held.resolve();
		}
		const result = await work;
		expect(result.rowCount).toBe(2);
		expect(chunks).toHaveLength(2);
		let bytes = 0;
		const complete = await consumeReadSqlValues(
			db,
			sql.replace("SELECT x FROM t", "SELECT zeroblob(8000) FROM t"),
			[],
			(chunk) => {
				for (const row of chunk.rows) bytes += (row[0] as Uint8Array).byteLength;
			},
			strict,
		);
		expect(complete.rowCount).toBe(600);
		expect(bytes).toBe(600 * 8000);
		expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
	});
	test("consumer failure is sanitized and its slot is reclaimed", async () => {
		await expect(
			consumeReadSqlValues(
				db,
				sql,
				[],
				() => {
					throw new Error("private consumer data");
				},
				strict,
			),
		).rejects.toMatchObject({
			code: "DB_READ_CONSUMER_FAILED",
			message: "database read consumer failed",
		});
		expect(await readNativeRows(db, "SELECT 1 AS ok", [], strict)).toEqual([{ ok: 1 }]);
	});
	test("cancellation and absolute deadline cover a consumer awaiting ACK", async () => {
		const entered = deferred();
		const held = deferred();
		const controller = new AbortController();
		const work = consumeReadSqlValues(
			db,
			sql,
			[],
			async () => {
				entered.resolve();
				await held.promise;
			},
			{ ...strict, signal: controller.signal },
		);
		const result = work.catch((error) => error);
		await entered.promise;
		controller.abort();
		expect(await result).toMatchObject({ code: "DB_READ_ABORTED" });
		held.resolve();
		await expect(
			consumeReadSqlValues(db, sql, [], () => new Promise(() => {}), { ...strict, timeoutMs: 80 }),
		).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
	});
	test("maxRows one returns three streamed rows while explicit LIMIT one is preserved", async () => {
		const selected = "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3";
		for (const [query, expected] of [
			[selected, 3],
			[`${selected} LIMIT 1`, 1],
		] as const) {
			const values: unknown[][] = [];
			const result = await consumeReadSqlValues(
				db,
				query,
				[],
				(chunk) => {
					values.push(...chunk.rows);
				},
				{ ...strict, maxRows: 1 },
			);
			expect(result.rowCount).toBe(expected);
			expect(values).toHaveLength(expected);
		}
	});
});

describe("admission and identity", () => {
	test("bound source handles stay pinned when a symlink is retargeted", async () => {
		const alias = join(home, "moving.db");
		symlinkSync(path, alias);
		const pinned = new Database(alias);
		const otherPath = join(home, "other.db");
		const other = new Database(otherPath);
		other.run("CREATE TABLE marker(value TEXT)");
		other.run("INSERT INTO marker VALUES ('other')");
		try {
			expect(await readNativeRows(pinned, "SELECT * FROM marker", [], strict)).toEqual([
				{ value: "original" },
			]);
			unlinkSync(alias);
			symlinkSync(otherPath, alias);
			expect(await readNativeRows(pinned, "SELECT * FROM marker", [], strict)).toEqual([
				{ value: "original" },
			]);
			await assertDbReadersReady(alias);
			await closeReadDatabase(path);
			expect(getDbWorkerAvailability(alias).available).toBe(true);
			expect(getDbWorkerAvailability(path).reason).toBe("database_closing");
		} finally {
			pinned.close();
			other.close();
		}
	});
	test("availability is pure registered state and only a successful probe marks a generation ready", async () => {
		expect(getDbWorkerAvailability(path)).toEqual({
			available: false,
			reason: "database_unregistered",
		});
		getReadDatabaseIdentity(path);
		expect(getDbWorkerAvailability(path)).toEqual({
			available: false,
			reason: "database_not_ready",
		});
		await assertDbReadersReady(path);
		const alias = join(home, "readiness-alias.db");
		symlinkSync(path, alias);
		await assertDbReadersReady(alias);
		const realpath = spyOn(realpathSync, "native").mockImplementation(() => {
			throw new Error("hot path must not access files");
		});
		try {
			expect(getDbWorkerAvailability(path)).toEqual({ available: true, reason: null });
			expect(getDbWorkerAvailability(alias)).toEqual({ available: true, reason: null });
			expect(getDbWorkerAvailability(join(home, "unknown"))).toEqual({
				available: false,
				reason: "database_unregistered",
			});
		} finally {
			realpath.mockRestore();
		}
		await closeReadDatabase(alias);
		expect(getDbWorkerAvailability(path).reason).toBe("database_closing");
		expect(getDbWorkerAvailability(alias).reason).toBe("database_closing");
		resumeReadDatabase(path);
		expect(getDbWorkerAvailability(path).reason).toBe("database_not_ready");
		expect(getDbWorkerAvailability(alias).reason).toBe("database_unregistered");
		await assertDbReadersReady(alias);
		expect(getDbWorkerAvailability(path).available).toBe(true);
		expect(getDbWorkerAvailability(alias).available).toBe(true);
	});
	test("main stream queue keeps its quota while compatible ephemeral retains its separate path", async () => {
		const entered = deferred();
		const held = deferred();
		const stream = consumeReadSqlValues(
			db,
			sql,
			[],
			async () => {
				entered.resolve();
				await held.promise;
			},
			strict,
		);
		await entered.promise;
		const controller = new AbortController();
		const pending = Array.from({ length: (DB_READ_QUEUE_MAX_TASKS * 3) / 4 }, () =>
			runReadTask(
				path,
				{ kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 },
				{ signal: controller.signal },
			).catch((error) => error),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getDbWorkerPoolStats().queued).toBe((DB_READ_QUEUE_MAX_TASKS * 3) / 4);
		await expect(
			runEphemeralReadTask(path, { kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 }),
		).resolves.toEqual({ columns: ["1"], rows: [[1]] });
		expect(getDbWorkerPoolStats().main?.queued).toBe((DB_READ_QUEUE_MAX_TASKS * 3) / 4);
		controller.abort();
		await Promise.all(pending);
		expect(getDbWorkerPoolStats().queued).toBe(0);
		held.resolve();
		await stream;
	});
	test("ordinary queue enforces its cumulative 6 MiB parameter budget", async () => {
		const entered = deferred();
		const held = deferred();
		const stream = consumeReadSqlValues(
			db,
			sql,
			[],
			async () => {
				entered.resolve();
				await held.promise;
			},
			strict,
		);
		await entered.promise;
		const controller = new AbortController();
		const pending = Array.from({ length: (DB_READ_QUEUE_MAX_TASKS * 3) / 4 }, () =>
			runReadTask(
				path,
				{ kind: "selectRows", sql: "SELECT ?", params: ["x".repeat(300000)], maxRows: 1 },
				{ signal: controller.signal },
			).catch((error) => error),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getDbWorkerPoolStats().queued).toBeLessThan(DB_READ_QUEUE_MAX_TASKS);
		controller.abort();
		const results = await Promise.all(pending);
		expect(
			results.some(
				(error) =>
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "DB_READ_OVERLOADED",
			),
		).toBe(true);
		held.resolve();
		await stream;
	});
	test("canonical aliases share identity, close blocks readers, replacement gets a new generation", async () => {
		expect(await readNativeRows(db, "SELECT * FROM marker", [], strict)).toEqual([
			{ value: "original" },
		]);
		const alias = join(home, "alias.db");
		symlinkSync(path, alias);
		expect(getReadDatabaseIdentity(alias)).toBe(getReadDatabaseIdentity(path));
		const before = getReadDatabaseIdentity(path);
		await closeReadDatabase(alias);
		await expect(readNativeRows(db, "SELECT * FROM marker", [], strict)).rejects.toMatchObject({
			code: "DB_READ_DATABASE_CLOSED",
		});
		db.close();
		renameSync(path, join(home, "old.db"));
		db = new Database(path);
		db.run("CREATE TABLE marker(value TEXT)");
		db.run("INSERT INTO marker VALUES ('replacement')");
		const after = resumeReadDatabase(path);
		expect(after.generation).toBe(before.generation + 1);
		expect(await readNativeRows(db, "SELECT * FROM marker", [], strict)).toEqual([
			{ value: "replacement" },
		]);
	});
	test("close retires an ACK-blocked worker and drain/resume are readiness barriers", async () => {
		const entered = deferred();
		const held = deferred();
		const work = consumeReadSqlValues(
			db,
			sql,
			[],
			async () => {
				entered.resolve();
				await held.promise;
			},
			strict,
		).catch((error) => error);
		await entered.promise;
		await closeReadDatabase(path, { timeoutMs: 1000 });
		expect(await work).toMatchObject({ code: "DB_READ_DATABASE_CLOSED" });
		held.resolve();
		resumeReadDatabase(path);
		await assertDbReadersReady(path);
		await drainDbWorkerPool({ timeoutMs: 1000 });
		await expect(
			runEphemeralReadTask(path, { kind: "selectRows", sql: "SELECT 1", params: [], maxRows: 1 }),
		).rejects.toMatchObject({ code: "DB_READ_UNAVAILABLE" });
		resumeDbWorkerPool();
		await assertDbReadersReady(path);
	});
});
