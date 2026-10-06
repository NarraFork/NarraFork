import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRequests, users } from "@server/db/schema";
import { resetDbWorkerPoolForTest, shutdownDbWorkerPool } from "@server/lib/db-worker/pool";
import { decodeUsageHistoryCursor } from "@server/lib/usage-history-cursor";
import { cleanDb, getTestDb } from "../../tests/setup";
import { UsageHistoryService } from "./usage-history-service";

const { db, sqlite } = getTestDb();
const service = new UsageHistoryService(db);

const createdAt = "2026-07-17T12:00:00.000Z";

afterEach(() => cleanDb(sqlite));

test("reference cost coverage survives detail, totals, series and breakdown without repricing history", async () => {
	db.insert(apiRequests)
		.values([
			{ id: "legacy", createdAt, costUsd: 99, provider: "legacy" },
			{
				id: "partial",
				createdAt,
				costUsd: 0.5,
				costStatus: "partial",
				costMissingFields: ["cacheRead"],
				provider: "fixture",
			},
			{
				id: "unknown",
				createdAt,
				costUsd: null,
				costStatus: "unknown",
				costMissingFields: ["input"],
				provider: "fixture",
			},
			{
				id: "free",
				createdAt,
				costUsd: 0,
				costStatus: "complete",
				costMissingFields: [],
				provider: "free",
			},
		])
		.run();
	expect(await service.getUsageRecord("legacy")).toMatchObject({
		costUsd: 99,
		costStatus: null,
		costMissingFields: null,
	});
	expect(await service.getUsageRecord("partial")).toMatchObject({
		costUsd: 0.5,
		costStatus: "partial",
		costMissingFields: ["cacheRead"],
	});
	expect(await service.getUsageStats({})).toMatchObject({
		totalCost: 99.5,
		costStatus: "partial",
		unpricedRequestCount: 2,
		partialRequestCount: 1,
	});
	expect(await service.getUsageStats({ provider: "free" })).toMatchObject({
		totalCost: 0,
		costStatus: "complete",
	});
	const filters = { startDate: "2026-07-17T00:00:00.000Z", endDate: "2026-07-17T23:59:59.999Z" };
	const series = await service.getUsageTimeSeries(filters);
	expect(series.points[0]).toMatchObject({
		totalCost: 99.5,
		costStatus: "partial",
		partialRequestCount: 1,
	});
	expect(
		await service.getUsageBreakdown(filters, { dimension: "provider", metric: "cost" }),
	).toMatchObject({ costStatus: "partial", partialRequestCount: 1 });
	expect(
		await service.getUsageTimeSeriesStacked(filters, { dimension: "provider", metric: "cost" }),
	).toMatchObject({ costStatus: "partial", partialRequestCount: 1 });
});

function seedUsers() {
	db.insert(users)
		.values([
			{ id: "alice-id", username: "Alice", passwordHash: "test", createdAt },
			{ id: "bob-id", username: "Bob", passwordHash: "test", createdAt },
		])
		.run();
	db.insert(apiRequests)
		.values([
			{
				id: "alice-1",
				userId: "alice-id",
				kind: "narrator",
				provider: "codex",
				inputTokens: 100,
				outputTokens: 10,
				costUsd: 1,
				createdAt,
			},
			{
				id: "alice-2",
				userId: "alice-id",
				kind: "summary",
				provider: "anthropic",
				inputTokens: 200,
				outputTokens: 20,
				costUsd: 2,
				createdAt,
			},
			{ id: "bob-1", userId: "bob-id", kind: "narrator", inputTokens: 400, costUsd: 4, createdAt },
			{
				id: "deleted-1",
				userId: "deleted-id",
				kind: "narrator",
				inputTokens: 800,
				costUsd: 8,
				createdAt,
			},
			{ id: "legacy-1", userId: null, kind: "narrator", inputTokens: 1600, costUsd: 16, createdAt },
		])
		.run();
}

const dateFilters = { startDate: "2026-07-17T00:00:00.000Z", endDate: "2026-07-18T00:00:00.000Z" };

