import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	SEARCH_QUERY_MAX_BYTES,
	SEARCH_QUERY_MAX_PARAMS,
	SEARCH_QUERY_MAX_PARAMS_BYTES,
	SEARCH_QUERY_MAX_ROWS,
	SEARCH_QUERY_MAX_SQL_BYTES,
	type SearchQueryParams,
} from "./protocol";
import { runSearchQuery } from "./search-query";

let sqlite: Database;
beforeEach(() => {
	sqlite = new Database(":memory:");
});
afterEach(() => sqlite.close());

function query(overrides: Partial<SearchQueryParams> = {}) {
	return runSearchQuery(sqlite, {
		kind: "searchQuery",
		sql: "SELECT ? AS title, 42 AS total, null AS optional",
		params: ["search result"],
		maxRows: 1,
		...overrides,
	});
}

describe("bounded worker search queries", () => {
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
		expect(() => query({ sql: `SELECT 1 ${" ".repeat(SEARCH_QUERY_MAX_SQL_BYTES)}` })).toThrow();
		expect(() => query({ params: Array(SEARCH_QUERY_MAX_PARAMS + 1).fill(null) })).toThrow();
		for (const value of [NaN, Infinity, -Infinity, true, {}, undefined, 1n]) {
			expect(() => query({ params: [value] as SearchQueryParams["params"] })).toThrow();
		}
		expect(() => query({ params: Array(1) })).toThrow();
		for (const maxRows of [0, -1, 1.5, NaN, Infinity, SEARCH_QUERY_MAX_ROWS + 1])
			expect(() => query({ maxRows })).toThrow();
	});

	test("enforces UTF-8 and serialized parameter byte budgets separately", () => {
		expect(() => query({ params: ["界".repeat(SEARCH_QUERY_MAX_PARAMS_BYTES / 2)] })).toThrow();
		expect(() => query({ params: ["\\".repeat(SEARCH_QUERY_MAX_PARAMS_BYTES / 2)] })).toThrow();
		expect(() => query({ params: ["a".repeat(SEARCH_QUERY_MAX_PARAMS_BYTES)] })).toThrow();
		// This deliberately exceeds the older usage-task's 64 KiB parameter ceiling.
		expect(query({ params: ["a".repeat(70_000)] })[0]?.title).toHaveLength(70_000);
	});

	test("accepts the maximum parameter count and row budget", () => {
		const params = Array(SEARCH_QUERY_MAX_PARAMS).fill(1);
		const sql = `SELECT ${params.map(() => "?").join(" + ")} AS total`;
		expect(query({ sql, params })).toEqual([{ total: SEARCH_QUERY_MAX_PARAMS }]);
		const rows = query({
			sql: "WITH RECURSIVE data(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM data WHERE n < ?) SELECT n FROM data",
			params: [SEARCH_QUERY_MAX_ROWS],
			maxRows: SEARCH_QUERY_MAX_ROWS,
		});
		expect(rows).toHaveLength(SEARCH_QUERY_MAX_ROWS);
		expect(rows.at(-1)).toEqual({ n: SEARCH_QUERY_MAX_ROWS });
	});

	test("rejects overflow rows rather than truncating", () => {
		expect(() => query({ sql: "SELECT 1 UNION ALL SELECT 2", params: [] })).toThrow("row budget");
		expect(query({ sql: "SELECT 1 AS value WHERE 0", params: [] })).toEqual([]);
	});

	test("enforces aggregate serialized byte budget, including keys and JSON escaping", () => {
		expect(() =>
			query({ sql: "SELECT printf('%.*c', ?, 'x') AS content", params: [SEARCH_QUERY_MAX_BYTES] }),
		).toThrow("byte budget");
		expect(() =>
			query({
				sql: "SELECT printf('%.*c', ?, 'x') AS content UNION ALL SELECT printf('%.*c', ?, 'x')",
				params: [SEARCH_QUERY_MAX_BYTES / 2, SEARCH_QUERY_MAX_BYTES / 2],
				maxRows: 2,
			}),
		).toThrow("byte budget");
		expect(() =>
			query({
				sql: "SELECT printf('%.*c', ?, char(10)) AS content",
				params: [SEARCH_QUERY_MAX_BYTES / 2],
			}),
		).toThrow("byte budget");
	});

	test("rejects blobs and non-finite returned numbers and releases errored statements", () => {
		for (const sql of ["SELECT x'ff' AS value", "SELECT 1e999 AS value"])
			expect(() => query({ sql, params: [] })).toThrow("Unexpected search query value");
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
