import { describe, expect, test } from "bun:test";
import type { OutlineCommitSummary, OutlineViewBlock } from "@shared/outline-api";
import { visibleFoldRows } from "@shared/outline-fold";
import { OUTLINE_RECENTS_MAX, parseOutlineRecents, withOutlineRecent } from "./outline-recents";
import {
	parseOutlineBlockSearch,
	spaceLabelKey,
	timelineOldestFirst,
	timelinePosition,
	viewFoldSource,
	viewFoldTree,
} from "./outline-view";

function block(id: string, childIds: string[] = [], extra: Partial<OutlineViewBlock> = {}) {
	return {
		id,
		sid: id,
		parentId: null,
		content: id,
		task: null,
		alias: null,
		tags: [],
		childIds,
		hidden: 0,
		processHidden: 0,
		openTasks: 0,
		inProgress: [],
		lock: null,
		pending: [],
		...extra,
	} satisfies OutlineViewBlock;
}

function commit(seq: number): OutlineCommitSummary {
	return {
		id: `c${seq}`,
		seq,
		kind: "edit",
		actorKind: "human",
		actorName: "alice",
		responsibleName: "alice",
		narratorId: null,
		createdAt: "2026-10-26T00:00:00.000Z",
		summary: "",
	};
}

describe("block page search", () => {
	test("keeps well-formed asOf and view only", () => {
		expect(parseOutlineBlockSearch({ asOf: "12", view: "all" })).toEqual({ asOf: 12, view: "all" });
		expect(parseOutlineBlockSearch({ asOf: 0 })).toEqual({ asOf: 0 });
		expect(parseOutlineBlockSearch({ asOf: "-1", view: "facts" })).toEqual({});
		expect(parseOutlineBlockSearch({ asOf: "1.5", view: "weird" })).toEqual({});
		expect(parseOutlineBlockSearch({ asOf: "x" })).toEqual({});
	});
});

describe("a view as the tree its folding is worked out on", () => {
	const view = {
		rootId: "root",
		blocks: [
			block("root", ["a", "t", "b"]),
			block("a", ["a1", "a2"]),
			block("t", ["n", "r", "q"], {
				task: { status: "doing", assignee: null, due: null, depends: [] },
			}),
			block("b", [], { hidden: 3 }),
			block("a1", ["a1x"]),
			block("a2"),
			block("n", ["n1"], { pending: ["chg1"] }),
			block("r", ["rh"], { content: "Report (generation 1 · 2026-11-09 17:38 UTC)" }),
			block("q", [], { question: { state: "open", proceed: false } }),
			block("a1x"),
			block("n1", [], {
				question: { state: "answered", proceed: false },
				lock: {
					blockId: "n1",
					by: { kind: "human", id: "u", name: "alice" },
					delegate: null,
					versionSeq: 1,
					canUnlock: false,
				},
			}),
			block("rh", ["rp"], { content: "## Findings" }),
			block("rp"),
		],
	};
	const none = { expanded: new Set<string>(), collapsed: new Set<string>() };
	const rowsOf = (v: Parameters<typeof viewFoldTree>[0], fold = none) => {
		const source = viewFoldSource(v);
		return visibleFoldRows(viewFoldTree(v, source, fold), source).rows;
	};

	test("depth first from the root's children, the root itself left out; facts stay open", () => {
		expect(rowsOf(view).map((r) => [r.node.id, r.depth])).toEqual([
			["a", 0],
			["a1", 1],
			["a1x", 2],
			["a2", 1],
			["t", 0],
			["n", 1],
			["r", 1],
			["q", 1],
			["b", 0],
		]);
	});

	test("tasks, reports, headings and marks are read from the blocks", () => {
		const source = viewFoldSource(view);
		expect(source.task("t")).toBe("doing");
		expect(source.task("a")).toBeNull();
		// A report is known by its line (or its id).
		expect(source.report("r")).toBe(true);
		expect(source.report("n")).toBe(false);
		expect(source.heading?.("rh")).toBe(true);
		expect(source.heading?.("rp")).toBe(false);
		expect(source.marks?.("q")).toEqual({ question: 1, pending: 0, locked: 0 });
		// An answered question is no mark; a lock is.
		expect(source.marks?.("n1")).toEqual({ question: 0, pending: 0, locked: 1 });
		expect(source.marks?.("n")).toEqual({ question: 0, pending: 1, locked: 0 });
		expect(source.marks?.("a")).toBeNull();
		expect(source.children("missing")).toEqual([]);
		const rows = rowsOf(view);
		expect(rows.find((r) => r.node.id === "n")?.hidden).toMatchObject({ locked: 1 });
		expect(rows.find((r) => r.node.id === "r")?.preview).toMatchObject({
			kind: "report",
			textId: "rp",
		});
	});

	test("the reader's folding goes over the default; a block whose children were not read cannot fold", () => {
		const rows = rowsOf(view, { expanded: new Set(["n"]), collapsed: new Set(["a", "b", "a2"]) });
		expect(rows.map((r) => r.node.id)).toEqual(["a", "t", "n", "n1", "r", "q", "b"]);
		expect(rows.find((r) => r.node.id === "b")?.node.open).toBe(false);
		expect(rows.find((r) => r.node.id === "b")?.node.kids).toEqual([]);
		expect(rowsOf({ rootId: "missing", blocks: view.blocks })).toEqual([]);
	});

	test("a root under a task makes its blocks details", () => {
		const focused = { rootId: "a", blocks: view.blocks };
		expect(rowsOf(focused).map((r) => r.node.id)).toEqual(["a1", "a1x", "a2"]);
		expect(rowsOf({ ...focused, rootInTask: true }).map((r) => r.node.id)).toEqual(["a1", "a2"]);
	});
});

