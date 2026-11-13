import { describe, expect, test } from "bun:test";
import type { OutlineSearchHitView, OutlineSpaceSummary } from "@shared/outline-api";
import { buildSearchTree, flattenSearchTree, markTerms, searchTerms } from "./search-tree";
import {
	LOCATE_PENDING_MS,
	locateKeys,
	requestTreeLocate,
	type TreeLocateTarget,
	takeTreeLocate,
} from "./tree-locate";
import { parseTreeAnchor } from "./tree-scroll";

function hit(
	blockId: string,
	spaceId: string,
	path: Array<[string, string]>,
	extra: Partial<OutlineSearchHitView> = {},
): OutlineSearchHitView {
	return {
		blockId,
		spaceId,
		pageId: path[0]?.[0] ?? blockId,
		address: `k/${blockId}`,
		alias: null,
		title: `title ${blockId}`,
		snippet: `snippet ${blockId}`,
		path: path.map(([, title]) => title),
		pathIds: path.map(([id]) => id),
		process: false,
		...extra,
	};
}

const space = (id: string, kind: OutlineSpaceSummary["kind"]): OutlineSpaceSummary => ({
	id,
	key: `${kind}:${id}`,
	kind,
	projectId: kind === "project" ? `p-${id}` : null,
	narratorId: kind === "session" ? `n-${id}` : null,
	label: id,
	mine: kind === "personal",
	orphaned: false,
	lastSeq: 1,
});

describe("a search as a tree", () => {
	test("hits hang under their space, page and ancestors, each drawn once", () => {
		const tree = buildSearchTree(
			[
				hit("b1", "S1", [
					["pg", "Tasks"],
					["t1", "Fix the race"],
				]),
				hit("b2", "S1", [
					["pg", "Tasks"],
					["t1", "Fix the race"],
				]),
				hit("t1", "S1", [["pg", "Tasks"]]),
				hit("pg2", "S2", []),
				hit("b1", "S1", [["pg", "Tasks"]]),
			],
			[space("S1", "project"), space("S2", "personal")],
		);
		const rows = flattenSearchTree(tree).map(
			({ node, depth }) => `${depth} ${node.kind} ${node.key}${node.hit ? " *" : ""}`,
		);
		expect(rows).toEqual([
			"0 space space:S1",
			"1 page pg",
			"2 block t1 *",
			"3 block b1 *",
			"3 block b2 *",
			"0 space space:S2",
			"1 page pg2 *",
		]);
		expect(tree[0]?.space?.kind).toBe("project");
		// An ancestor that is a hit too takes the hit's title.
		expect(tree[0]?.children[0]?.children[0]?.title).toBe("title t1");
	});

	test("a hit without ancestor ids hangs under its space", () => {
		const old = { ...hit("b", "S", [["pg", "Page"]]), pathIds: undefined };
		const rows = flattenSearchTree(buildSearchTree([old], [])).map(
			({ node, depth }) => `${depth} ${node.kind} ${node.key}`,
		);
		expect(rows).toEqual(["0 space space:S", "1 block b"]);
	});

	test("terms are marked wherever they occur, whatever their case", () => {
		expect(searchTerms("  Race  the race ")).toEqual(["race", "the"]);
		expect(markTerms("The RACE is in the reader", ["race"])).toEqual([
			{ text: "The ", match: false },
			{ text: "RACE", match: true },
			{ text: " is in the reader", match: false },
		]);
		expect(markTerms("竞态在读取里", ["竞态"])).toEqual([
			{ text: "竞态", match: true },
			{ text: "在读取里", match: false },
		]);
		expect(markTerms("nothing", [])).toEqual([{ text: "nothing", match: false }]);
		expect(markTerms("", ["x"])).toEqual([]);
	});
});

describe("locating in the tree", () => {
	const target: TreeLocateTarget = {
		spaceId: "S",
		pageId: "pg",
		blockId: "b",
		pathIds: ["pg"],
		pageTitle: "Page",
	};

	test("the keys to open, by where the space hangs", () => {
		const session = {
			id: "S",
			kind: "session",
			projectId: null,
			mine: false,
			orphaned: false,
		} as const;
		expect(locateKeys(session, { spaceId: "PS", projectId: "P" }, "pg", null)).toEqual({
			keys: ["space:PS", "group:sessions:P", "space:S", "page:pg"],
			pinIn: "group:sessions:P",
		});
		expect(locateKeys(session, null, "pg", null)).toEqual({
			keys: ["group:loose", "space:S", "page:pg"],
			pinIn: "group:loose",
		});
		const project = {
			id: "PS",
			kind: "project",
			projectId: "P",
			mine: false,
			orphaned: false,
		} as const;
		expect(locateKeys(project, null, "pg", null)).toEqual({
			keys: ["space:PS", "page:pg"],
			pinIn: "root",
		});
		const mine = {
			id: "M",
			kind: "personal",
			projectId: null,
			mine: true,
			orphaned: false,
		} as const;
		expect(locateKeys(mine, null, "pg", null)?.keys).toEqual(["space:M", "page:pg"]);
		expect(locateKeys({ ...mine, mine: false }, null, "pg", null)).toBeNull();
		expect(locateKeys({ ...session, orphaned: true }, null, "pg", null)?.keys[0]).toBe(
			"group:orphaned",
		);
	});

	test("in a tree rooted at a space: its own pages, its sessions, nothing else", () => {
		const project = {
			id: "PS",
			kind: "project",
			projectId: "P",
			mine: false,
			orphaned: false,
		} as const;
		const root = { spaceId: "PS", projectId: "P" };
		expect(locateKeys(project, null, "pg", root)).toEqual({ keys: ["page:pg"], pinIn: null });
		const session = {
			id: "S",
			kind: "session",
			projectId: null,
			mine: false,
			orphaned: false,
		} as const;
		expect(locateKeys(session, { spaceId: "PS", projectId: "P" }, "pg", root)?.keys).toEqual([
			"group:sessions:P",
			"space:S",
			"page:pg",
		]);
		expect(locateKeys(session, { spaceId: "other", projectId: "Q" }, "pg", root)).toBeNull();
	});

	test("a request waits for its host's tree, is taken once, and goes stale", () => {
		requestTreeLocate("page", target, 1000);
		expect(takeTreeLocate("panel", 1001)).toBeNull();
		expect(takeTreeLocate("page", 1001)).toEqual(target);
		expect(takeTreeLocate("page", 1002)).toBeNull();
		requestTreeLocate("page", target, 1000);
		expect(takeTreeLocate("page", 1001 + LOCATE_PENDING_MS)).toBeNull();
	});
});

describe("the scroll anchor", () => {
	test("only a well-formed anchor is read back", () => {
		expect(parseTreeAnchor('{"key":"space:a","offset":12.4}')).toEqual({
			key: "space:a",
			offset: 12,
		});
		for (const bad of [null, "", "x", "[]", '{"key":"","offset":1}', '{"key":"a","offset":"1"}']) {
			expect(parseTreeAnchor(bad)).toBeNull();
		}
	});
});
