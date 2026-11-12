/**
 * Guards the geometry rules for dropping into the sidebar (internal drags and external
 * narrators alike).
 *
 * Every rule here fails silently if it regresses: the drop still succeeds, it just lands
 * somewhere the user did not aim — a merge instead of a reorder, a tab inside a folder
 * instead of next to it, or a break in the positional pinned-section invariant.
 */

import { describe, expect, test } from "bun:test";
import {
	type RecentTabDropRow,
	type RecentTabDropSource,
	recentTabDropHighlight,
	recentTabDropIndicatorRow,
	resolveRecentTabDropTarget,
} from "./recent-tab-drop-target";

const H = 40;

function row(
	index: number,
	key: string,
	overrides: Partial<Omit<RecentTabDropRow, "key" | "top" | "bottom">> = {},
): RecentTabDropRow {
	return {
		key,
		top: index * H,
		bottom: index * H + H,
		kind: "tab",
		pinned: false,
		canNest: key.startsWith("narrator:") || key.startsWith("subagent:"),
		...overrides,
	};
}

const top = (index: number) => index * H + 4;
const middle = (index: number) => index * H + 20;
const bottom = (index: number) => index * H + 36;

const narratorSource = (key = "narrator:x"): RecentTabDropSource => ({
	key,
	kind: "tab",
	pinned: false,
	canNest: true,
});

/** [a] [folder f: m1, m2] [b] */
function folderRows(): RecentTabDropRow[] {
	return [
		row(0, "narrator:a"),
		row(1, "folder:f", { kind: "folder", folderId: "f", canNest: false }),
		row(2, "narrator:m1", { kind: "member", folderId: "f" }),
		row(3, "narrator:m2", { kind: "member", folderId: "f" }),
		row(4, "narrator:b"),
	];
}

