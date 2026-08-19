/**
 * Guards the grouping RULES, which are the part of directory mode that can go wrong
 * silently: a mis-grouped tab still renders and still navigates, it just claims to live in
 * a directory it does not, and nobody notices until they trust the grouping.
 */

import { describe, expect, it } from "bun:test";
import {
	aggregateDirectoryStatus,
	buildDirectoryDragInfo,
	directoryLabel,
	directoryRowId,
	directoryRowKeyBlock,
	groupRecentTabsByDirectory,
	moveDirectoryRow,
	normalizeTabDirectory,
	type RecentTabRow,
	resolveDirectoryDropTarget,
} from "./recent-tab-directory-groups";
import type { RecentTab } from "./recent-tabs-utils";

function tab(overrides: Partial<RecentTab> & Pick<RecentTab, "id">): RecentTab {
	return {
		type: "narrator",
		title: `Tab ${overrides.id}`,
		lastVisitedAt: 1,
		...overrides,
	} as RecentTab;
}

/** Compact view of the produced rows, so assertions read as the rendered outcome. */
function shape(rows: RecentTabRow[]): string[] {
	return rows.map((row) => {
		if (row.kind === "tab") return `tab:${row.tab.id}`;
		if (row.kind === "workspace") {
			return `ws:${row.tab.id}[${row.children.map((c) => c.id).join(",")}]`;
		}
		return `dir:${row.path}[${row.children.map((c) => c.id).join(",")}]`;
	});
}

describe("normalizeTabDirectory", () => {
	it("folds separators and trailing slashes so one directory has one key", () => {
		expect(normalizeTabDirectory("C:\\work\\repo\\")).toBe("C:/work/repo");
		expect(normalizeTabDirectory("/home/me/repo/")).toBe("/home/me/repo");
		expect(normalizeTabDirectory("  /home/me/repo  ")).toBe("/home/me/repo");
	});

	it("keeps the filesystem root intact rather than emptying it", () => {
		expect(normalizeTabDirectory("/")).toBe("/");
	});

	it("returns null for absent or blank subtitles", () => {
		expect(normalizeTabDirectory(undefined)).toBeNull();
		expect(normalizeTabDirectory("")).toBeNull();
		expect(normalizeTabDirectory("   ")).toBeNull();
	});

	it("does NOT fold case — that would merge two directories on a case-sensitive fs", () => {
		expect(normalizeTabDirectory("/home/Repo")).not.toBe(normalizeTabDirectory("/home/repo"));
	});
});

describe("groupRecentTabsByDirectory", () => {
	it("merges narrators sharing a directory into one group", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "a", subtitle: "/w/repo" }),
			tab({ id: "b", subtitle: "/w/repo" }),
		]);
		expect(shape(rows)).toEqual(["dir:/w/repo[a,b]"]);
		expect(rows[0].kind === "directory" && rows[0].label).toBe("repo");
	});

	it("leaves a lone narrator flat — a header per tab would double the rows for nothing", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "a", subtitle: "/w/one" }),
			tab({ id: "b", subtitle: "/w/two" }),
		]);
		expect(shape(rows)).toEqual(["tab:a", "tab:b"]);
	});

	it("groups subagents together with narrators in the same directory", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "n", subtitle: "/w/repo" }),
			tab({ id: "s", type: "subagent", subtitle: "/w/repo" }),
		]);
		expect(shape(rows)).toEqual(["dir:/w/repo[n,s]"]);
	});

	it("never groups chapter tabs: their subtitle is a TITLE, not a path", () => {
		// Two chapters that happen to share a title must not be presented as one directory.
		const rows = groupRecentTabsByDirectory([
			tab({ id: "c1", type: "chapter", narratorId: "n1", subtitle: "Refactor auth" }),
			tab({ id: "c2", type: "chapter", narratorId: "n2", subtitle: "Refactor auth" }),
		]);
		expect(shape(rows)).toEqual(["tab:c1", "tab:c2"]);
	});

	it("never groups project tabs, and folds workspace children into their unit", () => {
		const wsChildren = new Map([
			["w1", [tab({ id: "c1", workspaceId: "w1" }), tab({ id: "c2", workspaceId: "w1" })]],
		]);
		const rows = groupRecentTabsByDirectory(
			[
				tab({ id: "p1", type: "project", subtitle: "/w/repo" }),
				tab({ id: "p2", type: "project", subtitle: "/w/repo" }),
				tab({ id: "w1", type: "workspace" }),
				tab({ id: "w2", type: "workspace" }),
			],
			wsChildren,
		);
		expect(shape(rows)).toEqual(["tab:p1", "tab:p2", "ws:w1[c1,c2]", "ws:w2[]"]);
	});

	it("leaves narrators without a cwd flat", () => {
		const rows = groupRecentTabsByDirectory([tab({ id: "a" }), tab({ id: "b" })]);
		expect(shape(rows)).toEqual(["tab:a", "tab:b"]);
	});

	it("places a group at its FIRST member's position, preserving recency order", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "solo", subtitle: "/w/other" }),
			tab({ id: "a", subtitle: "/w/repo" }),
			tab({ id: "mid", subtitle: "/w/elsewhere" }),
			tab({ id: "b", subtitle: "/w/repo" }),
		]);
		expect(shape(rows)).toEqual(["tab:solo", "dir:/w/repo[a,b]", "tab:mid"]);
	});

	it("treats separator variants of one directory as the same group", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "a", subtitle: "C:\\w\\repo" }),
			tab({ id: "b", subtitle: "C:/w/repo/" }),
		]);
		expect(shape(rows)).toEqual(["dir:C:/w/repo[a,b]"]);
	});

	it("keeps directory row ids out of the tab-key namespace", () => {
		// Tab keys are `${type}:${id}`, and no RecentTabType is "dir".
		expect(directoryRowId("/w/repo")).toBe("dir:/w/repo");
	});

	it("labels a group by its last segment, falling back to the whole path", () => {
		expect(directoryLabel("/w/repo")).toBe("repo");
		expect(directoryLabel("/")).toBe("/");
	});
});

