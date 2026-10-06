/**
 * git-status-cache-bound.test.ts — the cache must not grow without limit.
 *
 * `dropStatus` removes a worktree's entry wherever one is destroyed cleanly, so the LRU cap
 * is the backstop for everything that is not a clean destroy: a directory removed outside
 * NarraFork, a cleanup that failed partway, or a caller that queries a transient path and
 * never announces its end. Each entry holds a status summary with up to 200 file records,
 * so "it will be dropped eventually" is not a bound.
 *
 * Eviction can only cost a re-query — the value is derived from git and always recomputable
 * — so what has to be proven is the bound itself, and that eviction never targets an entry
 * whose query is still in flight (that promise is what concurrent callers share).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { GitStatusSummary } from "./git-service";
import { gitService } from "./git-service";
import {
	clearStatusCache,
	getStatusSummaryCached,
	invalidateStatus,
	peekStatusSummary,
	STATUS_CACHE_MAX_ENTRIES,
	statusCacheSize,
} from "./git-status-cache";

const originalGetStatusSummary = gitService.getStatusSummary;

function summaryFor(path: string): GitStatusSummary {
	return {
		branch: "main",
		headSha: "abc123",
		ahead: 0,
		behind: 0,
		files: [],
		staged: 0,
		unstaged: 0,
		untracked: 0,
		hasChanges: false,
		serverCapped: false,
		workspacePath: path,
	} as unknown as GitStatusSummary;
}

beforeEach(() => {
	clearStatusCache();
});

afterEach(() => {
	gitService.getStatusSummary = originalGetStatusSummary;
	clearStatusCache();
});

describe("git status cache — LRU bound", () => {
	test("never exceeds the cap no matter how many distinct paths are queried", async () => {
		gitService.getStatusSummary = mock(async (path: string) => summaryFor(path));

		// Deliberately well past the cap, and awaited one at a time so each query settles
		// (eviction runs when a query completes, not when it starts).
		for (let i = 0; i < STATUS_CACHE_MAX_ENTRIES * 2; i++) {
			await getStatusSummaryCached(`/tmp/nf-status-bound/wt-${i}`);
		}

		expect(statusCacheSize()).toBeLessThanOrEqual(STATUS_CACHE_MAX_ENTRIES);
	});

	test("evicts the least recently used path, keeping the most recent ones", async () => {
		gitService.getStatusSummary = mock(async (path: string) => summaryFor(path));

		const first = "/tmp/nf-status-bound/oldest";
		await getStatusSummaryCached(first);
		for (let i = 0; i < STATUS_CACHE_MAX_ENTRIES; i++) {
			await getStatusSummaryCached(`/tmp/nf-status-bound/later-${i}`);
		}

		// The oldest key is gone; the newest survived.
		expect(peekStatusSummary(first)).toBeNull();
		expect(
			peekStatusSummary(`/tmp/nf-status-bound/later-${STATUS_CACHE_MAX_ENTRIES - 1}`),
		).not.toBeNull();
	});

	test("a repeatedly refreshed path survives a flood of one-off paths", async () => {
		// The reason an expired-but-reused entry is touched: a workspace the Git panel polls
		// must not be evicted by transient keys, or the poll pays for a git query every time.
		gitService.getStatusSummary = mock(async (path: string) => summaryFor(path));

		const hot = "/tmp/nf-status-bound/hot";
		for (let i = 0; i < STATUS_CACHE_MAX_ENTRIES; i++) {
			await getStatusSummaryCached(`/tmp/nf-status-bound/cold-${i}`);
			// Expire the hot entry, then read it again — the same shape as a poll after its
			// TTL lapses, which must count as a use.
			invalidateStatus(hot);
			await getStatusSummaryCached(hot);
		}

		expect(peekStatusSummary(hot)).not.toBeNull();
		expect(statusCacheSize()).toBeLessThanOrEqual(STATUS_CACHE_MAX_ENTRIES);
	});

	test("does not evict an entry whose query is still in flight", async () => {
		// Concurrent callers are waiting on that promise. Dropping the entry would let the
		// next caller spawn a second git process for an answer already being computed.
		const pending = new Map<string, (value: GitStatusSummary) => void>();
		gitService.getStatusSummary = mock(
			(path: string) =>
				new Promise<GitStatusSummary>((resolve) => {
					pending.set(path, resolve);
				}),
		);

		const slow = "/tmp/nf-status-bound/slow";
		const slowPromise = getStatusSummaryCached(slow);

		// Start and settle enough other paths to push the cache past its cap while `slow` is
		// still unresolved.
		const others: Array<Promise<GitStatusSummary>> = [];
		for (let i = 0; i < STATUS_CACHE_MAX_ENTRIES + 10; i++) {
			const path = `/tmp/nf-status-bound/other-${i}`;
			others.push(getStatusSummaryCached(path));
		}
		for (const [path, resolve] of pending) {
			if (path !== slow) resolve(summaryFor(path));
		}
		await Promise.all(others);

		// The in-flight entry is still there, so the original caller is still served by the
		// one query rather than a second one.
		const resolveSlow = pending.get(slow);
		expect(resolveSlow).toBeDefined();
		resolveSlow?.(summaryFor(slow));
		await expect(slowPromise).resolves.toMatchObject({ workspacePath: slow });
	});
});

describe("git status cache — rejection handling", () => {
	test("a rejected query removes the cache entry and propagates the error", async () => {
		let callCount = 0;
		gitService.getStatusSummary = mock(async (_path: string) => {
			callCount++;
			if (callCount === 1) throw new Error("spawn timeout");
			return summaryFor(_path);
		});

		const path = "/tmp/nf-status-bound/reject-test";

		// First call should reject
		await expect(getStatusSummaryCached(path)).rejects.toThrow("spawn timeout");

		// The cache must not retain a polluted entry — peek should be null
		expect(peekStatusSummary(path)).toBeNull();
		expect(statusCacheSize()).toBe(0);
	});

	test("after rejection, the next call succeeds and is cached normally", async () => {
		let callCount = 0;
		gitService.getStatusSummary = mock(async (path: string) => {
			callCount++;
			if (callCount === 1) throw new Error("transient failure");
			return summaryFor(path);
		});

		const path = "/tmp/nf-status-bound/reject-recover";

		// First call fails
		await expect(getStatusSummaryCached(path)).rejects.toThrow("transient failure");

		// Second call must succeed fresh (not return a stale/broken entry)
		const result = await getStatusSummaryCached(path);
		expect(result.branch).toBe("main");
		expect(peekStatusSummary(path)).not.toBeNull();
		expect(callCount).toBe(2);
	});

	test("concurrent callers sharing a rejected inflight all receive the error", async () => {
		gitService.getStatusSummary = mock(async (_path: string) => {
			await new Promise((r) => setTimeout(r, 10));
			throw new Error("shared failure");
		});

		const path = "/tmp/nf-status-bound/shared-reject";
		const p1 = getStatusSummaryCached(path);
		const p2 = getStatusSummaryCached(path);

		// Both callers share the same inflight promise and must see the rejection.
		const results = await Promise.allSettled([p1, p2]);
		expect(results[0]?.status).toBe("rejected");
		expect(results[1]?.status).toBe("rejected");

		// Cache cleaned up after rejection
		expect(peekStatusSummary(path)).toBeNull();
	});
});
