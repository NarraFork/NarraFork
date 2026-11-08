/**
 * An outline plan's tree in its ExitPlanMode card (plan readability), as the measure lays it out:
 * the rows of the default view (the title clamped to three lines, the background whole under it
 * with no arrow or marker, the points, each closed row's preview line with its label measured in
 * the body font), the quick control's room, their heights and gaps, what opening a node, a
 * subtree or everything adds, the toolbar, the plan's capped box — and how the card's detail is
 * classified and keyed: an outline plan is a tree (a plan file, a cut prefix, a non-tree text
 * stay markdown), the reader's view and the preview's labels reach the classifier and the
 * measure-cache key, and the interaction state holds the view per card.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type OutlineItem, serializeMarkdownOutline } from "@shared/outline";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	PLAN_TREE_CLAMP_LINES,
	type PlanTree,
	type PlanTreeAction,
	type PlanTreeView,
	parsePlanTree,
	resetPlanTreeCacheForTest,
} from "@shared/outline-plan-tree";
import {
	classifyToolDetail,
	type ToolPlanTreeDetail,
	type ToolSectionBody,
} from "@shared/pretext-layout/tool-detail";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { buildCacheKey, extractDataRevision, retainedBodySourceChars } from "../measure-cache";
import { typographyMetrics } from "../pretext-fonts";
import { rowInteractionSig } from "../vlist-exact-row-state";
import {
	applyVListPlanTreeAction,
	createVListInteractionState,
	resetVListInteractionStateForLod,
	resolvePlanTreeViewRow,
} from "../vlist-interaction-state";
import {
	layoutPlanTree,
	PLAN_TREE_BACKGROUND_GAP,
	PLAN_TREE_INDENT,
	PLAN_TREE_MAX_INDENT_DEPTH,
	PLAN_TREE_PAD_Y,
	PLAN_TREE_PREVIEW_LABEL_GAP,
	PLAN_TREE_ROW_GAP,
	PLAN_TREE_SUBTREE_GAP,
	PLAN_TREE_SUBTREE_SLOT,
	PLAN_TREE_TOGGLE_SLOT,
	PLAN_TREE_TOOLBAR_GAP,
	planTreeMarkerSlot,
	planTreeToolbarHeight,
} from "./measure-plan-tree";
import { measureToolBody, resolveDetailCap } from "./measure-tool-call";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});
beforeEach(() => {
	resetPlanTreeCacheForTest();
	resetTypographyForTest();
});

const item = (content: string, children: OutlineItem[] = [], task = false): OutlineItem => ({
	content,
	task: task ? { status: "todo", assignee: null } : null,
	props: {},
	children,
});
const step = (content: string, children: OutlineItem[] = []) => item(content, children, true);

const LONG = "长".repeat(400);
/**
 * A long root (a legacy title), the background, a big point whose first small point has two
 * details (one with a child) and whose second has one short detail, the notable points.
 */
const PLAN = serializeMarkdownOutline([
	step(`Ship the importer\n${LONG}`, [
		item("The importer fails every night and is rerun by hand."),
		step("Phase 1", [
			step("Parse", [item("Detail A", [item("Deeper")]), item("Detail B")]),
			step("Validate", [item("Short")]),
		]),
		item("Notable points", [item("A risk")]),
	]),
]);

const planTree = (): PlanTree => {
	const t = parsePlanTree(PLAN);
	if (!t) throw new Error("not a tree");
	return t;
};
const view = (...actions: PlanTreeAction[]): PlanTreeView =>
	actions.reduce(applyPlanTreeAction, DEFAULT_PLAN_TREE_VIEW);
const textLeftAt = (depth: number) =>
	Math.min(depth, PLAN_TREE_MAX_INDENT_DEPTH) * PLAN_TREE_INDENT +
	PLAN_TREE_TOGGLE_SLOT +
	planTreeMarkerSlot();

