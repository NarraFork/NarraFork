import { afterEach, describe, expect, test } from "bun:test";
import { apiRequests, narrators, users, userUsageTotals } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../tests/setup";
import { insertApiRequestWithUserUsage, listUserUsageTotals } from "./user-usage-totals";

const { db, sqlite } = getTestDb();
afterEach(() => cleanDb(sqlite));
const at = "2026-09-01T00:00:00.000Z";
function record(
	id: string,
	userId: string | null = "alice",
	extra: Partial<typeof apiRequests.$inferInsert> = {},
) {
	return insertApiRequestWithUserUsage(
		{ id, userId, createdAt: at, inputTokens: 100, outputTokens: 20, costUsd: 0.01, ...extra },
		db,
	);
}

describe("durable user usage", () => {
	test("unknown, partial, and explicit free costs survive rollup", () => {
		record("unknown", "alice", { costStatus: "unknown", costUsd: null });
		expect(listUserUsageTotals(50, undefined, db).records[0]?.costStatus).toBe("unknown");
		record("partial", "alice", {
			costStatus: "partial",
			costUsd: 0.02,
			costMissingFields: ["output"],
		});
		expect(listUserUsageTotals(50, undefined, db).records[0]).toMatchObject({
			costStatus: "partial",
			costUsd: 0.02,
			unpricedRequestCount: 2,
			partialRequestCount: 1,
		});
		record("free", "bob", { costStatus: "complete", costUsd: 0 });
		expect(listUserUsageTotals(50, undefined, db).records[1]).toMatchObject({
			costStatus: "complete",
			costUsd: 0,
			unpricedRequestCount: 0,
		});
	});
	test("all providers and models roll into the initiating user, never the shared narrator", () => {
		record("one", "alice", { provider: "openai" });
		record("two", "alice", {
			provider: "anthropic",
			cachedInputTokens: 30,
			cacheCreationInputTokens: 40,
			reasoningTokens: 5,
		});
		record("three", "bob", { inputTokens: 900 });
		const page = listUserUsageTotals(50, undefined, db);
		expect(page.records.map((r) => [r.userId, r.requestCount, r.inputTokens])).toEqual([
			["alice", 2, 200],
			["bob", 1, 900],
		]);
		expect(page.records[0]).toMatchObject({
			cachedInputTokens: 30,
			cacheCreationTokens: 40,
			reasoningTokens: 5,
			costUsd: 0.02,
		});
	});
	test("duplicate completion is idempotent even if its supplied user changes", () => {
		expect(record("one")).toBe(true);
		expect(record("one", "bob")).toBe(false);
		expect(listUserUsageTotals(50, undefined, db).records).toHaveLength(1);
		expect(listUserUsageTotals(50, undefined, db).records[0]?.requestCount).toBe(1);
	});
	test("unknown legacy/system identity stays in detail, not assigned to a user", () => {
		record("one", null);
		expect(db.select().from(apiRequests).get()?.userId).toBeNull();
		expect(listUserUsageTotals(50, undefined, db).records).toEqual([]);
	});
	test("unknown cost is counted explicitly; known zero cost is not unpriced", () => {
		record("one", "alice", { costUsd: null });
		record("two", "alice", { costUsd: 0 });
		record("three", "alice", { costUsd: 0.02 });
		expect(listUserUsageTotals(50, undefined, db).records[0]).toMatchObject({
			requestCount: 3,
			unpricedRequestCount: 1,
			costUsd: 0.02,
		});
	});
	test("out-of-order completion preserves earliest and latest times", () => {
		record("later", "alice", { createdAt: "2026-09-03T00:00:00.000Z" });
		record("earlier");
		expect(listUserUsageTotals(50, undefined, db).records[0]).toMatchObject({
			firstUsedAt: at,
			lastUsedAt: "2026-09-03T00:00:00.000Z",
		});
	});
	test("narrator cleanup and user deletion do not erase attribution totals", () => {
		db.insert(users)
			.values({ id: "alice", username: "Alice", passwordHash: "test", createdAt: at })
			.run();
		db.insert(narrators).values({ id: "n", createdAt: at, updatedAt: at }).run();
		record("one", "alice", { narratorId: "n" });
		expect(listUserUsageTotals(50, undefined, db).records[0]?.username).toBe("Alice");
		db.delete(narrators).where(eq(narrators.id, "n")).run();
		expect(db.select().from(apiRequests).all()).toHaveLength(0);
		db.delete(users).where(eq(users.id, "alice")).run();
		expect(listUserUsageTotals(50, undefined, db).records[0]).toMatchObject({
			userId: "alice",
			username: null,
			requestCount: 1,
		});
	});
	test("cursor pagination is bounded and deterministic", () => {
		for (const userId of ["charlie", "alice", "bob"]) record(userId, userId);
		const first = listUserUsageTotals(2, undefined, db);
		expect(first.records.map((r) => r.userId)).toEqual(["alice", "bob"]);
		expect(first.hasMore).toBe(true);
		const second = listUserUsageTotals(2, first.nextCursor ?? undefined, db);
		expect(second.records.map((r) => r.userId)).toEqual(["charlie"]);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeNull();
		expect(listUserUsageTotals(1e6, undefined, db).limit).toBe(100);
		expect(listUserUsageTotals(Number.NaN, undefined, db).limit).toBe(50);
	});
	test("rollup failure rolls back detail so a retry can safely finish", () => {
		sqlite.run(
			"CREATE TRIGGER reject_user_usage BEFORE INSERT ON user_usage_totals BEGIN SELECT RAISE(ABORT, 'test failure'); END",
		);
		try {
			expect(() => record("one")).toThrow();
			expect(db.select().from(apiRequests).all()).toHaveLength(0);
			expect(db.select().from(userUsageTotals).all()).toHaveLength(0);
		} finally {
			sqlite.run("DROP TRIGGER reject_user_usage");
		}
		expect(record("one")).toBe(true);
	});
	test("user/time index serves filtered history", () => {
		const plan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id FROM api_requests WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 51",
			)
			.all("alice");
		expect(JSON.stringify(plan)).toContain("idx_api_requests_user_created");
	});
});
