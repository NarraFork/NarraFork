/**
 * A page open in the connected outline refreshes alone (review S1): a commit hint of one page
 * re-reads that page's current view, not the other pages open in the same space, nor the space's
 * page list, nor a view as of a commit; a burst of hints is one read.
 */
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { outlineKeys, treePageRefresher } from "./useOutline";

const SPACE = "space1";

/** Block reads of two open pages, a view as of a commit and the page list, each observed. */
function client() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const reads: string[] = [];
	const observe = (key: readonly unknown[], name: string) => {
		const observer = new QueryObserver(queryClient, {
			queryKey: key,
			queryFn: async () => {
				reads.push(name);
				return { name };
			},
			initialData: { name },
			staleTime: Number.POSITIVE_INFINITY,
		});
		observer.subscribe(() => {});
	};
	observe([...outlineKeys.block(SPACE, "pageA", null, "all"), 200, 65536], "A");
	observe([...outlineKeys.block(SPACE, "pageB", null, "all"), 200, 65536], "B");
	observe([...outlineKeys.block(SPACE, "pageA", 7, "all"), 200, 65536], "A@7");
	observe(outlineKeys.pages(SPACE), "pages");
	return { queryClient, reads };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function stale(queryClient: QueryClient): string[] {
	return queryClient
		.getQueryCache()
		.getAll()
		.filter((q) => q.state.isInvalidated)
		.map((q) => (q.state.data as { name: string }).name)
		.sort();
}

describe("a page open in the connected outline", () => {
	test("a commit to it re-reads it alone, once per burst", async () => {
		const { queryClient, reads } = client();
		let refreshed = 0;
		const refresher = treePageRefresher(
			queryClient,
			SPACE,
			"pageA",
			() => ({ shown: 3, fetching: false }),
			1,
			() => refreshed++,
		);
		refresher.hint({ kind: "changed", seq: 4 });
		refresher.hint({ kind: "changed", seq: 5 });
		refresher.hint({ kind: "changed", seq: 6 });
		await tick(20);
		expect(stale(queryClient)).toEqual([]);
		expect(reads).toEqual(["A"]);
		expect(refreshed).toBe(1);
		// The next burst: one more read.
		refresher.hint({ kind: "changed", seq: 7 });
		refresher.hint({ kind: "changed", seq: 8 });
		await tick(20);
		expect(reads).toEqual(["A", "A"]);
		refresher.dispose();
	});

	test("nothing newer than what is shown: nothing is read", async () => {
		const { queryClient, reads } = client();
		const refresher = treePageRefresher(
			queryClient,
			SPACE,
			"pageA",
			() => ({ shown: 9, fetching: false }),
			1,
		);
		refresher.hint({ kind: "subscribed", seq: 9 });
		await tick(20);
		expect(reads).toEqual([]);
		// A change waiting for confirmation, or access lost, reads it whatever the seq.
		refresher.hint({ kind: "pending" });
		await tick(20);
		expect(reads).toEqual(["A"]);
		refresher.dispose();
	});

	test("a read in flight is waited for, then looked at again", async () => {
		const { queryClient, reads } = client();
		let fetching = true;
		const refresher = treePageRefresher(
			queryClient,
			SPACE,
			"pageB",
			() => ({ shown: fetching ? 1 : 2, fetching }),
			1,
		);
		refresher.hint({ kind: "changed", seq: 2 });
		await tick(20);
		expect(reads).toEqual([]);
		// The read that was in flight already holds seq 2: nothing more to read.
		fetching = false;
		await tick(20);
		expect(reads).toEqual([]);
		refresher.dispose();
	});
});