describe("aggregateDirectoryStatus", () => {
	it("reports counts so a collapsed group cannot hide activity", () => {
		const summary = aggregateDirectoryStatus([
			tab({ id: "a", status: "working" }),
			tab({ id: "b", status: "working" }),
			tab({ id: "c", status: "waiting" }),
			tab({ id: "d", status: "idle" }),
		]);
		expect(summary.workingCount).toBe(2);
		expect(summary.attentionCount).toBe(1);
	});

	it("lets an attention state outrank working for the row colour", () => {
		// The blocked narrator is the only member that will not progress on its own, so
		// the collapsed row must read as blocked rather than busy.
		const waiting = aggregateDirectoryStatus([
			tab({ id: "a", status: "working" }),
			tab({ id: "b", status: "waiting" }),
		]);
		const workingOnly = aggregateDirectoryStatus([tab({ id: "a", status: "working" })]);
		expect(waiting.accentColor).not.toBe(workingOnly.accentColor);
		expect(waiting.accentColor).toBe(
			aggregateDirectoryStatus([tab({ id: "x", status: "waiting" })]).accentColor,
		);
	});

	it("ranks an errored member above a waiting one", () => {
		const summary = aggregateDirectoryStatus([
			tab({ id: "a", status: "waiting" }),
			tab({ id: "b", status: "idle", substatus: ["error"] }),
		]);
		expect(summary.attentionCount).toBe(2);
		expect(summary.accentColor).toBe(
			aggregateDirectoryStatus([tab({ id: "x", status: "idle", substatus: ["error"] })])
				.accentColor,
		);
	});

	it("counts unread as attention", () => {
		const summary = aggregateDirectoryStatus([
			tab({ id: "a", status: "idle", substatus: ["unread"] }),
		]);
		expect(summary.attentionCount).toBe(1);
	});

	it("has no accent when every member is idle with no tags", () => {
		const summary = aggregateDirectoryStatus([
			tab({ id: "a", status: "idle" }),
			tab({ id: "b", status: "idle" }),
		]);
		expect(summary.workingCount).toBe(0);
		expect(summary.attentionCount).toBe(0);
	});
});

/**
 * A reusable fixture: one directory group [a,b], one plain tab, one workspace unit.
 * Ids double as sortable ids (`narrator:a` etc.), matching `tabSortId` in the sidebar.
 */
function fixtureRows(): RecentTabRow[] {
	return groupRecentTabsByDirectory(
		[
			tab({ id: "a", subtitle: "/w/repo" }),
			tab({ id: "solo", subtitle: "/w/elsewhere" }),
			tab({ id: "w1", type: "workspace" }),
			tab({ id: "b", subtitle: "/w/repo" }),
		],
		new Map([["w1", [tab({ id: "wc", workspaceId: "w1" })]]]),
	);
}

