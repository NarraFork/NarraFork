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
import { type GitStatusSummary, gitService } from "./git-service";
import { normalizeWorkspacePath } from "./git-workspace";

/** How long a cached status is considered fresh (ms). */
const DEFAULT_TTL_MS = 800;

interface CacheEntry {
	/** Resolved status, or null while the first query is in flight. */
	value: GitStatusSummary | null;
	/** Epoch ms when `value` was produced. */
	producedAt: number;
	/** Shared in-flight promise so concurrent callers don't duplicate work. */
	inflight: Promise<GitStatusSummary> | null;
}

const cache = new Map<string, CacheEntry>();

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
		return entry.value;
	}

	// A query is already running — share it
	if (entry?.inflight) {
		return entry.inflight;
	}

	if (!entry) {
		entry = { value: null, producedAt: 0, inflight: null };
		cache.set(key, entry);
	}

	const inflight = gitService
		.getStatusSummary(rawPath)
		.then((summary) => {
			entry.value = summary;
			entry.producedAt = Date.now();
			return summary;
		})
		.finally(() => {
			entry.inflight = null;
		});

	entry.inflight = inflight;
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
	const key = normalizeWorkspacePath(rawPath);
	const entry = cache.get(key);
	if (!entry) return;
	// Keep any in-flight promise (its result is still wanted) but mark stale.
	entry.value = null;
	entry.producedAt = 0;
}

/** Drop a path's cache entry entirely (e.g. worktree removed). */
export function dropStatus(rawPath: string): void {
	cache.delete(normalizeWorkspacePath(rawPath));
}

/** Clear the entire cache. Used on shutdown / test teardown. */
export function clearStatusCache(): void {
	cache.clear();
}

logger.debug("git-status-cache initialized", { ttlMs: DEFAULT_TTL_MS });
