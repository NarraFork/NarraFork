import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { readNativeRows, readQuery } from "../../../db/worker-read";
import { logger } from "../../logger";
import {
	closeReadDatabase,
	drainDbWorkerPool,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	runShortReadTask,
} from "../pool";
import {
	SELECT_ROWS_MAX_BYTES,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	type SelectRowsParams,
	type SelectRowsResult,
} from "../protocol";
import { ReadBudgetMeter } from "../read-budget";
import { type ReadTaskDiagnostics, warnReadBudgetExceeded } from "../read-diagnostics";

const SLOW_SQL =
	"WITH RECURSIVE scan(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM scan WHERE n < ?) SELECT sum(n) AS total FROM scan";
let home: string;
let dbPath: string;
let writer: Database;
let previousConcurrency: string | undefined;
let previousSqlDiagnostics: string | undefined;
let diagnosticClockOffset = 0;

async function query(sql: string, params: SelectRowsParams["params"] = [], maxRows = 10_000) {
	const { columns, rows } = await runReadTask<SelectRowsResult>(dbPath, {
		kind: "selectRows",
		sql,
		params,
		maxRows,
	});
	return rows.map((row) =>
		Object.fromEntries(columns.map((column, index) => [column, row[index]])),
	);
}

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "narrafork-search-worker-"));
	dbPath = join(home, "fixture.db");
	writer = new Database(dbPath);
	writer.run("PRAGMA journal_mode = WAL");
	writer.run("CREATE TABLE messages(id INTEGER PRIMARY KEY, content TEXT)");
	writer.run("INSERT INTO messages(content) VALUES ('first searchable message')");
	writer.run("CREATE VIRTUAL TABLE messages_fts USING fts5(content, tokenize='trigram')");
	writer.run("INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages");
	previousSqlDiagnostics = process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
	delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	await resetDbWorkerPoolForTest();
});

afterEach(async () => {
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	if (previousSqlDiagnostics === undefined) delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
	else process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = previousSqlDiagnostics;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	writer.close();
	rmSync(home, { recursive: true, force: true });
});

