import { describe, expect, test } from "bun:test";
import { buildFoldTree, type FoldSource } from "@shared/outline-fold";
import { OutlineViewStates } from "./view-state";

/** p1 → x (a fact with y under it), z (a finished task with a note). */
const KIDS: Record<string, string[]> = { p1: ["x", "z"], x: ["y"], z: ["zn"] };
const source: FoldSource = {
	children: (id) => KIDS[id] ?? [],
	task: (id) => (id === "z" ? "done" : null),
	report: () => false,
};
const treeOf = (view: { expanded: Set<string>; collapsed: Set<string> }) =>
	buildFoldTree(source, { rootId: "p1" }, view);

describe("outline view state", () => {
	test("one state per page per surface: two surfaces on a page fold independently", () => {
		const panel = new OutlineViewStates();
		const page = new OutlineViewStates();
		const a = panel.of("p1");
		const b = page.of("p1");
		expect(a).not.toBe(b);
		expect(panel.of("p1")).toBe(a);
		const heard: string[] = [];
		a.on((part) => heard.push(part));
		// Closing a fact and opening a finished task: one set each.
		expect(a.fold(treeOf(a), { kind: "node", id: "x" })).toBe(true);
		expect(a.fold(treeOf(a), { kind: "node", id: "z" })).toBe(true);
		// Nothing to change: nobody is told.
		expect(a.fold(treeOf(a), { kind: "node", id: "y" })).toBe(false);
		expect(a.fold(treeOf(a), { kind: "node", id: "z", open: true })).toBe(false);
		// A view that re-projects first says so itself.
		expect(a.fold(treeOf(a), { kind: "reveal", id: "y" }, true)).toBe(true);
		a.setFocus("x");
		a.setCaret({ blockId: "x", anchor: 0, head: 2 });
		a.setBlocks(["y", "z"]);
		a.setAnchor({ blockId: "y", x: 30, y: 120 });
		a.setView("map");
		a.setView("map");
		a.setLayout("down");
		expect(heard).toEqual([
			"collapsed",
			"collapsed",
			"focus",
			"caret",
			"blocks",
			"anchor",
			"view",
			"layout",
		]);
		expect(a.snapshot()).toEqual({
			focus: "x",
			collapsed: [],
			expanded: ["z"],
			caret: { blockId: "x", anchor: 0, head: 2 },
			blocks: ["y", "z"],
			anchor: { blockId: "y", x: 30, y: 120 },
			view: "map",
			layout: "down",
		});
		expect(b.snapshot()).toEqual({
			focus: "p1",
			collapsed: [],
			expanded: [],
			caret: null,
			blocks: [],
			anchor: null,
			view: "outline",
			layout: "right",
		});
	});

	test("the stored folding and direction replace the surface's in one event", () => {
		const state = new OutlineViewStates().of("p1");
		state.collapsed.add("local");
		state.expanded.add("opened");
		const heard: string[] = [];
		state.on((part) => heard.push(part));
		state.applyStored(["a", "b"], ["c"], "down");
		expect(heard).toEqual(["stored"]);
		expect([...state.collapsed]).toEqual(["a", "b"]);
		expect([...state.expanded]).toEqual(["c"]);
		expect(state.layout).toBe("down");
	});

	test("a surface keeps the most recent pages", () => {
		const states = new OutlineViewStates();
		const first = states.of("p0");
		first.collapsed.add("x");
		for (let i = 1; i <= 40; i++) states.of(`p${i}`);
		expect(states.of("p0")).not.toBe(first);
		expect(states.of("p0").collapsed.size).toBe(0);
	});
});
