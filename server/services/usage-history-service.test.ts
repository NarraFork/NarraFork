import { afterEach, describe, expect, test } from "bun:test";
import { apiRequests } from "@server/db/schema";
import { decodeUsageHistoryCursor } from "@server/lib/usage-history-cursor";
import { cleanDb, getTestDb } from "../../tests/setup";
import { UsageHistoryService } from "./usage-history-service";

const { db, sqlite } = getTestDb();
const service = new UsageHistoryService(db);

const createdAt = "2026-07-17T12:00:00.000Z";

afterEach(() => cleanDb(sqlite));

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
});