describe("moveDirectoryRow", () => {
	it("lands before the target when dragged up, after it when dragged down", () => {
		// Rows: dir[a,b], tab:solo, ws:w1[wc]. solo sits BELOW the group, so dragging it
		// onto the group header is a drag UP and lands before the group.
		const up = moveDirectoryRow(fixtureRows(), "narrator:solo", "dir:/w/repo");
		expect(shape(up ?? [])).toEqual(["tab:solo", "dir:/w/repo[a,b]", "ws:w1[wc]"]);
		// Dragging the group DOWN onto solo lands after it.
		const down = moveDirectoryRow(fixtureRows(), "dir:/w/repo", "narrator:solo");
		expect(shape(down ?? [])).toEqual(["tab:solo", "dir:/w/repo[a,b]", "ws:w1[wc]"]);
	});

	it("moves a whole group past a workspace unit as one block", () => {
		const next = moveDirectoryRow(fixtureRows(), "dir:/w/repo", "workspace:w1");
		expect(shape(next ?? [])).toEqual(["tab:solo", "ws:w1[wc]", "dir:/w/repo[a,b]"]);
		expect(directoryRowKeyBlock((next ?? [])[2])).toEqual(["narrator:a", "narrator:b"]);
	});

	it("reorders members inside their own group", () => {
		const next = moveDirectoryRow(fixtureRows(), "narrator:b", "narrator:a");
		expect(shape(next ?? [])).toEqual(["dir:/w/repo[b,a]", "tab:solo", "ws:w1[wc]"]);
	});

	it("drops a member onto its own header as 'first position'", () => {
		const next = moveDirectoryRow(fixtureRows(), "narrator:b", "dir:/w/repo");
		expect(shape(next ?? [])[0]).toBe("dir:/w/repo[b,a]");
	});

	it("refuses to move a member out of its group — cwd, not position, defines membership", () => {
		expect(moveDirectoryRow(fixtureRows(), "narrator:a", "narrator:solo")).toBeNull();
		expect(moveDirectoryRow(fixtureRows(), "narrator:a", "workspace:w1")).toBeNull();
	});

	it("refuses to move a workspace child directly — the workspace is one unit", () => {
		expect(moveDirectoryRow(fixtureRows(), "narrator:wc", "narrator:solo")).toBeNull();
	});

	it("refuses no-op drops onto the same unit", () => {
		expect(moveDirectoryRow(fixtureRows(), "dir:/w/repo", "narrator:a")).toBeNull();
		expect(moveDirectoryRow(fixtureRows(), "narrator:solo", "narrator:solo")).toBeNull();
	});
});

describe("resolveDirectoryDropTarget", () => {
	it("anchors an outsider hovering a member to the member's group header", () => {
		expect(resolveDirectoryDropTarget(fixtureRows(), "narrator:solo", "narrator:a")).toBe(
			"dir:/w/repo",
		);
		expect(resolveDirectoryDropTarget(fixtureRows(), "workspace:w1", "narrator:b")).toBe(
			"dir:/w/repo",
		);
	});

	it("keeps same-group hovers on the member so within-group reorder works", () => {
		expect(resolveDirectoryDropTarget(fixtureRows(), "narrator:a", "narrator:b")).toBe(
			"narrator:b",
		);
	});

	it("bounces a member hovering outside its group back to itself", () => {
		expect(resolveDirectoryDropTarget(fixtureRows(), "narrator:a", "narrator:solo")).toBe(
			"narrator:a",
		);
	});

	it("bounces a group hovering its own member back to itself", () => {
		expect(resolveDirectoryDropTarget(fixtureRows(), "dir:/w/repo", "narrator:a")).toBe(
			"dir:/w/repo",
		);
	});
});

describe("buildDirectoryDragInfo", () => {
	it("classifies every sortable id in the list", () => {
		const info = buildDirectoryDragInfo(fixtureRows());
		expect(info.get("narrator:a")).toEqual({ role: "dirMember", rowIndex: 0 });
		expect(info.get("dir:/w/repo")).toEqual({ role: "dirHeader", rowIndex: 0 });
		expect(info.get("narrator:solo")).toEqual({ role: "plain", rowIndex: 1 });
		expect(info.get("workspace:w1")).toEqual({ role: "wsHeader", rowIndex: 2 });
		expect(info.get("narrator:wc")).toEqual({ role: "wsChild", rowIndex: 2 });
	});
});
