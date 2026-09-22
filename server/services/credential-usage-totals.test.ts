import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as relations from "@server/db/relations";
import * as schema from "@server/db/schema";
import { apiRequests, credentialUsageTotals } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { cleanDb, getTestDb } from "../../tests/setup";
import {
	deleteCredentialUsageTotals,
	getCredentialUsageTotals,
	listProviderCredentialTotals,
	recordCredentialUsage,
	roundCostForSerialization,
	serializeCredentialUsageSummary,
} from "./credential-usage-totals";

const { db, sqlite } = getTestDb();

afterEach(() => cleanDb(sqlite));

function record(overrides: Partial<Parameters<typeof recordCredentialUsage>[0]> = {}) {
	recordCredentialUsage(
		{
			provider: "codex",
			credentialId: "cred-a",
			model: "gpt-5.5",
			inputTokens: 1000,
			outputTokens: 200,
			costUsd: 0.01,
			...overrides,
		},
		db,
	);
}

describe("credential usage totals", () => {
	test("explicit free and partial zero costs remain distinguishable in durable totals", () => {
		record({ costUsd: 0, costStatus: "complete" });
		expect(getCredentialUsageTotals("codex", "cred-a", 50, db)).toMatchObject({
			costStatus: "complete",
			costUsd: 0,
			unpricedRequestCount: 0,
		});
		record({ costUsd: 0, costStatus: "partial" });
		record({ costUsd: null, costStatus: "unknown" });
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary).toMatchObject({
			costStatus: "partial",
			costUsd: 0,
			partialRequestCount: 1,
			unpricedRequestCount: 2,
			costIsPartial: true,
		});
		expect(summary.byModel[0]?.costStatus).toBe("partial");
		expect(listProviderCredentialTotals("codex", 50, db)[0]?.costStatus).toBe("partial");
	});
	test("partial amounts contribute known cost without increasing complete coverage", () => {
		record({ costUsd: 0.03, costStatus: "partial" });
		expect(getCredentialUsageTotals("codex", "cred-a", 50, db)).toMatchObject({
			costStatus: "partial",
			costUsd: 0.03,
			unpricedRequestCount: 1,
			partialRequestCount: 1,
		});
	});

	test("首次记录建立行，后续记录累加", () => {
		record({ at: "2026-07-01T00:00:00.000Z" });
		record({ at: "2026-07-02T00:00:00.000Z" });
		record({ at: "2026-07-03T00:00:00.000Z" });

		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.requestCount).toBe(3);
		expect(summary.inputTokens).toBe(3000);
		expect(summary.outputTokens).toBe(600);
		expect(summary.totalTokens).toBe(3600);
		expect(summary.costUsd).toBeCloseTo(0.03, 6);
		// firstSeenAt is the earliest sighting and must not be overwritten.
		expect(summary.firstSeenAt).toBe("2026-07-01T00:00:00.000Z");
		expect(summary.lastSeenAt).toBe("2026-07-03T00:00:00.000Z");
	});

	test("同一凭据的不同模型各自成行，汇总时相加", () => {
		record({ model: "gpt-5.5", inputTokens: 1000, costUsd: 0.01 });
		record({ model: "gpt-5.4-mini", inputTokens: 500, costUsd: 0.001 });

		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.byModel).toHaveLength(2);
		expect(summary.inputTokens).toBe(1500);
		expect(summary.costUsd).toBeCloseTo(0.011, 6);
		expect(summary.byModel.map((r) => r.model).sort()).toEqual(["gpt-5.4-mini", "gpt-5.5"]);
	});

	test("不同 provider 的同名 credentialId 不会串账", () => {
		record({ provider: "codex", credentialId: "shared-id", inputTokens: 100 });
		record({ provider: "anthropic", credentialId: "shared-id", inputTokens: 700 });

		expect(getCredentialUsageTotals("codex", "shared-id", 50, db).inputTokens).toBe(100);
		expect(getCredentialUsageTotals("anthropic", "shared-id", 50, db).inputTokens).toBe(700);
	});

	test("未定价请求被单独计数，成本标记为部分覆盖", () => {
		record({ costUsd: 0.02 });
		record({ costUsd: null });
		record({ costUsd: undefined });

		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.requestCount).toBe(3);
		expect(summary.unpricedRequestCount).toBe(2);
		expect(summary.costIsPartial).toBe(true);
		expect(summary.costUsd).toBeCloseTo(0.02, 6);
	});

	test("全部定价时 costIsPartial 为 false", () => {
		record({ costUsd: 0.01 });
		record({ costUsd: 0.02 });
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.unpricedRequestCount).toBe(0);
		expect(summary.costIsPartial).toBe(false);
	});

	test("非法/负数 token 与成本被归零，不产生负累计", () => {
		record({
			inputTokens: -100,
			outputTokens: Number.NaN,
			cachedInputTokens: Number.POSITIVE_INFINITY,
			costUsd: -5,
		});
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.inputTokens).toBe(0);
		expect(summary.outputTokens).toBe(0);
		expect(summary.cachedInputTokens).toBe(0);
		expect(summary.costUsd).toBe(0);
		expect(summary.requestCount).toBe(1);
		// -5 is not a valid cost, so the request counts as unpriced rather than as a
		// credit. The discarded cost MUST show up as unpriced: "cost 0 with full
		// coverage" would read as free instead of unknown.
		expect(summary.unpricedRequestCount).toBe(1);
		expect(summary.costIsPartial).toBe(true);
	});

	test("成本为 NaN/Infinity 时同样计入未定价，而不是静默记 0 成本", () => {
		record({ costUsd: Number.NaN });
		record({ costUsd: Number.POSITIVE_INFINITY });
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.requestCount).toBe(2);
		expect(summary.unpricedRequestCount).toBe(2);
		expect(summary.costUsd).toBe(0);
		expect(summary.costIsPartial).toBe(true);
	});

	test("缺少 provider/credentialId 时静默跳过，不建垃圾行", () => {
		record({ provider: "", credentialId: "x" });
		record({ provider: "codex", credentialId: "  " });
		const rows = db.select().from(credentialUsageTotals).all();
		expect(rows).toHaveLength(0);
	});

	test("空模型名归入 unknown 桶，而不是撞成同一空键", () => {
		record({ model: "" });
		record({ model: "   " });
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.byModel.map((r) => r.model)).toEqual(["unknown"]);
		expect(summary.requestCount).toBe(2);
	});

	test("删除叙述者会清掉明细但保留累计（核心：历史不随叙述者消失）", () => {
		db.insert(apiRequests)
			.values({
				id: "req-1",
				narratorId: null,
				kind: "narrator",
				provider: "codex",
				credentialId: "cred-a",
				model: "gpt-5.5",
				inputTokens: 1000,
				outputTokens: 200,
				costUsd: 0.01,
				createdAt: "2026-07-01T00:00:00.000Z",
			})
			.run();
		record();

		// Simulate the narrator-scoped cleanup: api_requests rows go away.
		db.delete(apiRequests).where(eq(apiRequests.credentialId, "cred-a")).run();
		expect(db.select().from(apiRequests).all()).toHaveLength(0);

		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.requestCount).toBe(1);
		expect(summary.inputTokens).toBe(1000);
	});

	test("删除凭据会清掉累计，且只影响该凭据", () => {
		record({ credentialId: "cred-a" });
		record({ credentialId: "cred-b" });

		deleteCredentialUsageTotals("codex", "cred-a", db);

		expect(getCredentialUsageTotals("codex", "cred-a", 50, db).requestCount).toBe(0);
		expect(getCredentialUsageTotals("codex", "cred-b", 50, db).requestCount).toBe(1);
	});

	test("没有记录时返回全零汇总而不是抛错", () => {
		const summary = getCredentialUsageTotals("codex", "never-used", 50, db);
		expect(summary.requestCount).toBe(0);
		expect(summary.totalTokens).toBe(0);
		expect(summary.costUsd).toBe(0);
		expect(summary.costIsPartial).toBe(false);
		expect(summary.firstSeenAt).toBeNull();
		expect(summary.byModel).toEqual([]);
	});

	test("listProviderCredentialTotals 按凭据聚合并跨模型求和", () => {
		record({ credentialId: "cred-a", model: "gpt-5.5", inputTokens: 100, costUsd: 0.01 });
		record({ credentialId: "cred-a", model: "gpt-5.4", inputTokens: 200, costUsd: 0.02 });
		record({ credentialId: "cred-b", model: "gpt-5.5", inputTokens: 300, costUsd: null });

		const entries = listProviderCredentialTotals("codex", 200, db);
		const byId = new Map(entries.map((e) => [e.credentialId, e]));

		expect(byId.get("cred-a")?.requestCount).toBe(2);
		expect(byId.get("cred-a")?.inputTokens).toBe(300);
		expect(byId.get("cred-a")?.costUsd).toBeCloseTo(0.03, 6);
		expect(byId.get("cred-a")?.costIsPartial).toBe(false);

		expect(byId.get("cred-b")?.requestCount).toBe(1);
		expect(byId.get("cred-b")?.costIsPartial).toBe(true);
	});

	test("listProviderCredentialTotals 只返回指定 provider", () => {
		record({ provider: "codex", credentialId: "c1" });
		record({ provider: "anthropic", credentialId: "k1" });

		const codexEntries = listProviderCredentialTotals("codex", 200, db);
		expect(codexEntries.map((e) => e.credentialId)).toEqual(["c1"]);
	});

	test("模型数超过 limit 时汇总仍然完整，只有 byModel 被截断并标记", () => {
		// A long-lived credential accumulates one row per distinct model string.
		// Summing only the returned `byModel` rows would undercount by 5 requests
		// here, with nothing on the wire to say so.
		for (let i = 0; i < 8; i++) {
			record({
				model: `model-${i}`,
				inputTokens: 100,
				outputTokens: 10,
				costUsd: 0.01,
				at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
			});
		}

		const summary = getCredentialUsageTotals("codex", "cred-a", 3, db);

		// byModel is capped and flagged...
		expect(summary.byModel).toHaveLength(3);
		expect(summary.byModelTruncated).toBe(true);
		// ...but every aggregate still covers all 8 models.
		expect(summary.requestCount).toBe(8);
		expect(summary.inputTokens).toBe(800);
		expect(summary.outputTokens).toBe(80);
		expect(summary.totalTokens).toBe(880);
		expect(summary.costUsd).toBeCloseTo(0.08, 6);
		// first/lastSeenAt span the full range, not just the returned window.
		expect(summary.firstSeenAt).toBe("2026-07-01T00:00:00.000Z");
		expect(summary.lastSeenAt).toBe("2026-07-08T00:00:00.000Z");
		// The truncated window keeps the most recently used models.
		expect(summary.byModel.map((r) => r.model)).toEqual(["model-7", "model-6", "model-5"]);
	});

	test("模型数未超过 limit 时 byModelTruncated 为 false", () => {
		record({ model: "gpt-5.5" });
		record({ model: "gpt-5.4" });
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.byModel).toHaveLength(2);
		expect(summary.byModelTruncated).toBe(false);
	});

	test("未定价请求在截断场景下也全部计入（* 标记不会因截断丢失）", () => {
		record({ model: "priced", costUsd: 0.5, at: "2026-07-09T00:00:00.000Z" });
		for (let i = 0; i < 5; i++) {
			// Oldest rows, so a limit of 1 excludes every unpriced model from byModel.
			record({
				model: `unpriced-${i}`,
				costUsd: null,
				at: `2026-07-0${i + 1}T00:00:00.000Z`,
			});
		}

		const summary = getCredentialUsageTotals("codex", "cred-a", 1, db);
		expect(summary.byModel.map((r) => r.model)).toEqual(["priced"]);
		expect(summary.byModelTruncated).toBe(true);
		expect(summary.unpricedRequestCount).toBe(5);
		expect(summary.costIsPartial).toBe(true);
	});

	test("cache/reasoning token 分别累加，totalTokens 不含 reasoning（避免与 output 重复计）", () => {
		record({
			inputTokens: 100,
			outputTokens: 50,
			cachedInputTokens: 900,
			cacheCreationTokens: 200,
			reasoningTokens: 30,
		});
		const summary = getCredentialUsageTotals("codex", "cred-a", 50, db);
		expect(summary.cachedInputTokens).toBe(900);
		expect(summary.cacheCreationTokens).toBe(200);
		expect(summary.reasoningTokens).toBe(30);
		// reasoning tokens are already part of the reported output count upstream.
		expect(summary.totalTokens).toBe(100 + 50 + 900 + 200);
	});
});

