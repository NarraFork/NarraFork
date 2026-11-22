import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eventBus } from "../lib/event-bus";
import { type GitStatusSummary, gitService } from "./git-service";
import {
	clearStatusCache,
	dropStatus,
	getStatusSummaryCached,
	invalidateStatus,
	markStatusDirty,
	peekStatusSummary,
	STATUS_CACHE_MAX_ENTRIES,
	statusCacheSize,
} from "./git-status-cache";
import { coordinateGitStatusQuery, getLocalGitStatusQueryKey } from "./git-status-query";

const originalGetStatusSummary = gitService.getStatusSummary;
const summary = (branch = "main"): GitStatusSummary => ({
	branch,
	headSha: "abc",
	files: [],
	staged: 0,
	unstaged: 0,
	untracked: 0,
	hasChanges: false,
	totalFiles: 0,
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

// Stub subprocess loading, not the coordinator now owning the cache.
function loadWith(load: (path: string) => Promise<GitStatusSummary>) {
	gitService.getStatusSummary = mock((path, options = {}) =>
		coordinateGitStatusQuery(getLocalGitStatusQueryKey(path), () => load(path), options),
	);
}
beforeEach(clearStatusCache);
afterEach(() => {
	gitService.getStatusSummary = originalGetStatusSummary;
	clearStatusCache();
});

describe("status facade and shared result cache", () => {
	test("bounded results evict the oldest while keeping frequently read paths", async () => {
		loadWith(async () => summary());
		const hot = "/tmp/nf-status/hot";
		await getStatusSummaryCached("/tmp/nf-status/oldest");
		for (let i = 0; i < STATUS_CACHE_MAX_ENTRIES * 2; i++) {
			await getStatusSummaryCached(`/tmp/nf-status/${i}`);
			await getStatusSummaryCached(hot);
			expect(statusCacheSize()).toBeLessThanOrEqual(STATUS_CACHE_MAX_ENTRIES);
		}
		expect(statusCacheSize()).toBe(STATUS_CACHE_MAX_ENTRIES);
		expect(peekStatusSummary("/tmp/nf-status/oldest")).toBeNull();
		expect(peekStatusSummary(hot)).not.toBeNull();
	});

	test("eviction cannot duplicate an in-flight query", async () => {
		let finish!: (value: GitStatusSummary) => void;
		let slowCalls = 0;
		const slow = "/tmp/nf-status/slow";
		loadWith(async (path) => {
			if (path !== slow) return summary();
			slowCalls++;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const first = getStatusSummaryCached(slow);
		for (let i = 0; i < STATUS_CACHE_MAX_ENTRIES + 10; i++)
			await getStatusSummaryCached(`/tmp/nf-status/other-${i}`);
		const second = getStatusSummaryCached(slow);
		finish(summary());
		expect(await first).toEqual(await second);
		expect(slowCalls).toBe(1);
		expect(statusCacheSize()).toBe(STATUS_CACHE_MAX_ENTRIES);
	});

	test("direct service and legacy reads reuse results; ttl zero reaches the coordinator", async () => {
		let calls = 0;
		loadWith(async () => summary(String(++calls)));
		const path = "/tmp/nf-status/shared";
		expect((await gitService.getStatusSummary(path)).branch).toBe("1");
		expect((await getStatusSummaryCached(path)).branch).toBe("1");
		expect((await getStatusSummaryCached(path, { ttlMs: 0 })).branch).toBe("2");
		expect((await gitService.getStatusSummary(path)).branch).toBe("2");
	});

	test("tool dirtiness is lazy and silent; the next read and explicit refresh remain fresh", async () => {
		let calls = 0;
		loadWith(async () => summary(String(++calls)));
		const path = "/tmp/nf-status/lazy-dirty";
		expect((await getStatusSummaryCached(path)).branch).toBe("1");
		const events: string[] = [];
		const listener = ({ queryKey }: { queryKey: string }) => events.push(queryKey);
		eventBus.on("git:workspace_invalidated", listener);
		try {
			for (let index = 0; index < 100; index++) markStatusDirty(path);
			expect(calls).toBe(1);
			expect(events).toEqual([]);
			expect(peekStatusSummary(path)?.branch).toBe("1");
			expect((await getStatusSummaryCached(path)).branch).toBe("2");
			expect((await getStatusSummaryCached(path, { ttlMs: 0 })).branch).toBe("3");
			invalidateStatus(path);
			expect(events).toEqual([getLocalGitStatusQueryKey(path)]);
			expect((await getStatusSummaryCached(path)).branch).toBe("4");
		} finally {
			eventBus.off("git:workspace_invalidated", listener);
		}
	});

	test("failed shared reads leave no result and can retry", async () => {
		let calls = 0;
		loadWith(async () => {
			if (++calls === 1) throw new Error("spawn timeout");
			return summary();
		});
		const path = "/tmp/nf-status/error";
		const results = await Promise.allSettled([
			getStatusSummaryCached(path),
			getStatusSummaryCached(path),
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(statusCacheSize()).toBe(0);
		expect(peekStatusSummary(path)).toBeNull();
		await getStatusSummaryCached(path);
		expect(calls).toBe(2);
	});

	test("dirty preserves last value, but a pre-invalidation completion cannot replace it", async () => {
		const path = "/tmp/nf-status/dirty";
		let finish!: (value: GitStatusSummary) => void;
		let calls = 0;
		loadWith(async () => {
			if (++calls === 2)
				return new Promise((resolve) => {
					finish = resolve;
				});
			return summary(calls === 1 ? "last" : "new");
		});
		await getStatusSummaryCached(path);
		const old = getStatusSummaryCached(path, { ttlMs: 0 });
		await turn();
		invalidateStatus(path);
		expect(peekStatusSummary(path)?.branch).toBe("last");
		const fresh = getStatusSummaryCached(path);
		finish(summary("invalidated"));
		expect((await old).branch).toBe("invalidated");
		expect((await fresh).branch).toBe("new");
		expect(peekStatusSummary(path)?.branch).toBe("new");
	});

	test("root invalidation preserves scoped last values and emits once after invalidating", async () => {
		let calls = 0;
		loadWith(async () => summary(String(++calls)));
		const root = "/tmp/nf-status/repo";
		await getStatusSummaryCached(`${root}/sub`);
		await getStatusSummaryCached(`${root}2`);
		const events: string[] = [];
		const listener = (event: { queryKey: string }) => {
			events.push(event.queryKey);
		};
		eventBus.on("git:workspace_invalidated", listener);
		try {
			invalidateStatus(root);
		} finally {
			eventBus.off("git:workspace_invalidated", listener);
		}
		expect(events).toEqual([getLocalGitStatusQueryKey(root)]);
		expect(peekStatusSummary(`${root}/sub`)?.branch).toBe("1");
		expect((await getStatusSummaryCached(`${root}/sub`)).branch).toBe("3");
		expect((await getStatusSummaryCached(`${root}2`)).branch).toBe("2");
		dropStatus(root);
		expect(peekStatusSummary(`${root}/sub`)).toBeNull();
		expect(statusCacheSize()).toBe(1);
	});

	test("drop prevents unfinished work from repopulating the destroyed workspace", async () => {
		let finish!: (value: GitStatusSummary) => void;
		loadWith(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = getStatusSummaryCached("/tmp/nf-status/drop");
		await turn();
		dropStatus("/tmp/nf-status/drop");
		finish(summary());
		await pending;
		expect(statusCacheSize()).toBe(0);
	});

	test("an already-aborted subscriber cannot read a cached value", async () => {
		loadWith(async () => summary());
		await getStatusSummaryCached("/tmp/nf-status/abort");
		await expect(
			getStatusSummaryCached("/tmp/nf-status/abort", {
				signal: AbortSignal.abort(new Error("disconnected")),
			}),
		).rejects.toThrow("disconnected");
	});
});
