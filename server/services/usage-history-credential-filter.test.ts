import { afterEach, describe, expect, test } from "bun:test";
import { apiRequests } from "@server/db/schema";
import { cleanDb, getTestDb } from "../../tests/setup";
import { UsageHistoryService } from "./usage-history-service";

const { db, sqlite } = getTestDb();
const service = new UsageHistoryService(db);

afterEach(() => cleanDb(sqlite));

function seed() {
	db.insert(apiRequests)
		.values([
			{
				id: "req-a1",
				kind: "narrator",
				provider: "codex",
				credentialId: "cred-a",
				model: "gpt-5.5",
				inputTokens: 1000,
				outputTokens: 100,
				costUsd: 0.01,
				createdAt: "2026-07-01T00:00:00.000Z",
			},
			{
				id: "req-a2",
				kind: "narrator",
				provider: "codex",
				credentialId: "cred-a",
				model: "gpt-5.5",
				inputTokens: 2000,
				outputTokens: 200,
				costUsd: 0.02,
				createdAt: "2026-07-02T00:00:00.000Z",
			},
			{
				id: "req-b1",
				kind: "narrator",
				provider: "codex",
				credentialId: "cred-b",
				model: "gpt-5.4",
				inputTokens: 4000,
				outputTokens: 400,
				costUsd: 0.04,
				createdAt: "2026-07-03T00:00:00.000Z",
			},
			{
				id: "req-none",
				kind: "narrator",
				provider: "anthropic",
				credentialId: null,
				model: "claude-opus-4-6",
				inputTokens: 8000,
				outputTokens: 800,
				costUsd: 0.08,
				createdAt: "2026-07-04T00:00:00.000Z",
			},
		])
		.run();
}

describe("usage history credential filter", () => {
	test("按 credentialId 过滤列表", async () => {
		seed();
		const result = await service.listUsageHistoryCursor({ credentialId: "cred-a" }, 50);
		expect(result.records.map((r) => r.id).sort()).toEqual(["req-a1", "req-a2"]);
	});

	test("按 credentialId 过滤统计", async () => {
		seed();
		const stats = await service.getUsageStats({ credentialId: "cred-a" });
		expect(stats.totalRequests).toBe(2);
		expect(stats.totalInputTokens).toBe(3000);
		expect(stats.totalOutputTokens).toBe(300);
		expect(stats.totalCost).toBeCloseTo(0.03, 6);
	});

	test("credentialId 与 provider 过滤可叠加", async () => {
		seed();
		const stats = await service.getUsageStats({ provider: "codex", credentialId: "cred-b" });
		expect(stats.totalRequests).toBe(1);
		expect(stats.totalInputTokens).toBe(4000);
	});

	test("credentialId 与 provider 矛盾时返回空结果", async () => {
		seed();
		const stats = await service.getUsageStats({ provider: "anthropic", credentialId: "cred-a" });
		expect(stats.totalRequests).toBe(0);
	});

	test("credentialId 是精确匹配，不做前缀/子串匹配", async () => {
		seed();
		// "cred" is a prefix of both cred-a and cred-b; a LIKE filter would match
		// them and also mean an index-less table scan.
		const stats = await service.getUsageStats({ credentialId: "cred" });
		expect(stats.totalRequests).toBe(0);
	});

	test("未指定 credentialId 时统计包含无凭据的请求", async () => {
		seed();
		const stats = await service.getUsageStats({});
		expect(stats.totalRequests).toBe(4);
	});

	test("时间序列同样受 credentialId 约束", async () => {
		seed();
		const series = await service.getUsageTimeSeries(
			{
				credentialId: "cred-a",
				startDate: "2026-07-01T00:00:00.000Z",
				endDate: "2026-07-04T23:59:59.999Z",
			},
			{ granularity: "day" },
		);
		const total = series.points.reduce((sum, point) => sum + point.requestCount, 0);
		expect(total).toBe(2);
	});

	test("空白 credentialId 被忽略，不会过滤掉所有结果", async () => {
		seed();
		const stats = await service.getUsageStats({ credentialId: "   " });
		expect(stats.totalRequests).toBe(4);
	});
});

describe("usage history model filter", () => {
	test("model 是子串匹配（UI 是自由文本框，用户依赖部分模型名）", async () => {
		seed();
		// "gpt-5" matches both gpt-5.5 rows and the gpt-5.4 row.
		const stats = await service.getUsageStats({ model: "gpt-5" });
		expect(stats.totalRequests).toBe(3);

		// A mid-string fragment works too — this is the semantic being preserved.
		const opus = await service.getUsageStats({ model: "opus" });
		expect(opus.totalRequests).toBe(1);
	});

	test("LIKE 通配符被转义，用户输入的 % 不会匹配任意内容", async () => {
		seed();
		// Unescaped, "%" would match every row. Escaped, it is a literal that no
		// model name contains.
		expect((await service.getUsageStats({ model: "%" })).totalRequests).toBe(0);
		// "_" is LIKE's single-char wildcard; "gpt_5.5" must not match "gpt-5.5".
		expect((await service.getUsageStats({ model: "gpt_5.5" })).totalRequests).toBe(0);
		// The literal name still matches, so escaping did not break normal input.
		expect((await service.getUsageStats({ model: "gpt-5.5" })).totalRequests).toBe(2);
	});

	test("过长的 model 过滤被截断，不产生超长 LIKE 模式", async () => {
		seed();
		// 128-char cap: a 300-char needle is cut, and since no model contains the
		// truncated prefix the result is empty rather than an error.
		const stats = await service.getUsageStats({ model: "x".repeat(300) });
		expect(stats.totalRequests).toBe(0);
	});

	test("空白 model 被忽略", async () => {
		seed();
		expect((await service.getUsageStats({ model: "   " })).totalRequests).toBe(4);
	});
});
