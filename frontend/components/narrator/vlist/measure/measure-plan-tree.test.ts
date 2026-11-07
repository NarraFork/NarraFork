/**
 * An outline plan's tree in its ExitPlanMode card (plan readability), as the measure lays it out:
 * the overview's rows (root and two levels), their heights (lines × the body line, clamped to two
 * unless whole), the badge's room, the toolbar, the plan's capped box — and how the card's detail
 * is classified and keyed: an outline plan is a tree (a plan file, a cut prefix, a non-tree text
 * stay markdown), the reader's view reaches the classifier and the measure-cache key, and the
 * interaction state holds it per card.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type OutlineItem, serializeMarkdownOutline } from "@shared/outline";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	PLAN_TREE_CLAMP_LINES,
	type PlanTree,
	parsePlanTree,
	resetPlanTreeCacheForTest,
} from "@shared/outline-plan-tree";
import {
	classifyToolDetail,
	type ToolPlanTreeDetail,
	type ToolSectionBody,
} from "@shared/pretext-layout/tool-detail";
import { resetTypographyForTest, setTypography } from "@shared/pretext-layout/typography";
import { buildCacheKey, extractDataRevision } from "../measure-cache";
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
	PLAN_TREE_INDENT,
	PLAN_TREE_MAX_INDENT_DEPTH,
	PLAN_TREE_PAD_Y,
	PLAN_TREE_ROW_GAP,
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

const LONG = "长".repeat(400);
/** A long root (the legacy shape), phases, tasks with details, a fifth level. */
const PLAN = serializeMarkdownOutline([
	item(
		`Ship the importer\n${LONG}`,
		[
			item("Goal", [item("Imports run unattended")]),
			item(
				"Phase 1",
				[item("Parse", [item("Detail A", [item("Deeper")]), item("Detail B")], true)],
				true,
			),
		],
		true,
	),
]);

const planTree = (): PlanTree => {
	const t = parsePlanTree(PLAN);
	if (!t) throw new Error("not a tree");
	return t;
};

describe("the overview's rows", () => {
	test("the root and two levels, each row its lines × the body line, gaps between", () => {
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const line = typographyMetrics().line.body;
		expect(layout.rows.map((r) => [r.key, r.depth, r.open])).toEqual([
			["r", 0, true],
			["r.0", 1, true],
			["r.0.0", 2, false],
			["r.1", 1, true],
			["r.1.0", 2, false],
		]);
		// The long root is clamped to two lines; the others are one line.
		expect(layout.rows.map((r) => r.height)).toEqual([
			PLAN_TREE_CLAMP_LINES * line,
			line,
			line,
			line,
			line,
		]);
		let y = 0;
		for (const row of layout.rows) {
			expect(row.top).toBe(y);
			y += row.height + PLAN_TREE_ROW_GAP;
		}
		expect(layout.contentHeight).toBe(y - PLAN_TREE_ROW_GAP);
		expect(layout.rows[0]?.clamped).toBe(true);
		expect(layout.rows[0]?.textToggles).toBe(true);
		expect(layout.toolbar).toBe(true);
		expect(layout.size).toBe(8);
	});

	test("indent, arrow and marker slots; deep levels stop indenting", () => {
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const row = layout.rows.find((r) => r.key === "r.1.0");
		expect(row?.left).toBe(2 * PLAN_TREE_INDENT);
		expect(row?.textLeft).toBe(2 * PLAN_TREE_INDENT + PLAN_TREE_TOGGLE_SLOT + planTreeMarkerSlot());
		// A folded row with children carries its child count, and its text gives it room.
		expect(row?.badge?.text).toBe("+2");
		expect(row?.badge?.count).toBe(2);
		const open = layout.rows.find((r) => r.key === "r.1");
		expect(open?.badge).toBeNull();
		expect((row?.textWidth ?? 0) + (row?.badge?.width ?? 0)).toBeLessThan(
			600 - (row?.textLeft ?? 0),
		);
		const deep = serializeMarkdownOutline([
			item("r", [
				item("1", [item("2", [item("3", [item("4", [item("5", [item("6", [item("7")])])])])])]),
			]),
		]);
		const all = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" });
		const rows = layoutPlanTree(parsePlanTree(deep) as PlanTree, all, 600).rows;
		expect(rows.at(-1)?.depth).toBe(7);
		expect(rows.at(-1)?.left).toBe(PLAN_TREE_MAX_INDENT_DEPTH * PLAN_TREE_INDENT);
	});

	test("a whole text takes all its lines; a narrower box wraps it into more", () => {
		const whole = applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "text", key: "r" });
		const wide = layoutPlanTree(planTree(), whole, 600).rows[0];
		const narrow = layoutPlanTree(planTree(), whole, 300).rows[0];
		const line = typographyMetrics().line.body;
		expect(wide?.clamped).toBe(false);
		expect((wide?.height ?? 0) / line).toBeGreaterThan(PLAN_TREE_CLAMP_LINES);
		expect(narrow?.height ?? 0).toBeGreaterThan(wide?.height ?? 0);
		// Clamped, both are two lines whatever the width.
		expect(layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 300).rows[0]?.height).toBe(2 * line);
	});

	test("opening a node adds its rows; 「全部展开」 shows every block whole", () => {
		const base = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		const opened = layoutPlanTree(
			planTree(),
			applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "node", key: "r.1.0" }),
			600,
		);
		expect(opened.rows.map((r) => r.key)).toContain("r.1.0.0");
		expect(opened.contentHeight).toBeGreaterThan(base.contentHeight);
		const all = layoutPlanTree(
			planTree(),
			applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" }),
			600,
		);
		expect(all.rows).toHaveLength(8);
		expect(all.rows.some((r) => r.clamped)).toBe(false);
	});

	test("nothing folded or clamped and nothing opened: no toolbar", () => {
		const flat = parsePlanTree(
			serializeMarkdownOutline([item("Title", [item("Goal", [item("Short")])])]),
		) as PlanTree;
		expect(flat.folds).toBe(false);
		expect(layoutPlanTree(flat, DEFAULT_PLAN_TREE_VIEW, 600).toolbar).toBe(false);
	});

	test("the reader's typography sets the line", () => {
		const before = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600).rows[1]?.height;
		setTypography({ fontScalePercent: 130, lineHeightScalePercent: 120 });
		const after = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600).rows[1]?.height;
		expect(after).toBe(typographyMetrics().line.body);
		expect(after).toBeGreaterThan(before ?? 0);
	});
});

