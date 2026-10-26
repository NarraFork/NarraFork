import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRequests, users } from "@server/db/schema";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	shutdownDbWorkerPool,
} from "@server/lib/db-worker/pool";
import { decodeUsageHistoryCursor } from "@server/lib/usage-history-cursor";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { PgDialect } from "drizzle-orm/pg-core";
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

test("preserves normalized OpenAI input and cache buckets in history and aggregates", async () => {
	db.insert(apiRequests)
		.values([
			{
				id: "openai-mixed-cache",
				createdAt,
				provider: "openai",
				inputTokens: 200,
				outputTokens: 30,
				cachedInputTokens: 800,
				cacheCreationInputTokens: 600,
				reasoningTokens: 10,
			},
			{
				id: "openai-fully-cached",
				createdAt,
				provider: "openai",
				inputTokens: 0,
				outputTokens: 20,
				cachedInputTokens: 400,
			},
		])
		.run();
	const filters = { provider: "openai" };
	for (const records of [
		(await service.listUsageHistory(filters)).records,
		(await service.listUsageHistoryCursor(filters)).records,
	]) {
		expect(records.find((record) => record.id === "openai-mixed-cache")).toMatchObject({
			inputTokens: 200,
			cachedInputTokens: 800,
			cacheCreationInputTokens: 600,
		});
		expect(records.find((record) => record.id === "openai-fully-cached")).toMatchObject({
			inputTokens: 0,
			cachedInputTokens: 400,
		});
	}
	expect(await service.getUsageRecord("openai-mixed-cache")).toMatchObject({
		inputTokens: 200,
		cachedInputTokens: 800,
	});
	const expectedTotals = {
		totalInputTokens: 200,
		totalOutputTokens: 50,
		totalCacheReadTokens: 1200,
		totalCacheCreationTokens: 600,
		totalReasoningTokens: 10,
		totalTokens: 2050,
	};
	expect(await service.getUsageStats(filters)).toMatchObject(expectedTotals);
	const series = await service.getUsageTimeSeries({
		...filters,
		startDate: "2026-07-17T00:00:00.000Z",
		endDate: "2026-07-17T23:59:59.999Z",
	});
	expect(series.points).toHaveLength(1);
	expect(series.points[0]).toMatchObject(expectedTotals);
});

