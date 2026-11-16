import { describe, expect, test } from "bun:test";
import {
	parseTreeOpen,
	TREE_OPEN_LIMITS,
	TreeOpenState,
	treeCountLabel,
	treeOpenStorageKey,
	withTreeOpen,
} from "./tree-open-state";

describe("the forest's open rows of spaces and groups", () => {
	test("stored keys: malformed, repeated and the old page keys are dropped", () => {
		expect(parseTreeOpen(null)).toEqual([]);
		expect(parseTreeOpen("not json")).toEqual([]);
		expect(parseTreeOpen('{"a":1}')).toEqual([]);
		expect(
			parseTreeOpen(
				JSON.stringify([
					"space:abc",
					"space:abc",
					"page:p1",
					"group:loose",
					"group:sessions:proj_1",
					"group:other",
					"space:../x",
					42,
				]),
			),
		).toEqual(["space:abc", "group:loose", "group:sessions:proj_1"]);
	});

	test("the outline page and the dock panels keep their own", () => {
		expect(treeOpenStorageKey("page")).not.toBe(treeOpenStorageKey("panel"));
	});

	test("at most the key limit is kept, the newest", () => {
		let keys: string[] = [];
		for (let i = 0; i < TREE_OPEN_LIMITS.maxKeys + 20; i++)
			keys = withTreeOpen(keys, `space:s${i}`, true);
		expect(keys).toHaveLength(TREE_OPEN_LIMITS.maxKeys);
		expect(keys[0]).toBe("space:s20");
	});

	test("the state: listeners hear a change once; clear closes everything", () => {
		const state = new TreeOpenState(null, []);
		let heard = 0;
		const off = state.subscribe(() => heard++);
		state.setOpen("space:a", true);
		state.setOpen("space:a", true);
		expect(heard).toBe(1);
		expect(state.isOpen("space:a")).toBe(true);
		state.toggle("space:a");
		expect(state.isOpen("space:a")).toBe(false);
		state.setOpen("group:loose", true);
		state.clear();
		expect(state.snapshot()).toEqual([]);
		off();
	});

	test("counts past the cap read as one less with a plus", () => {
		expect(treeCountLabel(12, 100)).toBe("12");
		expect(treeCountLabel(100, 100)).toBe("99+");
	});
});

test("several nodes open or close at once, in the order given", () => {
	const state = new TreeOpenState(null, ["space:a"]);
	let heard = 0;
	state.subscribe(() => heard++);
	state.setMany(["space:b", "group:loose", "space:p"], true);
	expect(state.snapshot()).toEqual(["space:a", "space:b", "group:loose", "space:p"]);
	expect(heard).toBe(1);
	state.setMany(["space:a", "space:p", "space:zz"], false);
	expect(state.snapshot()).toEqual(["space:b", "group:loose"]);
	state.setMany([], true);
	expect(heard).toBe(2);
});
