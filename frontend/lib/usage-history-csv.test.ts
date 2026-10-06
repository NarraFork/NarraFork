import { describe, expect, test } from "bun:test";
import type { UsageHistoryRecord } from "@frontend/types/usage-history";
import { usageHistoryCsv } from "./usage-history-csv";

function record(ownership: Pick<UsageHistoryRecord, "userId" | "username">): UsageHistoryRecord {
	return {
		id: "request-1",
		narratorId: null,
		kind: "narrator",
		provider: "openai",
		credentialId: null,
		credentialName: null,
		model: "model",
		inputTokens: 10,
		outputTokens: 5,
		cachedInputTokens: 2,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		reasoningTokens: 0,
		ttftMs: null,
		durationMs: null,
		costUsd: null,
		contextPercent: null,
		meterUsage: null,
		meterUnit: null,
		createdAt: "2026-09-08T00:00:00Z",
		...ownership,
	};
}

describe("usage CSV ownership", () => {
	test("includes stable user IDs, names, deleted IDs and translated unattributed rows", () => {
		const csv = usageHistoryCsv(
			[
				record({ userId: "alice-id", username: "Alice" }),
				record({ userId: "deleted-id", username: null }),
				record({ userId: null, username: null }),
			],
			"未归属",
		);
		const rows = csv.split("\n").map((row) => row.split(","));
		expect(rows[0].slice(0, 3)).toEqual(["Time", "User ID", "User"]);
		expect(rows[1].slice(1, 3)).toEqual(["alice-id", "Alice"]);
		expect(rows[2].slice(1, 3)).toEqual(["deleted-id", "deleted-id"]);
		expect(rows[3].slice(1, 3)).toEqual(["", "未归属"]);
		expect(rows).toHaveLength(4);
	});

	test("escapes labels and prevents user-controlled spreadsheet formulas", () => {
		expect(usageHistoryCsv([record({ username: 'Alice,"A"' })], "Unattributed")).toContain(
			'"Alice,""A"""',
		);
		expect(usageHistoryCsv([record({ username: "=1+2" })], "Unattributed")).toContain("'=1+2");
		expect(usageHistoryCsv([record({})], "Unattributed")).toContain(",,Unattributed,");
	});
});

test("CSV preserves unknown and partial reference cost instead of exporting free usage", () => {
	const unknown = {
		...record({}),
		costUsd: 0,
		costStatus: "unknown" as const,
		costMissingFields: ["input", "output"],
	};
	const partial = { ...record({}), costUsd: 0.25, costStatus: "partial" as const };
	const free = { ...record({}), costUsd: 0, costStatus: "complete" as const };
	const [headers, ...rows] = usageHistoryCsv([unknown, partial, free], "Unattributed")
		.split("\n")
		.map((row) => row.split(","));
	const costIndex = headers.indexOf("Known Reference Cost (USD)");
	const statusIndex = headers.indexOf("Cost Status");
	expect(rows[0][costIndex]).toBe("");
	expect(rows[0][statusIndex]).toBe("unknown");
	expect(rows[1][costIndex]).toBe("0.25");
	expect(rows[1][statusIndex]).toBe("partial");
	expect(rows[2][costIndex]).toBe("0");
	expect(rows[2][statusIndex]).toBe("complete");
});