describe("real selectRows read-worker pool", () => {
	test("short reads see new committed WAL data without starting the ordinary pool", async () => {
		const select = (id: number) =>
			runShortReadTask(dbPath, {
				kind: "selectRows",
				sql: "SELECT id, content FROM messages WHERE id = ?",
				params: [id],
				maxRows: 1,
			});
		expect(await select(2)).toEqual({ columns: ["id", "content"], rows: [] });
		writer.run("INSERT INTO messages(id, content) VALUES (2, 'committed')");
		expect(await select(2)).toEqual({ columns: ["id", "content"], rows: [[2, "committed"]] });
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("short-read database closure drains a reader reused across sources", async () => {
		const params: SelectRowsParams = {
			kind: "selectRows",
			sql: "SELECT 42 AS value",
			params: [],
			maxRows: 1,
		};
		const otherPath = join(home, "second.db");
		new Database(otherPath).close();
		expect(await runShortReadTask(dbPath, params)).toEqual({ columns: ["value"], rows: [[42]] });
		expect(await runShortReadTask(otherPath, params)).toEqual({ columns: ["value"], rows: [[42]] });
		expect(getDbWorkerPoolStats()).toMatchObject({
			workers: 0,
			tracked: 1,
			shortReads: { workers: 1, concurrency: 1 },
		});
		await closeReadDatabase(otherPath, { timeoutMs: 5000 });
		expect(getDbWorkerPoolStats().tracked).toBe(0);
		const error = await runShortReadTask(otherPath, params).catch((failure) => failure);
		expect(error).toMatchObject({ code: "DB_READ_DATABASE_CLOSED" });
		expect(await runShortReadTask(dbPath, params)).toEqual({ columns: ["value"], rows: [[42]] });
	}, 30_000);

	test("cached readonly worker sees new committed WAL data and preserves FTS snippet", async () => {
		expect(await query("SELECT id, content FROM messages ORDER BY id")).toHaveLength(1);
		writer.transaction(() => {
			writer.run("INSERT INTO messages(content) VALUES ('second searchable message')");
			writer.run(
				"INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages WHERE id = 2",
			);
		})();
		const sql =
			"WITH matched AS MATERIALIZED (SELECT rowid AS id, snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet, rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank, rowid DESC LIMIT 10) SELECT id, snippet FROM matched ORDER BY rank, id DESC";
		expect(await query(sql, ["searchable"])).toEqual(
			writer.query<Record<string, unknown>, [string]>(sql).all("searchable"),
		);
		expect(await query("SELECT id, content FROM messages ORDER BY id")).toHaveLength(2);
		expect(getDbWorkerPoolStats().workers).toBe(1);
	}, 30_000);

	test("worker refuses writes and opens its connection readonly", async () => {
		await expect(query("DELETE FROM messages")).rejects.toThrow();
		await expect(query("WITH ignored AS (SELECT 1) DELETE FROM messages")).rejects.toThrow();
		// SQL validation and the driver's readonly open are independent lines of defense.
		// A source guard pins the actual entry's flag: no SELECT can introspect sqlite3_db_readonly.
		const entry = await Bun.file(new URL("../worker-entry.ts", import.meta.url)).text();
		expect(entry).toContain("new Database(dbPath, { readonly: true })");
		expect(await query("SELECT count(*) AS total FROM messages")).toEqual([{ total: 1 }]);
	}, 30_000);

	test("large valid reads are complete and malformed inputs do not poison the cached worker", async () => {
		const text = "a".repeat(SELECT_ROWS_MAX_PARAMS_BYTES + 1);
		const bound = await query("SELECT ? AS value", [text]);
		expect(bound).toEqual([{ value: text }]);
		for (const [sql, params] of [
			["SELECT ? AS value", [Infinity]],
			["SELECT 1; SELECT 2", []],
		] as const) {
			const failure = await query(sql, [...params]).catch((error) => error);
			expect(failure).toMatchObject({ code: "DB_READ_INVALID" });
		}
		const rows = await query("SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3", [], 1);
		expect(rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
		const big = await query("SELECT printf('%.*c', ?, 'x') AS value", [SELECT_ROWS_MAX_BYTES + 1]);
		expect((big[0].value as string).length).toBe(SELECT_ROWS_MAX_BYTES + 1);
		const ok = await query("SELECT 42 AS value");
		expect(ok).toEqual([{ value: 42 }]);
		expect(getDbWorkerPoolStats().busy).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
	}, 30_000);

	test("main-thread heartbeat advances during a real SQLite recursive scan", async () => {
		await query("SELECT 1 AS ready"); // Do not count startup as evidence of scan isolation.
		let beats = 0;
		const timer = setInterval(() => beats++, 5);
		try {
			expect(await query(SLOW_SQL, [3_000_000])).toEqual([{ total: 4_500_001_500_000 }]);
			expect(beats).toBeGreaterThan(5);
		} finally {
			clearInterval(timer);
		}
	}, 30_000);

	test("deadline retires a scanning worker and subsequent work gets a fresh worker", async () => {
		await query("SELECT 1 AS ready");
		await expect(
			runReadTask(
				dbPath,
				{
					kind: "selectRows",
					sql: SLOW_SQL,
					params: [10_000_000],
					maxRows: 1,
				},
				{ timeoutMs: 100 },
			),
		).rejects.toThrow(/timed out|timeout/);
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(getDbWorkerPoolStats().busy).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
		expect(await query("SELECT 42 AS recovered")).toEqual([{ recovered: 42 }]);
	}, 30_000);

	test("cancellation retires a scanning worker and frees its pool slot", async () => {
		await query("SELECT 1 AS ready");
		const controller = new AbortController();
		const task = runReadTask(
			dbPath,
			{
				kind: "selectRows",
				sql: SLOW_SQL,
				params: [10_000_000],
				maxRows: 1,
			},
			{ timeoutMs: 10_000, signal: controller.signal },
		);
		const rejection = task.then(
			() => null,
			(error: unknown) => error,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(getDbWorkerPoolStats().busy).toBe(1);
		controller.abort();
		const error = await rejection;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/aborted/);
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(getDbWorkerPoolStats().busy).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
		// Shared cancellation settles only after native exit, so replacement needs no reset.
		expect(getDbWorkerPoolStats()).toMatchObject({ retiring: 0, tracked: 0 });
		expect(await query("SELECT 42 AS recovered")).toEqual([{ recovered: 42 }]);
		expect(getDbWorkerPoolStats().retiring).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
	}, 30_000);
	test.each([
		"native",
		"query",
	] as const)("host callsite skips the read bridge after async boundaries (%s)", async (mode) => {
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		const nativeNow = Date.now.bind(Date);
		diagnosticClockOffset += 20_000;
		const clock = spyOn(Date, "now").mockImplementation(() => nativeNow() + diagnosticClockOffset);
		const records: Record<string, unknown>[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, fields) => {
			if (message === "Database read worker SQL diagnostic") records.push(fields ?? {});
		});
		async function businessRead() {
			await Promise.resolve();
			await Promise.resolve();
			if (mode === "native")
				return readNativeRows(writer, "SELECT 42 AS value", [], {
					executionPolicy: "worker-required",
				});
			const messages = sqliteTable("messages", { id: integer("id") });
			return readQuery(drizzle(writer).select({ value: messages.id }).from(messages), {
				executionPolicy: "worker-required",
			});
		}
		try {
			expect(await businessRead()).toEqual([{ value: mode === "native" ? 42 : 1 }]);
			const dispatch = records.find((record) => record.phase === "dispatch");
			expect(dispatch).toMatchObject({
				sql: {
					hostSiteStatus: "available",
					hostSite: {
						file: "server/lib/db-worker/__tests__/select-rows-pool.test.ts",
						fn: "businessRead",
					},
				},
			});
		} finally {
			clock.mockRestore();
			warn.mockRestore();
		}
	}, 10_000);

	test("opt-in SQL start reaches the host while a real worker SELECT is still pending", async () => {
		const previous = process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
		await query("SELECT 1 AS ready");
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		let settled = false;
		let seen = false;
		let receive!: () => void;
		const started = new Promise<void>((resolve) => {
			receive = resolve;
		});
		const diagnosticRecords: Record<string, unknown>[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message, fields) => {
			if (message !== "Database read worker SQL diagnostic") return;
			diagnosticRecords.push(fields ?? {});
			const sql = fields?.sql as { current?: { stage?: string } } | undefined;
			if (fields?.phase === "sql-start" && sql?.current?.stage === "iterate") {
				seen = true;
				expect(settled).toBe(false);
				receive();
			}
		});
		const pending = query(SLOW_SQL, [1_000_000]).finally(() => {
			settled = true;
		});
		try {
			await Promise.race([started, pending]);
			expect(seen).toBe(true);
			expect(settled).toBe(false);
			expect(getDbWorkerPoolStats().busy).toBe(1);
			expect(await pending).toEqual([{ total: 500_000_500_000 }]);
			const current = diagnosticRecords.find(
				(record) =>
					record.phase === "sql-start" &&
					(record.sql as { current?: { stage: string } })?.current?.stage === "iterate",
			);
			expect(current).toMatchObject({
				kind: "selectRows",
				sql: {
					state: "running",
					worker: expect.stringMatching(/^dbw-\d+$/),
					hostSite: { file: "server/lib/db-worker/__tests__/select-rows-pool.test.ts" },
					current: {
						hashStatus: "collected",
						sqlHash: expect.stringMatching(/^[a-f0-9]{64}$/),
						workerSite: { file: "server/lib/db-worker/select-rows.ts" },
					},
				},
			});
			const text = JSON.stringify(diagnosticRecords);
			for (const value of [SLOW_SQL, dbPath, home, "1_000_000"]) expect(text).not.toContain(value);
		} finally {
			await pending.catch(() => {});
			if (previous === undefined) delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
			else process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = previous;
			warn.mockRestore();
		}
	}, 10_000);
});

describe("direct pool observation diagnostics", () => {
	let offset = 0;
	let now: ReturnType<typeof spyOn<typeof Date, "now">>;
	let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
	beforeEach(() => {
		const nativeNow = Date.now.bind(Date);
		offset += 20_000;
		now = spyOn(Date, "now").mockImplementation(() => nativeNow() + offset);
		warn = spyOn(logger, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		now.mockRestore();
		warn.mockRestore();
	});
	function log(companionMessage?: string) {
		expect(warn).toHaveBeenCalledTimes(companionMessage ? 2 : 1);
		const observations = warn.mock.calls.filter(
			([message]) => message === "Database read observation threshold exceeded",
		);
		expect(observations).toHaveLength(1);
		if (companionMessage)
			expect(warn.mock.calls.filter(([message]) => message === companionMessage)).toHaveLength(1);
		return observations[0][1] as Record<string, unknown>;
	}
	test("oversized single request executes when idle and logs once without bind or result content", async () => {
		const secret = "private-payload-";
		const value = secret + "x".repeat(8 * 1024 * 1024);
		const sql = `SELECT ? AS value ${" ".repeat(64 * 1024)}`;
		const result = await runReadTask<SelectRowsResult>(
			dbPath,
			{ kind: "selectRows", sql, params: [value], maxRows: 1 },
			{ diagnosticSource: "来".repeat(256) },
		);
		expect(result.rows[0][0]).toBe(value);
		const diagnostic = log();
		expect(diagnostic).toMatchObject({
			status: "completed",
			partial: false,
			task: "selectRows",
			sourceTruncated: true,
			sqlTruncated: true,
		});
		const exceeded = diagnostic.exceeded as Array<{
			kind: string;
			actual: number;
			threshold: number;
		}>;
		expect(exceeded.map((item) => item.kind).sort()).toEqual([
			"parameterBytes",
			"resultBytes",
			"sqlBytes",
			"taskBytes",
		]);
		expect(new Set(exceeded.map((item) => item.kind)).size).toBe(exceeded.length);
		expect(diagnostic.metrics).toMatchObject({
			sqlBytes: Buffer.byteLength(sql),
			parameterCount: 1,
			rows: 1,
		});
		expect(Buffer.byteLength(diagnostic.sql as string)).toBeLessThanOrEqual(64 * 1024);
		expect(Buffer.byteLength(diagnostic.source as string)).toBeLessThanOrEqual(256);
		expect(JSON.stringify(diagnostic)).not.toContain(secret);
		expect(diagnostic).not.toHaveProperty("stack");
	}, 30_000);
	test("logger failure never changes successful reads and default source identifies the task", async () => {
		warn.mockImplementation(() => {
			throw new Error("sink unavailable");
		});
		const result = await runReadTask<SelectRowsResult>(dbPath, {
			kind: "selectValues",
			sql: "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3",
			params: [],
			maxRows: 1,
		});
		expect(result.rows).toEqual([[1], [2], [3]]);
		expect(log()).toMatchObject({ source: "selectValues", status: "completed", partial: false });
	});
	test("logical owners retain paired single-query excess independently of cumulative rows", async () => {
		const owner: ReadTaskDiagnostics = { meter: new ReadBudgetMeter(), partial: false };
		const first = await runReadTask<SelectRowsResult>(
			dbPath,
			{
				kind: "selectRows",
				sql: "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3",
				params: [],
				maxRows: 1,
			},
			{ diagnosticContext: owner },
		);
		expect(first.rows).toEqual([[1], [2], [3]]);
		owner.observedRows = first.rows.length;
		owner.observedBytes = owner.meter
			.snapshot()
			.find((item) => item.kind === "resultBytes")?.actual;
		const second = await runReadTask<SelectRowsResult>(
			dbPath,
			{
				kind: "selectRows",
				sql: "WITH RECURSIVE page(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM page WHERE n < ?) SELECT n FROM page",
				params: [11],
				maxRows: 10,
			},
			{ diagnosticContext: owner },
		);
		expect(second.rows).toHaveLength(11);
		expect(warn).not.toHaveBeenCalled();
		warnReadBudgetExceeded({
			snapshot: owner.meter.snapshot(),
			task: "logicalRows",
			elapsedMs: 0,
			partial: false,
			status: "completed",
		});
		expect(log()).toMatchObject({
			metrics: { rows: 14, queryRows: 3 },
			exceeded: [{ kind: "queryRows", actual: 3, threshold: 1, phase: "result" }],
		});
	}, 30_000);
	for (const counts of [
		[3, 2],
		[6000, 6000],
	] as const) {
		test(`logical owner keeps per-page thresholds separate from ${counts[0] + counts[1]} cumulative rows`, async () => {
			const owner: ReadTaskDiagnostics = { meter: new ReadBudgetMeter(), partial: false };
			for (const count of counts) {
				const result = await runReadTask<SelectRowsResult>(
					dbPath,
					{
						kind: "selectRows",
						sql: "WITH RECURSIVE page(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM page WHERE n < ?) SELECT n FROM page",
						params: [count],
						maxRows: count,
					},
					{ diagnosticContext: owner },
				);
				expect(result.rows).toHaveLength(count);
				owner.observedRows = (owner.observedRows ?? 0) + result.rows.length;
				owner.observedBytes = owner.meter
					.snapshot()
					.find((item) => item.kind === "resultBytes")?.actual;
			}
			expect(owner.meter.snapshot().find((item) => item.kind === "queryRows")).toBeUndefined();
			warnReadBudgetExceeded({
				snapshot: owner.meter.snapshot(),
				task: "logicalRows",
				elapsedMs: 0,
				partial: false,
				status: "completed",
			});
			if (counts[0] + counts[1] > 10_000)
				expect(log()).toMatchObject({
					exceeded: [{ kind: "rows", actual: 12_000, threshold: 10_000, phase: "result" }],
				});
			else expect(warn).not.toHaveBeenCalled();
		}, 30_000);
	}

	test("native execution failure records known input observations as partial", async () => {
		const failure = await runReadTask(dbPath, {
			kind: "selectRows",
			sql: `SELECT missing_column FROM messages ${" ".repeat(65536)}`,
			params: [],
			maxRows: 1,
		}).catch((error) => error);
		expect(failure).toMatchObject({ name: "DbReadTaskExecutionError", code: "SQLITE_ERROR" });
		expect(log("Database read worker query failed")).toMatchObject({
			status: "failed",
			partial: true,
			code: "SQLITE_ERROR",
		});
	});
	for (const mode of ["cancel", "timeout", "consumer"] as const) {
		test(`${mode} preserves the last streamed numeric snapshot and frees the slot`, async () => {
			await query("SELECT 1 AS warm");
			const controller = new AbortController();
			const entered = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			const task = runReadTask(
				dbPath,
				{ kind: "selectChunks", sql: "SELECT zeroblob(4194305)", params: [], maxRows: 1 },
				{
					signal: controller.signal,
					timeoutMs: mode === "timeout" ? 200 : 5000,
					onChunk: async () => {
						entered.resolve();
						if (mode === "consumer") throw new Error("private consumer");
						await held.promise;
					},
				},
			).catch((error) => error);
			await entered.promise;
			if (mode === "cancel") controller.abort();
			const failure = await task;
			held.resolve();
			const code =
				mode === "cancel"
					? "DB_READ_ABORTED"
					: mode === "timeout"
						? "DB_READ_TASK_TIMEOUT"
						: "DB_READ_CONSUMER_FAILED";
			expect(failure).toMatchObject({ code });
			const diagnostic = log(mode === "timeout" ? "Database read task timed out" : undefined);
			if (mode === "timeout") {
				const timeout = warn.mock.calls.find(
					([message]) => message === "Database read task timed out",
				)?.[1];
				expect(timeout).toMatchObject({
					requestId: diagnostic.requestId,
					kind: "selectChunks",
					source: "unattributed",
					phase: "running",
				});
			}
			expect(diagnostic).toMatchObject({ status: "failed", partial: true, code });
			expect(diagnostic.metrics).toMatchObject({ rows: 1 });
			expect((diagnostic.metrics as { resultBytes: number }).resultBytes).toBeGreaterThan(
				4 * 1024 * 1024,
			);
			expect(getDbWorkerPoolStats().busy).toBe(0);
		}, 30_000);
	}
});
