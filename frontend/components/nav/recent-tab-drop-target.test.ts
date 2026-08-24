/**
 * Guards the geometry rules for dropping an EXTERNAL narrator into the sidebar.
 *
 * Every rule here fails silently if it regresses: the drop still succeeds, the tab still
 * appears, it just lands somewhere the user did not aim — or, in the pinned case, quietly
 * breaks the positional pinned-section invariant the server relies on.
 */

import { describe, expect, test } from "bun:test";
import {
	type RecentTabDropRow,
	recentTabDropIndicatorRow,
	recentTabWorkspaceBounds,
	resolveRecentTabDropTarget,
} from "./recent-tab-drop-target";

const ROW_HEIGHT = 40;

/** A row occupying `[index*40, index*40+40)`, so midpoints are index*40 + 20. */
function row(
	index: number,
	key: string,
	overrides: Partial<Omit<RecentTabDropRow, "key" | "top" | "bottom">> = {},
): RecentTabDropRow {
	return {
		key,
		top: index * ROW_HEIGHT,
		bottom: index * ROW_HEIGHT + ROW_HEIGHT,
		pinned: false,
		keyBlock: [key],
		...overrides,
	};
}

const upperHalf = (index: number) => index * ROW_HEIGHT + 5;
const lowerHalf = (index: number) => index * ROW_HEIGHT + 35;

describe("resolveRecentTabDropTarget", () => {
	test("upper half of a row anchors before it, lower half after it", () => {
		const rows = [row(0, "narrator:a"), row(1, "narrator:b")];
		expect(resolveRecentTabDropTarget(rows, upperHalf(1))).toEqual({
			kind: "before",
			key: "narrator:b",
		});
		expect(resolveRecentTabDropTarget(rows, lowerHalf(1))).toEqual({
			kind: "after",
			key: "narrator:b",
		});
	});

	// An empty section is where dragging a narrator in matters MOST (fresh install, or
	// right after "clear tabs"), so it resolves to a real target rather than to nothing.
	test("an empty list resolves to the anchor-free target, not null", () => {
		expect(resolveRecentTabDropTarget([], 10)).toEqual({ kind: "empty" });
	});

	test("below every row anchors after the last one", () => {
		const rows = [row(0, "narrator:a"), row(1, "narrator:b")];
		expect(resolveRecentTabDropTarget(rows, 500)).toEqual({
			kind: "after",
			key: "narrator:b",
		});
	});

	test("above the list anchors before the first unpinned row", () => {
		const rows = [row(0, "narrator:a"), row(1, "narrator:b")];
		expect(resolveRecentTabDropTarget(rows, -20)).toEqual({
			kind: "before",
			key: "narrator:a",
		});
	});

	// A workspace is a hand-built structure: pointing at it means joining it, not being
	// ordered beside it. If this regresses the drop silently becomes a reorder and the
	// narrator never enters the workspace.
	describe("workspace groups", () => {
		const rows = [
			row(0, "narrator:a"),
			row(1, "workspace:w1", {
				workspaceId: "w1",
				keyBlock: ["workspace:w1", "narrator:x", "narrator:y"],
			}),
			row(2, "narrator:x", { workspaceId: "w1", keyBlock: ["narrator:x"] }),
			row(3, "narrator:y", { workspaceId: "w1", keyBlock: ["narrator:y"] }),
			row(4, "narrator:b"),
		];

		test("the header resolves to joining, on either half", () => {
			expect(resolveRecentTabDropTarget(rows, upperHalf(1))).toEqual({
				kind: "workspace",
				workspaceId: "w1",
			});
			expect(resolveRecentTabDropTarget(rows, lowerHalf(1))).toEqual({
				kind: "workspace",
				workspaceId: "w1",
			});
		});

		test("a child resolves to joining too", () => {
			expect(resolveRecentTabDropTarget(rows, lowerHalf(3))).toEqual({
				kind: "workspace",
				workspaceId: "w1",
			});
		});

		test("rows around the group still order normally", () => {
			expect(resolveRecentTabDropTarget(rows, lowerHalf(0))).toEqual({
				kind: "after",
				key: "narrator:a",
			});
			expect(resolveRecentTabDropTarget(rows, upperHalf(4))).toEqual({
				kind: "before",
				key: "narrator:b",
			});
		});

		test("a pinned workspace can still be joined — joining does not move the header", () => {
			const pinnedWs = [
				row(0, "workspace:w1", {
					pinned: true,
					workspaceId: "w1",
					keyBlock: ["workspace:w1", "narrator:x"],
				}),
				row(1, "narrator:x", { pinned: true, workspaceId: "w1", keyBlock: ["narrator:x"] }),
				row(2, "narrator:b"),
			];
			expect(resolveRecentTabDropTarget(pinnedWs, lowerHalf(0))).toEqual({
				kind: "workspace",
				workspaceId: "w1",
			});
		});
	});

	// The server derives the pinned section positionally: it walks from the top while rows
	// are pinned. An unpinned tab inserted mid-section would end that walk early and every
	// pinned tab below it would stop counting as pinned.
	describe("pinned section", () => {
		const rows = [
			row(0, "narrator:p1", { pinned: true }),
			row(1, "narrator:p2", { pinned: true }),
			row(2, "narrator:a"),
			row(3, "narrator:b"),
		];

		test("a drop inside the pinned section is pulled to the first unpinned row", () => {
			expect(resolveRecentTabDropTarget(rows, upperHalf(0))).toEqual({
				kind: "before",
				key: "narrator:a",
			});
			expect(resolveRecentTabDropTarget(rows, lowerHalf(1))).toEqual({
				kind: "before",
				key: "narrator:a",
			});
		});

		test("with no unpinned rows the only position is after the whole section", () => {
			const allPinned = [
				row(0, "narrator:p1", { pinned: true }),
				row(1, "narrator:p2", { pinned: true }),
			];
			expect(resolveRecentTabDropTarget(allPinned, upperHalf(0))).toEqual({
				kind: "after",
				key: "narrator:p2",
			});
			expect(resolveRecentTabDropTarget(allPinned, 500)).toEqual({
				kind: "after",
				key: "narrator:p2",
			});
		});

		test("a gap below the pinned section does not anchor after a pinned row", () => {
			const gapped = [
				row(0, "narrator:p1", { pinned: true }),
				// Row 1 is deliberately absent: a 40px gap between the pinned row and `a`.
				row(2, "narrator:a"),
			];
			expect(resolveRecentTabDropTarget(gapped, 50)).toEqual({
				kind: "before",
				key: "narrator:a",
			});
		});
	});

	// A directory row and a workspace group occupy several flat keys. Anchoring to the
	// row's own key would place the tab INSIDE the unit, and the server's regroup would
	// then move it somewhere the user did not choose.
	describe("multi-key units anchor to block edges", () => {
		const rows = [
			row(0, "dir:/repo", { keyBlock: ["narrator:d1", "narrator:d2", "narrator:d3"] }),
			row(1, "narrator:b"),
		];

		test("before a directory row anchors to its FIRST member", () => {
			expect(resolveRecentTabDropTarget(rows, upperHalf(0))).toEqual({
				kind: "before",
				key: "narrator:d1",
			});
		});

		test("after a directory row anchors to its LAST member", () => {
			expect(resolveRecentTabDropTarget(rows, lowerHalf(0))).toEqual({
				kind: "after",
				key: "narrator:d3",
			});
		});
	});
});