describe("cache hit rate eligibility", () => {
	const filters = { startDate: "2026-07-17T00:00:00.000Z", endDate: "2026-07-19T23:59:59.999Z" };

	function seedCacheRequests() {
		db.insert(apiRequests)
			.values([
				{
					id: "cache-large",
					createdAt,
					provider: "cached",
					model: "nug:claude-opus-4.6",
					inputTokens: 200,
					cachedInputTokens: 800,
					cacheCreationInputTokens: 600,
					outputTokens: 50,
					costUsd: 1,
				},
				{
					id: "cache-small",
					createdAt,
					provider: "cached",
					model: "claude-opus-4-6-20260514",
					inputTokens: 0,
					cachedInputTokens: 100,
					outputTokens: 50,
					costUsd: 2,
				},
				{
					id: "zero-cache",
					createdAt,
					provider: "cached",
					model: "nug:claude-opus-4.6",
					inputTokens: 10000,
					cachedInputTokens: 0,
					cacheCreationInputTokens: 3000,
					outputTokens: 50,
					costUsd: 3,
				},
				{
					id: "missing-cache",
					createdAt,
					provider: "uncached",
					model: "uncached",
					inputTokens: 20000,
					outputTokens: 50,
					costUsd: 4,
				},
				{
					id: "write-only",
					createdAt: "2026-07-18T12:00:00.000Z",
					provider: "uncached",
					model: "uncached",
					inputTokens: 30000,
					cacheCreationInputTokens: 4000,
					outputTokens: 50,
					costUsd: 5,
				},
			])
			.run();
	}

	test("summary and time buckets only use positive cache-read rows without filtering ordinary totals", async () => {
		seedCacheRequests();
		const stats = await service.getUsageStats(filters);
		expect(stats).toMatchObject({
			totalRequests: 5,
			totalInputTokens: 60200,
			totalOutputTokens: 250,
			totalCacheCreationTokens: 7600,
			totalCacheReadTokens: 900,
			totalTokens: 68950,
			totalCost: 15,
			cacheHitRateReadTokens: 900,
			cacheHitRateInputTokens: 1700,
		});
		expect(stats.cacheHitRate).toBeCloseTo(900 / 1700);
		const points = (await service.getUsageTimeSeries(filters)).points;
		expect(points.map((point) => point.requestCount)).toEqual([4, 1, 0]);
		expect(points[0].cacheHitRate).toBeCloseTo(900 / 1700);
		expect(points[1].cacheHitRate).toBeNull();
		expect(points[2].cacheHitRate).toBeNull();
		expect(
			(await service.getUsageStats({ ...filters, provider: "uncached" })).cacheHitRate,
		).toBeNull();
		expect(
			(await service.getUsageStats({ ...filters, provider: "missing" })).cacheHitRate,
		).toBeNull();
	});

	for (const dimension of ["provider", "model", "kind", "user"] as const) {
		test(`keeps ${dimension} breakdown and stacked ratios weighted and null when ineligible`, async () => {
			seedCacheRequests();
			const breakdown = await service.getUsageBreakdown(filters, {
				dimension,
				metric: "cacheHitRate",
			});
			expect(breakdown.total).toBeCloseTo(900 / 1700);
			expect(breakdown.entries.filter((entry) => entry.value != null)).toHaveLength(1);
			expect(breakdown.entries.find((entry) => entry.value != null)?.value).toBeCloseTo(900 / 1700);
			expect(breakdown.entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(5);
			const stacked = await service.getUsageTimeSeriesStacked(filters, {
				dimension,
				metric: "cacheHitRate",
			});
			const participating = stacked.series.find((series) => series.data[0].value != null);
			expect(participating?.data[0].value).toBeCloseTo(900 / 1700);
			for (const series of stacked.series) {
				expect(series.data[1].value).toBeNull();
				expect(series.data[2].value).toBeNull();
			}
			const empty = await service.getUsageBreakdown(
				{ ...filters, provider: "uncached" },
				{ dimension, metric: "cacheHitRate" },
			);
			expect(empty.total).toBeNull();
			expect(empty.entries.every((entry) => entry.value === null)).toBe(true);
		});
	}

	for (const options of [
		{ dimension: "provider", cluster: false },
		{ dimension: "model", cluster: false },
		{ dimension: "model", cluster: true },
		{ dimension: "user", cluster: false },
	] as const) {
		test(`${options.dimension} cluster=${options.cluster} keeps eligible groups before LIMIT and compiles PostgreSQL NULLS LAST`, async () => {
			// Exceed both the ordinary top-20 and clustered-model top-200 candidate limits.
			db.insert(apiRequests)
				.values([
					...Array.from({ length: 205 }, (_, index) => ({
						id: `null-rate-${index}`,
						provider: `a-uncached-${index}`,
						model: `a-uncached-${index}`,
						userId: `a-uncached-${index}`,
						createdAt,
						inputTokens: 1000,
						cachedInputTokens: 0,
					})),
					{
						id: "rate-high",
						provider: "z-cached-high",
						model: "z-cached-high",
						userId: "z-cached-high",
						createdAt,
						inputTokens: 10,
						cachedInputTokens: 90,
					},
					{
						id: "rate-low",
						provider: "z-cached-low",
						model: "z-cached-low",
						userId: "z-cached-low",
						createdAt,
						inputTokens: 50,
						cachedInputTokens: 50,
					},
				])
				.run();
			const inspected = new UsageHistoryService(db);
			const dialect = new PgDialect();
			const compiled: ReturnType<PgDialect["sqlToQuery"]>[] = [];
			// Compile the actual generated query through the PG dialect, then execute only
			// against the isolated in-memory SQLite fixture (no PostgreSQL connection).
			const aggregate = spyOn(
				inspected as unknown as {
					aggregate(query: SQLWrapper & PromiseLike<unknown[]>): Promise<unknown[]>;
				},
				"aggregate",
			).mockImplementation(async (query) => {
				compiled.push(dialect.sqlToQuery(query.getSQL()));
				return await query;
			});
			try {
				const breakdown = await inspected.getUsageBreakdown(filters, {
					...options,
					metric: "cacheHitRate",
				});
				expect(breakdown.entries.slice(0, 2).map(({ label, value }) => ({ label, value }))).toEqual(
					[
						{ label: "z-cached-high", value: 0.9 },
						{ label: "z-cached-low", value: 0.5 },
					],
				);
				expect(breakdown.total).toBe(0.7);
				const stacked = await inspected.getUsageTimeSeriesStacked(filters, {
					...options,
					metric: "cacheHitRate",
					topN: 2,
				});
				expect(stacked.series.map((series) => series.label)).toEqual([
					"z-cached-high",
					"z-cached-low",
					"other",
				]);
				expect(stacked.series[0].data[0].value).toBe(0.9);
				expect(stacked.series[1].data[0].value).toBe(0.5);
				expect(stacked.series[2].data.every((point) => point.value === null)).toBe(true);
				const ranked = compiled.filter((query) => /order by[\s\S]*limit/i.test(query.sql));
				expect(ranked).toHaveLength(2);
				for (const query of ranked) {
					expect(query.sql).toMatch(/order by[\s\S]*DESC NULLS LAST[\s\S]*limit \$\d+/);
					expect(query.params.at(-1)).toBe(
						options.dimension === "model" && options.cluster ? 200 : query === ranked[0] ? 20 : 2,
					);
				}
			} finally {
				aggregate.mockRestore();
			}
		});
	}

	test("recombines other-series numerators and denominators instead of adding percentages", async () => {
		db.insert(apiRequests)
			.values([
				{ id: "top-a", createdAt, provider: "a", model: "a", cachedInputTokens: 100 },
				{
					id: "top-b",
					createdAt,
					provider: "b",
					model: "b",
					cachedInputTokens: 90,
					inputTokens: 10,
				},
				{
					id: "other-small",
					createdAt,
					provider: "c",
					model: "c",
					cachedInputTokens: 80,
					inputTokens: 20,
				},
				{
					id: "other-large",
					createdAt,
					provider: "d",
					model: "d",
					cachedInputTokens: 200,
					inputTokens: 800,
				},
				{
					id: "other-excluded",
					createdAt,
					provider: "e",
					model: "e",
					cachedInputTokens: 0,
					inputTokens: 999999,
				},
			])
			.run();
		for (const dimension of ["provider", "model"] as const) {
			const stacked = await service.getUsageTimeSeriesStacked(filters, {
				dimension,
				metric: "cacheHitRate",
				topN: 2,
			});
			expect(stacked.series.find((series) => series.label === "other")?.data[0].value).toBeCloseTo(
				280 / 1100,
			);
		}
	});

	test("user breakdown other and overall rates use eligible totals beyond the top 20", async () => {
		db.insert(apiRequests)
			.values([
				...Array.from({ length: 20 }, (_, index) => ({
					id: `cache-top-${index}`,
					userId: `user-${index}`,
					createdAt,
					cachedInputTokens: 1,
				})),
				{
					id: "cache-other-small",
					userId: "other-small",
					createdAt,
					cachedInputTokens: 50,
					inputTokens: 50,
				},
				{
					id: "cache-other-large",
					userId: "other-large",
					createdAt,
					cachedInputTokens: 100,
					inputTokens: 900,
				},
				{
					id: "cache-other-excluded",
					userId: "other-excluded",
					createdAt,
					cachedInputTokens: 0,
					inputTokens: 999999,
				},
			])
			.run();
		const breakdown = await service.getUsageBreakdown(filters, {
			dimension: "user",
			metric: "cacheHitRate",
		});
		expect(breakdown.total).toBeCloseTo(170 / 1120);
		expect(breakdown.entries.find((entry) => entry.label === "other")).toMatchObject({ count: 3 });
		expect(breakdown.entries.find((entry) => entry.label === "other")?.value).toBeCloseTo(
			150 / 1100,
		);
	});
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
				stacked.series
					.flatMap((item) => item.data)
					.reduce((sum, item) => sum + (item.value ?? 0), 0),
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
			stacked.series.map((entry) => entry.data.reduce((sum, point) => sum + (point.value ?? 0), 0)),
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
			stacked.series.flatMap((item) => item.data).reduce((sum, item) => sum + (item.value ?? 0), 0),
		).toBe(4);
		expect(stacked.series.find((item) => item.label === "claude-opus-4-6")?.data[0].value).toBe(2);
	});
});

