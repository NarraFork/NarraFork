import type { ExecutionLogFilters } from "@frontend/types/execution-log";

/**
 * Cursor stack for keyset pagination.
 *
 * The execution log has no offset mode (a `COUNT(*)`/OFFSET page would scan the
 * whole tool-call table), so "previous page" is implemented by remembering the
 * cursor that opened each page rather than by arithmetic on a page number.
 */
export function currentExecutionLogCursor(cursorStack: readonly string[]): string | undefined {
	return cursorStack.at(-1);
}

export function advanceExecutionLogCursor(
	cursorStack: readonly string[],
	nextCursor: string | null | undefined,
): string[] {
	if (!nextCursor || currentExecutionLogCursor(cursorStack) === nextCursor) return [...cursorStack];
	return [...cursorStack, nextCursor];
}

export function retreatExecutionLogCursor(cursorStack: readonly string[]): string[] {
	return cursorStack.slice(0, -1);
}

export function executionLogListQueryKey(
	filters: ExecutionLogFilters,
	pageSize: number,
	cursor: string | undefined,
) {
	return ["execution-log", "list", filters, pageSize, cursor ?? null] as const;
}
