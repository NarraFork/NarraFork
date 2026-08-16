/**
 * Cache for per-file commit boundaries.
 *
 * {@link gitService.getLastCommitTimes} spawns a `git log` walk (~0.3 s on the NarraFork
 * repository). The Git panel refetches every 30 s per open chapter, so an uncached call
 * would put a recurring subprocess on the request path for every viewer — exactly the
 * pattern the project's main-thread rules forbid.
 *
 * Same shape as `git-status-cache` (TTL + in-flight de-duplication) with two additions
 * the boundary query needs:
 *
 *  - `headSha` is part of the key, so a commit invalidates by construction rather than by
 *    waiting out a TTL. Boundaries are *derived from* HEAD; a stale one would filter
 *    attributions against a commit that no longer bounds anything.
 *  - Entries are capped and evicted least-recently-used, because the key space grows with
 *    every distinct changed-file set, not just with the number of workspaces.
 */
import { logger } from "../lib/logger";
import { gitService } from "./git-service";
import { normalizeWorkspacePath } from "./git-workspace";

/** Boundaries resolved for one (workspace, HEAD, path set). */
export interface CommitBoundaries {
	/** Path → ISO UTC timestamp of that path's last commit. */
	byPath: Map<string, string>;
	/** Oldest commit in the walk, used for paths the walk did not resolve. */
	oldestInWindow: string | null;
}

/**
 * Freshness window.
 *
 * Only a backstop: `headSha` in the key already handles commits, and `invalidateBoundaries`
 * handles index changes. This bounds staleness for the remaining case — the working tree
 * changing without either signal firing.
 *
 * It must be LONGER than the panel's refetch interval, or the cache cannot hit in the
 * steady state: at 15 s against a 30 s refetch, every entry had always expired by the time
 * the next request arrived, so each open chapter paid for a ~0.3 s `git log --name-only`
 * every 30 s forever and the cache only ever de-duplicated concurrent viewers. Five
 * minutes is well clear of the interval while still bounding the one case the two real
 * invalidation signals do not cover.
 *
 * Staleness here is cheap and self-correcting: a boundary that is slightly old widens a
 * file's attribution window, which can only show an extra contributor, never hide one.
 */
const DEFAULT_TTL_MS = 300_000;

/**
 * Maximum retained entries.
 *
 * The key includes the path set, so a session that stages files one at a time produces a
 * new key each time. Without a cap those accumulate for the process's lifetime.
 */
const MAX_ENTRIES = 32;

interface CacheEntry {
	value: CommitBoundaries | null;
	producedAt: number;
	inflight: Promise<CommitBoundaries> | null;
}

/** Insertion-ordered, so the first key is the least recently used. */
const cache = new Map<string, CacheEntry>();

/**
 * Build the cache key.
 *
 * Paths are sorted so the same set in a different order hits the same entry; `git status`
 * ordering is not guaranteed stable across invocations. The count is included so two
 * different sets cannot collide by joining to the same string.
 */
function cacheKey(workspaceKey: string, headSha: string, paths: string[]): string {
	return `${workspaceKey}\u0000${headSha}\u0000${paths.length}\u0000${[...paths].sort().join("\u0000")}`;
}

/** Evict least-recently-used entries until the cache is within its cap. */
function evictIfNeeded(): void {
	while (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done) return;
		cache.delete(oldest.value);
	}
}

/** Mark `key` as most recently used by reinserting it at the end. */
function touch(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
}

/**
 * Resolve commit boundaries for `paths`, reusing a recent result or a concurrent query.
 *
 * Known limitation, inherited from `git-status-cache`: the key is built from
 * `normalizeWorkspacePath`, which case-folds, while `rawPath` is what git receives. On a
 * case-sensitive filesystem `/srv/WT` and `/srv/wt` are different worktrees that share one
 * cache entry, so whichever is queried first supplies boundaries for both. Keying on the
 * raw path instead would fix that and simultaneously break invalidation: `invalidateStatus`
 * and `invalidateBoundaries` are called with paths that reach them through different code
 * routes (the watcher, chapter records, tool execution), and the folded key is what makes
 * those agree today. Two worktrees whose absolute paths differ only in case is a case
 * nothing in this repository produces; silently failing to invalidate is not. Left as is
 * deliberately — change both caches together or neither.
 *
 * @param rawPath  Filesystem path to pass to git (un-normalized).
 * @param headSha  Current HEAD. Available from `GitStatusSummary.headSha`, so callers
 *                 need no extra git invocation.
 * @param paths    Repo-relative paths of interest.
 */
export async function getCommitBoundariesCached(
	rawPath: string,
	headSha: string,
	paths: string[],
	opts: { ttlMs?: number } = {},
): Promise<CommitBoundaries> {
	const workspaceKey = normalizeWorkspacePath(rawPath);
	const key = cacheKey(workspaceKey, headSha, paths);
	const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
	const now = Date.now();

	let entry = cache.get(key);

	if (entry?.value && ttl > 0 && now - entry.producedAt < ttl) {
		touch(key, entry);
		return entry.value;
	}

	// A walk is already running for this exact key — share it rather than spawning a
	// second git process for the same answer.
	if (entry?.inflight) return entry.inflight;

	if (entry) {
		// Reaching here means the entry expired and is about to be recomputed, which is
		// still a use of this key. Without the touch it kept its old position in insertion
		// order, so a repeatedly-refreshed hot key could be evicted by one-off cold keys —
		// the staged-one-file-at-a-time pattern the cap exists for.
		touch(key, entry);
	} else {
		entry = { value: null, producedAt: 0, inflight: null };
		cache.set(key, entry);
	}
	const live = entry;

	const inflight = gitService
		.getLastCommitTimes(rawPath, paths)
		.then((result) => {
			live.value = result;
			live.producedAt = Date.now();
			return result;
		})
		.catch((error) => {
			// A boundary failure must not fail the panel: an empty result means "no
			// boundaries known", which the view treats as unbounded. Showing a file's
			// full recorded history is worse than ideal but strictly better than an
			// error page, and the next refresh retries.
			logger.debug("Commit boundary lookup failed", {
				workspacePath: workspaceKey,
				error: String(error),
			});
			cache.delete(key);
			return { byPath: new Map<string, string>(), oldestInWindow: null };
		})
		.finally(() => {
			live.inflight = null;
			evictIfNeeded();
		});

	live.inflight = inflight;
	return inflight;
}

/**
 * Invalidate every cached boundary for a workspace.
 *
 * Called alongside `invalidateStatus`: staging, committing or discarding changes alters
 * which paths matter and, for a commit, where their boundaries lie.
 */
export function invalidateBoundaries(rawPath: string): void {
	const prefix = `${normalizeWorkspacePath(rawPath)}\u0000`;
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
}

/** Clear the entire cache. Used on shutdown / test teardown. */
export function clearBoundaryCache(): void {
	cache.clear();
}

/** Entry count, for tests asserting the LRU bound. */
export function boundaryCacheSize(): number {
	return cache.size;
}
