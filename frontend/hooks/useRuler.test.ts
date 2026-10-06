import { describe, expect, test } from "bun:test";
import {
	flattenRulerPages,
	type RulerData,
	rulerNewerPageParam,
	rulerOlderPageParam,
} from "./useRuler";

function commit(sha: string) {
	return { sha, shortSha: sha, message: sha, author: "A", date: "d" };
}

function page(overrides: Partial<RulerData> = {}): RulerData {
	return {
		commits: [],
		segments: [],
		activeChapters: [],
		...overrides,
	};
}

describe("flattenRulerPages", () => {
	test("preserves degraded metadata across merged pages", () => {
		const merged = flattenRulerPages([
			page({
				commits: [{ sha: "a", shortSha: "a", message: "one", author: "A", date: "2026-01-01" }],
				degraded: true,
				fallback: true,
				fallbacks: [{ feature: "ruler.gitLog", reason: "git_log_failed", error: "boom" }],
				capabilities: {
					read: {
						supported: false,
						fallback: true,
						code: "FEATURE_DISABLED",
						reason: "Ruler read degraded",
					},
				},
			}),
			page({
				commits: [{ sha: "b", shortSha: "b", message: "two", author: "B", date: "2026-01-02" }],
				fallbacks: [{ feature: "ruler.gitCount", reason: "git_rev_list_failed", message: "oops" }],
			}),
		]);

		expect(merged.degraded).toBe(true);
		expect(merged.fallback).toBe(true);
		expect(merged.fallbacks).toHaveLength(2);
		expect(merged.fallbacks?.[0]).toMatchObject({
			feature: "ruler.gitLog",
			reason: "git_log_failed",
		});
		expect(merged.fallbacks?.[1]).toMatchObject({
			feature: "ruler.gitCount",
			reason: "git_rev_list_failed",
		});
		expect(merged.capabilities).toMatchObject({
			read: {
				supported: false,
				fallback: true,
				code: "FEATURE_DISABLED",
				reason: "Ruler read degraded",
			},
		});
		expect(merged.commits).toHaveLength(2);
	});

	test("orders pages by absolute offset, not by array position", () => {
		// React Query PREPENDS pages fetched in the "older" direction, so `pages` arrives
		// oldest-batch-first while each batch is newest-first. Concatenating naively
		// produced a commit list in neither order, and tick positions — hence every
		// chapter's placement — are derived from this array.
		const merged = flattenRulerPages([
			page({
				commits: [
					{ sha: "c2", shortSha: "c2", message: "older-newest", author: "A", date: "d" },
					{ sha: "c3", shortSha: "c3", message: "oldest", author: "A", date: "d" },
				],
				firstOffset: 1,
				lastOffset: 2,
			}),
			page({
				commits: [{ sha: "c1", shortSha: "c1", message: "head", author: "A", date: "d" }],
				firstOffset: 0,
				lastOffset: 0,
			}),
		]);

		expect(merged.commits.map((c) => c.sha)).toEqual(["c1", "c2", "c3"]);
	});

	test("deduplicates commits that two pages both cover", () => {
		// The "newer" cursor direction computes its offset as `cursorIndex - limit`, which
		// deliberately overlaps the page it pages towards.
		const merged = flattenRulerPages([
			page({
				commits: [
					{ sha: "a", shortSha: "a", message: "one", author: "A", date: "d" },
					{ sha: "b", shortSha: "b", message: "two", author: "A", date: "d" },
				],
				firstOffset: 0,
				lastOffset: 1,
			}),
			page({
				commits: [
					{ sha: "b", shortSha: "b", message: "two", author: "A", date: "d" },
					{ sha: "c", shortSha: "c", message: "three", author: "A", date: "d" },
				],
				firstOffset: 1,
				lastOffset: 2,
			}),
		]);

		expect(merged.commits.map((c) => c.sha)).toEqual(["a", "b", "c"]);
	});

	test("re-indexes segments against the flattened commit list", () => {
		// The server computes fromIndex/toIndex per page, so a second page's indices
		// address the wrong commits after concatenation. SHAs are absolute; indices are not.
		const merged = flattenRulerPages([
			page({
				commits: [
					{ sha: "a", shortSha: "a", message: "one", author: "A", date: "d" },
					{ sha: "b", shortSha: "b", message: "two", author: "A", date: "d" },
				],
				firstOffset: 0,
				lastOffset: 1,
				segments: [
					{
						fromSha: "a",
						toSha: "a",
						fromIndex: 0,
						toIndex: 0,
						activeChapterCount: 1,
						totalChapterCount: 1,
						activeChapterIds: ["ch-a"],
						isExpandable: true,
					},
				],
			}),
			page({
				commits: [{ sha: "c", shortSha: "c", message: "three", author: "A", date: "d" }],
				firstOffset: 2,
				lastOffset: 2,
				segments: [
					{
						fromSha: "c",
						// Page-local index 0, which addresses commit "a" in the flattened list.
						fromIndex: 0,
						toSha: "c",
						toIndex: 0,
						activeChapterCount: 1,
						totalChapterCount: 1,
						activeChapterIds: ["ch-c"],
						isExpandable: true,
					},
				],
			}),
		]);

		const segC = merged.segments.find((seg) => seg.fromSha === "c");
		expect(segC?.fromIndex).toBe(2);
		expect(segC?.toIndex).toBe(2);
		const segA = merged.segments.find((seg) => seg.fromSha === "a");
		expect(segA?.fromIndex).toBe(0);
	});

	test("keeps the server's index when a segment's sha is outside the loaded window", () => {
		const merged = flattenRulerPages([
			page({
				commits: [{ sha: "a", shortSha: "a", message: "one", author: "A", date: "d" }],
				firstOffset: 0,
				lastOffset: 0,
			}),
			page({
				commits: [{ sha: "b", shortSha: "b", message: "two", author: "A", date: "d" }],
				firstOffset: 1,
				lastOffset: 1,
				segments: [
					{
						fromSha: "unloaded",
						toSha: "also-unloaded",
						fromIndex: 7,
						toIndex: 8,
						activeChapterCount: 0,
						totalChapterCount: 1,
						activeChapterIds: [],
						isExpandable: true,
					},
				],
			}),
		]);

		const seg = merged.segments.find((s) => s.fromSha === "unloaded");
		expect(seg?.fromIndex).toBe(7);
		expect(seg?.toIndex).toBe(8);
	});

	test("reads totalCommitCount from the offset-ordered pages, not array position", () => {
		// The aggregate fields must agree with the ordering this function just established.
		// `pages[0]` was the head of an array it had already declared unordered — harmless
		// while every page reports the same total, but the kind of line a later change
		// copies into somewhere order actually matters.
		const merged = flattenRulerPages([
			page({
				commits: [{ sha: "c2", shortSha: "c2", message: "older", author: "A", date: "d" }],
				firstOffset: 1,
				lastOffset: 1,
				totalCommitCount: 2,
			}),
			page({
				commits: [{ sha: "c1", shortSha: "c1", message: "head", author: "A", date: "d" }],
				firstOffset: 0,
				lastOffset: 0,
				totalCommitCount: 2,
			}),
		]);

		expect(merged.totalCommitCount).toBe(2);
		expect(merged.firstOffset).toBe(0);
		expect(merged.lastOffset).toBe(1);
	});

	test("carries each chapter's parked snapshot through the merge", () => {
		// The recovery panel is rebuilt from this field after a reload, so dropping it here
		// would restore the pre-fix behaviour: server still tracking parked work, no UI able
		// to act on it.
		const merged = flattenRulerPages([
			page({
				commits: [{ sha: "a", shortSha: "a", message: "one", author: "A", date: "d" }],
				firstOffset: 0,
				lastOffset: 0,
				activeChapters: [
					{
						id: "ch-a",
						title: "Alpha",
						branch: "chapter/alpha",
						role: "branch",
						parentChapterId: null,
						startCommitSha: "a",
						parkedSnapshot: "abcdef0123456789",
						narratorId: null,
						narratorStatus: null,
						axisOffset: 0,
						crossOffset: 0,
					},
				],
			}),
			page({
				commits: [{ sha: "b", shortSha: "b", message: "two", author: "A", date: "d" }],
				firstOffset: 1,
				lastOffset: 1,
			}),
		]);

		expect(merged.activeChapters[0]?.parkedSnapshot).toBe("abcdef0123456789");
	});

	test("keeps the older end available after merging pages", () => {
		// `rulerOlderPageParam` reads `lastOffset` off the MERGED result, so a max that
		// picked the wrong end would strand paging after the first "load older" click.
		const merged = flattenRulerPages([
			page({ commits: [commit("c3")], firstOffset: 2, lastOffset: 3, totalCommitCount: 10 }),
			page({ commits: [commit("c1")], firstOffset: 0, lastOffset: 1, totalCommitCount: 10 }),
		]);

		expect(merged.firstOffset).toBe(0);
		expect(merged.lastOffset).toBe(3);
		expect(rulerOlderPageParam(merged)).toEqual({ cursor: "c3", direction: "older" });
	});

	test("deduplicates identical fallbacks", () => {
		const merged = flattenRulerPages([
			page({ fallbacks: [{ feature: "ruler.gitLog", reason: "git_log_failed", error: "boom" }] }),
			page({ fallbacks: [{ feature: "ruler.gitLog", reason: "git_log_failed", error: "boom" }] }),
		]);

		expect(merged.fallbacks).toHaveLength(1);
		expect(merged.fallbacks?.[0]).toMatchObject({
			feature: "ruler.gitLog",
			reason: "git_log_failed",
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Paging direction
//
// `git log` is newest-first: offset 0 is HEAD and grows towards OLDER history. The
// predicates used to be inline booleans written against field names that said the
// opposite (`oldestLoadedIndex` for the offset of the page's first commit), so the very
// first page — the one with all the older history still ahead of it — reported "nothing
// older to load". On a repository longer than one page (200 commits) every chapter
// anchored past the window then lost its tick, and the Ruler told the user the start
// commit was not on this branch while offering no way to load it.
// ─────────────────────────────────────────────────────────────────────────────

describe("rulerOlderPageParam", () => {
	test("[REGRESSION] the FIRST page can still page older", () => {
		// The exact shape the server returns for a fresh load of a long repository, and
		// the exact case the old `oldestLoadedIndex > 0` test answered `false` for.
		const firstPage = page({
			commits: [commit("head"), commit("older")],
			firstOffset: 0,
			lastOffset: 199,
			totalCommitCount: 1058,
		});

		expect(rulerOlderPageParam(firstPage)).toEqual({ cursor: "older", direction: "older" });
	});

	test("cursors on the page's OLDEST commit, since the server counts forward from it", () => {
		const p = page({
			commits: [commit("newest"), commit("middle"), commit("oldest")],
			firstOffset: 0,
			lastOffset: 2,
			totalCommitCount: 99,
		});

		expect(rulerOlderPageParam(p)?.cursor).toBe("oldest");
	});

	test("stops at the end of history rather than re-asking forever", () => {
		const lastPage = page({
			commits: [commit("a"), commit("b")],
			firstOffset: 8,
			lastOffset: 9,
			totalCommitCount: 10,
		});

		expect(rulerOlderPageParam(lastPage)).toBeUndefined();
	});

	test("a single page covering the whole history offers nothing more", () => {
		const whole = page({
			commits: [commit("a"), commit("b")],
			firstOffset: 0,
			lastOffset: 1,
			totalCommitCount: 2,
		});

		expect(rulerOlderPageParam(whole)).toBeUndefined();
	});

	test("an empty page yields no param: there is no cursor to count forward from", () => {
		// `lastOffset` is `firstOffset - 1` here (an offset past HEAD). Without the cursor
		// guard this would ask again with `cursor: undefined` and re-fetch offset 0 forever.
		const empty = page({ commits: [], firstOffset: 500, lastOffset: 499, totalCommitCount: 10 });

		expect(rulerOlderPageParam(empty)).toBeUndefined();
	});

	test("a response predating the offset fields pages nowhere (old server, no guessing)", () => {
		const legacy = page({ commits: [commit("a")], totalCommitCount: 100 });

		expect(rulerOlderPageParam(legacy)).toBeUndefined();
		expect(rulerNewerPageParam(legacy)).toBeUndefined();
	});
});

describe("rulerNewerPageParam", () => {
	test("the first page has nothing newer: offset 0 IS HEAD", () => {
		const firstPage = page({
			commits: [commit("head")],
			firstOffset: 0,
			lastOffset: 199,
			totalCommitCount: 1058,
		});

		expect(rulerNewerPageParam(firstPage)).toBeUndefined();
	});

	test("a page below HEAD cursors on its NEWEST commit", () => {
		const deeper = page({
			commits: [commit("newest"), commit("oldest")],
			firstOffset: 200,
			lastOffset: 399,
			totalCommitCount: 1058,
		});

		expect(rulerNewerPageParam(deeper)).toEqual({ cursor: "newest", direction: "newer" });
	});
});
