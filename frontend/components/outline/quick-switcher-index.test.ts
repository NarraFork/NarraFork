import { describe, expect, test } from "bun:test";
import type { OutlineSearchHitView } from "@shared/outline-api";
import {
	type LocalSource,
	LocalSwitcherIndex,
	mergeSwitcherHits,
	SWITCHER_LIMIT,
	type SwitcherHit,
	serverHit,
} from "./quick-switcher-index";

/** Parse everything a search needs (a loaded machine must not leave blocks out). */
const ALL = Number.POSITIVE_INFINITY;

function source(texts: Record<string, string>, pageId = "page"): LocalSource {
	return { pageId, ids: () => Object.keys(texts), textOf: (id) => texts[id] ?? "" };
}

function server(over: Partial<OutlineSearchHitView>): OutlineSearchHitView {
	return {
		blockId: "x",
		spaceId: "s1",
		pageId: "p2",
		address: "@x",
		alias: null,
		title: "",
		snippet: "",
		path: [],
		process: false,
		...over,
	};
}

describe("local switcher index", () => {
	test("titles before bodies, prefixes before infixes, case-insensitive", () => {
		const src = source({
			a: "Notes on Apples\nmore",
			b: "apple pie",
			c: "Fruit\nan APPLE on the second line",
			d: "nothing here",
		});
		const ix = new LocalSwitcherIndex();
		const hits = ix.search(src, "s1", "apple", [], ALL);
		expect(hits.map((h) => [h.blockId, h.via])).toEqual([
			["b", "title"],
			["a", "title"],
			["c", "body"],
		]);
		expect(hits.every((h) => h.local && h.pageId === "page" && h.spaceId === "s1")).toBe(true);
		expect(hits[0]?.label).toBe("apple pie");
	});

	test("recently focused blocks rank first, and alone for an empty query", () => {
		const src = source({ a: "alpha one", b: "alpha two", c: "alpha three" });
		const ix = new LocalSwitcherIndex();
		expect(ix.search(src, "s1", "alpha", ["c", "b"], ALL).map((h) => h.blockId)).toEqual([
			"c",
			"b",
			"a",
		]);
		const empty = ix.search(src, "s1", "  ", ["b", "gone", "a"], ALL);
		expect(empty.map((h) => [h.blockId, h.via])).toEqual([
			["b", "recent"],
			["a", "recent"],
		]);
	});

	test("rebuilds after invalidate and for another source; at most SWITCHER_LIMIT rows", () => {
		const texts: Record<string, string> = {};
		for (let i = 0; i < SWITCHER_LIMIT + 10; i++) texts[`b${i}`] = `item ${i}`;
		const src = source(texts);
		const ix = new LocalSwitcherIndex();
		expect(ix.search(src, "s1", "item", [], ALL)).toHaveLength(SWITCHER_LIMIT);
		expect(ix.stats.entries).toBe(SWITCHER_LIMIT + 10);
		texts.extra = "zebra";
		expect(ix.search(src, "s1", "zebra", [], ALL)).toHaveLength(0);
		ix.invalidate();
		expect(ix.search(src, "s1", "zebra", [], ALL).map((h) => h.blockId)).toEqual(["extra"]);
		const other = source({ q: "zebra crossing" }, "page2");
		expect(ix.search(other, "s1", "zebra", [], ALL)[0]).toMatchObject({
			blockId: "q",
			pageId: "page2",
		});
	});
});

describe("incremental index", () => {
	test("warm parses in slices; a search after it parses nothing; an edit reparses one block", () => {
		const texts: Record<string, string> = {};
		for (let i = 0; i < 50; i++) texts[`b${i}`] = `**block** ${i}`;
		const src = source(texts);
		const ix = new LocalSwitcherIndex();
		// A zero budget still makes progress: one block per slice.
		let slices = 1;
		while (!ix.warm(src, 0)) slices++;
		expect(slices).toBeGreaterThan(1);
		expect(slices).toBeLessThanOrEqual(51);
		expect(ix.search(src, "s1", "block 7", [], ALL).map((h) => h.blockId)).toEqual(["b7"]);
		expect(ix.stats.parsed).toBe(0);
		expect(ix.stats.entries).toBe(50);
		texts.b3 = "renamed";
		ix.invalidate();
		expect(ix.search(src, "s1", "renamed", [], ALL).map((h) => [h.blockId, h.via])).toEqual([
			["b3", "title"],
		]);
		expect(ix.stats.parsed).toBe(1);
		// A deleted block leaves the index.
		delete texts.b3;
		ix.invalidate();
		expect(ix.search(src, "s1", "renamed", [], ALL)).toEqual([]);
		expect(ix.stats.entries).toBe(49);
	});

	test("a search parses only within its budget; the next one goes on", () => {
		const texts: Record<string, string> = {};
		for (let i = 0; i < 40; i++) texts[`b${i}`] = `entry ${i}`;
		const src = source(texts);
		const ix = new LocalSwitcherIndex();
		// No time to parse: nothing local yet (the server's search still answers).
		expect(ix.search(src, "s1", "entry 7", [], 0)).toEqual([]);
		expect(ix.stats.left).toBe(40);
		expect(ix.search(src, "s1", "entry 7", [], ALL).map((h) => h.blockId)).toEqual(["b7"]);
		expect(ix.stats.left).toBe(0);
		expect(ix.stats.entries).toBe(40);
	});

	test("another page starts over", () => {
		const ix = new LocalSwitcherIndex();
		const a = source({ x: "same text" }, "pa");
		expect(ix.warm(a, 100)).toBe(true);
		const b = source({ x: "same text" }, "pb");
		expect(ix.search(b, "s1", "same", [])[0]?.pageId).toBe("pb");
		expect(ix.stats.parsed).toBe(1);
	});
});

describe("server hits", () => {
	test("an alias equal to the query is an alias hit; else title or body", () => {
		expect(serverHit(server({ alias: "Roadmap", title: "Plan" }), " roadmap ").via).toBe("alias");
		expect(serverHit(server({ alias: "Roadmap2", title: "The roadmap" }), "roadmap").via).toBe(
			"title",
		);
		const body = serverHit(server({ title: "", snippet: "…roadmap…" }), "roadmap");
		expect(body.via).toBe("body");
		expect(body.label).toBe("…roadmap…");
		expect(body.local).toBe(false);
	});

	test("merge: local first, then this space, then other spaces, each block once", () => {
		const hit = (blockId: string, spaceId: string, local = false): SwitcherHit => ({
			blockId,
			pageId: "p",
			spaceId,
			label: blockId,
			via: "title",
			path: [],
			local,
		});
		const merged = mergeSwitcherHits(
			[hit("l1", "s1", true), hit("l2", "s1", true)],
			[hit("o1", "s2"), hit("l1", "s1"), hit("h1", "s1"), hit("o2", "s3"), hit("h2", "s1")],
			"s1",
		);
		expect(merged.map((h) => h.blockId)).toEqual(["l1", "l2", "h1", "h2", "o1", "o2"]);
		expect(merged[0]?.local).toBe(true);
		expect(mergeSwitcherHits([hit("a", "s1", true)], [hit("b", "s1")], "s1", 1)).toHaveLength(1);
	});
});
