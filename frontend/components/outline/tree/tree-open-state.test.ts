import { describe, expect, test } from "bun:test";
import {
	liveTreePages,
	parseTreeOpen,
	TREE_OPEN_LIMITS,
	TreeOpenState,
	treeCountLabel,
	withTreeOpen,
} from "./tree-open-state";

describe("the connected outline's open nodes", () => {
	test("stored keys: malformed and repeated ones are dropped", () => {
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
		).toEqual(["space:abc", "page:p1", "group:loose", "group:sessions:proj_1"]);
	});

	test("opening a page past the limit closes the page open longest; other nodes stay", () => {
		let keys: string[] = ["space:s"];
		for (let i = 0; i < TREE_OPEN_LIMITS.maxPages; i++)
			keys = withTreeOpen(keys, `page:p${i}`, true);
		expect(keys.filter((k) => k.startsWith("page:"))).toHaveLength(TREE_OPEN_LIMITS.maxPages);
		keys = withTreeOpen(keys, "page:new", true);
		expect(keys).toContain("space:s");
		expect(keys).not.toContain("page:p0");
		expect(keys).toContain("page:p1");
		expect(keys.at(-1)).toBe("page:new");
		expect(keys.filter((k) => k.startsWith("page:"))).toHaveLength(TREE_OPEN_LIMITS.maxPages);
		// Reopening one moves it to the newest; closing removes it.
		keys = withTreeOpen(keys, "page:p1", true);
		expect(keys.at(-1)).toBe("page:p1");
		expect(withTreeOpen(keys, "space:s", false)).not.toContain("space:s");
	});

	test("at most the key limit is kept, the newest", () => {
		let keys: string[] = [];
		for (let i = 0; i < TREE_OPEN_LIMITS.maxKeys + 20; i++)
			keys = withTreeOpen(keys, `space:s${i}`, true);
		expect(keys).toHaveLength(TREE_OPEN_LIMITS.maxKeys);
		expect(keys[0]).toBe("space:s20");
	});

	test("only the newest open pages are kept fresh", () => {
		const keys = Array.from({ length: 10 }, (_, i) => `page:p${i}`);
		const live = liveTreePages(["space:s", ...keys]);
		expect(live.size).toBe(TREE_OPEN_LIMITS.livePages);
		expect(live.has("page:p9")).toBe(true);
		expect(live.has("page:p1")).toBe(false);
	});

	test("the state tells its listeners and clears", () => {
		const state = new TreeOpenState([]);
		let heard = 0;
		const off = state.subscribe(() => heard++);
		state.toggle("space:a");
		expect(state.isOpen("space:a")).toBe(true);
		state.setOpen("space:a", true);
		expect(heard).toBe(1);
		state.toggle("page:p");
		expect(state.isLive("page:p")).toBe(true);
		state.clear();
		expect(state.snapshot()).toEqual([]);
		expect(heard).toBe(3);
		off();
	});

	test("counts past the cap read as one less with a plus", () => {
		expect(treeCountLabel(12, 100)).toBe("12");
		expect(treeCountLabel(100, 100)).toBe("99+");
	});
});
