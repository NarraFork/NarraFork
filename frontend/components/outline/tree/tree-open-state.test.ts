import { describe, expect, test } from "bun:test";
import {
	liveTreePages,
	parseTreeOpen,
	TREE_OPEN_LIMITS,
	TreeOpenState,
	treeCountLabel,
	treeOpenStorageKey,
	withinShownPages,
	withTreeOpen,
} from "./tree-open-state";

const pages = (n: number, prefix = "p") =>
	Array.from({ length: n }, (_, i) => `page:${prefix}${i}`);

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

	test("only shown pages count: past the limit the shown page opened longest goes", () => {
		const hidden = pages(5, "h");
		const shown = pages(TREE_OPEN_LIMITS.maxPages + 1);
		const keys = ["space:s", ...hidden, ...shown];
		const kept = withinShownPages(keys, new Set(shown));
		expect(kept).not.toContain("page:p0");
		expect(kept).toContain("page:p1");
		// Pages under a closed parent are not shown: they neither count nor go.
		for (const h of hidden) expect(kept).toContain(h);
		expect(kept).toContain("space:s");
		expect(withinShownPages(keys, new Set(hidden))).toEqual(keys);
	});

	test("only the newest shown pages are kept fresh", () => {
		const keys = pages(10);
		const live = liveTreePages(["space:s", ...keys], new Set(keys.slice(0, 9)));
		expect(live.size).toBe(TREE_OPEN_LIMITS.livePages);
		expect(live.has("page:p8")).toBe(true);
		expect(live.has("page:p9")).toBe(false);
		expect(live.has("page:p0")).toBe(false);
	});

	test("the state: showing a 13th page closes the oldest shown; hiding frees a slot", () => {
		const state = new TreeOpenState(null, []);
		let heard = 0;
		const off = state.subscribe(() => heard++);
		const hides: Array<() => void> = [];
		for (const key of pages(TREE_OPEN_LIMITS.maxPages + 1)) {
			state.setOpen(key, true);
			hides.push(state.showPage(key));
		}
		expect(state.isOpen("page:p0")).toBe(false);
		expect(state.isOpen("page:p1")).toBe(true);
		const live = pages(TREE_OPEN_LIMITS.maxPages + 1).filter((k) => state.isLive(k));
		expect(live).toHaveLength(TREE_OPEN_LIMITS.livePages);
		expect(state.isLive(`page:p${TREE_OPEN_LIMITS.maxPages}`)).toBe(true);
		// The newest stops being shown (its parent closed): it stays open, an older one goes live.
		hides[TREE_OPEN_LIMITS.maxPages]?.();
		expect(state.isOpen(`page:p${TREE_OPEN_LIMITS.maxPages}`)).toBe(true);
		expect(state.isLive(`page:p${TREE_OPEN_LIMITS.maxPages}`)).toBe(false);
		expect(state.isLive(`page:p${TREE_OPEN_LIMITS.maxPages - TREE_OPEN_LIMITS.livePages}`)).toBe(
			true,
		);
		expect(heard).toBeGreaterThan(0);
		state.clear();
		expect(state.snapshot()).toEqual([]);
		off();
	});

	test("counts past the cap read as one less with a plus", () => {
		expect(treeCountLabel(12, 100)).toBe("12");
		expect(treeCountLabel(100, 100)).toBe("99+");
	});
	test("reopening a parent keeps the pages it shows again; older shown pages go", () => {
		const state = new TreeOpenState(null, []);
		const a = pages(12, "a");
		const b = pages(12, "b");
		const hideA = a.map((key) => {
			state.setOpen(key, true);
			return state.showPage(key);
		});
		// A closes: its pages stay open, not shown.
		for (const hide of hideA) hide();
		for (const key of b) {
			state.setOpen(key, true);
			state.showPage(key);
		}
		// A opens again: its twelve pages are shown, and they are what the reader looks at.
		for (const key of a) if (state.isOpen(key)) state.showPage(key);
		expect(a.filter((key) => state.isOpen(key))).toHaveLength(12);
		expect(b.filter((key) => state.isOpen(key))).toHaveLength(0);
		expect(a.filter((key) => state.isLive(key))).toHaveLength(TREE_OPEN_LIMITS.livePages);
	});
});

test("several nodes open or close at once, in the order given", () => {
	const state = new TreeOpenState(null, ["space:a"]);
	let heard = 0;
	state.subscribe(() => heard++);
	state.setMany(["space:b", "group:loose", "page:p"], true);
	expect(state.snapshot()).toEqual(["space:a", "space:b", "group:loose", "page:p"]);
	expect(heard).toBe(1);
	state.setMany(["space:a", "page:p", "space:zz"], false);
	expect(state.snapshot()).toEqual(["space:b", "group:loose"]);
	state.setMany([], true);
	expect(heard).toBe(2);
});