describe("cost rounding at the serialization boundary", () => {
	test("float 累加的长尾在序列化时被收敛到 6 位", () => {
		// 0.1 + 0.2 in binary floating point; the raw sum keeps a long tail.
		record({ model: "m", costUsd: 0.1 });
		record({ model: "m", costUsd: 0.2 });
		const raw = getCredentialUsageTotals("codex", "cred-a", 50, db);
		const wire = serializeCredentialUsageSummary(raw);

		expect(wire.costUsd).toBe(0.3);
		// The per-model row is rounded by the same rule, so the breakdown cannot
		// disagree with the aggregate on the wire.
		expect(wire.byModel[0]?.costUsd).toBe(0.3);
	});

	test("roundCostForSerialization 处理非有限值", () => {
		expect(roundCostForSerialization(Number.NaN)).toBe(0);
		expect(roundCostForSerialization(Number.POSITIVE_INFINITY)).toBe(0);
		expect(roundCostForSerialization(0.1234567891)).toBe(0.123457);
	});
});

describe("recordCredentialUsage 在写锁占用时不抛错", () => {
	// This is the SQLITE_BUSY branch. busy_timeout is 250ms by design (bun:sqlite
	// runs on the JS thread, so a multi-second wait freezes the whole server), and
	// the catch swallows the failure: the API request already succeeded, so losing
	// one rollup count beats failing the request or blocking the event loop.
	test("SQLITE_BUSY 时记录被丢弃，但调用方不受影响", () => {
		const dir = mkdtempSync(join(tmpdir(), "narrafork-usage-busy-"));
		const dbPath = join(dir, "busy.db");
		const writer = new Database(dbPath);
		const victim = new Database(dbPath);
		try {
			writer.run("PRAGMA journal_mode = WAL");
			writer.run(`CREATE TABLE credential_usage_totals (
				id text PRIMARY KEY NOT NULL,
				provider text NOT NULL,
				credential_id text NOT NULL,
				model text NOT NULL,
				request_count integer DEFAULT 0 NOT NULL,
				input_tokens integer DEFAULT 0 NOT NULL,
				output_tokens integer DEFAULT 0 NOT NULL,
				cached_input_tokens integer DEFAULT 0 NOT NULL,
				cache_creation_tokens integer DEFAULT 0 NOT NULL,
				reasoning_tokens integer DEFAULT 0 NOT NULL,
				cost_usd real DEFAULT 0 NOT NULL,
				unpriced_request_count integer DEFAULT 0 NOT NULL,
				partial_request_count integer DEFAULT 0 NOT NULL,
				first_seen_at text NOT NULL,
				last_seen_at text NOT NULL
			)`);
			writer.run(
				"CREATE UNIQUE INDEX idx_credential_usage_totals_key ON credential_usage_totals (provider, credential_id, model)",
			);

			victim.run("PRAGMA busy_timeout = 250");
			// Full schema so the instance matches the Db type recordCredentialUsage
			// takes; only credential_usage_totals actually exists in this database,
			// which is all this test touches.
			const victimDb = drizzle({ client: victim, schema: { ...schema, ...relations } });

			// A sanity write proves the connection works before the lock is taken.
			recordCredentialUsage(
				{ provider: "codex", credentialId: "cred-a", model: "gpt-5.5", inputTokens: 10 },
				victimDb,
			);
			expect(
				victim.query("SELECT count(*) as n FROM credential_usage_totals").get() as {
					n: number;
				},
			).toEqual({ n: 1 });

			// Hold an exclusive write lock from the other connection.
			writer.run("BEGIN EXCLUSIVE");
			try {
				// Must not throw even though the upsert cannot acquire the lock.
				expect(() =>
					recordCredentialUsage(
						{ provider: "codex", credentialId: "cred-a", model: "gpt-5.5", inputTokens: 999 },
						victimDb,
					),
				).not.toThrow();
			} finally {
				writer.run("ROLLBACK");
			}

			// The dropped count is the accepted trade-off: still 1 request, and the
			// blocked 999 input tokens were never added.
			const row = victim
				.query(
					"SELECT request_count as requestCount, input_tokens as inputTokens FROM credential_usage_totals",
				)
				.get() as { requestCount: number; inputTokens: number };
			expect(row.requestCount).toBe(1);
			expect(row.inputTokens).toBe(10);
		} finally {
			victim.close();
			writer.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
