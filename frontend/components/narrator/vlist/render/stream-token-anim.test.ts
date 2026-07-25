import { describe, expect, it } from "bun:test";
import {
	commonPrefixLength,
	STREAM_ANIM_MAX_KEYS,
	StreamAnimStore,
	segmentGraphemes,
	splitFragmentForAnim,
} from "./stream-token-anim";

describe("segmentGraphemes", () => {
	it("splits ASCII into one grapheme per character with offsets", () => {
		const g = segmentGraphemes("abc");
		expect(g).toEqual([
			{ text: "a", start: 0, end: 1 },
			{ text: "b", start: 1, end: 2 },
			{ text: "c", start: 2, end: 3 },
		]);
	});

	it("keeps CJK characters as single graphemes with correct offsets", () => {
		const g = segmentGraphemes("你好");
		expect(g.map((x) => x.text)).toEqual(["你", "好"]);
		expect(g[0]).toEqual({ text: "你", start: 0, end: 1 });
		expect(g[1]).toEqual({ text: "好", start: 1, end: 2 });
	});

	it("keeps surrogate-pair emoji together (code-unit offsets)", () => {
		const g = segmentGraphemes("a😀b");
		expect(g.map((x) => x.text)).toEqual(["a", "😀", "b"]);
		// 😀 is 2 UTF-16 code units → offsets 1..3, then b at 3..4.
		expect(g[1]).toEqual({ text: "😀", start: 1, end: 3 });
		expect(g[2]).toEqual({ text: "b", start: 3, end: 4 });
	});

	it("returns empty for empty input", () => {
		expect(segmentGraphemes("")).toEqual([]);
	});
});

describe("commonPrefixLength", () => {
	it("returns full length when one is a prefix of the other", () => {
		expect(commonPrefixLength("hello", "hello world")).toBe(5);
	});
	it("returns divergence point on rewrite", () => {
		expect(commonPrefixLength("hello", "help")).toBe(3);
	});
	it("returns 0 when nothing matches", () => {
		expect(commonPrefixLength("abc", "xyz")).toBe(0);
	});
});

describe("StreamAnimStore.resolveBoundary", () => {
	it("does not animate on first sighting (boundary = full length)", () => {
		const store = new StreamAnimStore();
		expect(store.resolveBoundary("k", "hello")).toBe(5);
	});

	it("animates only the appended suffix on pure append", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", "hello");
		// Next frame appended " world" → boundary is the old length (5).
		expect(store.resolveBoundary("k", "hello world")).toBe(5);
		// A further append moves the boundary to the previous full length.
		expect(store.resolveBoundary("k", "hello world!")).toBe(11);
	});

	it("uses common prefix when the text is rewritten (not append)", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("k", "hello");
		// "help" diverges at offset 3.
		expect(store.resolveBoundary("k", "help")).toBe(3);
	});

	it("tracks multiple keys independently", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("a", "foo");
		store.resolveBoundary("b", "bar");
		expect(store.resolveBoundary("a", "foobar")).toBe(3);
		expect(store.resolveBoundary("b", "barbaz")).toBe(3);
	});

	it("evicts oldest keys past the capacity bound", () => {
		const store = new StreamAnimStore(3);
		store.resolveBoundary("a", "1");
		store.resolveBoundary("b", "2");
		store.resolveBoundary("c", "3");
		expect(store.size()).toBe(3);
		store.resolveBoundary("d", "4"); // evicts "a"
		expect(store.size()).toBe(3);
		// "a" was evicted → treated as first sighting again (boundary = full len).
		expect(store.resolveBoundary("a", "12")).toBe(2);
	});

	it("re-accessing a key marks it most-recently-used (LRU)", () => {
		const store = new StreamAnimStore(2);
		store.resolveBoundary("a", "1");
		store.resolveBoundary("b", "2");
		// Touch "a" so it becomes newest; inserting "c" should evict "b".
		store.resolveBoundary("a", "1x");
		store.resolveBoundary("c", "3"); // evicts "b", keeps "a"
		// "a" still known → append boundary is its previous length ("1x" → 2).
		expect(store.resolveBoundary("a", "1xy")).toBe(2);
		// "b" was evicted → first sighting again.
		expect(store.resolveBoundary("b", "2")).toBe(1);
	});

	it("clear() drops all keys", () => {
		const store = new StreamAnimStore();
		store.resolveBoundary("a", "1");
		store.clear();
		expect(store.size()).toBe(0);
	});

	it("exposes a sane default capacity", () => {
		expect(STREAM_ANIM_MAX_KEYS).toBeGreaterThan(0);
	});
});

describe("splitFragmentForAnim", () => {
	it("returns all-static when the fragment ends before the boundary", () => {
		const r = splitFragmentForAnim("hello", 0, 10);
		expect(r).toEqual({ staticText: "hello", animGraphemes: [] });
	});

	it("returns all-static when the fragment ends exactly at the boundary", () => {
		const r = splitFragmentForAnim("hello", 0, 5);
		expect(r).toEqual({ staticText: "hello", animGraphemes: [] });
	});

	it("animates every grapheme when the fragment starts at/after the boundary", () => {
		const r = splitFragmentForAnim("abc", 5, 5);
		expect(r.staticText).toBe("");
		expect(r.animGraphemes).toEqual([
			{ gid: 5, text: "a" },
			{ gid: 6, text: "b" },
			{ gid: 7, text: "c" },
		]);
	});

	it("splits a straddling fragment into static prefix + animated tail", () => {
		// Fragment "world" starts at global offset 6; boundary at 8 → "wo" static,
		// "rld" animated with global gids 8,9,10.
		const r = splitFragmentForAnim("world", 6, 8);
		expect(r.staticText).toBe("wo");
		expect(r.animGraphemes).toEqual([
			{ gid: 8, text: "r" },
			{ gid: 9, text: "l" },
			{ gid: 10, text: "d" },
		]);
	});

	it("never splits a multi-unit grapheme across the boundary", () => {
		// "a😀" starts at offset 4; boundary 5 falls INSIDE the emoji's code units
		// (emoji at global 5..7). The emoji's start (5) >= boundary → animated whole.
		const r = splitFragmentForAnim("a😀", 4, 5);
		expect(r.staticText).toBe("a");
		expect(r.animGraphemes).toEqual([{ gid: 5, text: "😀" }]);
	});

	it("keeps CJK grapheme gids at code-unit offsets", () => {
		const r = splitFragmentForAnim("你好", 3, 4);
		expect(r.staticText).toBe("你");
		expect(r.animGraphemes).toEqual([{ gid: 4, text: "好" }]);
	});
});
