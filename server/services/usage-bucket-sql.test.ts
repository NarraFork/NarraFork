import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { apiRequests } from "@server/db/schema";
import type { UsageBucketGranularity } from "@shared/usage-time-zone";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { usageBucketExpression } from "./usage-bucket-sql";

const sqlite = new Database(":memory:");
sqlite.run("CREATE TABLE api_requests (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
const db = drizzle({ client: sqlite });

afterAll(() => sqlite.close());

/** 整年跨度：DST 分段全部落在范围内，SQL 必须按记录所在的段取偏移。 */
const YEAR = {
	start: new Date("2026-01-01T00:00:00.000Z"),
	end: new Date("2027-01-01T00:00:00.000Z"),
};

function labelOf(createdAt: string, granularity: UsageBucketGranularity, timeZone: string): string {
	sqlite.run("DELETE FROM api_requests");
	sqlite.run("INSERT INTO api_requests (id, created_at) VALUES ('row', ?)", [createdAt]);
	const rows = db
		.select({
			bucket: usageBucketExpression({ dialect: "sqlite", granularity, timeZone, ...YEAR }),
		})
		.from(apiRequests)
		.all();
	return rows[0]?.bucket ?? "";
}

describe("usageBucketExpression (sqlite)", () => {
	test("day buckets follow UTC+8 local midnight", () => {
		expect(labelOf("2026-11-04T17:00:00.000Z", "day", "Asia/Shanghai")).toBe(
			"2026-11-05T00:00:00.000Z",
		);
		expect(labelOf("2026-11-04T17:00:00.000Z", "day", "UTC")).toBe("2026-11-04T00:00:00.000Z");
	});

	test("day buckets follow UTC-5 in both winter and summer", () => {
		expect(labelOf("2026-01-15T03:00:00.000Z", "day", "America/New_York")).toBe(
			"2026-01-14T00:00:00.000Z",
		);
		expect(labelOf("2026-07-15T03:00:00.000Z", "day", "America/New_York")).toBe(
			"2026-07-14T00:00:00.000Z",
		);
	});

	test("records on both sides of a DST jump keep the same local day", () => {
		// 01:30 EST 与 03:30 EDT 是同一天；一个查询一个偏移会把其中一条算到隔壁日。
		expect(labelOf("2026-03-08T06:30:00.000Z", "day", "America/New_York")).toBe(
			"2026-03-08T00:00:00.000Z",
		);
		expect(labelOf("2026-03-08T07:30:00.000Z", "day", "America/New_York")).toBe(
			"2026-03-08T00:00:00.000Z",
		);
		expect(labelOf("2026-03-09T04:30:00.000Z", "day", "America/New_York")).toBe(
			"2026-03-09T00:00:00.000Z",
		);
	});

	test("hour buckets land on the local hour for a half-hour offset zone", () => {
		expect(labelOf("2026-05-10T18:45:00.000Z", "hour", "Asia/Kolkata")).toBe(
			"2026-05-11T00:00:00.000Z",
		);
		expect(labelOf("2026-11-05T02:30:00.000Z", "hour", "Asia/Shanghai")).toBe(
			"2026-11-05T10:00:00.000Z",
		);
	});

	test("month buckets cross the year boundary in the reader's zone", () => {
		expect(labelOf("2026-12-31T20:00:00.000Z", "month", "Asia/Shanghai")).toBe(
			"2027-01-01T00:00:00.000Z",
		);
		expect(labelOf("2026-03-15T12:00:00.000Z", "month", "America/New_York")).toBe(
			"2026-03-01T00:00:00.000Z",
		);
	});

	test("a single-offset span emits one modifier instead of a case expression", () => {
		const expression = usageBucketExpression({
			dialect: "sqlite",
			granularity: "day",
			timeZone: "Asia/Shanghai",
			start: new Date("2026-01-01T00:00:00.000Z"),
			end: new Date("2026-02-01T00:00:00.000Z"),
		});
		const { sql: rendered } = db.select({ bucket: expression }).from(apiRequests).toSQL();
		expect(rendered).not.toContain("case");
		expect(rendered).toContain("'480 minutes'");
	});

	test("a span with DST emits a case expression over both offsets", () => {
		const expression = usageBucketExpression({
			dialect: "sqlite",
			granularity: "day",
			timeZone: "America/New_York",
			start: new Date("2026-03-01T00:00:00.000Z"),
			end: new Date("2026-04-01T00:00:00.000Z"),
		});
		const { sql: rendered } = db.select({ bucket: expression }).from(apiRequests).toSQL();
		expect(rendered).toContain("case");
		expect(rendered).toContain("'-300 minutes'");
		expect(rendered).toContain("'-240 minutes'");
	});
});

describe("usageBucketExpression (sqlite) grouping", () => {
	test("rows inside one local day collapse into the same bucket", () => {
		sqlite.run("DELETE FROM api_requests");
		const values = [
			["a", "2026-11-04T16:10:00.000Z"],
			["b", "2026-11-04T23:59:00.000Z"],
			["c", "2026-11-05T15:00:00.000Z"],
			["d", "2026-11-05T16:30:00.000Z"],
		];
		for (const [id, createdAt] of values) {
			sqlite.run("INSERT INTO api_requests (id, created_at) VALUES (?, ?)", [id, createdAt]);
		}
		const bucket = usageBucketExpression({
			dialect: "sqlite",
			granularity: "day",
			timeZone: "Asia/Shanghai",
			...YEAR,
		});
		const rows = db.select({ bucket }).from(apiRequests).orderBy(bucket).groupBy(bucket).all();
		// 本地 11-05（a/b/c）与 11-06（d）两个桶。
		expect(rows.map((row) => row.bucket)).toEqual([
			"2026-11-05T00:00:00.000Z",
			"2026-11-06T00:00:00.000Z",
		]);
	});
});

describe("usageBucketExpression (sqlite) filtering", () => {
	test("absolute-time filters and local labels stay independent", () => {
		sqlite.run("DELETE FROM api_requests");
		sqlite.run(
			"INSERT INTO api_requests (id, created_at) VALUES ('row', '2026-11-04T17:30:00.000Z')",
		);
		const rows = db
			.select({
				bucket: usageBucketExpression({
					dialect: "sqlite",
					granularity: "day",
					timeZone: "Asia/Shanghai",
					...YEAR,
				}),
			})
			.from(apiRequests)
			.where(eq(apiRequests.id, "row"))
			.all();
		expect(rows[0]?.bucket).toBe("2026-11-05T00:00:00.000Z");
	});
});
