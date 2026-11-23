import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { PgDialect } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { readDbAll, readNativeRows, readSqlRows } from "../../../db/worker-read";
import {
	readFanoutHttpMiddleware,
	resetReadFanoutDiagnosticsForTest,
	runReadFanoutWebSocketScope,
	startReadFanoutCapture,
	stopReadFanoutCapture,
} from "../../read-fanout-diagnostics";
import {
	drainDbWorkerPool,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	setDbWorkerSpecifiersForTest,
} from "../pool";
import type { SelectRowsParams } from "../protocol";

let directory: string;
let databasePath: string;
let previousConcurrency: string | undefined;
let previousWorkers: string | undefined;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function params(value: string): SelectRowsParams {
	return { kind: "selectRows", sql: "SELECT ? AS value", params: [value], maxRows: 10 };
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "narrafork-read-fanout-pool-"));
	databasePath = join(directory, "private-database.db");
	const db = new Database(databasePath);
	db.run("CREATE TABLE fixture(value TEXT)");
	db.close();
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	previousWorkers = process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	delete process.env.NARRAFORK_DB_WORKER;
	resetDbWorkerPoolForTest();
	resetReadFanoutDiagnosticsForTest();
});
afterEach(async () => {
	resetReadFanoutDiagnosticsForTest();
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	if (previousWorkers === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorkers;
	rmSync(directory, { recursive: true, force: true });
});
function fixture() {
	const path = join(directory, "worker.ts");
	writeFileSync(
		path,
		`
import { parentPort } from "node:worker_threads";
const self = { onmessage: undefined };
const postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", data => self.onmessage?.({data}));
self.onmessage = ({data}) => {
  if(data.type !== "task") return;
  const {requestId,params} = data;
  postMessage({type:"progress",requestId,tableName:"fixture",done:0,total:1});
  const mode=params.params?.[0];
  setTimeout(() => {
    if(mode === "error" || mode === "shared-error") postMessage({type:"error",requestId,code:"DB_READ_FAILED",message:"private-error-text"});
    else postMessage({type:"result",requestId,result:{columns:["value"],rows:[[42]]},durationMs:7});
  }, mode === "slow" || mode === "shared-error" ? 80 : mode === "hang" ? 5000 : 2);
};
postMessage({type:"ready"});
`,
	);
	setDbWorkerSpecifiersForTest([pathToFileURL(path).href]);
}

describe("read fanout pool observations", () => {
	test("pool entries, dedupe subscriptions and actual posts stay distinct; queue/acquire/cold timing", async () => {
		fixture();
		const capture = startReadFanoutCapture();
		const started = deferred();
		const owner = runReadFanoutWebSocketScope("narrator", "subscribe", () =>
			runReadTask(databasePath, params("slow"), {
				dedupeKey: "private-key",
				onProgress: started.resolve,
			}),
		);
		await started.promise;
		const shared = runReadFanoutWebSocketScope("narrator", "unsubscribe", () =>
			runReadTask(databasePath, params("slow"), { dedupeKey: "private-key" }),
		);
		const queued = runReadTask(databasePath, params("other"));
		expect(getDbWorkerPoolStats().inFlight).toBe(1);
		await Promise.all([owner, shared, queued]);
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			poolEntries: 3,
			poolCompleted: 3,
			poolFailed: 0,
			dedupeHits: 1,
			dispatched: 2,
			workerResults: 2,
			poolUnfinished: 0,
			dispatchedUnfinished: 0,
		});
		expect(report.timings.coldStart.count).toBe(1);
		expect(report.timings.workerAcquire.count).toBe(2);
		expect(report.timings.queueWait.count).toBeGreaterThanOrEqual(1);
		expect(report.timings.workerWall).toMatchObject({ count: 2, sumMs: 14 });
		expect(report.timings.dispatchToResponse.count).toBe(2);
		const template = report.templates.find((row) => row.counts.poolEntries === 3);
		expect(template?.counts).toMatchObject({ dispatched: 2, dedupeHits: 1 });
		expect(
			report.sources.find((row) => row.source === "WS narrator unsubscribe")?.counts,
		).toMatchObject({ poolEntries: 1, dedupeHits: 1, dispatched: 0 });
		for (const secret of [databasePath, "private-key", "slow", "SELECT ? AS value"])
			expect(JSON.stringify(report)).not.toContain(secret);
	});

	test("shared execution failure fails both callers without rejecting subscriber admission", async () => {
		fixture();
		const capture = startReadFanoutCapture();
		const started = deferred();
		const owner = runReadTask(databasePath, params("shared-error"), {
			dedupeKey: "shared-error-key",
			onProgress: started.resolve,
		}).catch((error) => error);
		await started.promise;
		const shared = runReadTask(databasePath, params("shared-error"), {
			dedupeKey: "shared-error-key",
		}).catch((error) => error);
		for (const failure of await Promise.all([owner, shared]))
			expect(failure).toMatchObject({ code: "DB_READ_FAILED" });
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			poolEntries: 2,
			poolFailed: 2,
			dedupeHits: 1,
			dispatched: 1,
			workerErrors: 1,
			admissionRejected: 0,
			dispatchFailed: 0,
			poolUnfinished: 0,
		});
	});

	test("queued cancellation and timeout are terminal caller outcomes, not physical dispatches", async () => {
		fixture();
		const started = deferred();
		const ownerAbort = new AbortController();
		const owner = runReadTask(databasePath, params("hang"), {
			signal: ownerAbort.signal,
			onProgress: started.resolve,
		}).catch((error) => error);
		await started.promise;
		const capture = startReadFanoutCapture();
		const queuedAbort = new AbortController();
		const cancelled = runReadTask(databasePath, params("abort-queued"), {
			signal: queuedAbort.signal,
		}).catch((error) => error);
		queuedAbort.abort();
		const timedOut = runReadTask(databasePath, params("timeout-queued"), { timeoutMs: 15 }).catch(
			(error) => error,
		);
		expect(await cancelled).toMatchObject({ code: "DB_READ_ABORTED" });
		expect(await timedOut).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			poolEntries: 2,
			poolFailed: 2,
			cancelled: 1,
			timedOut: 1,
			dispatched: 0,
			poolUnfinished: 0,
		});
		expect(report.timings.queueWait.count).toBeGreaterThanOrEqual(1);
		ownerAbort.abort();
		await owner;
	});

	test("running abort, execution timeout, missing error duration and admission rejection are explicit", async () => {
		fixture();
		await runReadTask(databasePath, params("ready"));
		const capture = startReadFanoutCapture();
		const started = deferred();
		const abort = new AbortController();
		const pending = runReadTask(databasePath, params("hang"), {
			signal: abort.signal,
			onProgress: started.resolve,
		}).catch((error) => error);
		await started.promise;
		abort.abort();
		expect(await pending).toMatchObject({ code: "DB_READ_ABORTED" });
		await expect(
			runReadTask(databasePath, params("hang"), { timeoutMs: 500 }),
		).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		await expect(runReadTask(databasePath, params("error"))).rejects.toMatchObject({
			code: "DB_READ_FAILED",
		});
		await expect(
			runReadTask(databasePath, { ...params("invalid"), sql: "DELETE FROM private_table" }),
		).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			poolEntries: 4,
			poolFailed: 4,
			dispatched: 3,
			cancelled: 1,
			timedOut: 1,
			workerErrors: 1,
			workerDurationMissing: 1,
			admissionRejected: 1,
			dispatchFailed: 2,
			dispatchedUnfinished: 2,
		});
		expect(report.timings.workerWall.count).toBe(0);
		expect(report.timings.dispatchToResponse.count).toBe(1);
		expect(report.timings.dispatchToAbandon.count).toBe(2);
		expect(JSON.stringify(report)).not.toContain("private-error-text");
	});

	test("failed postMessage is distinct from admission rejection and a delivered task", async () => {
		fixture();
		const capture = startReadFanoutCapture();
		const uncloneable = { ...params("clone"), cloneFailure: () => {} };
		await expect(runReadTask(databasePath, uncloneable)).rejects.toMatchObject({
			code: "DB_READ_FAILED",
		});
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			poolEntries: 1,
			poolFailed: 1,
			dispatched: 0,
			admissionRejected: 0,
			postMessageFailed: 1,
			dispatchFailed: 0,
		});
	});

	test("a task admitted before the window contributes only an unattributed pre-window reply", async () => {
		fixture();
		const started = deferred();
		const pending = runReadTask(databasePath, params("slow"), { onProgress: started.resolve });
		await started.promise;
		const app = new Hono();
		app.use("/api/*", readFanoutHttpMiddleware);
		app.post("/api/admin/diagnostics/read-fanout/start", async (c) => {
			await runReadTask(databasePath, params("excluded-control"));
			return c.json({ ok: true });
		});
		const capture = startReadFanoutCapture();
		const control = app.request("http://local/api/admin/diagnostics/read-fanout/start", {
			method: "POST",
		});
		await pending;
		expect((await control).status).toBe(200);
		const report = stopReadFanoutCapture(capture.captureId);
		expect(report.totals).toMatchObject({
			poolEntries: 0,
			dispatched: 0,
			workerResults: 0,
			preWindowResponses: 1,
		});
	});

	test("worker creation inside an excluded scope does not hide a later pre-window reply", async () => {
		fixture();
		const app = new Hono();
		app.use("/api/*", readFanoutHttpMiddleware);
		app.post("/api/admin/diagnostics/read-fanout/start", async (c) => {
			await runReadTask(databasePath, params("excluded-cold-worker"));
			return c.json({ ok: true });
		});
		const first = startReadFanoutCapture();
		expect(
			(
				await app.request("http://local/api/admin/diagnostics/read-fanout/start", {
					method: "POST",
				})
			).status,
		).toBe(200);
		expect(stopReadFanoutCapture(first.captureId).totals.preWindowResponses).toBe(0);
		const started = deferred();
		const pending = runReadTask(databasePath, params("slow"), { onProgress: started.resolve });
		await started.promise;
		const second = startReadFanoutCapture();
		await pending;
		expect(stopReadFanoutCapture(second.captureId).totals).toMatchObject({
			poolEntries: 0,
			dispatched: 0,
			preWindowResponses: 1,
		});
	});

	test("compatible inline, worker-required refusal and PostgreSQL driver semantics are preserved", async () => {
		const memory = new Database(":memory:");
		const capture = startReadFanoutCapture();
		try {
			expect(await readSqlRows(memory, "SELECT 6 AS value")).toEqual([{ value: 6 }]);
			await expect(
				readNativeRows(memory, "SELECT 6 AS value", [], { executionPolicy: "worker-required" }),
			).rejects.toMatchObject({ code: "DB_READ_UNSUPPORTED" });
			const abort = new AbortController();
			abort.abort();
			const pg = { dialect: new PgDialect(), all: () => [{ value: 7 }] };
			expect(
				await readDbAll(pg, sql`SELECT 7 AS value`, {
					signal: abort.signal,
					executionPolicy: "worker-required",
				}),
			).toEqual([{ value: 7 }]);
			const report = stopReadFanoutCapture(capture.captureId);
			expect(report.totals).toMatchObject({
				logicalReads: 3,
				logicalCompleted: 2,
				logicalFailed: 1,
				poolEntries: 0,
				inlineReads: 1,
				postgresReads: 1,
			});
		} finally {
			memory.close();
		}
	});

	test("public nested bridges count one logical read, preserve 128-row mapping and isolate observer failures", async () => {
		const database = new Database(databasePath);
		database.run("INSERT INTO fixture VALUES ('private-bound-value')");
		const capture = startReadFanoutCapture();
		try {
			expect(
				await readSqlRows(
					database,
					"SELECT value FROM fixture WHERE value = ?",
					["private-bound-value"],
					{ diagnosticSource: "private-caller-label" },
				),
			).toEqual([{ value: "private-bound-value" }]);
			expect(await readDbAll(drizzle(database), sql`SELECT 2 AS value`)).toEqual([{ value: 2 }]);
			const clock = spyOn(performance, "now").mockImplementation(() => {
				throw new Error("observer clock failed");
			});
			try {
				expect(await readNativeRows(database, "SELECT 3 AS value")).toEqual([{ value: 3 }]);
			} finally {
				clock.mockRestore();
			}
			expect(
				(
					await readNativeRows(
						database,
						"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<129) SELECT x FROM n",
					)
				).length,
			).toBe(129);
			const report = stopReadFanoutCapture(capture.captureId);
			expect(report.totals).toMatchObject({
				logicalReads: 4,
				logicalCompleted: 4,
				poolEntries: 4,
				dispatched: 4,
				workerResults: 4,
			});
			expect(report.timings.compileSync.count).toBe(1);
			expect(report.timings.mapSync.count).toBe(4); // 1 + 1 + no clock sample + 2 batches
			for (const secret of ["private-bound-value", "private-caller-label", databasePath])
				expect(JSON.stringify(report)).not.toContain(secret);
		} finally {
			database.close();
		}
	});
});