describe("the default view's rows", () => {
	test("each row its lines × the body line (and its preview line), gaps between", () => {
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const line = typographyMetrics().line.body;
		expect(layout.rows.map((r) => [r.key, r.role, r.open])).toEqual([
			["r", "title", true],
			["r.0", "background", false],
			["r.1", "point", true],
			["r.1.0", "point", false],
			["r.1.1", "point", false],
			["r.2", "notable", true],
			["r.2.0", "notableItem", false],
		]);
		const preview = line + PLAN_TREE_ROW_GAP + line;
		// The long root is clamped to three lines; a closed row adds its preview line.
		expect(layout.rows.map((r) => r.height)).toEqual([
			PLAN_TREE_CLAMP_LINES * line,
			line,
			line,
			preview,
			preview,
			line,
			line,
		]);
		let y = 0;
		for (const row of layout.rows) {
			expect(row.top).toBe(y);
			y +=
				row.height + PLAN_TREE_ROW_GAP + (row.role === "background" ? PLAN_TREE_BACKGROUND_GAP : 0);
		}
		expect(layout.contentHeight).toBe(y - PLAN_TREE_ROW_GAP);
		expect(layout.rows[0]?.clamped).toBe(true);
		expect(layout.rows[0]?.textToggles).toBe(true);
		expect(layout.toolbar).toBe(true);
		expect(layout.allOpen).toBe(false);
		expect(layout.size).toBe(11);
	});

	test("the background sits under the title's text, whole, however long", () => {
		const long = serializeMarkdownOutline([
			step("Title", [item("背".repeat(380)), step("Phase", [step("Task")])]),
		]);
		const layout = layoutPlanTree(parsePlanTree(long) as PlanTree, DEFAULT_PLAN_TREE_VIEW, 300);
		const bg = layout.rows[1];
		expect(bg?.role).toBe("background");
		expect(bg?.left).toBe(0);
		expect(bg?.textLeft).toBe(textLeftAt(0));
		expect(bg?.clamped).toBe(false);
		expect(bg?.textToggles).toBe(false);
		expect((bg?.height ?? 0) / typographyMetrics().line.body).toBeGreaterThan(
			PLAN_TREE_CLAMP_LINES,
		);
		expect(layout.rows[2]?.top).toBe(
			(bg?.top ?? 0) + (bg?.height ?? 0) + PLAN_TREE_ROW_GAP + PLAN_TREE_BACKGROUND_GAP,
		);
	});

	test("indent, arrow and marker slots, the quick control's room; deep levels stop indenting", () => {
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const row = (key: string) => layout.rows.find((r) => r.key === key);
		expect(row("r.1.0")?.left).toBe(2 * PLAN_TREE_INDENT);
		expect(row("r.1.0")?.textLeft).toBe(textLeftAt(2));
		// A row with something folded inside gives its quick control room; one without does not.
		expect(row("r.1.0")?.subtree).toBe("expand");
		expect(row("r.1.0")?.textWidth).toBe(
			600 - textLeftAt(2) - PLAN_TREE_SUBTREE_SLOT - PLAN_TREE_SUBTREE_GAP,
		);
		expect(row("r.2.0")?.subtree).toBeNull();
		expect(row("r.2.0")?.textWidth).toBe(600 - textLeftAt(2));
		expect(row("r")?.subtree).toBeNull();
		const deep = serializeMarkdownOutline([
			item("r", [
				item("1", [item("2", [item("3", [item("4", [item("5", [item("6", [item("7")])])])])])]),
			]),
		]);
		const rows = layoutPlanTree(parsePlanTree(deep) as PlanTree, view({ kind: "all" }), 600).rows;
		expect(rows.at(-1)?.depth).toBe(7);
		expect(rows.at(-1)?.left).toBe(PLAN_TREE_MAX_INDENT_DEPTH * PLAN_TREE_INDENT);
	});

	test("a preview: its first child's first line, at a child's text, narrowed by the label and the ellipsis", () => {
		const labels = { more: "还有 {n} 条 ▸", one: "展开 ▸" };
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600, labels);
		const line = typographyMetrics().line.body;
		const parse = layout.rows.find((r) => r.key === "r.1.0");
		const p = parse?.preview;
		expect(p?.top).toBe(line + PLAN_TREE_ROW_GAP);
		expect(p?.left).toBe(textLeftAt(3));
		expect(p?.label).toBe("还有 1 条 ▸");
		expect(p?.rest).toBe(1);
		expect(p?.ellipsis).toBe(true);
		expect(p?.labelWidth).toBeGreaterThan(0);
		expect(p?.width).toBe(
			600 -
				textLeftAt(3) -
				(p?.labelWidth ?? 0) -
				PLAN_TREE_PREVIEW_LABEL_GAP -
				layout.ellipsisWidth,
		);
		// A lone one-line detail that fits: the line is all there is, no ellipsis, no label.
		const validate = layout.rows.find((r) => r.key === "r.1.1")?.preview;
		expect([validate?.label, validate?.ellipsis, validate?.width]).toEqual([
			null,
			false,
			600 - textLeftAt(3),
		]);
	});

	test("a lone detail wider than its line, of several lines, or with blocks under it: 「展开 ▸」", () => {
		const wide = serializeMarkdownOutline([
			step("Title", [item("Background."), step("Phase", [step("Task", [item("x".repeat(300))])])]),
		]);
		const lines = serializeMarkdownOutline([
			step("Title", [item("Background."), step("Phase", [step("Task", [item("one\ntwo")])])]),
		]);
		const under = serializeMarkdownOutline([
			step("Title", [
				item("Background."),
				step("Phase", [step("Task", [item("one", [item("under")])])]),
			]),
		]);
		for (const md of [wide, lines, under]) {
			const layout = layoutPlanTree(parsePlanTree(md) as PlanTree, DEFAULT_PLAN_TREE_VIEW, 400, {
				more: "还有 {n} 条 ▸",
				one: "展开 ▸",
			});
			const p = layout.rows.find((r) => r.key === "r.1.0")?.preview;
			expect([p?.label, p?.ellipsis, p?.rest]).toEqual(["展开 ▸", true, 0]);
		}
	});

	test("a whole text takes all its lines; a narrower box wraps it into more", () => {
		const whole = view({ kind: "text", key: "r" });
		const wide = layoutPlanTree(planTree(), whole, 600).rows[0];
		const narrow = layoutPlanTree(planTree(), whole, 300).rows[0];
		const line = typographyMetrics().line.body;
		expect(wide?.clamped).toBe(false);
		expect((wide?.height ?? 0) / line).toBeGreaterThan(PLAN_TREE_CLAMP_LINES);
		expect(narrow?.height ?? 0).toBeGreaterThan(wide?.height ?? 0);
		// Clamped, both are three lines whatever the width.
		expect(layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 300).rows[0]?.height).toBe(
			PLAN_TREE_CLAMP_LINES * line,
		);
	});
});

