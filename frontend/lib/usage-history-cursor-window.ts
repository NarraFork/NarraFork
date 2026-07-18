import type { UsageHistoryFilters } from "@frontend/types/usage-history";

export function currentUsageHistoryCursor(cursorStack: readonly string[]): string | undefined {
	return cursorStack.at(-1);
}

export function advanceUsageHistoryCursor(
	cursorStack: readonly string[],
	nextCursor: string | null | undefined,
): string[] {
	if (!nextCursor || currentUsageHistoryCursor(cursorStack) === nextCursor) return [...cursorStack];
	return [...cursorStack, nextCursor];
}

export function retreatUsageHistoryCursor(cursorStack: readonly string[]): string[] {
	return cursorStack.slice(0, -1);
}

export function usageHistoryListQueryKey(
	filters: UsageHistoryFilters,
	pageSize: number,
	cursor: string | undefined,
) {
	return ["usage-history", "list", filters, pageSize, cursor ?? null] as const;
}