describe("resolveRecentTabDropTarget", () => {
	test("edges of a tab place before/after, the middle merges", () => {
		const rows = [row(0, "narrator:a"), row(1, "narrator:b")];
		expect(resolveRecentTabDropTarget(rows, top(1), narratorSource())).toEqual({
			kind: "before",
			key: "narrator:b",
		});
		expect(resolveRecentTabDropTarget(rows, bottom(1), narratorSource())).toEqual({
			kind: "after",
			key: "narrator:b",
		});
		expect(resolveRecentTabDropTarget(rows, middle(1), narratorSource())).toEqual({
			kind: "merge",
			key: "narrator:b",
		});
	});

	test("a project tab never merges and never receives a merge", () => {
		const rows = [row(0, "project:p"), row(1, "narrator:b")];
		expect(resolveRecentTabDropTarget(rows, middle(0), narratorSource())).toMatchObject({
			kind: "after",
		});
		const project: RecentTabDropSource = {
			key: "project:q",
			kind: "tab",
			pinned: false,
			canNest: false,
		};
		expect(resolveRecentTabDropTarget(rows, middle(1), project)).toMatchObject({
			kind: "after",
			key: "narrator:b",
		});
	});

	test("an empty list resolves to the anchor-free target", () => {
		expect(resolveRecentTabDropTarget([], 10, narratorSource())).toEqual({ kind: "empty" });
	});

	test("dropping a tab onto its own row is a no-op", () => {
		const rows = [row(0, "narrator:x")];
		expect(resolveRecentTabDropTarget(rows, middle(0), narratorSource())).toBeNull();
	});

	test("the middle of a folder header joins it; its lower edge is the first member slot", () => {
		const rows = folderRows();
		expect(resolveRecentTabDropTarget(rows, middle(1), narratorSource())).toEqual({
			kind: "into-folder",
			folderId: "f",
		});
		expect(resolveRecentTabDropTarget(rows, bottom(1), narratorSource())).toEqual({
			kind: "member-before",
			folderId: "f",
			key: "narrator:m1",
		});
		expect(resolveRecentTabDropTarget(rows, top(1), narratorSource())).toEqual({
			kind: "before",
			key: "folder:f",
		});
	});

	test("between members is an in-folder slot, never a merge", () => {
		const rows = folderRows();
		expect(resolveRecentTabDropTarget(rows, middle(2), narratorSource())).toEqual({
			kind: "member-after",
			folderId: "f",
			key: "narrator:m1",
		});
		expect(resolveRecentTabDropTarget(rows, top(3), narratorSource())).toEqual({
			kind: "member-before",
			folderId: "f",
			key: "narrator:m2",
		});
	});

	test("the pinned/unpinned boundary inside a folder resolves to the unpinned side", () => {
		const rows = [
			row(0, "folder:f", { kind: "folder", folderId: "f", canNest: false }),
			row(1, "narrator:p", { kind: "member", folderId: "f", memberPinned: true }),
			row(2, "narrator:u", { kind: "member", folderId: "f" }),
		];
		expect(resolveRecentTabDropTarget(rows, bottom(1), narratorSource())).toEqual({
			kind: "member-before",
			folderId: "f",
			key: "narrator:u",
		});
		expect(resolveRecentTabDropTarget(rows, top(1), narratorSource())).toEqual({
			kind: "member-before",
			folderId: "f",
			key: "narrator:p",
		});
	});

	test("a dragged folder moves around whole units and never nests", () => {
		const rows = [
			...folderRows(),
			row(5, "folder:g", { kind: "folder", folderId: "g", canNest: false }),
		];
		const folder: RecentTabDropSource = {
			key: "folder:g",
			kind: "folder",
			pinned: false,
			folderId: "g",
			canNest: false,
		};
		expect(resolveRecentTabDropTarget(rows, middle(1), folder)).toMatchObject({ kind: "after" });
		// Over a member of another folder: placed around that whole folder.
		expect(resolveRecentTabDropTarget(rows, top(2), folder)).toEqual({
			kind: "before",
			key: "folder:f",
		});
		expect(resolveRecentTabDropTarget(rows, middle(0), folder)).toMatchObject({
			kind: expect.stringMatching(/before|after/),
			key: "narrator:a",
		});
	});

	test("its own members are not targets while a folder is dragged", () => {
		const rows = folderRows();
		const folder: RecentTabDropSource = {
			key: "folder:f",
			kind: "folder",
			pinned: false,
			folderId: "f",
			canNest: false,
		};
		// m1/m2 are skipped, so the pointer over them falls in a gap after `a`.
		expect(resolveRecentTabDropTarget(rows, middle(2), folder)).toEqual({
			kind: "after",
			key: "narrator:a",
		});
	});

	test("dragging across the pin divider pins or unpins, at the slot aimed at", () => {
		const rows = [
			row(0, "narrator:p1", { pinned: true }),
			row(1, "narrator:p2", { pinned: true }),
			row(2, "narrator:a"),
			row(3, "narrator:b"),
		];
		// An unpinned tab aimed into the pinned block is pinned there.
		expect(resolveRecentTabDropTarget(rows, top(0), narratorSource())).toEqual({
			kind: "before",
			key: "narrator:p1",
			pinned: true,
		});
		expect(resolveRecentTabDropTarget(rows, top(1), narratorSource())).toEqual({
			kind: "before",
			key: "narrator:p2",
			pinned: true,
		});
		// A pinned tab aimed into the unpinned block is unpinned there.
		const pinned: RecentTabDropSource = { ...narratorSource(), pinned: true };
		expect(resolveRecentTabDropTarget(rows, bottom(3), pinned)).toEqual({
			kind: "after",
			key: "narrator:b",
			pinned: false,
		});
		// Within its own block nothing changes.
		expect(resolveRecentTabDropTarget(rows, bottom(2), narratorSource())).toEqual({
			kind: "after",
			key: "narrator:a",
		});
	});

	test("the divider line itself is the unpinned side", () => {
		const rows = [
			row(0, "narrator:p1", { pinned: true }),
			row(1, "narrator:a"),
			row(2, "narrator:b"),
		];
		// Lower half of the last pinned row: the line above the first unpinned one,
		// written as the slot before it ("after the last pinned" is the same boundary).
		expect(resolveRecentTabDropTarget(rows, bottom(0), narratorSource())).toEqual({
			kind: "before",
			key: "narrator:a",
		});
		const pinned: RecentTabDropSource = { ...narratorSource("narrator:p0"), pinned: true };
		expect(resolveRecentTabDropTarget(rows, bottom(0), pinned)).toEqual({
			kind: "before",
			key: "narrator:a",
			pinned: false,
		});
		// Its upper half is still in the pinned block.
		expect(resolveRecentTabDropTarget(rows, top(0), narratorSource())).toEqual({
			kind: "before",
			key: "narrator:p1",
			pinned: true,
		});
	});

	test("above the measured divider pins even when no pinned unit is rendered yet", () => {
		const rows = [row(0, "narrator:a"), row(1, "narrator:b")];
		const divider = { top: -10, bottom: -2 };
		expect(resolveRecentTabDropTarget(rows, -8, narratorSource(), divider)).toEqual({
			kind: "before",
			key: "narrator:a",
			pinned: true,
		});
		// Below the same divider stays unpinned.
		expect(resolveRecentTabDropTarget(rows, bottom(1), narratorSource(), divider)).toEqual({
			kind: "after",
			key: "narrator:b",
		});
	});

	test("below every row anchors after the last unit", () => {
		const rows = folderRows();
		expect(resolveRecentTabDropTarget(rows, 1000, narratorSource())).toEqual({
			kind: "after",
			key: "narrator:b",
		});
	});
});

describe("indicator geometry", () => {
	test("after a folder draws under its last visible member", () => {
		const rows = folderRows();
		expect(recentTabDropIndicatorRow(rows, { kind: "after", key: "folder:f" })).toEqual({
			row: rows[3],
			side: "bottom",
		});
	});

	test("merge highlights one row, joining highlights the whole folder", () => {
		const rows = folderRows();
		expect(recentTabDropHighlight(rows, { kind: "merge", key: "narrator:a" })).toEqual({
			top: 0,
			bottom: H,
		});
		expect(recentTabDropHighlight(rows, { kind: "into-folder", folderId: "f" })).toEqual({
			top: H,
			bottom: 4 * H,
		});
		expect(recentTabDropHighlight(rows, { kind: "before", key: "narrator:a" })).toBeNull();
	});
});
