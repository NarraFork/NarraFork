/**
 * The reader's outline of a plan (plan readability): parsed from the plan's markdown rendering,
 * shown by default as the root and two levels under it (deeper levels folded), each node and
 * text flipped by the reader, 「全部展开」 opening everything and 「全部收起」 returning to the
 * overview.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type OutlineItem, serializeMarkdownOutline } from "../outline";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	isDefaultPlanTreeView,
	isPlanNodeOpen,
	isPlanTextWhole,
	PLAN_TREE_OPEN_DEPTH,
	type PlanTreeView,
	parsePlanTree,
	planDescendants,
	planTreeViewSignature,
	resetPlanTreeCacheForTest,
	visiblePlanRows,
} from "../outline-plan-tree";

const item = (content: string, children: OutlineItem[] = [], task = false): OutlineItem => ({
	content,
	task: task ? { status: "todo", assignee: null } : null,
	props: {},
	children,
});

/** Root → 2 phases → tasks → details → a fifth level. */
const PLAN = serializeMarkdownOutline([
	item(
		"Ship the importer",
		[
			item("Goal", [item("Imports run unattended")]),
			item(
				"Phase 1",
				[
					item("Parse", [item("Detail A", [item("Deeper")]), item("Detail B")], true),
					item("Validate", [], true),
				],
				true,
			),
			item("Phase 2", [item("Import", [item("Detail C")], true)], true),
		],
		true,
	),
]);

beforeEach(() => resetPlanTreeCacheForTest());

const tree = () => {
	const parsed = parsePlanTree(PLAN);
	if (!parsed) throw new Error("not a tree");
	return parsed;
};
const keys = (view: PlanTreeView) => visiblePlanRows(tree(), view).rows.map((r) => r.node.key);

describe("parsing the plan's markdown", () => {
	test("one root, its levels, index-path keys, depths, tasks, the count", () => {
		const t = tree();
		expect(t.root.key).toBe("r");
		expect(t.root.task).toBe("todo");
		expect(t.root.children.map((c) => [c.key, c.depth, c.plain])).toEqual([
			["r.0", 1, "Goal"],
			["r.1", 1, "Phase 1"],
			["r.2", 1, "Phase 2"],
		]);
		expect(t.size).toBe(12);
		expect(planDescendants(t.root)).toBe(11);
		// A task at the open depth has children: something is folded in the overview.
		expect(t.folds).toBe(true);
	});

	test("marks, links, line breaks, a heading, code, properties and the assignee", () => {
		const md = serializeMarkdownOutline([
			{
				content: "Title **bold** `code` [[k/AbCdEfGh|label]]\nsecond line",
				task: { status: "doing", assignee: "agent:w-1" },
				props: { depends: [{ target: "k/XyXyXyXy", label: "Prep" }], due: "2026-11-30" },
				children: [item("# Heading"), item("```ts\nconst a = 1;\nconst b = 2;\n```")],
			},
		]);
		const t = parsePlanTree(md);
		expect(t?.root.task).toBe("doing");
		const [first, second, depends, due] = t?.root.lines ?? [];
		expect(first?.runs).toEqual([
			{ text: "Title " },
			{ text: "bold", strong: true },
			{ text: " " },
			{ text: "code", code: true },
			{ text: " " },
			{ text: "label", link: true },
			{ text: " @agent:w-1", link: true },
		]);
		expect(second?.runs).toEqual([{ text: "second line" }]);
		expect(depends).toEqual({ runs: [{ text: "depends:: Prep" }], tone: "dim" });
		expect(due).toEqual({ runs: [{ text: "due:: 2026-11-30" }], tone: "dim" });
		expect(t?.root.children[0]?.heading).toBe(true);
		expect(t?.root.children[1]?.lines.map((l) => [l.tone, l.runs[0]?.text])).toEqual([
			["code", "const a = 1;"],
			["code", "const b = 2;"],
		]);
	});

	test("not one outline tree: null (the caller keeps the markdown)", () => {
		expect(parsePlanTree("# A plan file\n\nSome prose.")).toBeNull();
		expect(parsePlanTree("- one\n- two")).toBeNull();
		expect(parsePlanTree("")).toBeNull();
	});

	test("read annotations are not blocks", () => {
		const t = parsePlanTree("- [ ] Root\n  - Step\n  ‹… 3 more›");
		expect(t?.size).toBe(2);
	});

	test("kept by text: the same tree for the same plan", () => {
		expect(parsePlanTree(PLAN)).toBe(parsePlanTree(PLAN) as never);
	});
});

