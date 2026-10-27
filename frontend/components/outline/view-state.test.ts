import { describe, expect, test } from "bun:test";
import { OutlineViewStates } from "./view-state";

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
		a.toggleCollapsed("x");
		a.setCollapsed(["y", "z"], true);
		a.setCollapsed(["y"], true);
		a.setFocus("x");
		a.setCaret({ blockId: "x", anchor: 0, head: 2 });
		a.setBlocks(["y", "z"]);
		a.setAnchor({ blockId: "y", top: 120 });
		expect(heard).toEqual(["collapsed", "collapsed", "focus", "caret", "blocks", "anchor"]);
		expect(a.snapshot()).toEqual({
			focus: "x",
			collapsed: ["x", "y", "z"],
			caret: { blockId: "x", anchor: 0, head: 2 },
			blocks: ["y", "z"],
			anchor: { blockId: "y", top: 120 },
		});
		expect(b.snapshot()).toEqual({
			focus: "p1",
			collapsed: [],
			caret: null,
			blocks: [],
			anchor: null,
		});
	});

	test("a surface keeps the most recent pages", () => {
		const states = new OutlineViewStates();
		const first = states.of("p0");
		first.toggleCollapsed("x");
		for (let i = 1; i <= 40; i++) states.of(`p${i}`);
		expect(states.of("p0")).not.toBe(first);
		expect(states.of("p0").collapsed.size).toBe(0);
	});
});