describe("UsageHistoryService production worker", () => {
	test("runs all aggregates against the worker DB with the same field mapping", async () => {
		seedUsers();
		sqlite.run("UPDATE api_requests SET cached_input_tokens = 100 WHERE id = 'alice-1'");
		const directory = await mkdtemp(join(tmpdir(), "usage-history-worker-"));
		const path = join(directory, "usage.db");
		try {
			await writeFile(path, sqlite.serialize());
			const fileDb = new Database(path);
			const workerService = new UsageHistoryService(drizzle({ client: fileDb }) as typeof db);
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
			for (const dimension of ["provider", "model", "user"] as const) {
				expect(
					await workerService.getUsageBreakdown(dateFilters, { dimension, metric: "cacheHitRate" }),
				).toEqual(
					await service.getUsageBreakdown(dateFilters, { dimension, metric: "cacheHitRate" }),
				);
				expect(
					await workerService.getUsageTimeSeriesStacked(dateFilters, {
						dimension,
						metric: "cacheHitRate",
						topN: 2,
					}),
				).toEqual(
					await service.getUsageTimeSeriesStacked(dateFilters, {
						dimension,
						metric: "cacheHitRate",
						topN: 2,
					}),
				);
			}
			expect((await workerService.getUsageStats(filters)).cacheHitRate).toBe(0.5);
			expect((await workerService.listUsageHistory(filters)).total).toBe(2);
			expect(await workerService.listProviders()).toEqual(["anthropic", "codex"]);
			// Clear only the injected main-thread fixture: subsequent totals must still come from disk.
			cleanDb(sqlite);
			expect((await workerService.getUsageStats(filters)).totalRequests).toBe(2);
			expect(getDbWorkerPoolStats().workers).toBeGreaterThan(0);
			fileDb.close();
		} finally {
			shutdownDbWorkerPool();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("fails closed instead of performing a main-thread scan when workers are disabled", async () => {
		seedUsers();
		const directory = await mkdtemp(join(tmpdir(), "usage-history-worker-"));
		const fileDb = new Database(join(directory, "usage.db"));
		const original = process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER = "off";
		try {
			await expect(
				new UsageHistoryService(drizzle({ client: fileDb }) as typeof db).getUsageStats({}),
			).rejects.toMatchObject({ statusCode: 503, code: "USAGE_QUERY_UNAVAILABLE" });
		} finally {
			fileDb.close();
			await rm(directory, { recursive: true, force: true });
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
