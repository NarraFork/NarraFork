/**
 * Guards the grouping RULES, which are the part of directory mode that can go wrong
 * silently: a mis-grouped tab still renders and still navigates, it just claims to live in
 * a directory it does not, and nobody notices until they trust the grouping.
 */

import { describe, expect, it } from "bun:test";
import {
	aggregateDirectoryStatus,
	applyDirectoryMemberOrder,
	directoryLabel,
	directoryRowId,
	directoryRowKeyBlock,
	groupRecentTabsByDirectory,
	normalizeTabDirectory,
	type RecentTabRow,
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
 * `dirSortOrder` is the column that made hand-ordering survive at all: the flat order it
 * used to be expressed through is rewritten by the `above_idle` auto-promote on every
 * status change, so any arrangement stored there was wiped by the next narrator that
 * started working.
 */
describe("directory member ordering", () => {
	it("keeps recency order when no member was ever hand-ordered", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "a", subtitle: "/w/repo" }),
			tab({ id: "b", subtitle: "/w/repo" }),
			tab({ id: "c", subtitle: "/w/repo" }),
		]);
		expect(shape(rows)).toEqual(["dir:/w/repo[a,b,c]"]);
	});

	it("applies hand-arranged positions", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "a", subtitle: "/w/repo", dirSortOrder: 2 }),
			tab({ id: "b", subtitle: "/w/repo", dirSortOrder: 0 }),
			tab({ id: "c", subtitle: "/w/repo", dirSortOrder: 1 }),
		]);
		expect(shape(rows)).toEqual(["dir:/w/repo[b,c,a]"]);
	});

	/**
	 * Unordered members sort FIRST, not last. A member without a position is typically a
	 * brand-new narrator, and sorting it below older hand-placed rows would bury the newest
	 * session and read as "my new narrator did not show up".
	 */
	it("puts never-ordered members above hand-ordered ones, in recency order", () => {
		const rows = groupRecentTabsByDirectory([
			tab({ id: "old1", subtitle: "/w/repo", dirSortOrder: 0 }),
			tab({ id: "new1", subtitle: "/w/repo" }),
			tab({ id: "old2", subtitle: "/w/repo", dirSortOrder: 1 }),
			tab({ id: "new2", subtitle: "/w/repo" }),
		]);
		// new1/new2 keep their incoming (recency) order; old1/old2 keep their arrangement.
		expect(shape(rows)).toEqual(["dir:/w/repo[new1,new2,old1,old2]"]);
	});
});

describe("directoryRowKeyBlock", () => {
	it("keeps workspace and directory members together in visible order", () => {
		const rows = groupRecentTabsByDirectory(
			[
				tab({ id: "a", subtitle: "/w/repo" }),
				tab({ id: "w", type: "workspace" }),
				tab({ id: "b", subtitle: "/w/repo" }),
			],
			new Map([["w", [tab({ id: "child", workspaceId: "w" })]]]),
		);
		expect(rows.map(directoryRowKeyBlock)).toEqual([
			["narrator:a", "narrator:b"],
			["workspace:w", "narrator:child"],
		]);
	});
});

describe("applyDirectoryMemberOrder", () => {
	it("stamps positions from the key order and leaves the flat order alone", () => {
		const tabs = [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "outside" })];
		const next = applyDirectoryMemberOrder(tabs, ["narrator:b", "narrator:a"]);
		expect(next.map((t) => t.id)).toEqual(["a", "b", "outside"]);
		expect(next.find((t) => t.id === "b")?.dirSortOrder).toBe(0);
		expect(next.find((t) => t.id === "a")?.dirSortOrder).toBe(1);
	});
	it("leaves tabs outside the group untouched (same object identity)", () => {
		const outside = tab({ id: "outside" });
		const next = applyDirectoryMemberOrder([tab({ id: "a" }), outside], ["narrator:a"]);
		expect(next[1]).toBe(outside);
	});
	it("does not mutate the source order or positions", () => {
		const tabs = [tab({ id: "a", dirSortOrder: 0 }), tab({ id: "b", dirSortOrder: 1 })];
		const next = applyDirectoryMemberOrder(tabs, ["narrator:b", "narrator:a"]);
		expect(tabs.map((t) => t.dirSortOrder)).toEqual([0, 1]);
		expect(next.map((t) => t.dirSortOrder)).toEqual([1, 0]);
	});
});