describe("the overview: the root and two levels", () => {
	test(`depths below ${PLAN_TREE_OPEN_DEPTH} are open; deeper rows do not show`, () => {
		const { rows } = visiblePlanRows(tree(), DEFAULT_PLAN_TREE_VIEW);
		expect(rows.map((r) => [r.node.key, r.node.depth, r.open])).toEqual([
			["r", 0, true],
			["r.0", 1, true],
			["r.0.0", 2, false],
			["r.1", 1, true],
			["r.1.0", 2, false],
			["r.1.1", 2, false],
			["r.2", 1, true],
			["r.2.0", 2, false],
		]);
		// Texts are clamped by default.
		expect(rows.every((r) => !r.whole)).toBe(true);
	});

	test("a leaf is never open", () => {
		const leaf = tree().root.children[1]?.children[1];
		expect(leaf && isPlanNodeOpen(leaf, DEFAULT_PLAN_TREE_VIEW)).toBe(false);
	});
});

describe("the reader's view", () => {
	test("opening a folded node shows its children, folding it again hides them", () => {
		const opened = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" });
		expect(keys(opened)).toContain("r.1.0.0");
		expect(keys(opened)).toContain("r.1.0.1");
		// Its child is at depth 3, folded by default: its own child stays hidden.
		expect(keys(opened)).not.toContain("r.1.0.0.0");
		const back = applyPlanTreeAction(opened, { kind: "node", key: "r.1.0" });
		expect(isDefaultPlanTreeView(back)).toBe(true);
		expect(keys(back)).toEqual(keys(DEFAULT_PLAN_TREE_VIEW));
	});

	test("folding an open phase hides everything under it", () => {
		const view = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1" });
		expect(keys(view).filter((k) => k.startsWith("r.1."))).toEqual([]);
		expect(visiblePlanRows(tree(), view).rows.find((r) => r.node.key === "r.1")?.open).toBe(false);
	});

	test("a text opens whole and clamps again", () => {
		const node = tree().root;
		const whole = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "text", key: "r" });
		expect(isPlanTextWhole(node, whole)).toBe(true);
		expect(isPlanTextWhole(node, applyPlanTreeAction(whole, { kind: "text", key: "r" }))).toBe(
			false,
		);
	});

	test("「全部展开」 opens every node and text; flips count from there; 「全部收起」 is the overview", () => {
		const all = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" });
		const rows = visiblePlanRows(tree(), all).rows;
		expect(rows).toHaveLength(12);
		expect(rows.every((r) => r.whole)).toBe(true);
		expect(rows.filter((r) => r.node.children.length > 0).every((r) => r.open)).toBe(true);
		// A flip in `all` folds that node and clamps that text.
		const folded = applyPlanTreeAction(all, { kind: "node", key: "r.1.0" });
		expect(keys(folded)).not.toContain("r.1.0.0");
		const clamped = applyPlanTreeAction(all, { kind: "text", key: "r" });
		expect(isPlanTextWhole(tree().root, clamped)).toBe(false);
		const overview = applyPlanTreeAction(folded, { kind: "all" });
		expect(overview).toBe(DEFAULT_PLAN_TREE_VIEW);
		// From a view with flips, 「全部展开」 drops them.
		const flipped = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1" });
		expect(applyPlanTreeAction(flipped, { kind: "all" })).toMatchObject({ all: true });
		expect(applyPlanTreeAction(flipped, { kind: "all" }).nodes.size).toBe(0);
	});

	test("the signature names the view, empty for the overview", () => {
		expect(planTreeViewSignature(DEFAULT_PLAN_TREE_VIEW)).toBe("");
		const a = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" });
		const b = applyPlanTreeAction(a, { kind: "text", key: "r" });
		expect(planTreeViewSignature(a)).not.toBe(planTreeViewSignature(b));
		expect(
			planTreeViewSignature(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" })),
		).toBe("a||");
	});

	test("at most `max` rows, the rest counted", () => {
		const all = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" });
		const { rows, cut } = visiblePlanRows(tree(), all, 5);
		expect(rows).toHaveLength(5);
		expect(cut).toBe(7);
	});
});