describe("opening", () => {
	test("a node shows its children in place of the preview; a deeper node previews in turn", () => {
		const base = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const opened = layoutPlanTree(planTree(), view({ kind: "node", key: "r.1.0" }), 600);
		const row = (key: string) => opened.rows.find((r) => r.key === key);
		expect(row("r.1.0")?.preview).toBeNull();
		expect(row("r.1.0.0")?.preview?.left).toBe(textLeftAt(4));
		expect(row("r.1.0.1")).toBeDefined();
		expect(opened.contentHeight).toBeGreaterThan(base.contentHeight);
	});

	test("a subtree: everything in it, whole; collapsing it is the default layout again", () => {
		const base = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const expanded = layoutPlanTree(planTree(), view({ kind: "subtree", key: "r.1" }), 600);
		const inside = expanded.rows.filter((r) => r.key.startsWith("r.1"));
		expect(inside.map((r) => r.key)).toEqual([
			"r.1",
			"r.1.0",
			"r.1.0.0",
			"r.1.0.0.0",
			"r.1.0.1",
			"r.1.1",
			"r.1.1.0",
		]);
		expect(inside.every((r) => r.preview === null && !r.clamped)).toBe(true);
		expect(expanded.rows.find((r) => r.key === "r.1")?.subtree).toBe("collapse");
		const back = layoutPlanTree(
			planTree(),
			view({ kind: "subtree", key: "r.1" }, { kind: "subtree", key: "r.1" }),
			600,
		);
		expect(back.contentHeight).toBe(base.contentHeight);
	});

	test("「全部展开」 shows every block whole; the toolbar then offers 「全部收起」", () => {
		const all = layoutPlanTree(planTree(), view({ kind: "all" }), 600);
		expect(all.rows).toHaveLength(11);
		expect(all.rows.some((r) => r.clamped || r.preview)).toBe(false);
		expect(all.allOpen).toBe(true);
		expect(all.toolbar).toBe(true);
	});

	test("a text flip that no longer clamps (a wider card) does not keep the toolbar", () => {
		const md = serializeMarkdownOutline([
			step("Title", [item("Background."), step(`Phase ${"长".repeat(110)}`)]),
		]);
		const t = parsePlanTree(md) as PlanTree;
		const flipped = view({ kind: "text", key: "r.1" });
		// Narrow: the point clamps, the toolbar shows; whole after the flip, 「全部收起」 is offered.
		const narrow = layoutPlanTree(t, flipped, 200);
		expect(narrow.rows[2]?.textToggles).toBe(true);
		expect([narrow.toolbar, narrow.allOpen]).toEqual([true, true]);
		// Wide: nothing clamps any more; the flip alone keeps no toolbar.
		const wide = layoutPlanTree(t, flipped, 4000);
		expect(wide.rows[2]?.textToggles).toBe(false);
		expect(wide.toolbar).toBe(false);
	});

	test("everything opened one by one: nothing hidden, so the toolbar offers 「全部收起」", () => {
		const opened = view(
			{ kind: "text", key: "r" },
			{ kind: "subtree", key: "r.1.0", open: true },
			{ kind: "subtree", key: "r.1.1", open: true },
			{ kind: "subtree", key: "r.2.0", open: true },
		);
		const layout = layoutPlanTree(planTree(), opened, 600);
		expect(layout.rows.some((r) => r.preview || r.clamped)).toBe(false);
		expect(layout.allOpen).toBe(true);
		// What it then does: the default view (the action says which way).
		expect(applyPlanTreeAction(opened, { kind: "all", open: false })).toEqual(
			DEFAULT_PLAN_TREE_VIEW,
		);
	});

	test("nothing folded or clamped and nothing opened: no toolbar", () => {
		const flat = parsePlanTree(
			serializeMarkdownOutline([
				step("Title", [item("Background."), step("Phase", [step("Task")])]),
			]),
		) as PlanTree;
		expect(flat.folds).toBe(false);
		expect(layoutPlanTree(flat, DEFAULT_PLAN_TREE_VIEW, 600).toolbar).toBe(false);
	});

	test("the reader's typography sets the line", () => {
		const before = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600).rows[2]?.height;
		setTypography({ fontScalePercent: 130, lineHeightScalePercent: 120 });
		const after = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600).rows[2]?.height;
		expect(after).toBe(typographyMetrics().line.body);
		expect(after).toBeGreaterThan(before ?? 0);
	});
});

