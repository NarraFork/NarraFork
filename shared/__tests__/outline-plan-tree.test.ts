/**
 * The reader's outline of a plan (plan readability): parsed from the plan's markdown rendering
 * into the plan format's roles (title, background, points, notable points, details), shown by
 * default as the title, the background whole, the big and small points, each closed node's
 * children behind one preview line, the notable items whole; each node and text flipped by the
 * reader, a whole subtree expanded or returned to the default view (the preview line, the quick
 * control, Alt+click), 「全部展开」 expanding the root's subtree and 「全部收起」 returning to
 * the default view.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type OutlineItem, serializeMarkdownOutline } from "../outline";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	isDefaultPlanTreeView,
	isPlanNodeOpen,
	isPlanSubtreeExpanded,
	isPlanTextWhole,
	isPlanTreeAllExpanded,
	PLAN_TREE_CLAMP_LINES,
	PLAN_TREE_OPEN_DEPTH,
	type PlanTreeAction,
	type PlanTreeView,
	parsePlanTree,
	planDescendants,
	planTextClamps,
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
const step = (content: string, children: OutlineItem[] = []) => item(content, children, true);

/** A plan in the format: title, background, two big points, the notable points. */
const PLAN = serializeMarkdownOutline([
	step("历史读取超过 10 秒改为告警", [
		item("读历史超过 10 秒就拒绝，慢磁盘上会话会莫名失败；这次改成告警。"),
		step("阶段 1：去掉固定时间拒绝", [
			step("清除模型历史链路的固定时间拒绝", [
				item("删除 deadline 传播和超时 reject", [item("保留错误码一个版本")]),
				item("loop.ts 删掉 HISTORY_READ_TIMEOUT 分支"),
				item("调用方不改签名"),
			]),
			step("工具结果回放改为告警", [item("回放超过 10 秒只记 warn")]),
			step("会话恢复改为告警"),
		]),
		step("阶段 2：界面提示", [step("读取慢时在会话头部提示")]),
		item("特别值得注意的点", [
			item("错误码保留一个版本", [item("旧日志解析器依赖它")]),
			item("压缩恢复链路这次不动"),
		]),
	]),
]);

beforeEach(() => resetPlanTreeCacheForTest());

const tree = () => {
	const parsed = parsePlanTree(PLAN);
	if (!parsed) throw new Error("not a tree");
	return parsed;
};
const keys = (view: PlanTreeView) => visiblePlanRows(tree(), view).rows.map((r) => r.node.key);
const act = (view: PlanTreeView, ...actions: PlanTreeAction[]) =>
	actions.reduce(applyPlanTreeAction, view);

