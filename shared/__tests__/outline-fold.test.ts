/**
 * The default view of an outline page and the reader's folding over it (task tree readability,
 * PR C): each default rule, the previews, the reader's two sets and how the actions keep them
 * minimal, marks counted on the closed row that hides them, and a large page.
 */
import { describe, expect, test } from "bun:test";
import {
	applyFoldAction,
	boundedFoldView,
	buildFoldTree,
	FOLD_PREVIEW_CHARS,
	type FoldAction,
	type FoldMarks,
	type FoldSource,
	type FoldTask,
	type FoldTree,
	foldDefaultOpen,
	foldHiddenMarks,
	foldPageControl,
	foldPreview,
	foldPreviewLine,
	foldSubtreeControl,
	type MutableFoldView,
	visibleFoldRows,
} from "../outline-fold";

interface Spec {
	id: string;
	task?: FoldTask;
	report?: boolean;
	heading?: boolean;
	marks?: Partial<FoldMarks>;
	kids?: Spec[];
}

function sourceOf(root: Spec): FoldSource {
	const byId = new Map<string, Spec>();
	const walk = (spec: Spec) => {
		byId.set(spec.id, spec);
		for (const kid of spec.kids ?? []) walk(kid);
	};
	walk(root);
	return {
		children: (id) => (byId.get(id)?.kids ?? []).map((kid) => kid.id),
		task: (id) => byId.get(id)?.task ?? null,
		report: (id) => byId.get(id)?.report === true,
		heading: (id) => byId.get(id)?.heading === true,
		marks: (id) => byId.get(id)?.marks ?? null,
	};
}

/**
 * A session's task page, as the owner's screenshot had it: a task in progress with notes, a
 * subagent report and a subtask; finished tasks; a cancelled one; a fact with details.
 */
const PAGE: Spec = {
	id: "page",
	kids: [
		{
			id: "doing",
			task: "doing",
			kids: [
				{
					id: "note1",
					kids: [{ id: "n1a", kids: [{ id: "n1a1" }] }, { id: "n1b" }, { id: "n1c" }],
				},
				{ id: "note2" },
				{ id: "note3", kids: [{ id: "n3a" }] },
				{
					id: "report",
					report: true,
					kids: [
						{ id: "rh", heading: true, kids: [{ id: "rp1" }, { id: "rp2" }] },
						{ id: "rh2", heading: true, kids: [{ id: "rp3" }] },
					],
				},
				{ id: "sub", task: "todo", kids: [{ id: "subnote", kids: [{ id: "subdeep" }] }] },
				{ id: "ask", marks: { question: 1 }, kids: [{ id: "askctx" }] },
			],
		},
		{
			id: "done",
			task: "done",
			kids: [
				{ id: "donesub", task: "done" },
				{ id: "result", kids: [{ id: "evidence", marks: { pending: 1 } }] },
				{ id: "donereport", report: true, kids: [{ id: "dr1" }] },
			],
		},
		{ id: "donebare", task: "done", kids: [{ id: "onlysub", task: "done" }] },
		{ id: "cancelled", task: "cancelled", kids: [{ id: "why" }] },
		{ id: "todo", task: "todo" },
		{ id: "fact", kids: [{ id: "factkid", kids: [{ id: "factdeep" }] }] },
	],
};

const emptyView = (): MutableFoldView => ({ expanded: new Set(), collapsed: new Set() });
const source = sourceOf(PAGE);
const tree = (view = emptyView(), options: Partial<Parameters<typeof buildFoldTree>[1]> = {}) =>
	buildFoldTree(source, { rootId: "page", ...options }, view);
const shown = (t: FoldTree) => visibleFoldRows(t, source).rows.map((row) => row.node.id);
const act = (view: MutableFoldView, action: FoldAction) =>
	applyFoldAction(tree(view), view, action);
const sets = (view: MutableFoldView) => ({
	expanded: [...view.expanded].sort(),
	collapsed: [...view.collapsed].sort(),
});