describe("recentTabDropIndicatorRow", () => {
	const rows = [
		row(0, "dir:/repo", { keyBlock: ["narrator:d1", "narrator:d2"] }),
		row(1, "narrator:b"),
	];

	test("a block-edge anchor points at the row that renders it, not a phantom row", () => {
		expect(recentTabDropIndicatorRow(rows, { kind: "after", key: "narrator:d2" })).toEqual({
			row: rows[0],
			side: "bottom",
		});
		expect(recentTabDropIndicatorRow(rows, { kind: "before", key: "narrator:d1" })).toEqual({
			row: rows[0],
			side: "top",
		});
	});

	test("a workspace join has no line — the group is highlighted instead", () => {
		expect(recentTabDropIndicatorRow(rows, { kind: "workspace", workspaceId: "w1" })).toBeNull();
	});

	test("the empty target has no line either", () => {
		expect(recentTabDropIndicatorRow([], { kind: "empty" })).toBeNull();
	});

	test("an anchor for a row that is gone yields no indicator", () => {
		expect(recentTabDropIndicatorRow(rows, { kind: "after", key: "narrator:gone" })).toBeNull();
	});

	// An EXPANDED directory group gives every member row the same keyBlock, so taking the
	// first match for an "after" anchor would draw the line under the group's header —
	// above the members it must sit below.
	test("an expanded group draws the after-line under its LAST row", () => {
		const expanded = [
			row(0, "dir:/repo", { keyBlock: ["narrator:d1", "narrator:d2"] }),
			row(1, "narrator:d1", { keyBlock: ["narrator:d1", "narrator:d2"] }),
			row(2, "narrator:d2", { keyBlock: ["narrator:d1", "narrator:d2"] }),
			row(3, "narrator:b"),
		];
		expect(recentTabDropIndicatorRow(expanded, { kind: "after", key: "narrator:d2" })).toEqual({
			row: expanded[2],
			side: "bottom",
		});
		expect(recentTabDropIndicatorRow(expanded, { kind: "before", key: "narrator:d1" })).toEqual({
			row: expanded[0],
			side: "top",
		});
	});
});

describe("recentTabWorkspaceBounds", () => {
	const rows = [
		row(0, "narrator:a"),
		row(1, "workspace:w1", { workspaceId: "w1" }),
		row(2, "narrator:x", { workspaceId: "w1" }),
		row(3, "narrator:y", { workspaceId: "w1" }),
		row(4, "narrator:b"),
	];

	test("spans the header and every child", () => {
		expect(recentTabWorkspaceBounds(rows, "w1")).toEqual({ top: 40, bottom: 160 });
	});

	test("a header with no children is still its own box", () => {
		const lone = [row(0, "workspace:w2", { workspaceId: "w2" })];
		expect(recentTabWorkspaceBounds(lone, "w2")).toEqual({ top: 0, bottom: 40 });
	});

	// Drawing a zero-height box at the top of the list would be worse than drawing nothing.
	test("a workspace with no rendered rows has no box", () => {
		expect(recentTabWorkspaceBounds(rows, "w-missing")).toBeNull();
	});
});