describe("parsing the plan's markdown", () => {
	test("roles from where each block sits, index-path keys, depths, the count, what folds", () => {
		const t = tree();
		const roles: Array<[string, string, number, boolean]> = [];
		const walk = (n: typeof t.root) => {
			roles.push([n.key, n.role, n.depth, n.folds]);
			n.children.forEach(walk);
		};
		walk(t.root);
		expect(roles).toEqual([
			["r", "title", 0, true],
			["r.0", "background", 1, false],
			["r.1", "point", 1, true],
			["r.1.0", "point", 2, true],
			["r.1.0.0", "detail", 3, true],
			["r.1.0.0.0", "detail", 4, false],
			["r.1.0.1", "detail", 3, false],
			["r.1.0.2", "detail", 3, false],
			["r.1.1", "point", 2, true],
			["r.1.1.0", "detail", 3, false],
			["r.1.2", "point", 2, false],
			["r.2", "point", 1, false],
			["r.2.0", "point", 2, false],
			["r.3", "notable", 1, true],
			["r.3.0", "notableItem", 2, true],
			["r.3.0.0", "detail", 3, false],
			["r.3.1", "notableItem", 2, false],
		]);
		expect(t.size).toBe(17);
		expect(planDescendants(t.root)).toBe(16);
		expect(t.folds).toBe(true);
	});

	test("the background is the root's first block only when it is a paragraph with nothing under it", () => {
		const first = (child: OutlineItem) =>
			parsePlanTree(serializeMarkdownOutline([step("Title", [child, step("Phase")])]))?.root
				.children[0]?.role;
		expect(first(item("A paragraph of background."))).toBe("background");
		expect(first(item("> A quoted paragraph."))).toBe("background");
		expect(first(step("A task"))).toBe("point");
		expect(first(item("# Background"))).toBe("point");
		expect(first(item("Goal", [item("Imports run unattended")]))).toBe("point");
		// Only the first: a later paragraph is a point.
		const t = parsePlanTree(
			serializeMarkdownOutline([step("Title", [step("Phase"), item("A paragraph")])]),
		);
		expect(t?.root.children.map((c) => c.role)).toEqual(["point", "point"]);
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

describe("the default view", () => {
	test(`depths below ${PLAN_TREE_OPEN_DEPTH} open; a closed node with children shows one preview line`, () => {
		const { rows } = visiblePlanRows(tree(), DEFAULT_PLAN_TREE_VIEW);
		expect(
			rows.map((r) => [
				r.node.key,
				r.open,
				r.preview && [r.preview.first.key, r.preview.rest, r.preview.more],
			]),
		).toEqual([
			["r", true, null],
			["r.0", false, null],
			["r.1", true, null],
			["r.1.0", false, ["r.1.0.0", 2, true]],
			// One one-line detail with nothing under it: the line may be all there is.
			["r.1.1", false, ["r.1.1.0", 0, false]],
			["r.1.2", false, null],
			["r.2", true, null],
			["r.2.0", false, null],
			["r.3", true, null],
			["r.3.0", false, ["r.3.0.0", 0, false]],
			["r.3.1", false, null],
		]);
	});

	test("the background and the notable items show whole; the title and the points clamp", () => {
		const { rows } = visiblePlanRows(tree(), DEFAULT_PLAN_TREE_VIEW);
		const whole = Object.fromEntries(rows.map((r) => [r.node.key, r.whole]));
		expect(whole).toMatchObject({
			r: false,
			"r.0": true,
			"r.1": false,
			"r.1.0": false,
			"r.3": false,
			"r.3.0": true,
			"r.3.1": true,
		});
		expect(PLAN_TREE_CLAMP_LINES).toBe(3);
		const t = tree();
		expect(planTextClamps(t.root)).toBe(true);
		expect(planTextClamps(t.root.children[0] as never)).toBe(false);
		// A detail is whole even if the reader somehow flipped it.
		const detail = t.root.children[1]?.children[0]?.children[0];
		if (!detail) throw new Error("no detail");
		const flipped = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "text", key: detail.key });
		expect(isPlanTextWhole(detail, flipped)).toBe(true);
	});

	test("the quick control: on rows with something folded inside, never on the root or the background", () => {
		const { rows } = visiblePlanRows(tree(), DEFAULT_PLAN_TREE_VIEW);
		expect(Object.fromEntries(rows.map((r) => [r.node.key, r.subtree]))).toEqual({
			r: null,
			"r.0": null,
			"r.1": "expand",
			"r.1.0": "expand",
			"r.1.1": "expand",
			"r.1.2": null,
			"r.2": null,
			"r.2.0": null,
			"r.3": "expand",
			"r.3.0": "expand",
			"r.3.1": null,
		});
	});

	test("a leaf is never open", () => {
		const leaf = tree().root.children[1]?.children[2];
		expect(leaf && isPlanNodeOpen(leaf, DEFAULT_PLAN_TREE_VIEW)).toBe(false);
	});
});

describe("the reader's view", () => {
	test("the arrow opens one node: its children show, a deeper node with children previews", () => {
		const opened = act(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" });
		const { rows } = visiblePlanRows(tree(), opened);
		const under = rows.filter((r) => r.node.key.startsWith("r.1.0."));
		expect(under.map((r) => [r.node.key, r.open, r.preview?.first.key ?? null])).toEqual([
			["r.1.0.0", false, "r.1.0.0.0"],
			["r.1.0.1", false, null],
			["r.1.0.2", false, null],
		]);
		expect(rows.find((r) => r.node.key === "r.1.0")?.preview).toBeNull();
		// The arrow again: back to the preview, the view the default one.
		const closed = applyPlanTreeAction(opened, { kind: "node", key: "r.1.0" });
		expect(isDefaultPlanTreeView(closed)).toBe(true);
		// A big point closes too, and then previews its first small point.
		const big = act(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1" });
		const row = visiblePlanRows(tree(), big).rows.find((r) => r.node.key === "r.1");
		expect([row?.open, row?.preview?.first.key, row?.preview?.rest]).toEqual([false, "r.1.0", 2]);
	});

	test("a subtree expands whole (each detail with its children, every text whole) and collapses back", () => {
		const view = act(DEFAULT_PLAN_TREE_VIEW, { kind: "subtree", key: "r.1.0" });
		expect(isPlanSubtreeExpanded(view, "r.1.0")).toBe(true);
		const { rows } = visiblePlanRows(tree(), view);
		const inside = rows.filter((r) => r.node.key.startsWith("r.1.0"));
		expect(inside.map((r) => [r.node.key, r.open, r.whole, r.preview])).toEqual([
			["r.1.0", true, true, null],
			["r.1.0.0", true, true, null],
			["r.1.0.0.0", false, true, null],
			["r.1.0.1", false, true, null],
			["r.1.0.2", false, true, null],
		]);
		expect(rows.find((r) => r.node.key === "r.1.0")?.subtree).toBe("collapse");
		// Outside it nothing changed.
		expect(rows.find((r) => r.node.key === "r.1.1")?.preview?.first.key).toBe("r.1.1.0");
		// Again: the default view inside it, which is the default view.
		expect(
			isDefaultPlanTreeView(applyPlanTreeAction(view, { kind: "subtree", key: "r.1.0" })),
		).toBe(true);
	});

	test("a big point's subtree: its small points' details too; one of them collapsed back inside it", () => {
		const view = act(DEFAULT_PLAN_TREE_VIEW, { kind: "subtree", key: "r.1" });
		expect(keys(view)).toEqual([
			"r",
			"r.0",
			"r.1",
			"r.1.0",
			"r.1.0.0",
			"r.1.0.0.0",
			"r.1.0.1",
			"r.1.0.2",
			"r.1.1",
			"r.1.1.0",
			"r.1.2",
			"r.2",
			"r.2.0",
			"r.3",
			"r.3.0",
			"r.3.1",
		]);
		// Collapse one small point inside the expanded big point: it previews again, its sibling
		// stays open, and the big point is no longer all expanded (its control says expand).
		const inner = applyPlanTreeAction(view, { kind: "subtree", key: "r.1.0" });
		const { rows } = visiblePlanRows(tree(), inner);
		const row = (key: string) => rows.find((r) => r.node.key === key);
		expect([row("r.1.0")?.open, row("r.1.0")?.preview?.rest]).toEqual([false, 2]);
		expect(row("r.1.1")?.open).toBe(true);
		expect(row("r.1")?.subtree).toBe("expand");
		expect(row("r.1.0")?.subtree).toBe("expand");
		// Expanding the big point again clears what was inside it.
		const again = applyPlanTreeAction(inner, { kind: "subtree", key: "r.1" });
		expect(planTreeViewSignature(again)).toBe(planTreeViewSignature(view));
	});

	test("a flipped node inside an expanded subtree makes it not all expanded; expanding clears it", () => {
		const view = act(
			DEFAULT_PLAN_TREE_VIEW,
			{ kind: "subtree", key: "r.1" },
			{ kind: "node", key: "r.1.1" },
		);
		expect(isPlanSubtreeExpanded(view, "r.1")).toBe(false);
		expect(isPlanSubtreeExpanded(view, "r.1.0")).toBe(true);
		const again = applyPlanTreeAction(view, { kind: "subtree", key: "r.1" });
		expect(isPlanSubtreeExpanded(again, "r.1")).toBe(true);
	});

	test("the text of a point opens whole and clamps again", () => {
		const t = tree();
		const point = t.root.children[1];
		if (!point) throw new Error("no point");
		const whole = act(DEFAULT_PLAN_TREE_VIEW, { kind: "text", key: point.key });
		expect(isPlanTextWhole(point, whole)).toBe(true);
		expect(
			isDefaultPlanTreeView(applyPlanTreeAction(whole, { kind: "text", key: point.key })),
		).toBe(true);
	});

	test("「全部展开」 expands the root's subtree; 「全部收起」 is the default view again", () => {
		const all = act(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" }, { kind: "all" });
		expect(isPlanTreeAllExpanded(all)).toBe(true);
		const { rows } = visiblePlanRows(tree(), all);
		expect(rows).toHaveLength(17);
		expect(rows.every((r) => r.whole && r.preview === null)).toBe(true);
		expect(rows.filter((r) => r.subtree).every((r) => r.subtree === "collapse")).toBe(true);
		// A node closed in it: no longer all expanded; 「全部展开」 again opens it.
		const one = applyPlanTreeAction(all, { kind: "node", key: "r.3" });
		expect(isPlanTreeAllExpanded(one)).toBe(false);
		expect(isPlanTreeAllExpanded(applyPlanTreeAction(one, { kind: "all" }))).toBe(true);
		expect(isDefaultPlanTreeView(applyPlanTreeAction(all, { kind: "all" }))).toBe(true);
	});

	test("the signature names the view; the default view's is empty", () => {
		expect(planTreeViewSignature(DEFAULT_PLAN_TREE_VIEW)).toBe("");
		const a = act(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" });
		const b = act(DEFAULT_PLAN_TREE_VIEW, { kind: "subtree", key: "r.1.0" });
		const c = act(DEFAULT_PLAN_TREE_VIEW, { kind: "text", key: "r.1.0" });
		const sigs = [a, b, c].map(planTreeViewSignature);
		expect(new Set(sigs).size).toBe(3);
		expect(sigs.every((s) => s.length > 0)).toBe(true);
		// Order-independent.
		const ab = act(
			DEFAULT_PLAN_TREE_VIEW,
			{ kind: "node", key: "r.1" },
			{ kind: "node", key: "r.2" },
		);
		const ba = act(
			DEFAULT_PLAN_TREE_VIEW,
			{ kind: "node", key: "r.2" },
			{ kind: "node", key: "r.1" },
		);
		expect(planTreeViewSignature(ab)).toBe(planTreeViewSignature(ba));
	});

	test("a key that only starts like another is not inside it", () => {
		const big = serializeMarkdownOutline([
			step(
				"Title",
				Array.from({ length: 12 }, (_, i) => step(`Phase ${i}`, [step("Task", [item("Detail")])])),
			),
		]);
		const t = parsePlanTree(big);
		if (!t) throw new Error("not a tree");
		const view = act(DEFAULT_PLAN_TREE_VIEW, { kind: "subtree", key: "r.1" });
		const { rows } = visiblePlanRows(t, view);
		expect(rows.find((r) => r.node.key === "r.1.0")?.open).toBe(true);
		expect(rows.find((r) => r.node.key === "r.10.0")?.open).toBe(false);
		// A node the reader opened under `r.10` is not inside `r.1`: expanding `r.1` keeps it, and
		// does not count it against `r.1` being all expanded.
		const both = act(
			DEFAULT_PLAN_TREE_VIEW,
			{ kind: "node", key: "r.10.0" },
			{ kind: "subtree", key: "r.1" },
		);
		expect(visiblePlanRows(t, both).rows.find((r) => r.node.key === "r.10.0")?.open).toBe(true);
		expect(isPlanSubtreeExpanded(both, "r.1")).toBe(true);
	});
});

describe("a preview's more", () => {
	test("a lone first child with blocks under it, or with several lines, is more than its line", () => {
		const one = (child: OutlineItem) =>
			visiblePlanRows(
				parsePlanTree(
					serializeMarkdownOutline([
						step("T", [item("Background."), step("P", [step("Task", [child])])]),
					]),
				) as never,
				DEFAULT_PLAN_TREE_VIEW,
			).rows.find((r) => r.node.key === "r.1.0")?.preview;
		expect(one(item("Short"))).toMatchObject({ rest: 0, more: false });
		expect(one(item("Short", [item("Under")]))).toMatchObject({ rest: 0, more: true });
		expect(one(item("One\nTwo"))).toMatchObject({ rest: 0, more: true });
	});
});

describe("a plan written before the format", () => {
	test("the same depth rules: the root, big and small points shown, details previewed", () => {
		const legacy = serializeMarkdownOutline([
			step("Ship the importer\nGoal: imports run unattended", [
				item("Goal", [item("Imports run unattended")]),
				step("Phase 1", [step("Parse", [item("Detail A", [item("Deeper")]), item("Detail B")])]),
			]),
		]);
		const t = parsePlanTree(legacy);
		if (!t) throw new Error("not a tree");
		const { rows } = visiblePlanRows(t, DEFAULT_PLAN_TREE_VIEW);
		expect(
			rows.map((r) => [r.node.key, r.node.role, r.preview?.first.key ?? null, r.preview?.rest]),
		).toEqual([
			["r", "title", null, undefined],
			["r.0", "point", null, undefined],
			["r.0.0", "point", null, undefined],
			["r.1", "point", null, undefined],
			["r.1.0", "point", "r.1.0.0", 1],
		]);
	});
});

describe("the row limit", () => {
	test("rows past it are counted", () => {
		const { rows, cut } = visiblePlanRows(tree(), DEFAULT_PLAN_TREE_VIEW, 4);
		expect(rows).toHaveLength(4);
		expect(cut).toBe(7);
	});
});
