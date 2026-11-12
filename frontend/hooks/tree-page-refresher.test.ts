/**
 * A page open in the connected outline refreshes alone (review S1): a commit hint of one page
 * re-reads that page's current view, not the other pages open in the same space, nor the space's
 * page list, nor a view as of a commit; a burst of hints is one read.
 */
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { outlineKeys, treePageRefresher } from "./useOutline";

const SPACE = "space1";

function client() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const reads: string[] = [];
	const seed = (key: readonly unknown[], name: string) => {
		queryClient.setQueryData(key, { name });
		// An observer, so an invalidation refetches (what a mounted page does).
		queryClient
			.getQueryCache()
			.find({ queryKey: key, exact: true })
			?.setOptions({
				queryKey: key,
				queryFn: async () => {
					reads.push(name);
					return { name };
				},
			});
	};
	seed([...outlineKeys.block(SPACE, "pageA", null, "all"), 200, 65536], "A");
	seed([...outlineKeys.block(SPACE, "pageB", null, "all"), 200, 65536], "B");
	seed([...outlineKeys.block(SPACE, "pageA", 7, "all"), 200, 65536], "A@7");
	seed(outlineKeys.pages(SPACE), "pages");
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
		const { queryClient } = client();
		const refresher = treePageRefresher(
			queryClient,
			SPACE,
			"pageA",
			() => ({ shown: 3, fetching: false }),
			1,
		);
		refresher.hint({ kind: "changed", seq: 4 });
		refresher.hint({ kind: "changed", seq: 5 });
		refresher.hint({ kind: "changed", seq: 6 });
		await tick();
		expect(stale(queryClient)).toEqual(["A"]);
		refresher.dispose();
	});

	test("nothing newer than what is shown: nothing is read", async () => {
		const { queryClient } = client();
		const refresher = treePageRefresher(
			queryClient,
			SPACE,
			"pageA",
			() => ({ shown: 9, fetching: false }),
			1,
		);
		refresher.hint({ kind: "subscribed", seq: 9 });
		await tick();
		expect(stale(queryClient)).toEqual([]);
		// A change waiting for confirmation, or access lost, reads it whatever the seq.
		refresher.hint({ kind: "pending" });
		await tick();
		expect(stale(queryClient)).toEqual(["A"]);
		refresher.dispose();
	});

	test("a read in flight is waited for, then looked at again", async () => {
		const { queryClient } = client();
		let fetching = true;
		const refresher = treePageRefresher(
			queryClient,
			SPACE,
			"pageB",
			() => ({ shown: fetching ? 1 : 2, fetching }),
			1,
		);
		refresher.hint({ kind: "changed", seq: 2 });
		await tick();
		expect(stale(queryClient)).toEqual([]);
		// The read that was in flight already holds seq 2: nothing more to read.
		fetching = false;
		await tick();
		expect(stale(queryClient)).toEqual([]);
		refresher.dispose();
	});
});
