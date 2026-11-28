import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	SELECT_ROWS_MAX_BYTES,
	SELECT_ROWS_MAX_PARAMS,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	SELECT_ROWS_MAX_ROWS,
	SELECT_ROWS_MAX_SQL_BYTES,
	type SelectRowsParams,
} from "./protocol";
import { jsonStringBytes, ReadBudgetMeter } from "./read-budget";
import { decodeReadBinds, encodeReadBinds, runSelectValues } from "./select-extended";
import { runSelectRows } from "./select-rows";

let sqlite: Database;
beforeEach(() => {
	sqlite = new Database(":memory:");
});
afterEach(() => sqlite.close());

function result(overrides: Partial<SelectRowsParams> = {}) {
	return runSelectRows(sqlite, {
		kind: "selectRows",
		sql: "SELECT ? AS title, 42 AS total, null AS optional",
		params: ["search result"],
		maxRows: 1,
		...overrides,
	});
}

/** Object view for assertions; duplicate names collapse here, not in the worker result. */
function query(overrides: Partial<SelectRowsParams> = {}) {
	const { columns, rows } = result(overrides);
	return rows.map((row) =>
		Object.fromEntries(columns.map((column, index) => [column, row[index]])),
	);
}

describe("bounded worker SELECT rows", () => {
	test("returns positional rows that keep duplicate column names apart", () => {
		expect(result({ sql: "SELECT ?, ?, null AS name", params: ["alice", 12] })).toEqual({
			columns: ["?", "?", "name"],
			rows: [["alice", 12, null]],
		});
		sqlite.run("CREATE TABLE t (id INTEGER)");
		sqlite.run("INSERT INTO t VALUES (1)");
		expect(
			result({ sql: "SELECT a.id, b.id FROM t a JOIN t b ON a.id = b.id", params: [] }),
		).toEqual({ columns: ["id", "id"], rows: [[1, 1]] });
	});

	test("preserves named fields and scalar types", () => {
		expect(query()).toEqual([{ title: "search result", total: 42, optional: null }]);
		expect(query({ sql: "WITH data AS (SELECT ? AS value) SELECT value FROM data" })).toEqual([
			{ value: "search result" },
		]);
	});

	test("rejects writes, multiple statements and WITH-disguised writes", () => {
		sqlite.run("CREATE TABLE protected_data (value TEXT)");
		for (const sql of [
			"DELETE FROM protected_data",
			"PRAGMA user_version = 2",
			"SELECT 1; DELETE FROM protected_data",
			"WITH data AS (SELECT 1) DELETE FROM protected_data",
			"WITH data AS (DELETE FROM protected_data RETURNING value) SELECT * FROM data",
		])
			expect(() => query({ sql, params: [] })).toThrow();
		expect(sqlite.query("SELECT count(*) AS total FROM protected_data").get()).toEqual({
			total: 0,
		});
	});

	test("validates SQL, parameter counts, scalar types and finite numbers", () => {
		expect(
			query({ sql: `SELECT 1 AS value ${" ".repeat(SELECT_ROWS_MAX_SQL_BYTES)}`, params: [] }),
		).toEqual([{ value: 1 }]);
		for (const value of [NaN, Infinity, -Infinity, true, {}, undefined, 1n]) {
			expect(() => query({ params: [value] as SelectRowsParams["params"] })).toThrow();
		}
		expect(() => query({ params: Array(1) })).toThrow();
		for (const maxRows of [0, -1, 1.5, NaN, Infinity]) expect(() => query({ maxRows })).toThrow();
	});

	test("observes UTF-8 and escaped parameter sizes while preserving complete text", () => {
		for (const value of [
			"界".repeat(SELECT_ROWS_MAX_PARAMS_BYTES / 2),
			"\\".repeat(SELECT_ROWS_MAX_PARAMS_BYTES / 2),
			"a".repeat(SELECT_ROWS_MAX_PARAMS_BYTES),
		])
			expect(query({ params: [value] })[0]?.title).toBe(value);
		for (const value of ["界", '\\"\n\t\u0000', "\ud800", "😀"])
			expect(jsonStringBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
	});

	test("accepts the maximum parameter count and row budget", () => {
		const params = Array(SELECT_ROWS_MAX_PARAMS).fill(1);
		const sql = `WITH data(value) AS (VALUES ${params.map(() => "(?)").join(",")}) SELECT sum(value) AS total FROM data`;
		expect(query({ sql, params })).toEqual([{ total: SELECT_ROWS_MAX_PARAMS }]);
		const rows = query({
			sql: "WITH RECURSIVE data(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM data WHERE n < ?) SELECT n FROM data",
			params: [SELECT_ROWS_MAX_ROWS],
			maxRows: SELECT_ROWS_MAX_ROWS,
		});
		expect(rows).toHaveLength(SELECT_ROWS_MAX_ROWS);
		expect(rows.at(-1)).toEqual({ n: SELECT_ROWS_MAX_ROWS });
	});

	test("executes 4097 VALUES parameters in ordinary and encoded readers", () => {
		const params = Array(SELECT_ROWS_MAX_PARAMS + 1).fill(1);
		const meter = new ReadBudgetMeter();
		const encoded = encodeReadBinds(params, meter);
		const sql = `WITH data(value) AS (VALUES ${params.map(() => "(?)").join(",")}) SELECT sum(value) AS total FROM data`;
		expect(
			runSelectValues(sqlite, { kind: "selectValues", sql, params: encoded, maxRows: 1 }, meter),
		).toEqual({ columns: ["total"], rows: [[4097]] });
		expect(query({ sql, params })).toEqual([{ total: 4097 }]);
		expect(meter.snapshot().filter((item) => item.kind === "parameterCount")).toEqual([
			{ kind: "parameterCount", actual: 4097, threshold: 4096, phase: "input" },
		]);
	});

	test("maxRows observes three rows and explicit SQL LIMIT still selects one", () => {
		const sql = "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3";
		expect(query({ sql, params: [], maxRows: 1 })).toEqual([
			{ value: 1 },
			{ value: 2 },
			{ value: 3 },
		]);
		expect(
			runSelectValues(sqlite, { kind: "selectValues", sql, params: [], maxRows: 1 }).rows,
		).toEqual([[1], [2], [3]]);
		expect(query({ sql: `${sql} LIMIT 1`, params: [] })).toEqual([{ value: 1 }]);
		expect(
			runSelectValues(sqlite, {
				kind: "selectValues",
				sql: `${sql} LIMIT 1`,
				params: [],
				maxRows: 1,
			}).rows,
		).toEqual([[1]]);
		expect(query({ sql: "SELECT 1 AS value WHERE 0", params: [] })).toEqual([]);
	});

	test("returns single and cumulative results above 4 MiB without whole-result serialization", () => {
		const stringify = spyOn(JSON, "stringify").mockImplementation(() => {
			throw new Error("Whole-result serialization forbidden");
		});
		try {
			for (const kind of ["selectRows", "selectValues"] as const) {
				const execute = kind === "selectRows" ? runSelectRows : runSelectValues;
				const single = execute(sqlite, {
					kind,
					sql: "SELECT printf('%.*c', ?, 'x') AS content",
					params: [SELECT_ROWS_MAX_BYTES + 1],
					maxRows: 1,
				} as never);
				expect((single.rows[0][0] as string).length).toBe(SELECT_ROWS_MAX_BYTES + 1);
				const multi = execute(sqlite, {
					kind,
					sql: "SELECT zeroblob(?) UNION ALL SELECT zeroblob(?)",
					params: [SELECT_ROWS_MAX_BYTES / 2, SELECT_ROWS_MAX_BYTES / 2 + 1],
					maxRows: 1,
				} as never);
				expect(multi.rows).toHaveLength(2);
				expect((multi.rows[1][0] as Uint8Array).byteLength).toBe(SELECT_ROWS_MAX_BYTES / 2 + 1);
			}
		} finally {
			stringify.mockRestore();
		}
	});

	test("oversized text and Blob binds decode in full and retain independent visible views", () => {
		const backing = new Uint8Array(SELECT_ROWS_MAX_PARAMS_BYTES * 3).fill(7);
		const view = backing.subarray(1, SELECT_ROWS_MAX_PARAMS_BYTES + 2);
		const text = "界".repeat(SELECT_ROWS_MAX_PARAMS_BYTES);
		const encoded = encodeReadBinds([view, text]);
		const decoded = decodeReadBinds({
			kind: "selectValues",
			sql: "SELECT ?, ?",
			params: encoded,
			maxRows: 1,
		});
		expect((decoded[0] as Uint8Array).byteLength).toBe(view.byteLength);
		expect((decoded[0] as Uint8Array).buffer.byteLength).toBe(view.byteLength);
		expect(decoded[1]).toBe(text);
		view.fill(9);
		expect((decoded[0] as Uint8Array)[0]).toBe(7);
	});

	test("returns blobs and releases errored statements", () => {
		expect(query({ sql: "SELECT x'ff' AS value", params: [] })).toEqual([
			{ value: new Uint8Array([255]) },
		]);
		expect(() => query({ sql: "SELECT missing_column", params: [] })).toThrow();
		expect(query()).toHaveLength(1);
	});

	test("wrapper preserves FTS5 snippet context with ranking and materialized CTEs", () => {
		sqlite.run("CREATE VIRTUAL TABLE messages_fts USING fts5(content, tokenize='trigram')");
		sqlite.run(
			"INSERT INTO messages_fts(content) VALUES ('before searchable after'), ('another searchable result')",
		);
		const projection =
			"SELECT rowid AS id, snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet, rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank, rowid DESC LIMIT 2";
		for (const sql of [
			projection,
			`WITH matches AS MATERIALIZED (${projection}) SELECT * FROM matches ORDER BY rank, id DESC`,
		]) {
			const direct = sqlite.query<Record<string, unknown>, [string]>(sql).all("searchable");
			expect(query({ sql, params: ["searchable"], maxRows: 2 })).toEqual(direct);
			expect(direct).toHaveLength(2);
			expect(String(direct[0]?.snippet)).toContain("<mark>searchable</mark>");
		}
	});
});