describe("the default view", () => {
	test("each rule by itself", () => {
		const base = { root: false, task: null, report: false, detail: false } as const;
		expect(foldDefaultOpen({ ...base, root: true, task: "done", report: true, detail: true })).toBe(
			true,
		);
		expect(foldDefaultOpen({ ...base, task: "todo" })).toBe(true);
		expect(foldDefaultOpen({ ...base, task: "doing", detail: true })).toBe(true);
		expect(foldDefaultOpen({ ...base, task: "done" })).toBe(false);
		expect(foldDefaultOpen({ ...base, task: "cancelled" })).toBe(false);
		expect(foldDefaultOpen({ ...base, report: true })).toBe(false);
		// A fact stays open; the same block under a task is a detail.
		expect(foldDefaultOpen(base)).toBe(true);
		expect(foldDefaultOpen({ ...base, detail: true })).toBe(false);
	});

	test("a task page: open tasks show one level, the rest is one line each", () => {
		expect(shown(tree())).toEqual([
			"doing",
			"note1",
			"note2",
			"note3",
			"report",
			"sub",
			"subnote",
			"ask",
			"done",
			"donebare",
			"cancelled",
			"todo",
			"fact",
			"factkid",
			"factdeep",
		]);
	});

	test("which blocks are details", () => {
		const t = tree();
		const detail = (id: string) => t.nodes.get(id)?.detail;
		expect(detail("doing")).toBe(false);
		expect(detail("note1")).toBe(true);
		expect(detail("rp1")).toBe(true);
		expect(detail("fact")).toBe(false);
		expect(detail("factdeep")).toBe(false);
	});

	test("the root is open whatever it is; under a task it makes its children details", () => {
		const done = buildFoldTree(source, { rootId: "done" });
		expect(done.nodes.get("done")?.open).toBe(true);
		expect(visibleFoldRows(done, source).rows.map((r) => r.node.id)).toEqual([
			"donesub",
			"result",
			"donereport",
		]);
		// A note focused as the page: its ancestors (a task) are not in the view.
		const loose = buildFoldTree(source, { rootId: "note1" });
		expect(loose.nodes.get("n1a")?.open).toBe(true);
		const under = buildFoldTree(source, { rootId: "note1", rootDetail: true });
		expect(under.nodes.get("n1a")?.open).toBe(false);
		expect(visibleFoldRows(under, source).rows.map((r) => r.node.id)).toEqual([
			"n1a",
			"n1b",
			"n1c",
		]);
	});
});

describe("previews", () => {
	const t = tree();
	test("a detail: its first child, and how many more", () => {
		expect(foldPreview(t, source, "note1")).toEqual({
			kind: "details",
			textId: "n1a",
			rest: 2,
			total: 4,
			more: true,
		});
		// One child, nothing under it: whether the line needs a label is the renderer's to say.
		expect(foldPreview(t, source, "note3")).toEqual({
			kind: "details",
			textId: "n3a",
			rest: 0,
			total: 1,
			more: false,
		});
	});

	test("a finished task: its first block that is neither a task nor a report", () => {
		expect(foldPreview(t, source, "done")).toEqual({
			kind: "result",
			textId: "result",
			rest: 2,
			total: 5,
			more: true,
		});
		expect(foldPreview(t, source, "cancelled")).toMatchObject({ kind: "result", textId: "why" });
		// Only subtasks under it: the title is all there is.
		expect(foldPreview(t, source, "donebare")).toBeNull();
	});

	test("a report: the first paragraph, under the first heading when it starts with one", () => {
		expect(foldPreview(t, source, "report")).toEqual({
			kind: "report",
			textId: "rp1",
			rest: 1,
			total: 5,
			more: true,
		});
		expect(foldPreview(t, source, "donereport")).toMatchObject({ textId: "dr1", total: 1 });
		// A heading with nothing under it is the summary itself.
		const bare = sourceOf({
			id: "p",
			kids: [{ id: "r", report: true, kids: [{ id: "h", heading: true }, { id: "x" }] }],
		});
		const bareTree = buildFoldTree(bare, { rootId: "p" });
		expect(foldPreview(bareTree, bare, "r")).toMatchObject({ textId: "h", rest: 1 });
	});

	test("an open node, a leaf and an unknown block have none", () => {
		expect(foldPreview(t, source, "doing")).toBeNull();
		expect(foldPreview(t, source, "note2")).toBeNull();
		expect(foldPreview(t, source, "nope")).toBeNull();
	});

	test("a preview line is one bounded line of plain text", () => {
		expect(foldPreviewLine("  a\tb\n c ")).toBe("a b c");
		const long = foldPreviewLine("x".repeat(1000));
		expect(long.length).toBe(FOLD_PREVIEW_CHARS);
		expect(long.endsWith("…")).toBe(true);
		// Never half of a character.
		const emoji = foldPreviewLine("😀".repeat(400));
		expect(/[\uD800-\uDBFF]…$/.test(emoji)).toBe(false);
	});
});