describe("UsageHistoryService user attribution", () => {
	for (const [userId, expectedCount, inputTokens] of [
		["alice-id", 2, 300],
		["bob-id", 1, 400],
		["deleted-id", 1, 800],
		["__unattributed__", 1, 1600],
		["missing", 0, 0],
	] as const) {
		test(`applies ${userId} to both lists and every aggregate`, async () => {
			seedUsers();
			const filters = { ...dateFilters, userId };
			const page = await service.listUsageHistory(filters);
			expect(page.total).toBe(expectedCount);
			expect(page.records).toHaveLength(expectedCount);
			expect((await service.listUsageHistoryCursor(filters)).records).toHaveLength(expectedCount);
			const stats = await service.getUsageStats(filters);
			expect(stats.totalRequests).toBe(expectedCount);
			expect(stats.totalInputTokens).toBe(inputTokens);
			const series = await service.getUsageTimeSeries(filters);
			expect(series.points.reduce((sum, point) => sum + point.requestCount, 0)).toBe(expectedCount);
			const breakdown = await service.getUsageBreakdown(filters, {
				dimension: "user",
				metric: "tokens",
			});
			expect(breakdown.entries.reduce((sum, item) => sum + item.count, 0)).toBe(expectedCount);
			const stacked = await service.getUsageTimeSeriesStacked(filters, {
				dimension: "user",
				metric: "requests",
			});
			expect(
				stacked.series.flatMap((item) => item.data).reduce((sum, item) => sum + item.value, 0),
			).toBe(expectedCount);
		});
	}

	test("returns current usernames and preserves deleted IDs on list and detail", async () => {
		seedUsers();
		const records = (await service.listUsageHistoryCursor({})).records;
		for (const [id, userId, username] of [
			["alice-1", "alice-id", "Alice"],
			["deleted-1", "deleted-id", null],
			["legacy-1", null, null],
		] as const) {
			expect(records.find((record) => record.id === id)).toMatchObject({ userId, username });
			expect(await service.getUsageRecord(id)).toMatchObject({ userId, username });
		}
	});

	test("groups multiple users and translates only the NULL sentinel", async () => {
		seedUsers();
		const breakdown = await service.getUsageBreakdown(
			{},
			{ dimension: "user", metric: "requests" },
		);
		expect(breakdown.total).toBe(5);
		expect(breakdown.entries).toContainEqual({
			label: "Alice",
			value: 2,
			count: 2,
			percentage: 40,
		});
		expect(breakdown.entries.map((entry) => entry.label).sort()).toEqual([
			"Alice",
			"Bob",
			"__unattributed__",
			"deleted-id",
		]);
		const stacked = await service.getUsageTimeSeriesStacked(dateFilters, {
			dimension: "user",
			metric: "cost",
			topN: 2,
		});
		expect(stacked.series.map((entry) => entry.label)).toEqual([
			"__unattributed__",
			"deleted-id",
			"other",
		]);
		expect(
			stacked.series.map((entry) => entry.data.reduce((sum, point) => sum + point.value, 0)),
		).toEqual([16, 8, 7]);
	});

	test("includes users beyond the top 20 in percentages and the other category", async () => {
		db.insert(apiRequests)
			.values(
				Array.from({ length: 25 }, (_, index) => ({
					id: `many-request-${index}`,
					userId: `many-user-${index}`,
					kind: "narrator",
					createdAt,
				})),
			)
			.run();
		const breakdown = await service.getUsageBreakdown(
			{},
			{ dimension: "user", metric: "requests" },
		);
		expect(breakdown.total).toBe(25);
		expect(breakdown.entries).toHaveLength(21);
		expect(breakdown.entries[0].percentage).toBe(4);
		expect(breakdown.entries[20]).toEqual({ label: "other", value: 5, count: 5, percentage: 20 });
	});

	test("combines exact user filtering with existing filters", async () => {
		seedUsers();
		expect(
			(await service.getUsageStats({ userId: "alice-id", provider: "codex" })).totalRequests,
		).toBe(1);
		expect((await service.getUsageStats({ userId: "alice" })).totalRequests).toBe(0);
		expect((await service.getUsageStats({ userId: "   " })).totalRequests).toBe(5);
	});

	test("preserves model family clustering and non-top totals", async () => {
		db.insert(apiRequests)
			.values([
				{ id: "a", kind: "narrator", model: "nug:claude-opus-4.6", createdAt },
				{ id: "b", kind: "narrator", model: "claude-opus-4-6-20260514", createdAt },
				{ id: "c", kind: "narrator", model: "gpt-5", createdAt },
				{ id: "d", kind: "narrator", model: "other", createdAt },
			])
			.run();
		const breakdown = await service.getUsageBreakdown(
			{},
			{ dimension: "model", metric: "requests" },
		);
		expect(breakdown.entries).toContainEqual({
			label: "claude-opus-4-6",
			value: 2,
			count: 2,
			percentage: 50,
		});
		const stacked = await service.getUsageTimeSeriesStacked(dateFilters, {
			dimension: "model",
			metric: "requests",
			topN: 2,
		});
		expect(
			stacked.series.flatMap((item) => item.data).reduce((sum, item) => sum + item.value, 0),
		).toBe(4);
		expect(stacked.series.find((item) => item.label === "claude-opus-4-6")?.data[0].value).toBe(2);
	});
});

