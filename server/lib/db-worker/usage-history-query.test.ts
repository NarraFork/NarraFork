import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { UsageHistoryQueryParams } from "./protocol";
import { runUsageHistoryQuery, USAGE_QUERY_MAX_BYTES } from "./usage-history-query";

let sqlite = new Database(":memory:");
afterEach(() => {
	sqlite.close();
	sqlite = new Database(":memory:");
});
function query(overrides: Partial<UsageHistoryQueryParams> = {}) {
	return runUsageHistoryQuery(sqlite, {
		kind: "usageHistoryQuery",
		sql: "SELECT ?",
		params: [42],
		columns: ["totalRequests"],
		maxRows: 1,
		...overrides,
	});
}

describe("bounded worker usage queries", () => {
	test("maps ordered Drizzle fields, including duplicate SQL expressions", () => {
		expect(
			query({
				sql: "SELECT ?, ?, null",
				params: ["alice", 12],
				columns: ["userId", "tokens", "username"],
			}),
		).toEqual([{ userId: "alice", tokens: 12, username: null }]);
	});
	test("rejects SQL writes, dump fields, oversized input and invalid metadata", () => {
		for (const sql of [
			"DELETE FROM users",
			"SELECT 1; DELETE FROM users",
			"SELECT raw_dump_json FROM api_requests",
			`SELECT '${"a".repeat(70_000)}'`,
		])
			expect(() => query({ sql })).toThrow();
		expect(() => query({ params: ["a".repeat(70_000)] })).toThrow();
		expect(() => query({ maxRows: 10001 })).toThrow();
		expect(() => query({ columns: ["__proto__"] })).toThrow();
		expect(() => query({ columns: ["id", "id"] })).toThrow();
	});
	test("throws rather than silently returning partial statistics", () => {
		expect(() => query({ sql: "SELECT 1 UNION ALL SELECT 2", params: [] })).toThrow("row budget");
	});
	test("bounds byte output while consuming rows", () => {
		expect(() =>
			query({ sql: "SELECT printf('%.*c', ?, 'x')", params: [USAGE_QUERY_MAX_BYTES + 1] }),
		).toThrow("byte budget");
	});
	test("query mismatch fails instead of corrupting the field mapping", () => {
		expect(() => query({ columns: ["one", "two"] })).toThrow();
	});
});