describe("the reader's view", () => {
	test("opening what is closed by default goes to `expanded`, and back leaves nothing", () => {
		const view = emptyView();
		expect(act(view, { kind: "node", id: "done" })).toBe(true);
		expect(sets(view)).toEqual({ expanded: ["done"], collapsed: [] });
		expect(shown(tree(view))).toContain("result");
		expect(act(view, { kind: "node", id: "done" })).toBe(true);
		expect(sets(view)).toEqual({ expanded: [], collapsed: [] });
	});

	test("closing what is open by default goes to `collapsed`, and back leaves nothing", () => {
		const view = emptyView();
		act(view, { kind: "node", id: "doing" });
		expect(sets(view)).toEqual({ expanded: [], collapsed: ["doing"] });
		expect(shown(tree(view))).not.toContain("note1");
		act(view, { kind: "node", id: "doing", open: true });
		expect(sets(view)).toEqual({ expanded: [], collapsed: [] });
	});

	test("a leaf, the root and an unknown block do not toggle", () => {
		const view = emptyView();
		for (const id of ["note2", "page", "nope"])
			expect(act(view, { kind: "node", id }), id).toBe(false);
		expect(sets(view)).toEqual({ expanded: [], collapsed: [] });
	});

	test("`expanded` wins over `collapsed`, and both over the default", () => {
		const both = tree({ expanded: new Set(["done"]), collapsed: new Set(["done"]) });
		expect(both.nodes.get("done")?.open).toBe(true);
		// The next toggle leaves the block in one set only.
		const view = { expanded: new Set(["done"]), collapsed: new Set(["done"]) };
		act(view, { kind: "node", id: "done" });
		expect(sets(view)).toEqual({ expanded: [], collapsed: [] });
	});

	test("a task that gets done closes by itself; one the reader opened stays open", () => {
		const finished = (opened: boolean) => {
			const page = (task: FoldTask): Spec => ({
				id: "p",
				kids: [{ id: "t", task, kids: [{ id: "n" }] }],
			});
			const view = emptyView();
			const before = buildFoldTree(sourceOf(page("doing")), { rootId: "p" }, view);
			expect(before.nodes.get("t")?.open).toBe(true);
			// Opening what is open already stores nothing; the reader's own opening does.
			applyFoldAction(before, view, { kind: "node", id: "t", open: true });
			expect(view.expanded.size).toBe(0);
			if (opened) view.expanded.add("t");
			return buildFoldTree(sourceOf(page("done")), { rootId: "p" }, view).nodes.get("t")?.open;
		};
		expect(finished(false)).toBe(false);
		expect(finished(true)).toBe(true);
	});

	test("everything inside a node: opened, then one place closed in it, then the default again", () => {
		const view = emptyView();
		expect(foldSubtreeControl(tree(view).nodes.get("doing") as never)).toBe("expand");
		act(view, { kind: "subtree", id: "doing", open: true });
		// Only what the default closes is stored (the open tasks are open already).
		expect(sets(view)).toEqual({
			expanded: ["ask", "n1a", "note1", "note3", "report", "rh", "rh2", "subnote"],
			collapsed: [],
		});
		const all = tree(view);
		expect(all.nodes.get("doing")?.allOpen).toBe(true);
		expect(foldSubtreeControl(all.nodes.get("doing") as never)).toBe("collapse");
		expect(shown(all)).toContain("n1a1");
		// Close one place inside: the node is no longer all open, the rest stays.
		act(view, { kind: "node", id: "report" });
		expect(view.expanded.has("report")).toBe(false);
		expect(view.expanded.has("rh")).toBe(true);
		expect(foldSubtreeControl(tree(view).nodes.get("doing") as never)).toBe("expand");
		// Back to the default inside it: nothing of the subtree stays stored.
		view.collapsed.add("fact");
		act(view, { kind: "subtree", id: "doing", open: false });
		expect(sets(view)).toEqual({ expanded: [], collapsed: ["fact"] });
	});

	test("the quick control: none where nothing folds inside, none on a leaf or the root", () => {
		const t = tree();
		const control = (id: string) => foldSubtreeControl(t.nodes.get(id) as never);
		expect(control("fact")).toBeNull();
		expect(control("note2")).toBeNull();
		expect(control("page")).toBeNull();
		expect(control("note1")).toBe("expand");
		expect(control("done")).toBe("expand");
		// A fact the reader closed something in offers to open it again.
		const closed = tree({ expanded: new Set(), collapsed: new Set(["factkid"]) });
		expect(foldSubtreeControl(closed.nodes.get("fact") as never)).toBe("expand");
	});

	test("the whole page: expand all, then collapse all is the default view", () => {
		const view = emptyView();
		expect(foldPageControl(tree(view), view)).toBe("expand");
		act(view, { kind: "all", open: true });
		const all = tree(view);
		expect(shown(all).length).toBe(all.order.length - 1);
		expect(view.collapsed.size).toBe(0);
		expect(foldPageControl(all, view)).toBe("collapse");
		act(view, { kind: "all", open: false });
		expect(sets(view)).toEqual({ expanded: [], collapsed: [] });
		expect(shown(tree(view))).toEqual(shown(tree()));
	});

	test("the page's control on a page of facts: only what the reader closed", () => {
		const facts = sourceOf({ id: "p", kids: [{ id: "a", kids: [{ id: "b" }] }] });
		const view = emptyView();
		const build = () => buildFoldTree(facts, { rootId: "p" }, view);
		expect(foldPageControl(build(), view)).toBeNull();
		applyFoldAction(build(), view, { kind: "node", id: "a" });
		expect(foldPageControl(build(), view)).toBe("expand");
		// Ids of another page's blocks are not this page's business.
		const other: MutableFoldView = { expanded: new Set(["elsewhere"]), collapsed: new Set() };
		expect(foldPageControl(buildFoldTree(facts, { rootId: "p" }, other), other)).toBeNull();
	});

	test("reveal opens the ancestors and nothing else", () => {
		const view = emptyView();
		expect(shown(tree(view))).not.toContain("n1a1");
		expect(act(view, { kind: "reveal", id: "n1a1" })).toBe(true);
		expect(sets(view)).toEqual({ expanded: ["n1a", "note1"], collapsed: [] });
		expect(shown(tree(view))).toContain("n1a1");
		expect(tree(view).nodes.get("note3")?.open).toBe(false);
		// Already on screen: nothing changes.
		expect(act(view, { kind: "reveal", id: "n1a1" })).toBe(false);
		expect(act(view, { kind: "reveal", id: "nope" })).toBe(false);
		// An ancestor the reader closed opens again.
		view.collapsed.add("doing");
		act(view, { kind: "reveal", id: "n1b" });
		expect(view.collapsed.has("doing")).toBe(false);
	});

	test("close all and open to a level (the keyboard's commands)", () => {
		const view = emptyView();
		act(view, { kind: "closeAll" });
		expect(shown(tree(view))).toEqual(["doing", "done", "donebare", "cancelled", "todo", "fact"]);
		// Only what is open by default needs storing.
		expect(sets(view)).toEqual({ expanded: [], collapsed: ["doing", "fact", "factkid", "sub"] });
		act(view, { kind: "level", level: 2 });
		const level2 = tree(view);
		expect(level2.nodes.get("done")?.open).toBe(true);
		expect(level2.nodes.get("note1")?.open).toBe(false);
		expect(level2.nodes.get("factkid")?.open).toBe(false);
		expect(sets(view)).toEqual({
			expanded: ["cancelled", "done", "donebare"],
			collapsed: ["factkid", "sub"],
		});
	});

	test("a pinned block stays on screen without anything being stored", () => {
		const view = emptyView();
		const pinned = tree(view, { pinned: ["n1a1", "nope"] });
		expect(pinned.nodes.get("n1a1")?.visible).toBe(true);
		expect(pinned.nodes.get("note1")?.open).toBe(true);
		expect(pinned.nodes.get("note3")?.open).toBe(false);
		expect(sets(view)).toEqual({ expanded: [], collapsed: [] });
	});

	test("what is stored fits the limit both sets share", () => {
		const view = {
			expanded: new Set(["a", "b", "c"]),
			collapsed: new Set(["c", "d", "e"]),
		};
		expect(boundedFoldView(view, 4)).toEqual({ expanded: ["a", "b", "c"], collapsed: ["d"] });
		expect(boundedFoldView(view, 2)).toEqual({ expanded: ["a", "b"], collapsed: [] });
		expect(boundedFoldView(view)).toEqual({ expanded: ["a", "b", "c"], collapsed: ["d", "e"] });
	});
});

