/** Legacy local facade; the query coordinator owns results and query lifecycles. */
import { eventBus } from "../lib/event-bus";
import { invalidateBoundaries } from "./git-commit-boundary-cache";
import { gitDiscoveryCache } from "./git-discovery-cache";
import {
	clearGitLineStatsCache,
	dropLocalGitLineStats,
	invalidateLocalGitLineStats,
} from "./git-line-stats-cache";
import { type GitStatusSummary, gitService, withGitRequestContext } from "./git-service";
import {
	clearGitStatusQueries,
	dropLocalGitStatusQueries,
	GIT_QUERY_CACHE_MAX_ENTRIES,
	getLocalGitStatusQueryKey,
	gitStatusQueryCacheSize,
	invalidateLocalGitStatusQueries,
	peekGitStatusQuery,
} from "./git-status-query";
import { normalizeWorkspacePath } from "./git-workspace";

export async function getStatusSummaryCached(
	rawPath: string,
	opts: { ttlMs?: number; signal?: AbortSignal } = {},
): Promise<GitStatusSummary> {
	opts.signal?.throwIfAborted();
	const read = () => gitService.getStatusSummary(rawPath, { ttlMs: opts.ttlMs });
	return opts.signal ? withGitRequestContext(opts.signal, read) : read();
}

/** Includes the last known result even when dirty; never triggers work. */
export function peekStatusSummary(rawPath: string): GitStatusSummary | null {
	return peekGitStatusQuery(getLocalGitStatusQueryKey(rawPath));
}

function invalidateLocalMetadata(rawPath: string): void {
	invalidateBoundaries(rawPath);
	gitDiscoveryCache.invalidate(
		"local",
		rawPath,
		undefined,
		(a, b) => normalizeWorkspacePath(a) === normalizeWorkspacePath(b),
	);
}

/** A tool may have written: keep lazy facts fresh without discarding verified page snapshots. */
export function markStatusDirty(rawPath: string): void {
	invalidateLocalGitLineStats(rawPath);
	invalidateLocalGitStatusQueries(rawPath);
	invalidateLocalMetadata(rawPath);
}

/** Publish once, after all working-tree-derived caches have been invalidated. */
export function invalidateStatus(rawPath: string): void {
	markStatusDirty(rawPath);
	eventBus.emit({
		type: "git:workspace_invalidated",
		queryKey: getLocalGitStatusQueryKey(rawPath),
	});
}

/** Destroyed worktrees must not retain their last result. */
export function dropStatus(rawPath: string): void {
	dropLocalGitLineStats(rawPath);
	dropLocalGitStatusQueries(rawPath);
	invalidateLocalMetadata(rawPath);
}

export function clearStatusCache(): void {
	clearGitLineStatsCache();
	clearGitStatusQueries();
}

export const statusCacheSize = gitStatusQueryCacheSize;
export const STATUS_CACHE_MAX_ENTRIES = GIT_QUERY_CACHE_MAX_ENTRIES;