describe("timeline", () => {
	test("pages of newest-first commits become one oldest-first list", () => {
		const commits = timelineOldestFirst([
			{ commits: [commit(9), commit(7)] },
			{ commits: [commit(7), commit(3)] },
		]);
		expect(commits.map((c) => c.seq)).toEqual([3, 7, 9]);
	});

	test("the position of a seq: the newest commit at or before it, and its neighbours", () => {
		const commits = [commit(3), commit(7), commit(9)];
		const at = (seq: number | undefined) => {
			const p = timelinePosition(commits, seq);
			return [p.previous?.seq ?? null, p.selected?.seq ?? null, p.next?.seq ?? null];
		};
		expect(at(undefined)).toEqual([7, 9, null]);
		expect(at(7)).toEqual([3, 7, 9]);
		expect(at(8)).toEqual([3, 7, 9]);
		expect(at(3)).toEqual([null, 3, 7]);
		expect(at(1)).toEqual([null, null, 3]);
		expect(timelinePosition([], undefined).selected).toBeNull();
	});
});

describe("space labels", () => {
	test("names come from the owner, with fallbacks for personal and orphaned spaces", () => {
		expect(spaceLabelKey({ kind: "personal", label: null, mine: true, orphaned: false })).toEqual({
			key: "space.personalMine",
		});
		expect(
			spaceLabelKey({ kind: "project", label: "Apollo", mine: false, orphaned: false }),
		).toEqual({ key: "space.project", values: { name: "Apollo" } });
		expect(spaceLabelKey({ kind: "project", label: null, mine: false, orphaned: true })).toEqual({
			key: "space.projectUnnamed",
		});
		expect(spaceLabelKey({ kind: "session", label: null, mine: false, orphaned: false })).toEqual({
			key: "space.sessionUnnamed",
		});
	});
});

describe("recents", () => {
	test("a visit goes first, replaces an older visit of the same block, and the list is capped", () => {
		let list = parseOutlineRecents(null);
		for (let i = 0; i < OUTLINE_RECENTS_MAX + 3; i++) {
			list = withOutlineRecent(list, {
				spaceId: "s",
				blockId: `b${i}`,
				title: `B${i}`,
				visitedAt: i,
			});
		}
		expect(list).toHaveLength(OUTLINE_RECENTS_MAX);
		list = withOutlineRecent(list, { spaceId: "s", blockId: "b5", title: "again", visitedAt: 99 });
		expect(list[0]).toEqual({ spaceId: "s", blockId: "b5", title: "again", visitedAt: 99 });
		expect(list.filter((r) => r.blockId === "b5")).toHaveLength(1);
	});

	test("malformed storage reads as empty or keeps only well-formed entries", () => {
		expect(parseOutlineRecents("not json")).toEqual([]);
		expect(parseOutlineRecents('{"a":1}')).toEqual([]);
		expect(
			parseOutlineRecents(
				JSON.stringify([{ spaceId: "s", blockId: "b", title: "t", visitedAt: 1 }, { blockId: 3 }]),
			),
		).toEqual([{ spaceId: "s", blockId: "b", title: "t", visitedAt: 1 }]);
	});
});