describe("marks of what a closed row hides", () => {
	test("each hidden mark is counted on its nearest visible ancestor, once", () => {
		const rows = visibleFoldRows(tree(), source).rows;
		const hidden = Object.fromEntries(
			rows.flatMap((row) => (row.hidden ? [[row.node.id, row.hidden]] : [])),
		);
		// The pending change is two levels under the finished task.
		expect(hidden).toEqual({ done: { question: 0, pending: 1, locked: 0, fresh: 0 } });
		// The question is a visible row itself: nothing counts it.
		expect(rows.find((row) => row.node.id === "ask")?.hidden).toBeNull();
		expect(tree().nodes.get("doing")?.under).toEqual({
			question: 1,
			pending: 0,
			locked: 0,
			fresh: 0,
		});
	});

	test("closing an ancestor moves the count up; opening it down again", () => {
		const view = emptyView();
		act(view, { kind: "node", id: "doing" });
		const row = (t: FoldTree, id: string) =>
			visibleFoldRows(t, source).rows.find((r) => r.node.id === id);
		expect(row(tree(view), "doing")?.hidden).toMatchObject({ question: 1 });
		const opened = emptyView();
		act(opened, { kind: "node", id: "done" });
		expect(row(tree(opened), "done")?.hidden).toBeNull();
		expect(row(tree(opened), "result")?.hidden).toMatchObject({ pending: 1 });
	});

	test("every kind adds up, and a block's own marks are not its row's", () => {
		const marked = sourceOf({
			id: "p",
			kids: [
				{
					id: "t",
					task: "done",
					marks: { locked: 1 },
					kids: [
						{ id: "a", marks: { question: 1, pending: 2 } },
						{
							id: "b",
							task: "done",
							marks: { fresh: 1, locked: 1 },
							kids: [{ id: "c", marks: { question: 1 } }],
						},
						{ id: "z", marks: { question: 0, pending: -3 } },
					],
				},
			],
		});
		const t = buildFoldTree(marked, { rootId: "p" });
		expect(foldHiddenMarks(t.nodes.get("t") as never)).toEqual({
			question: 2,
			pending: 2,
			locked: 1,
			fresh: 1,
		});
		expect(foldHiddenMarks(t.nodes.get("a") as never)).toBeNull();
	});
});

