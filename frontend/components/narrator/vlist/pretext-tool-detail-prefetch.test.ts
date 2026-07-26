import { describe, expect, it } from "bun:test";
import { PretextToolDetailPrefetchStore } from "./pretext-tool-detail-prefetch";

/** A fetcher recording its calls, resolving `{inputJson,outputJson}` per id. */
function makeFetcher(opts: { fail?: Set<string>; delayMs?: number } = {}) {
	const calls: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const fetcher = async (narratorId: string, toolUseId: string) => {
		calls.push(`${narratorId}/${toolUseId}`);
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
			if (opts.fail?.has(toolUseId)) throw new Error("boom");
			return { inputJson: { in: toolUseId }, outputJson: { out: toolUseId } };
		} finally {
			inFlight--;
		}
	};
	return {
		fetcher,
		calls,
		get maxInFlight() {
			return maxInFlight;
		},
	};
}

describe("PretextToolDetailPrefetchStore", () => {
	it("resolves payloads through the adapter resolvers after prefetching", async () => {
		const { fetcher } = makeFetcher();
		const store = new PretextToolDetailPrefetchStore(fetcher);
		await store.prefetch("n1", ["t1", "t2"]);
		expect(store.resolveFullToolInput("t1")).toEqual({ in: "t1" });
		expect(store.resolveFullToolOutput("t2")).toEqual({ out: "t2" });
		expect(store.size).toBe(2);
	});

	it("returns undefined for ids it has not fetched", async () => {
		const { fetcher } = makeFetcher();
		const store = new PretextToolDetailPrefetchStore(fetcher);
		await store.prefetch("n1", ["t1"]);
		expect(store.resolveFullToolInput("nope")).toBeUndefined();
		expect(store.resolveFullToolOutput(undefined)).toBeUndefined();
	});

	it("keeps resolver identity stable so the prefetch never triggers a rebuild", async () => {
		// This is the whole reason the prefetch lives outside React: a changing
		// resolver identity is what makes the on-demand path rebuild the document
		// (and grow the row) after paint.
		const { fetcher } = makeFetcher();
		const store = new PretextToolDetailPrefetchStore(fetcher);
		const inputBefore = store.resolveFullToolInput;
		const outputBefore = store.resolveFullToolOutput;
		await store.prefetch("n1", ["t1"]);
		expect(store.resolveFullToolInput).toBe(inputBefore);
		expect(store.resolveFullToolOutput).toBe(outputBefore);
	});

	it("fetches each id only once, even across repeated prefetch calls", async () => {
		const { fetcher, calls } = makeFetcher();
		const store = new PretextToolDetailPrefetchStore(fetcher);
		await store.prefetch("n1", ["t1", "t2"]);
		await store.prefetch("n1", ["t1", "t2", "t3"]);
		expect(calls).toEqual(["n1/t1", "n1/t2", "n1/t3"]);
	});

	it("does not retry a failed fetch, and keeps the rest of the batch", async () => {
		const { fetcher, calls } = makeFetcher({ fail: new Set(["bad"]) });
		const store = new PretextToolDetailPrefetchStore(fetcher);
		await store.prefetch("n1", ["good", "bad"]);
		// A failed payload degrades to the preview (undefined here) rather than
		// failing the whole document.
		expect(store.resolveFullToolInput("good")).toEqual({ in: "good" });
		expect(store.resolveFullToolInput("bad")).toBeUndefined();
		await store.prefetch("n1", ["bad"]);
		expect(calls.filter((c) => c.endsWith("/bad"))).toHaveLength(1);
	});

	it("drops everything when the narrator changes (ids are not shared)", async () => {
		const { fetcher } = makeFetcher();
		const store = new PretextToolDetailPrefetchStore(fetcher);
		await store.prefetch("n1", ["t1"]);
		expect(store.has("t1")).toBe(true);
		await store.prefetch("n2", ["t9"]);
		expect(store.has("t1")).toBe(false);
		expect(store.has("t9")).toBe(true);
	});

	it("bounds concurrency so one page cannot storm the API", async () => {
		const meter = makeFetcher({ delayMs: 5 });
		const store = new PretextToolDetailPrefetchStore(meter.fetcher);
		await store.prefetch(
			"n1",
			Array.from({ length: 20 }, (_, i) => `t${i}`),
		);
		expect(store.size).toBe(20);
		expect(meter.maxInFlight).toBeLessThanOrEqual(6);
		expect(meter.maxInFlight).toBeGreaterThan(1);
	});

	it("no-ops for an empty id list", async () => {
		const { fetcher, calls } = makeFetcher();
		const store = new PretextToolDetailPrefetchStore(fetcher);
		await store.prefetch("n1", []);
		expect(calls).toEqual([]);
		expect(store.size).toBe(0);
	});
});
