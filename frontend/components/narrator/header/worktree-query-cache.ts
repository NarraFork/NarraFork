import type { WorktreeListQuery, WorktreeListResult } from "@shared/narrator-worktrees";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { ReceiptScope } from "./worktree-receipt-store";

export const WORKTREE_LIST_STALE_MS = 30_000;
export const WORKTREE_LIST_GC_MS = 60_000;

type Pages = InfiniteData<WorktreeListResult, string | undefined>;

/** Stable display-cache identity; credentials are opaque, never raw tokens in query keys. */
export function worktreeListQueryKey(
	scope: ReceiptScope,
	workspaceKey: string | undefined,
	query: WorktreeListQuery,
	credentialIdentity: number | undefined,
) {
	return [
		"narratorWorktrees",
		scope.narratorId,
		workspaceKey,
		query,
		scope.userId,
		scope.deviceId,
		scope.repositoryKey,
		credentialIdentity,
	] as const;
}

/** Retaining a first page must not make an old page fresh or erase an invalidation. */
export function retainWorktreeFirstPage(client: QueryClient, queryKey: readonly unknown[]): void {
	const state = client.getQueryState<Pages>(queryKey);
	if (!state?.data || state.data.pages.length <= 1) return;
	client.setQueryData<Pages>(
		queryKey,
		{ pages: state.data.pages.slice(0, 1), pageParams: state.data.pageParams.slice(0, 1) },
		{ updatedAt: state.dataUpdatedAt },
	);
	if (state.isInvalidated)
		void client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
}

/** Cancel before trimming, otherwise cancellation's state reversion can restore the old chain. */
export async function releaseWorktreeListPages(
	client: QueryClient,
	queryKey: readonly unknown[],
): Promise<void> {
	const query = client.getQueryCache().find({ queryKey, exact: true });
	// A second visible view still owns its expanded list; never collapse its UI.
	if (query && query.getObserversCount() > 1 && query.isActive()) return;
	await client.cancelQueries({ queryKey, exact: true });
	const current = client.getQueryCache().find({ queryKey, exact: true });
	if (current && current.getObserversCount() > 1 && current.isActive()) return;
	retainWorktreeFirstPage(client, queryKey);
}