describe("large and broken trees", () => {
	test("a page of 2000 blocks is one cheap walk, and a deep chain does not recurse", () => {
		const kids: Spec[] = [];
		for (let i = 0; i < 200; i++) {
			const notes: Spec[] = [];
			for (let j = 0; j < 9; j++) notes.push({ id: `n${i}-${j}` });
			kids.push({ id: `t${i}`, task: i % 3 === 0 ? "done" : "doing", kids: notes });
		}
		const wide = sourceOf({ id: "p", kids });
		const view = emptyView();
		const t0 = performance.now();
		let built = buildFoldTree(wide, { rootId: "p" }, view);
		for (let i = 0; i < 20; i++) built = buildFoldTree(wide, { rootId: "p" }, view);
		const each = (performance.now() - t0) / 21;
		expect(built.order.length).toBe(2001);
		expect(visibleFoldRows(built, wide).rows.length).toBe(200 + 133 * 9);
		expect(visibleFoldRows(built, wide, 50)).toMatchObject({ cut: 200 + 133 * 9 - 50 });
		// Generous: a loaded CI machine. A walk takes well under a millisecond.
		expect(each).toBeLessThan(50);
		applyFoldAction(built, view, { kind: "all", open: true });
		expect(view.expanded.size).toBe(67);

		let chain: Spec = { id: "leaf" };
		for (let i = 0; i < 5000; i++) chain = { id: `c${i}`, kids: [chain] };
		const deep = sourceOf(chain);
		const deepTree = buildFoldTree(deep, { rootId: "c4999" });
		// Cut at the depth limit instead of walking bad data for ever.
		expect(deepTree.order.length).toBeLessThan(5000);
		expect(deepTree.order.length).toBeGreaterThan(100);
	});

	test("a block reached twice is shown once", () => {
		const looped: FoldSource = {
			children: (id) => (id === "p" ? ["a", "a", "b"] : id === "b" ? ["a", "p"] : []),
			task: () => null,
			report: () => false,
		};
		const t = buildFoldTree(looped, { rootId: "p" });
		expect(t.order).toEqual(["p", "a", "b"]);
		const view = emptyView();
		expect(applyFoldAction(t, view, { kind: "closeAll" })).toBe(true);
		expect([...view.collapsed]).toEqual(["b"]);
	});
});
