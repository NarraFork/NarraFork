import { describe, expect, test } from "bun:test";
import type { OutlineCommitSummary, OutlineViewBlock } from "@shared/outline-api";
import { OUTLINE_RECENTS_MAX, parseOutlineRecents, withOutlineRecent } from "./outline-recents";
import {
	parseOutlineBlockSearch,
	spaceLabelKey,
	timelineOldestFirst,
	timelinePosition,
	visibleRows,
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

describe("visible rows", () => {
	const view = {
		rootId: "root",
		blocks: [
			block("root", ["a", "b"]),
			block("a", ["a1", "a2"]),
			block("b", [], { hidden: 3 }),
			block("a1", ["a1x"]),
			block("a2"),
			block("a1x"),
		],
	};

	test("depth first from the root's children, the root itself left out", () => {
		expect(visibleRows(view, new Set()).map((r) => [r.block.id, r.depth])).toEqual([
			["a", 0],
			["a1", 1],
			["a1x", 2],
			["a2", 1],
			["b", 0],
		]);
	});

	test("a collapsed block hides its subtree; blocks with only hidden children can collapse", () => {
		const rows = visibleRows(view, new Set(["a", "b", "a2"]));
		expect(rows.map((r) => r.block.id)).toEqual(["a", "b"]);
		expect(rows.find((r) => r.block.id === "b")).toMatchObject({
			hasChildren: true,
			collapsed: true,
		});
		// A leaf is never collapsed, whatever the set says.
		expect(visibleRows(view, new Set(["a2"])).find((r) => r.block.id === "a2")?.collapsed).toBe(
			false,
		);
		expect(visibleRows({ rootId: "missing", blocks: view.blocks }, new Set())).toEqual([]);
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
