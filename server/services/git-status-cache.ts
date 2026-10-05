/**
 * Shared git status cache.
 *
 * Multiple narrators (and subagents) may share the same working directory.
 * Without coordination, each one independently runs `getStatusSummary`
 * (6 parallel git commands + untracked line-stat scans), which is wasteful
 * and can hammer the same `.git` on every file-change event.
 *
 * This cache is keyed by *normalized workspace path* and provides:
 *   - short-TTL caching of the last status result
 *   - in-flight de-duplication (concurrent callers share one git query)
 *   - explicit invalidation hooks for the watcher / tool execution
 *
 * It deliberately holds no chapter/narrator state — callers map a path to
 * subscribers themselves. Follows the main-thread performance rules: every
 * query is small, bounded, and short-lived.
 */
import { logger } from "../lib/logger";
import { invalidateBoundaries } from "./git-commit-boundary-cache";
import { gitDiscoveryCache } from "./git-discovery-cache";
import { type GitStatusSummary, gitService } from "./git-service";
import { normalizeWorkspacePath } from "./git-workspace";

/** How long a cached status is considered fresh (ms). */
const DEFAULT_TTL_MS = 800;

/**
 * Maximum retained entries.
 *
 * `dropStatus` removes a worktree's entry at each of the three sites that destroy one, so
 * in normal operation the map tracks live worktrees and stays small. This is the backstop
 * for the paths that are not a clean destroy: a directory removed outside NarraFork, a
 * chapter whose cleanup failed partway, or any future caller that queries a transient path
 * and never announces its end. Each entry holds a `GitStatusSummary` with up to 200
 * `GitStatusFile` records, so an unbounded map is a slow leak rather than a trivial one.
 *
 * Eviction is safe by construction: an entry is a cache of a value that can always be
 * recomputed from git, so losing one costs a query and never correctness. Sized well above
 * any plausible number of simultaneously active worktrees, so a real workload is never
 * evicting the entries it is about to reuse.
 *
 * Matches `git-commit-boundary-cache`'s approach, which caps for the same reason. The two
 * numbers differ because the key spaces do: boundaries are keyed by (workspace, HEAD, path
 * set) and churn with every staging change, while this is keyed by workspace alone.
 */
const MAX_ENTRIES = 128;

interface CacheEntry {
	/** Resolved status, or null while the first query is in flight. */
	value: GitStatusSummary | null;
	/** Epoch ms when `value` was produced. */
	producedAt: number;
	/** Shared in-flight promise so concurrent callers don't duplicate work. */
	inflight: Promise<GitStatusSummary> | null;
}

/** Insertion-ordered, so the first key is the least recently used. */
const cache = new Map<string, CacheEntry>();

/**
 * Evict least-recently-used entries until the cache is within its cap.
 *
 * An entry with a query in flight is never evicted: its promise is what concurrent callers
 * are waiting on, and dropping the entry would let the next caller start a second git
 * process for the same answer while the first is still running.
 */
function evictIfNeeded(): void {
	if (cache.size <= MAX_ENTRIES) return;
	for (const [key, entry] of cache) {
		if (cache.size <= MAX_ENTRIES) return;
		if (entry.inflight) continue;
		cache.delete(key);
	}
}

/** Mark `key` as most recently used by reinserting it at the end. */
function touch(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
}

/**
 * Get a git status summary for `rawPath`, reusing a recent cached result or a
 * concurrent in-flight query when possible.
 *
 * @param rawPath  Filesystem path to pass to git (un-normalized).
 * @param opts.ttlMs  Override freshness window. Pass 0 to force a refresh.
 */
