import { expect, test } from "bun:test";
import type { UsageBucketGranularity } from "@shared/usage-time-zone";
import { sql } from "drizzle-orm";
import { withPostgres } from "../../tests/db/pg-test-harness";
import { createPostgresClient } from "../db/postgres-client";
import { usageBucketExpression } from "./usage-bucket-sql";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const RANGE = {
	start: new Date("2026-01-01T00:00:00.000Z"),
	end: new Date("2027-01-01T00:00:00.000Z"),
};

/**
 * 真实 PostgreSQL 覆盖：`AT TIME ZONE` 的分桶语义只有在真库上才能验证，
 * `PgDialect` 只编译 SQL、仍在 SQLite 执行，发现不了函数与时区语义的差异。
 */
(PG_ENABLED ? test : test.skip)(
	"real PostgreSQL buckets by the reader's IANA zone, across DST and half-hour offsets",
	async () => {
		await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
				credentials.password,
			)}@127.0.0.1:${port}/nf_harness`;
			const client = createPostgresClient({ driver: "bun-sql", url, max: 4 });
			const db = client.db;
			try {
				await db.execute(
					sql`create temporary table api_requests (id text primary key, created_at text not null)`,
				);
				const seed: Array<[string, string]> = [
					["shanghai-midnight", "2026-11-04T17:00:00.000Z"],
					["ny-winter", "2026-01-15T03:00:00.000Z"],
					["ny-summer", "2026-07-15T03:00:00.000Z"],
					["dst-before", "2026-03-08T06:30:00.000Z"],
					["dst-after", "2026-03-08T07:30:00.000Z"],
					["kolkata", "2026-05-10T18:45:00.000Z"],
					["year-boundary", "2026-12-31T20:00:00.000Z"],
				];
				for (const [id, createdAt] of seed) {
					await db.execute(
						sql`insert into api_requests (id, created_at) values (${id}, ${createdAt})`,
					);
				}
				const bucketOf = async (
					id: string,
					granularity: UsageBucketGranularity,
					timeZone: string,
				): Promise<string | undefined> => {
					const expression = usageBucketExpression({
						dialect: "postgres",
						granularity,
						timeZone,
						...RANGE,
					});
					const rows = (await db.execute(
						sql`select ${expression} as bucket from api_requests where id = ${id}`,
					)) as Array<{ bucket: string }>;
					return rows[0]?.bucket;
				};

				expect(await bucketOf("shanghai-midnight", "day", "Asia/Shanghai")).toBe(
					"2026-11-05T00:00:00.000Z",
				);
				expect(await bucketOf("shanghai-midnight", "day", "UTC")).toBe("2026-11-04T00:00:00.000Z");
				expect(await bucketOf("ny-winter", "day", "America/New_York")).toBe(
					"2026-01-14T00:00:00.000Z",
				);
				expect(await bucketOf("ny-summer", "day", "America/New_York")).toBe(
					"2026-07-14T00:00:00.000Z",
				);
				// DST 切换两侧同属一个本地日：这一条在固定偏移的实现里会落到隔壁日。
				expect(await bucketOf("dst-before", "day", "America/New_York")).toBe(
					"2026-03-08T00:00:00.000Z",
				);
				expect(await bucketOf("dst-after", "day", "America/New_York")).toBe(
					"2026-03-08T00:00:00.000Z",
				);
				expect(await bucketOf("kolkata", "hour", "Asia/Kolkata")).toBe("2026-05-11T00:00:00.000Z");
				expect(await bucketOf("year-boundary", "month", "Asia/Shanghai")).toBe(
					"2027-01-01T00:00:00.000Z",
				);
			} finally {
				await client.close();
			}
		});
	},
	120_000,
);

(PG_ENABLED ? test : test.skip)(
	"real PostgreSQL groups a local day across the DST jump",
	async () => {
		await withPostgres(async ({ port, credentials }) => {
			const url = `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
				credentials.password,
			)}@127.0.0.1:${port}/nf_harness`;
			const client = createPostgresClient({ driver: "bun-sql", url, max: 4 });
			const db = client.db;
			try {
				await db.execute(
					sql`create temporary table api_requests (id text primary key, created_at text not null)`,
				);
				const seed = [
					["before", "2026-03-08T06:30:00.000Z"],
					["after", "2026-03-08T07:30:00.000Z"],
					["next-day", "2026-03-09T04:30:00.000Z"],
				];
				for (const [id, createdAt] of seed) {
					await db.execute(
						sql`insert into api_requests (id, created_at) values (${id}, ${createdAt})`,
					);
				}
				const bucket = usageBucketExpression({
					dialect: "postgres",
					granularity: "day",
					timeZone: "America/New_York",
					...RANGE,
				});
				const rows = (await db.execute(
					sql`select ${bucket} as bucket, count(*)::int as total from api_requests group by 1 order by 1`,
				)) as Array<{ bucket: string; total: number }>;
				expect(rows).toEqual([
					{ bucket: "2026-03-08T00:00:00.000Z", total: 2 },
					{ bucket: "2026-03-09T00:00:00.000Z", total: 1 },
				]);
			} finally {
				await client.close();
			}
		});
	},
	120_000,
);