describe("UsageHistoryService production worker", () => {
	test("runs all aggregates against the worker DB with the same field mapping", async () => {
		seedUsers();
		const directory = await mkdtemp(join(tmpdir(), "usage-history-worker-"));
		const path = join(directory, "usage.db");
		try {
			await writeFile(path, sqlite.serialize());
			const workerService = new UsageHistoryService(db, path);
			const filters = { ...dateFilters, userId: "alice-id" };
			expect(await workerService.getUsageStats(filters)).toEqual(
				await service.getUsageStats(filters),
			);
			expect((await workerService.getUsageTimeSeries(filters)).points).toEqual(
				(await service.getUsageTimeSeries(filters)).points,
			);
			expect(
				await workerService.getUsageBreakdown(dateFilters, { dimension: "user", metric: "cost" }),
			).toEqual(
				await service.getUsageBreakdown(dateFilters, { dimension: "user", metric: "cost" }),
			);
			expect(
				await workerService.getUsageTimeSeriesStacked(dateFilters, {
					dimension: "user",
					metric: "cost",
					topN: 2,
				}),
			).toEqual(
				await service.getUsageTimeSeriesStacked(dateFilters, {
					dimension: "user",
					metric: "cost",
					topN: 2,
				}),
			);
			expect((await workerService.listUsageHistory(filters)).total).toBe(2);
			expect(await workerService.listProviders()).toEqual(["anthropic", "codex"]);
			// Clear only the injected main-thread fixture: subsequent totals must still come from disk.
			cleanDb(sqlite);
			expect((await workerService.getUsageStats(filters)).totalRequests).toBe(2);
		} finally {
			shutdownDbWorkerPool();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("fails closed instead of performing a main-thread scan when workers are disabled", async () => {
		seedUsers();
		const original = process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER = "off";
		try {
			await expect(
				new UsageHistoryService(db, "unused.db").getUsageStats({}),
			).rejects.toMatchObject({ statusCode: 503, code: "USAGE_QUERY_UNAVAILABLE" });
		} finally {
			if (original === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = original;
			resetDbWorkerPoolForTest();
		}
	});
});

describe("UsageHistoryService cursor pagination", () => {
	test("returns stable pages for equal timestamps", async () => {
		db.insert(apiRequests)
			.values([
				{ id: "request-a", kind: "narrator", createdAt },
				{ id: "request-b", kind: "narrator", createdAt },
				{ id: "request-c", kind: "narrator", createdAt },
			])
			.run();

		const first = await service.listUsageHistoryCursor({}, 2);
		expect(first.records.map((record) => record.id)).toEqual(["request-c", "request-b"]);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBeTruthy();

		const cursor = decodeUsageHistoryCursor(first.nextCursor ?? undefined);
		expect(cursor).toEqual({ createdAt, id: "request-b" });

		const second = await service.listUsageHistoryCursor({}, 2, cursor ?? undefined);
		expect(second.records.map((record) => record.id)).toEqual(["request-a"]);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeNull();
	});

	test("keeps the legacy page response data available", async () => {
		db.insert(apiRequests)
			.values([
				{ id: "request-a", kind: "narrator", createdAt },
				{ id: "request-b", kind: "narrator", createdAt },
				{ id: "request-c", kind: "narrator", createdAt },
			])
			.run();

		const page = await service.listUsageHistory({}, 1, 2);
		expect(page.total).toBe(3);
		expect(page.records.map((record) => record.id)).toEqual(["request-c", "request-b"]);
	});

	test("surfaces the agent label and external kind for external-agent records", async () => {
		db.insert(apiRequests)
			.values([
				{
					id: "external-a",
					kind: "external",
					agentLabel: "DeepSeek Harness",
					createdAt,
				},
				{
					id: "external-b",
					kind: "external",
					agentLabel: null,
					createdAt,
				},
			])
			.run();

		const page = await service.listUsageHistory({}, 1, 10);
		const records = page.records.map((record) => ({
			id: record.id,
			kind: record.kind,
			agentLabel: record.agentLabel ?? null,
		}));
		expect(records).toEqual([
			{ id: "external-b", kind: "external", agentLabel: null },
			{ id: "external-a", kind: "external", agentLabel: "DeepSeek Harness" },
		]);
	});
});