describe("in the card", () => {
	const body = (v = DEFAULT_PLAN_TREE_VIEW): ToolPlanTreeDetail => ({
		kind: "plan-tree",
		tree: planTree(),
		view: v,
		markdown: {
			kind: "capped",
			id: "input.plan",
			source: "input.plan",
			cap: "plan",
			format: "markdown",
			live: false,
			followTarget: { kind: "end" },
			text: PLAN,
		},
		labels: { more: "{n} more ▸", one: "Expand ▸" },
	});

	test("toolbar line, gap, then the box: the rows and their padding, up to the plan's cap", () => {
		const measured = measureToolBody(body(), 612, 900);
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		expect(measured.kind).toBe("plan-tree");
		expect(measured.height).toBe(
			planTreeToolbarHeight() + PLAN_TREE_TOOLBAR_GAP + layout.contentHeight + PLAN_TREE_PAD_Y * 2,
		);
		// 「全部展开」 of a long plan in a short viewport: the box stops at 0.85 × the viewport.
		const all = measureToolBody(body(view({ kind: "all" })), 612, 200);
		expect(all.height).toBe(
			planTreeToolbarHeight() + PLAN_TREE_TOOLBAR_GAP + resolveDetailCap("plan", 200),
		);
	});

	test("the measured body counts the plan's text against the cache's source budget", () => {
		expect(retainedBodySourceChars(measureToolBody(body(), 612, 900))).toBe(PLAN.length);
	});

	test("the detail's labels are the preview's", () => {
		const measured = measureToolBody(
			{ ...body(), labels: { more: "还有 {n} 条 ▸", one: "展开 ▸" } },
			612,
			900,
		);
		const tree = measured.blocks.find((b) => b.kind === "fixed" && b.tag === "detail-plan-tree");
		const layout = (tree as unknown as { data: { layout: ReturnType<typeof layoutPlanTree> } }).data
			.layout;
		expect(layout.rows.find((r) => r.key === "r.1.0")?.preview?.label).toBe("还有 1 条 ▸");
	});
});