describe("in the card", () => {
	const body = (view = DEFAULT_PLAN_TREE_VIEW): ToolPlanTreeDetail => ({
		kind: "plan-tree",
		tree: planTree(),
		view,
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
	});

	test("toolbar line, gap, then the box: the rows and their padding, up to the plan's cap", () => {
		const measured = measureToolBody(body(), 612, 900);
		const layout = layoutPlanTree(planTree(), DEFAULT_PLAN_TREE_VIEW, 600);
		expect(measured.kind).toBe("plan-tree");
		expect(measured.height).toBe(
			planTreeToolbarHeight() + PLAN_TREE_TOOLBAR_GAP + layout.contentHeight + PLAN_TREE_PAD_Y * 2,
		);
		// 「全部展开」 of a long plan in a short viewport: the box stops at 0.85 × the viewport.
		const all = measureToolBody(
			body(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" })),
			612,
			200,
		);
		expect(all.height).toBe(
			planTreeToolbarHeight() + PLAN_TREE_TOOLBAR_GAP + resolveDetailCap("plan", 200),
		);
	});
});

describe("classifying an ExitPlanMode", () => {
	const classify = (inputJson: unknown, planView?: typeof DEFAULT_PLAN_TREE_VIEW) =>
		classifyToolDetail({
			toolUseId: "t1",
			toolName: "ExitPlanMode",
			category: "plan",
			status: "success",
			inputJson,
			...(planView ? { planView } : {}),
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
});

describe("the reader's view, per card", () => {
	test("held in the interaction state, kept across an LOD change, empty again at the overview", () => {
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

	test("the measure-cache key moves with the view and the plan, so a fold re-measures", () => {
		const detail = (view = DEFAULT_PLAN_TREE_VIEW, plan = PLAN) =>
			classifyToolDetail({
				toolUseId: "t1",
				toolName: "ExitPlanMode",
				category: "plan",
				status: "success",
				inputJson: { mode: "outline", plan },
				planView: view,
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
		const all = key(detail(applyPlanTreeAction(DEFAULT_PLAN_TREE_VIEW, { kind: "all" })));
		const other = key(detail(DEFAULT_PLAN_TREE_VIEW, PLAN.replace("Goal", "Aims")));
		expect(new Set([base, opened, text, all, other]).size).toBe(5);
		expect(key(detail())).toBe(base);
	});
});
