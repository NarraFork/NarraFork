import { expect, test } from "bun:test";
import type { WorktreeListQuery, WorktreeListResult } from "@shared/narrator-worktrees";
import { type InfiniteData, QueryClient, QueryObserver } from "@tanstack/react-query";
import {
	releaseWorktreeListPages,
	retainWorktreeFirstPage,
	WORKTREE_LIST_GC_MS,
	WORKTREE_LIST_STALE_MS,
	worktreeListQueryKey,
} from "./worktree-query-cache";

const scope = { userId: "user", narratorId: "n", deviceId: "local", repositoryKey: "repo" };
const condition: WorktreeListQuery = {
	limit: 20,
	search: "",
	sort: "lastCommitAt",
	order: "desc",
};
const key = worktreeListQueryKey(scope, "workspace", condition, 1);
const page = (index: number): WorktreeListResult => ({
	repositoryKey: "repo",
	truncated: false,
	hasMore: index < 2,
	nextCursor: index < 2 ? String(index + 1) : null,
	capabilities: {
		list: true,
		create: true,
		switch: false,
		delete: true,
		prune: false,
		remote: false,
	},
	entries: [],
});
type Pages = InfiniteData<WorktreeListResult, string | undefined>;
const pages: Pages = { pages: [page(0), page(1), page(2)], pageParams: [undefined, "1", "2"] };

for (const invalidated of [false, true]) {
	test(`retaining first page preserves old freshness and invalidated=${invalidated}`, async () => {
		const client = new QueryClient();
		try {
			const updatedAt = Date.now() - WORKTREE_LIST_STALE_MS - 1_000;
			client.setQueryData(key, pages, { updatedAt });
			if (invalidated) {
				await client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
			}
			retainWorktreeFirstPage(client, key);
			expect(client.getQueryData<Pages>(key)).toEqual({
				pages: [pages.pages[0]],
				pageParams: [undefined],
			});
			expect(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt);
			expect(client.getQueryState(key)?.isInvalidated).toBe(invalidated);
			expect(
				client.getQueryCache().find({ queryKey: key })?.isStaleByTime(WORKTREE_LIST_STALE_MS),
			).toBe(true);
			// Repeated cleanup is idempotent and must not turn a stale snapshot fresh.
			retainWorktreeFirstPage(client, key);
			expect(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt);
			expect(client.getQueryState(key)?.isInvalidated).toBe(invalidated);
		} finally {
			client.clear();
		}
	});
}

test("no cached data or one cached page is an exact no-op", async () => {
	const client = new QueryClient();
	try {
		retainWorktreeFirstPage(client, key);
		expect(client.getQueryState(key)).toBeUndefined();
		client.setQueryData(key, { pages: [page(0)], pageParams: [undefined] }, { updatedAt: 100 });
		await client.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
		const before = client.getQueryState(key);
		retainWorktreeFirstPage(client, key);
		expect(client.getQueryState(key)).toBe(before);
	} finally {
		client.clear();
	}
});

test("release cancels before trimming so cancellation rollback cannot restore the page chain", async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	let resolve!: (value: Pages) => void;
	const request: { signal?: AbortSignal } = {};
	try {
		const updatedAt = Date.now() - 31_000;
		client.setQueryData(key, pages, { updatedAt });
		const pending = client
			.fetchQuery({
				queryKey: key,
				queryFn: (context) => {
					request.signal = context.signal;
					return new Promise<Pages>((done) => {
						resolve = done;
					});
				},
			})
			.catch(() => undefined);
		expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
		await releaseWorktreeListPages(client, key);
		expect(request.signal?.aborted).toBe(true);
		expect(client.getQueryData<Pages>(key)?.pages).toHaveLength(1);
		expect(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt);
		resolve(pages);
		await pending;
		expect(client.getQueryData<Pages>(key)?.pages).toHaveLength(1);
		expect(client.getQueryData<Pages>(key)?.pageParams).toEqual([undefined]);
	} finally {
		client.clear();
	}
});

test("releasing one view does not collapse another active view's expanded pages", async () => {
	const client = new QueryClient();
	const unsubscribes: Array<() => void> = [];
	try {
		client.setQueryData(key, pages);
		for (let i = 0; i < 2; i++) {
			const observer = new QueryObserver(client, {
				queryKey: key,
				queryFn: async () => pages,
				staleTime: Infinity,
			});
			unsubscribes.push(observer.subscribe(() => {}));
		}
		await releaseWorktreeListPages(client, key);
		expect(client.getQueryData<Pages>(key)?.pages).toHaveLength(3);
		unsubscribes.pop()?.();
		await releaseWorktreeListPages(client, key);
		expect(client.getQueryData<Pages>(key)?.pages).toHaveLength(1);
	} finally {
		for (const unsubscribe of unsubscribes) unsubscribe();
		client.clear();
	}
});

test("stable query key isolates each principal, credential, device, repository, workspace and list condition", () => {
	expect(worktreeListQueryKey({ ...scope }, "workspace", { ...condition }, 1)).toEqual(key);
	const variants = [
		worktreeListQueryKey({ ...scope, userId: "another" }, "workspace", condition, 1),
		worktreeListQueryKey({ ...scope, narratorId: "another" }, "workspace", condition, 1),
		worktreeListQueryKey({ ...scope, deviceId: "another" }, "workspace", condition, 1),
		worktreeListQueryKey({ ...scope, repositoryKey: "another" }, "workspace", condition, 1),
		worktreeListQueryKey(scope, "another", condition, 1),
		worktreeListQueryKey(scope, "workspace", condition, 2),
		worktreeListQueryKey(scope, "workspace", { ...condition, search: "another" }, 1),
		worktreeListQueryKey(scope, "workspace", { ...condition, sort: "name" }, 1),
		worktreeListQueryKey(scope, "workspace", { ...condition, order: "asc" }, 1),
	];
	for (const variant of variants) expect(variant).not.toEqual(key);
	expect(new Set([key, ...variants].map((value) => JSON.stringify(value))).size).toBe(10);
	expect(WORKTREE_LIST_STALE_MS).toBe(30_000);
	expect(WORKTREE_LIST_GC_MS).toBe(60_000);
});
