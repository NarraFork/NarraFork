import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runReadTask,
	shutdownDbWorkerPool,
} from "../pool";
import {
	SEARCH_QUERY_MAX_BYTES,
	SEARCH_QUERY_MAX_PARAMS_BYTES,
	type SearchQueryParams,
} from "../protocol";

const SLOW_SQL =
	"WITH RECURSIVE scan(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM scan WHERE n < ?) SELECT sum(n) AS total FROM scan";
let home: string;
let dbPath: string;
let writer: Database;
let previousConcurrency: string | undefined;

function query(sql: string, params: SearchQueryParams["params"] = [], maxRows = 10_000) {
	return runReadTask<Record<string, unknown>[]>(dbPath, {
		kind: "searchQuery",
		sql,
		params,
		maxRows,
	});
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "narrafork-search-worker-"));
	dbPath = join(home, "fixture.db");
	writer = new Database(dbPath);
	writer.run("PRAGMA journal_mode = WAL");
	writer.run("CREATE TABLE messages(id INTEGER PRIMARY KEY, content TEXT)");
	writer.run("INSERT INTO messages(content) VALUES ('first searchable message')");
	writer.run("CREATE VIRTUAL TABLE messages_fts USING fts5(content, tokenize='trigram')");
	writer.run("INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages");
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	resetDbWorkerPoolForTest();
});

afterEach(() => {
	shutdownDbWorkerPool();
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	writer.close();
	rmSync(home, { recursive: true, force: true });
});

describe("real search read-worker pool", () => {
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

	test("input/output rejection does not poison the cached worker", async () => {
		await expect(
			query("SELECT ? AS value", ["a".repeat(SEARCH_QUERY_MAX_PARAMS_BYTES)]),
		).rejects.toThrow("oversized");
		await expect(query("SELECT ? AS value", [Infinity])).rejects.toThrow("oversized");
		await expect(query("SELECT 1; SELECT 2")).rejects.toThrow("oversized");
		await expect(query("SELECT 1 UNION ALL SELECT 2", [], 1)).rejects.toThrow("row budget");
		await expect(
			query("SELECT printf('%.*c', ?, 'x') AS value", [SEARCH_QUERY_MAX_BYTES]),
		).rejects.toThrow("byte budget");
		await expect(query("SELECT x'ff' AS value")).rejects.toThrow("Unexpected");
		expect(await query("SELECT 42 AS value")).toEqual([{ value: 42 }]);
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
					kind: "searchQuery",
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
				kind: "searchQuery",
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
		expect(await query("SELECT 42 AS recovered")).toEqual([{ recovered: 42 }]);
	}, 30_000);
});