describe("classifying an ExitPlanMode", () => {
	const classify = (
		inputJson: unknown,
		planView?: typeof DEFAULT_PLAN_TREE_VIEW,
		labels?: Record<string, string>,
	) =>
		classifyToolDetail({
			toolUseId: "t1",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "success",
			inputJson,
			...(planView ? { planView } : {}),
			...(labels ? { labels } : {}),
		})?.sections[0]?.body as ToolSectionBody | undefined;

	test("an outline plan is its tree (declared mode, or the server's submission)", () => {
		expect(classify({ mode: "outline", plan: PLAN })?.kind).toBe("plan-tree");
		expect(classify({ plan: PLAN, _planRoot: { blockId: "b" } })?.kind).toBe("plan-tree");
	});

	test("a plan file, a server-side prefix, a text that is not one tree stay markdown", () => {
		expect(classify({ mode: "file", plan: PLAN })?.kind).toBe("capped");
		expect(classify({ plan: PLAN })?.kind).toBe("capped");
		expect(
			classify({
				mode: "outline",
				plan: { _truncated: true, preview: PLAN.slice(0, 40), fullLength: PLAN.length },
			})?.kind,
		).toBe("capped");
		expect(classify({ mode: "outline", plan: "# A heading\n\nprose" })?.kind).toBe("capped");
	});

	test("the reader's view reaches the body; the markdown stays for the viewer", () => {
		const view = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" });
		const tree = classify({ mode: "outline", plan: PLAN }, view) as ToolPlanTreeDetail;
		expect(tree.view).toBe(view);
		expect(tree.markdown).toMatchObject({ kind: "capped", format: "markdown", text: PLAN });
		const plain = classify({ mode: "outline", plan: PLAN }) as ToolPlanTreeDetail;
		expect(plain.view).toBe(DEFAULT_PLAN_TREE_VIEW);
	});

	test("the preview's labels come from the adapter's, English when absent", () => {
		const zh = classify({ mode: "outline", plan: PLAN }, undefined, {
			planTreeDetailsMore: "还有 {n} 条 ▸",
			planTreeDetailsOne: "展开 ▸",
		}) as ToolPlanTreeDetail;
		expect(zh.labels).toEqual({ more: "还有 {n} 条 ▸", one: "展开 ▸" });
		const en = classify({ mode: "outline", plan: PLAN }) as ToolPlanTreeDetail;
		expect(en.labels).toEqual({ more: "{n} more ▸", one: "Expand ▸" });
	});
});

describe("the reader's view, per card", () => {
	test("held in the interaction state, kept across an LOD change, empty again at the default view", () => {
		let state = createVListInteractionState(5);
		expect(resolvePlanTreeViewRow(state, "tool-a")).toBe(DEFAULT_PLAN_TREE_VIEW);
		state = applyVListPlanTreeAction(state, "tool-a", { kind: "node", key: "r.1.0" });
		expect(resolvePlanTreeViewRow(state, "tool-a").nodes.has("r.1.0")).toBe(true);
		expect(resolvePlanTreeViewRow(state, "tool-b")).toBe(DEFAULT_PLAN_TREE_VIEW);
		const before = rowInteractionSig(createVListInteractionState(5), "tool-a");
		expect(rowInteractionSig(state, "tool-a")).not.toBe(before);
		expect(rowInteractionSig(state, "tool-b")).toBe(before);
		state = resetVListInteractionStateForLod(state, 3);
		expect(resolvePlanTreeViewRow(state, "tool-a").nodes.has("r.1.0")).toBe(true);
		state = applyVListPlanTreeAction(state, "tool-a", { kind: "node", key: "r.1.0" });
		expect(state.planTrees.size).toBe(0);
	});

	test("the measure-cache key moves with the view, the plan and the labels, so a fold re-measures", () => {
		const detail = (v = DEFAULT_PLAN_TREE_VIEW, plan = PLAN, labels?: Record<string, string>) =>
			classifyToolDetail({
				toolUseId: "t1",
				toolName: "ExitPlanMode",
				category: "plan",
				status: "success",
				inputJson: { mode: "outline", plan },
				planView: v,
				...(labels ? { labels } : {}),
			});
		const key = (d: ReturnType<typeof detail>) =>
			buildCacheKey("tool-t1", "tool-call", 600, 5, undefined, extractDataRevision({ detail: d }));
		const base = key(detail());
		const opened = key(
			detail(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" })),
		);
		const text = key(
			detail(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "text", key: "r" })),
		);
		const subtree = key(
			detail(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "subtree", key: "r.1.0" })),
		);
		const all = key(detail(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" })));
		const other = key(detail(DEFAULT_PLAN_TREE_VIEW, PLAN.replace("Parse", "Read")));
		const zh = key(
			detail(DEFAULT_PLAN_TREE_VIEW, PLAN, {
				planTreeDetailsMore: "还有 {n} 条 ▸",
				planTreeDetailsOne: "展开 ▸",
			}),
		);
		expect(new Set([base, opened, text, subtree, all, other, zh]).size).toBe(7);
		expect(key(detail())).toBe(base);
	});
});