export async function getStatusSummaryCached(
	rawPath: string,
	opts: { ttlMs?: number } = {},
): Promise<GitStatusSummary> {
	const key = normalizeWorkspacePath(rawPath);
	const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
	const now = Date.now();

	let entry = cache.get(key);

	// Fresh cached value
	if (entry?.value && ttl > 0 && now - entry.producedAt < ttl) {
		touch(key, entry);
		return entry.value;
	}

	// A query is already running — share it
	if (entry?.inflight) {
		return entry.inflight;
	}

	if (entry) {
		// An expired entry that is about to be recomputed is still a USE of this key.
		// Without the touch it keeps its old position, so a workspace being polled every
		// 30 s could be evicted by one-off cold paths — the opposite of what the cap is for.
		touch(key, entry);
	} else {
		entry = { value: null, producedAt: 0, inflight: null };
		cache.set(key, entry);
	}
	const live = entry;

	const inflight = gitService
		.getStatusSummary(rawPath)
		.then((summary) => {
			live.value = summary;
			live.producedAt = Date.now();
			return summary;
		})
		.catch((error) => {
			// A failed query must not leave a polluted entry in the cache. Without this,
			// `live.value` stays null / `producedAt` stays 0, making every subsequent caller
			// see an expired entry and re-trigger git — a thundering-herd on a workspace
			// whose git is broken or timing out. Deleting the entry lets the next caller
			// start fresh with a clean slot (and hit the cold path, which is correct).
			// Mirrors the pattern in git-commit-boundary-cache.ts.
			logger.debug("Status query failed, evicting cache entry", {
				workspacePath: key,
				error: String(error),
			});
			cache.delete(key);
			throw error;
		})
		.finally(() => {
			live.inflight = null;
			// Evicted after the query settles, never before: while `inflight` is set the
			// entry is what concurrent callers are sharing.
			evictIfNeeded();
		});

	live.inflight = inflight;
	return inflight;
}

/**
 * Read the last cached status without triggering a query.
 * Returns null when nothing is cached.
 */
export function peekStatusSummary(rawPath: string): GitStatusSummary | null {
	return cache.get(normalizeWorkspacePath(rawPath))?.value ?? null;
}

/**
 * Invalidate the cached status for a path, forcing the next read to refresh.
 * Call this after a write operation (commit, stage, discard) or on file change.
 */
export function invalidateStatus(rawPath: string): void {
	// Commit boundaries are derived from the same working tree, so they go stale on
	// exactly the events that invalidate a status. Invalidating both here — rather than
	// asking every call site to remember a second function — is what keeps them from
	// drifting apart. Synchronous on purpose: a deferred invalidation would leave a
	// window in which a refetch could still read boundaries from the old HEAD.
	invalidateBoundaries(rawPath);
	gitDiscoveryCache.invalidate(
		"local",
		rawPath,
		undefined,
		(a, b) => normalizeWorkspacePath(a) === normalizeWorkspacePath(b),
	);

	const key = normalizeWorkspacePath(rawPath);
	const entry = cache.get(key);
	if (!entry) return;
	// Keep any in-flight promise (its result is still wanted) but mark stale.
	entry.value = null;
	entry.producedAt = 0;
}

/**
 * Drop a path's cache entry entirely — for when the worktree itself is gone.
 *
 * `invalidateStatus` is not a substitute: it nulls the value but keeps the key, precisely
 * because the path is expected to come back. Once the directory is destroyed nothing can
 * read the entry again, so keeping the key leaks it (this Map is uncapped and each entry
 * holds up to 200 `GitStatusFile` records) for the process's lifetime.
 *
 * Called from the three places that destroy a worktree, alongside their existing
 * `worktreeTreeSnapshot.destroy` call for the same reason — a per-path resource that
 * becomes unreachable once the directory is gone:
 *   - `chapter-service.ts` → `remove`
 *   - `chapter-service.ts` → `removeForProjectDeletion`
 *   - `storage-service.ts` → `cleanupOrphanedWorktrees`
 *
 * Boundaries need the same treatment, and `invalidateBoundaries` already deletes its keys,
 * so one `dropStatus` call at each site covers both caches.
 */
export function dropStatus(rawPath: string): void {
	invalidateBoundaries(rawPath);
	gitDiscoveryCache.invalidate(
		"local",
		rawPath,
		undefined,
		(a, b) => normalizeWorkspacePath(a) === normalizeWorkspacePath(b),
	);
	cache.delete(normalizeWorkspacePath(rawPath));
}

/** Clear the entire cache. Used on shutdown / test teardown. */
export function clearStatusCache(): void {
	cache.clear();
}

/** Entry count, for tests asserting the LRU bound. */
export function statusCacheSize(): number {
	return cache.size;
}

/** The cap itself, so a test cannot drift from the value it is checking. */
export const STATUS_CACHE_MAX_ENTRIES = MAX_ENTRIES;

logger.debug("git-status-cache initialized", { ttlMs: DEFAULT_TTL_MS, maxEntries: MAX_ENTRIES });
