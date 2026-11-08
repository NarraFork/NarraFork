import { afterEach, describe, expect, test } from "bun:test";
import { apiRequests } from "@server/db/schema";
import { cleanDb, getTestDb } from "../../tests/setup";
import { UsageHistoryService } from "./usage-history-service";

const { db, sqlite } = getTestDb();
const service = new UsageHistoryService(db);

afterEach(() => cleanDb(sqlite));

type Granularity = "hour" | "day" | "month";

function seed(rows: Array<{ id: string; createdAt: string }>): void {
	db.insert(apiRequests).values(rows).run();
}

/** 只保留有数据的桶：标签 → 请求数。空桶不参与断言。 */
async function filledBuckets(
	filters: Parameters<UsageHistoryService["getUsageTimeSeries"]>[0],
	granularity: Granularity,
): Promise<Array<[string, number]>> {
	const series = await service.getUsageTimeSeries(filters, { granularity });
	return series.points
		.filter((point) => point.requestCount > 0)
		.map((point) => [point.timestamp, point.requestCount]);
}

const NOVEMBER = { startDate: "2026-11-03T00:00:00.000Z", endDate: "2026-11-07T00:00:00.000Z" };

describe("usage time series follows the reader's calendar", () => {
	test("UTC+8 puts records after local midnight on the local day, not the UTC day", async () => {
		seed([
			// 本地 11-05 01:30
			{ id: "after-local-midnight", createdAt: "2026-11-04T17:30:00.000Z" },
			// 本地 11-05 23:30
			{ id: "late-local-evening", createdAt: "2026-11-05T15:30:00.000Z" },
		]);

		expect(await filledBuckets({ ...NOVEMBER, timeZone: "Asia/Shanghai" }, "day")).toEqual([
			["2026-11-05T00:00:00.000Z", 2],
		]);
		// 同一批记录在 UTC 下属于两天：服务端不再替读者选日历。
		expect(await filledBuckets(NOVEMBER, "day")).toEqual([
			["2026-11-04T00:00:00.000Z", 1],
			["2026-11-05T00:00:00.000Z", 1],
		]);
	});

	test("UTC-5 keeps a late local evening on the same local day", async () => {
		seed([{ id: "ny-evening", createdAt: "2026-01-15T03:30:00.000Z" }]);
		expect(
			await filledBuckets(
				{
					startDate: "2026-01-13T00:00:00.000Z",
					endDate: "2026-01-16T00:00:00.000Z",
					timeZone: "America/New_York",
				},
				"day",
			),
		).toEqual([["2026-01-14T00:00:00.000Z", 1]]);
	});

	test("both sides of a DST jump land on the same local day", async () => {
		seed([
			// 本地 03-08 01:30 EST
			{ id: "before-jump", createdAt: "2026-03-08T06:30:00.000Z" },
			// 本地 03-08 03:30 EDT
			{ id: "after-jump", createdAt: "2026-03-08T07:30:00.000Z" },
			// 本地 03-09 00:30 EDT
			{ id: "next-local-day", createdAt: "2026-03-09T04:30:00.000Z" },
		]);
		expect(
			await filledBuckets(
				{
					startDate: "2026-03-07T00:00:00.000Z",
					endDate: "2026-03-10T00:00:00.000Z",
					timeZone: "America/New_York",
				},
				"day",
			),
		).toEqual([
			["2026-03-08T00:00:00.000Z", 2],
			["2026-03-09T00:00:00.000Z", 1],
		]);
	});

	test("month buckets cross the year boundary in the reader's zone", async () => {
		seed([
			// 本地 2026-12-31 23:30
			{ id: "december", createdAt: "2026-12-31T15:30:00.000Z" },
			// 本地 2027-01-01 00:30
			{ id: "january", createdAt: "2026-12-31T16:30:00.000Z" },
		]);
		expect(
			await filledBuckets(
				{
					startDate: "2026-12-01T00:00:00.000Z",
					endDate: "2027-02-01T00:00:00.000Z",
					timeZone: "Asia/Shanghai",
				},
				"month",
			),
		).toEqual([
			["2026-12-01T00:00:00.000Z", 1],
			["2027-01-01T00:00:00.000Z", 1],
		]);
	});

	test("hour buckets honour a half-hour offset zone", async () => {
		seed([{ id: "kolkata", createdAt: "2026-05-10T18:45:00.000Z" }]);
		expect(
			await filledBuckets(
				{
					startDate: "2026-05-10T12:00:00.000Z",
					endDate: "2026-05-11T06:00:00.000Z",
					timeZone: "Asia/Kolkata",
				},
				"hour",
			),
		).toEqual([["2026-05-11T00:00:00.000Z", 1]]);
	});

	test("an unknown zone falls back to UTC instead of the server process zone", async () => {
		seed([{ id: "unknown-zone", createdAt: "2026-11-04T17:30:00.000Z" }]);
		expect(await filledBuckets({ ...NOVEMBER, timeZone: "Mars/Olympus" }, "day")).toEqual([
			["2026-11-04T00:00:00.000Z", 1],
		]);
	});
});
