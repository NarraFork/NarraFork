import { describe, expect, test } from "bun:test";
import {
	advanceUsageHistoryCursor,
	currentUsageHistoryCursor,
	retreatUsageHistoryCursor,
	usageHistoryListQueryKey,
} from "./usage-history-cursor-window";

describe("usage history cursor window", () => {
	test("moves forward and backward without retaining rendered pages", () => {
		const firstPage: string[] = [];
		const secondPage = advanceUsageHistoryCursor(firstPage, "cursor-2");
		const thirdPage = advanceUsageHistoryCursor(secondPage, "cursor-3");

		expect(currentUsageHistoryCursor(firstPage)).toBeUndefined();
		expect(currentUsageHistoryCursor(secondPage)).toBe("cursor-2");
		expect(currentUsageHistoryCursor(thirdPage)).toBe("cursor-3");
		expect(retreatUsageHistoryCursor(thirdPage)).toEqual(["cursor-2"]);
		expect(retreatUsageHistoryCursor(secondPage)).toEqual([]);
	});

	test("does not append an empty or duplicate next cursor", () => {
		expect(advanceUsageHistoryCursor(["cursor-2"], null)).toEqual(["cursor-2"]);
		expect(advanceUsageHistoryCursor(["cursor-2"], "cursor-2")).toEqual(["cursor-2"]);
	});

	test("isolates users and unattributed requests in the cursor cache", () => {
		const alice = usageHistoryListQueryKey({ userId: "alice" }, 50, undefined);
		expect(alice).not.toEqual(usageHistoryListQueryKey({ userId: "bob" }, 50, undefined));
		expect(alice).not.toEqual(
			usageHistoryListQueryKey({ userId: "__unattributed__" }, 50, undefined),
		);
		expect(alice).not.toEqual(usageHistoryListQueryKey({}, 50, undefined));
	});

	test("isolates cached pages by filters, page size, and current cursor", () => {
		expect(usageHistoryListQueryKey({ provider: "openai" }, 50, "cursor-2")).not.toEqual(
			usageHistoryListQueryKey({ provider: "anthropic" }, 50, "cursor-2"),
		);
		expect(usageHistoryListQueryKey({ provider: "openai" }, 50, "cursor-2")).not.toEqual(
			usageHistoryListQueryKey({ provider: "openai" }, 100, "cursor-2"),
		);
		expect(usageHistoryListQueryKey({ provider: "openai" }, 50, "cursor-2")).not.toEqual(
			usageHistoryListQueryKey({ provider: "openai" }, 50, "cursor-3"),
		);
	});
});
