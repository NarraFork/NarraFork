/**
 * The guarantee under test: a damaged arrangement costs POSITIONS, never a panel.
 *
 * Each case below is a shape the previous layout-is-the-panel-set design turned into
 * a missing narrator, most importantly an empty or partial layout blob paired with a
 * non-empty member list — the reported bug.
 */

import { describe, expect, test } from "bun:test";
import type { WorkspacePanel } from "@shared/workspace-panels";
import type { SerializedDockview } from "dockview-react";
import type { PanelSpec } from "./dockview-layout";
import {
	decideSurfaceRefresh,
	livePanelIdentity,
	memberIdentity,
	panelDomId,
	planSeedMaterialisation,
	pruneWorkspaceLayout,
	reconcileLayoutWithPanels,
} from "./workspace-panel-set";

function narratorMember(narratorId: string, sortOrder: number): WorkspacePanel {
	return { id: `row-${narratorId}`, kind: "narrator", narratorId, config: null, sortOrder };
}

function terminalMember(id: string, sortOrder: number): WorkspacePanel {
	return {
		id,
		kind: "terminal",
		narratorId: null,
		config: { panelType: "terminal", terminalConfig: { cwd: "/x" } },
		sortOrder,
	};
}

/**
 * A layout with one group holding the given panel ids, mirroring what dockview
 * actually serializes (a grid whose leaf lists `views`, plus a `panels` map).
 */
function layoutWith(
	entries: Array<{ id: string; params: Record<string, unknown> }>,
): SerializedDockview {
	const panels: Record<string, unknown> = {};
	for (const entry of entries) {
		panels[entry.id] = { id: entry.id, contentComponent: "narrator", params: entry.params };
	}
	return {
		grid: {
			root: {
				type: "branch",
				data: [
					{
						type: "leaf",
						data: {
							id: "group-1",
							views: entries.map((entry) => entry.id),
							activeView: entries[0]?.id,
						},
					},
				],
			},
			width: 1920,
			height: 1080,
			orientation: "HORIZONTAL",
		},
		panels,
		activeGroup: "group-1",
	} as unknown as SerializedDockview;
}

test("retired filemod is dropped even when its host remains a member", () => {
	const layout = layoutWith([
		narratorEntry("a"),
		{ id: "old", params: { panelType: "narrator-tool", toolType: "filemod", narratorId: "a" } },
		{ id: "tree", params: { panelType: "narrator-tool", toolType: "filetree", narratorId: "a" } },
	]);
	const plan = reconcileLayoutWithPanels({ panels: [narratorMember("a", 0)], layout });
	expect(plan.droppedPanelIds).toEqual(["old"]);
	expect(plan.appended).toEqual([]);
	expect(gridViews(plan.layout)).toEqual(["a", "tree"]);
	expect(layout.panels.old).toBeDefined();
});

test("retired-only main grid does not reset a surviving floating narrator", () => {
	const layout = layoutWith([
		{ id: "old", params: { panelType: "narrator-tool", toolType: "filemod", narratorId: "a" } },
	]);
	layout.panels.a = {
		id: "a",
		contentComponent: "narrator",
		params: { panelType: "narrator", narratorId: "a" },
	};
	layout.floatingGroups = [
		{
			data: { id: "float", views: ["a"], activeView: "a" },
			position: { left: 1, top: 2, width: 400, height: 300 },
		},
	];
	const plan = reconcileLayoutWithPanels({ panels: [narratorMember("a", 0)], layout });
	expect(plan.layout).not.toBeNull();
	expect(plan.layout?.floatingGroups).toEqual(layout.floatingGroups);
	expect(plan.appended).toEqual([]);
	expect(plan.layout?.activeGroup).toBe("float");
});

function narratorEntry(narratorId: string) {
	return { id: narratorId, params: { panelType: "narrator", narratorId } };
}

/** Panel ids still referenced by the pruned grid. */
function gridViews(layout: SerializedDockview | null): string[] {
	if (!layout) return [];
	const views: string[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		if (record.type === "branch" && Array.isArray(record.data)) {
			for (const child of record.data) walk(child);
			return;
		}
		const data = record.data as { views?: unknown } | undefined;
		if (Array.isArray(data?.views)) views.push(...(data.views as string[]));
	};
	walk((layout as unknown as { grid: { root: unknown } }).grid.root);
	return views;
}

function panelIds(layout: SerializedDockview | null): string[] {
	if (!layout) return [];
	return Object.keys((layout as unknown as { panels: Record<string, unknown> }).panels);
}

describe("layout agrees with membership", () => {
	test("nothing is dropped or appended", () => {
		const panels = [narratorMember("n1", 1000), narratorMember("n2", 2000)];
		const plan = reconcileLayoutWithPanels({
			panels,
			layout: layoutWith([narratorEntry("n1"), narratorEntry("n2")]),
		});

		expect(plan.appended).toEqual([]);
		expect(plan.droppedPanelIds).toEqual([]);
		// The arrangement is handed through untouched.
		expect(plan.layout).not.toBeNull();
	});
});

describe("membership wins when the layout is missing panels", () => {
	// THE REPORTED BUG: the sidebar (and now the member list) knows about narrators
	// the layout never received. Restoring the layout alone rendered nothing for them.
	test("a layout naming only one of two members appends the other", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000), narratorMember("n2", 2000)],
			layout: layoutWith([narratorEntry("n1")]),
		});

		expect(plan.appended.map((panel) => panel.narratorId)).toEqual(["n2"]);
	});

	test("an empty layout places every member instead of rendering nothing", () => {
		const panels = [narratorMember("n1", 1000), narratorMember("n2", 2000)];

		for (const layout of [null, undefined, layoutWith([])]) {
			const plan = reconcileLayoutWithPanels({ panels, layout });
			expect(plan.layout).toBeNull();
			expect(plan.appended.map((panel) => panel.narratorId)).toEqual(["n1", "n2"]);
		}
	});

	test("appended order follows member sortOrder, not layout order", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("late", 3000), narratorMember("early", 1000)],
			layout: null,
		});

		expect(plan.appended.map((panel) => panel.narratorId)).toEqual(["early", "late"]);
	});
});

describe("layout entries that are no longer members are pruned", () => {
	test("a stale narrator entry is dropped while the arrangement survives", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000)],
			layout: layoutWith([narratorEntry("n1"), narratorEntry("gone")]),
		});

		expect(plan.droppedPanelIds).toEqual(["gone"]);
		// Pruned, NOT discarded: discarding would reset a hand-built arrangement every
		// time a narrator is removed elsewhere.
		expect(plan.layout).not.toBeNull();
		expect(panelIds(plan.layout)).toEqual(["n1"]);
		// The grid must stop referencing it too, or dockview's fromJSON throws — and
		// that throw is what used to blank the surface.
		expect(gridViews(plan.layout)).toEqual(["n1"]);
	});

	test("when every entry is stale the layout is abandoned, not restored empty", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000)],
			layout: layoutWith([narratorEntry("gone-a"), narratorEntry("gone-b")]),
		});

		expect(plan.layout).toBeNull();
		expect(plan.appended.map((panel) => panel.narratorId)).toEqual(["n1"]);
	});

	test("an entry with unusable params is dropped", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000)],
			layout: layoutWith([narratorEntry("n1"), { id: "junk", params: {} }]),
		});

		expect(plan.droppedPanelIds).toEqual(["junk"]);
		expect(gridViews(plan.layout)).toEqual(["n1"]);
	});
});

describe("pruning covers every serialized group location", () => {
	function layoutAcrossLocations() {
		const layout = layoutWith([narratorEntry("n1"), narratorEntry("gone")]);
		const group = (id: string, views: string[]) => ({
			id,
			views,
			activeView: "gone",
			tabGroups: [
				{ id: "mixed", collapsed: false, panelIds: views },
				{ id: "stale", collapsed: false, panelIds: ["gone"] },
			],
		});
		const leaf = (id: string, views: string[]) => ({ type: "leaf", data: group(id, views) });
		return {
			...layout,
			grid: {
				...layout.grid,
				root: {
					type: "branch",
					data: [
						{ type: "branch", data: [leaf("group-1", ["gone", "n1"])] },
						{ type: "branch", data: [leaf("stale-grid", ["gone"])] },
					],
				},
			},
			floatingGroups: [
				{
					data: group("float", ["gone", "n1"]),
					position: { left: 1, top: 2, width: 300, height: 400 },
				},
				{
					data: group("stale-float", ["gone"]),
					position: { left: 3, top: 4, width: 300, height: 400 },
				},
			],
			popoutGroups: [
				{ data: group("popout", ["gone", "n1"]), position: null, gridReferenceGroup: "group-1" },
				{
					grid: {
						...layout.grid,
						root: {
							type: "branch",
							data: [leaf("nested-popout", ["gone", "n1"]), leaf("stale-popout", ["gone"])],
						},
					},
					position: null,
					gridReferenceGroup: "stale-grid",
				},
			],
			edgeGroups: {
				left: { size: 200, visible: true, group: group("edge", ["gone", "n1"]) },
				right: { size: 300, visible: false, group: group("stale-edge", ["gone"]) },
			},
			activeGroup: "stale-float",
		} as unknown as SerializedDockview;
	}

	test("membership pruning removes stale references, empty branches and tab groups without mutation", () => {
		const layout = layoutAcrossLocations();
		const before = structuredClone(layout);
		const plan = reconcileLayoutWithPanels({ panels: [narratorMember("n1", 1000)], layout });
		expect(plan.droppedPanelIds).toEqual(["gone"]);
		expect(plan.appended).toEqual([]);
		expect(plan.layout).not.toBeNull();
		expect(gridViews(plan.layout)).toEqual(["n1"]);
		expect(plan.layout?.floatingGroups).toHaveLength(1);
		expect(plan.layout?.floatingGroups?.[0].data).toEqual({
			id: "float",
			views: ["n1"],
			activeView: "n1",
			tabGroups: [{ id: "mixed", collapsed: false, panelIds: ["n1"] }],
		});
		expect(plan.layout?.popoutGroups).toHaveLength(2);
		expect(plan.layout?.popoutGroups?.[0].gridReferenceGroup).toBe("group-1");
		expect(plan.layout?.popoutGroups?.[1].gridReferenceGroup).toBeUndefined();
		expect(plan.layout?.edgeGroups?.left?.group).toMatchObject({ views: ["n1"], activeView: "n1" });
		expect(plan.layout?.edgeGroups?.right).toBeUndefined();
		expect(plan.layout?.activeGroup).toBe("group-1");
		expect(JSON.stringify(plan.layout)).not.toContain("gone");
		expect(layout).toEqual(before);
	});

	test("an active durable floating group survives membership pruning", () => {
		const layout = layoutAcrossLocations();
		layout.activeGroup = "float";
		const pruned = pruneWorkspaceLayout(layout, new Set(["gone"]));
		expect(pruned?.activeGroup).toBe("float");
	});

	test("empty main grid falls back to all members even when a member was placed in a float", () => {
		const layout = layoutAcrossLocations();
		layout.grid = layoutWith([narratorEntry("gone")]).grid;
		expect(pruneWorkspaceLayout(layout, new Set(["gone"]))).toBeNull();
		const members = [narratorMember("n1", 1000), narratorMember("n2", 2000)];
		const plan = reconcileLayoutWithPanels({ panels: members, layout });
		expect(plan.layout).toBeNull();
		expect(plan.appended).toEqual(members);
	});

	test("unlisted panel references are removed as well as explicitly dropped ids", () => {
		const layout = layoutAcrossLocations();
		delete layout.panels.gone;
		const pruned = pruneWorkspaceLayout(layout, new Set());
		expect(gridViews(pruned)).toEqual(["n1"]);
		expect(JSON.stringify(pruned)).not.toContain("gone");
	});
});

describe("dependent panels follow their host", () => {
	test("kept while the host narrator is a member", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000)],
			layout: layoutWith([
				narratorEntry("n1"),
				{
					id: "wtool_n1_git",
					params: { panelType: "narrator-tool", toolType: "git", narratorId: "n1" },
				},
				{
					id: "wsubagent_n1_s1",
					params: { panelType: "subagent", hostNarratorId: "n1", subagentNarratorId: "s1" },
				},
			]),
		});

		// Dependent panels are arrangement, not membership: they are neither dropped
		// nor promoted to `appended`.
		expect(plan.droppedPanelIds).toEqual([]);
		expect(plan.appended).toEqual([]);
		expect(panelIds(plan.layout).sort()).toEqual(["n1", "wsubagent_n1_s1", "wtool_n1_git"]);
	});

	test("dropped once the host narrator is gone", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000)],
			layout: layoutWith([
				narratorEntry("n1"),
				{
					id: "wtool_dead_git",
					params: { panelType: "narrator-tool", toolType: "git", narratorId: "dead" },
				},
				{
					id: "wfile_dead_1",
					params: { panelType: "file", hostNarratorId: "dead", filePath: "/x" },
				},
			]),
		});

		expect(plan.droppedPanelIds.sort()).toEqual(["wfile_dead_1", "wtool_dead_git"]);
		expect(gridViews(plan.layout)).toEqual(["n1"]);
	});
});

describe("non-narrator members", () => {
	test("a terminal stored under its prefixed dom id is recognised", () => {
		const member = terminalMember("term-row", 1000);
		const plan = reconcileLayoutWithPanels({
			panels: [member],
			layout: layoutWith([
				{
					id: panelDomId(member),
					params: { panelType: "terminal", terminalConfig: { cwd: "/x" } },
				},
			]),
		});

		expect(plan.appended).toEqual([]);
		expect(plan.droppedPanelIds).toEqual([]);
	});

	test("two terminals are distinct members and neither is collapsed", () => {
		const a = terminalMember("row-a", 1000);
		const b = terminalMember("row-b", 2000);
		const plan = reconcileLayoutWithPanels({
			panels: [a, b],
			layout: layoutWith([
				{ id: panelDomId(a), params: { panelType: "terminal", terminalConfig: { cwd: "/a" } } },
			]),
		});

		expect(plan.appended.map((panel) => panel.id)).toEqual(["row-b"]);
	});
});

describe("panelDomId", () => {
	test("a narrator panel keeps the narrator id, which existing layouts contain", () => {
		expect(panelDomId(narratorMember("n1", 1000))).toBe("n1");
	});

	test("other kinds are keyed by their member row", () => {
		expect(panelDomId(terminalMember("row-a", 1000))).toBe("wsp_row-a");
	});
});

describe("degenerate layouts are treated as absent rather than throwing", () => {
	test("a layout with no grid falls back to members", () => {
		const plan = reconcileLayoutWithPanels({
			panels: [narratorMember("n1", 1000)],
			layout: {
				panels: { n1: { id: "n1", params: { panelType: "narrator", narratorId: "n1" } } },
			} as unknown as SerializedDockview,
		});

		expect(plan.appended.map((panel) => panel.narratorId)).toEqual(["n1"]);
		expect(plan.layout).toBeNull();
	});

	test("no members and no layout yields an empty plan", () => {
		const plan = reconcileLayoutWithPanels({ panels: [], layout: null });

		expect(plan.layout).toBeNull();
		expect(plan.appended).toEqual([]);
	});
});

/**
 * Regression: a restored layout stores narrator cells under SYNTHETIC ids.
 *
 * Seeded and migrated layouts persist a narrator panel under a `dvp_*` id rather than
 * the narrator id. A reconciliation (or a membership sync) that compared against
 * `panelDomId` therefore matched nothing: every member read as absent AND every
 * restored panel read as a non-member, so the surface re-added each one into the active
 * group and closed the originals — a multi-pane arrangement collapsed into a single
 * pane holding every tab.
 *
 * These assert that identity is id-independent, and that both directions of the
 * comparison agree. They are on the pure module because that is where identity is
 * defined; the effect and `addMemberPanel` both call these exact functions.
 */
describe("identity is independent of the dockview panel id", () => {
	test("a narrator entry stored under a synthetic dvp_ id is recognised as its member", () => {
		const member = narratorMember("n1", 1000);
		const plan = reconcileLayoutWithPanels({
			panels: [member],
			layout: layoutWith([
				{ id: "dvp_m3k1_2", params: { panelType: "narrator", narratorId: "n1" } },
			]),
		});

		// Neither re-added nor dropped: the arrangement is kept exactly as stored.
		expect(plan.appended).toEqual([]);
		expect(plan.droppedPanelIds).toEqual([]);
		expect(plan.layout).not.toBeNull();
		expect(gridViews(plan.layout)).toEqual(["dvp_m3k1_2"]);
	});

	test("member identity and live-panel identity agree for a synthetic id", () => {
		const member = narratorMember("n1", 1000);

		expect(livePanelIdentity({ panelType: "narrator", narratorId: "n1" }, "dvp_m3k1_2")).toBe(
			memberIdentity(member),
		);
		// ...and for the narrator-id convention, so both persisted shapes map to one key.
		expect(livePanelIdentity({ panelType: "narrator", narratorId: "n1" }, "n1")).toBe(
			memberIdentity(member),
		);
	});

	test("a multi-pane layout with synthetic ids survives reconciliation intact", () => {
		const members = [narratorMember("n1", 1000), narratorMember("n2", 2000)];
		const layout = {
			grid: {
				root: {
					type: "branch",
					data: [
						{ type: "leaf", data: { id: "group-1", views: ["dvp_a_1"], activeView: "dvp_a_1" } },
						{ type: "leaf", data: { id: "group-2", views: ["dvp_b_2"], activeView: "dvp_b_2" } },
					],
				},
				width: 1920,
				height: 1080,
				orientation: "HORIZONTAL",
			},
			panels: {
				dvp_a_1: { id: "dvp_a_1", params: { panelType: "narrator", narratorId: "n1" } },
				dvp_b_2: { id: "dvp_b_2", params: { panelType: "narrator", narratorId: "n2" } },
			},
			activeGroup: "group-1",
		} as unknown as SerializedDockview;

		const plan = reconcileLayoutWithPanels({ panels: members, layout });

		// Both panes preserved. This is the assertion that fails if identity regresses to
		// dom-id matching: `appended` would hold both members and the two groups would be
		// re-created as one.
		expect(plan.appended).toEqual([]);
		expect(plan.droppedPanelIds).toEqual([]);
		expect(plan.layout).toBe(layout);
		expect(gridViews(plan.layout).sort()).toEqual(["dvp_a_1", "dvp_b_2"]);
	});

	test("live identity is null for a dependent panel, so it is never treated as a member", () => {
		expect(
			livePanelIdentity(
				{ panelType: "narrator-tool", toolType: "git", narratorId: "n1" },
				"wtool_n1_git",
			),
		).toBeNull();
	});
});

function narratorSpec(
	specId: string,
	narratorId: string,
	placement: PanelSpec["placement"],
): PanelSpec {
	return {
		id: specId,
		params: { panelType: "narrator", narratorId },
		title: "Narrator",
		placement,
	};
}

describe("planSeedMaterialisation", () => {
	// THE CREATION-TIME BUG: a workspace created by a sidebar drag persisted a seed
	// envelope whose whole point is the split direction — and the surface then
	// ignored it, stacking both narrators into one tab group.
	test("two-narrator seed places the second panel relative to the first", () => {
		const members = [narratorMember("n1", 1000), narratorMember("n2", 2000)];
		const specs: PanelSpec[] = [
			narratorSpec("dvp_a_1", "n1", { kind: "first" }),
			narratorSpec("dvp_a_2", "n2", {
				kind: "relative",
				referenceId: "dvp_a_1",
				direction: "right",
			}),
		];

		const plan = planSeedMaterialisation(specs, members);

		expect(plan.appended).toEqual([]);
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[0].domId).toBe("n1");
		expect(plan.steps[0].position).toBeUndefined();
		expect(plan.steps[1].domId).toBe("n2");
		// The reference is resolved to the first MEMBER's dom id, not the seed's
		// temporary dvp_* id — dockview knows nothing about the latter.
		expect(plan.steps[1].position).toEqual({ direction: "right", referenceDomId: "n1" });
	});

	test("a member the seed does not mention is appended, never dropped", () => {
		const members = [narratorMember("n1", 1000), narratorMember("n2", 2000)];
		const specs: PanelSpec[] = [narratorSpec("dvp_a_1", "n1", { kind: "first" })];

		const plan = planSeedMaterialisation(specs, members);

		expect(plan.steps.map((step) => step.member.narratorId)).toEqual(["n1"]);
		expect(plan.appended.map((panel) => panel.narratorId)).toEqual(["n2"]);
	});

	test("a spec naming a non-member narrator is skipped", () => {
		const members = [narratorMember("n1", 1000)];
		const specs: PanelSpec[] = [
			narratorSpec("dvp_a_1", "n1", { kind: "first" }),
			narratorSpec("dvp_a_2", "gone", {
				kind: "relative",
				referenceId: "dvp_a_1",
				direction: "below",
			}),
		];

		const plan = planSeedMaterialisation(specs, members);

		expect(plan.steps.map((step) => step.member.narratorId)).toEqual(["n1"]);
		expect(plan.appended).toEqual([]);
	});

	test("a dangling reference degrades to a default position rather than dropping the panel", () => {
		const members = [narratorMember("n1", 1000), narratorMember("n2", 2000)];
		const specs: PanelSpec[] = [
			narratorSpec("dvp_a_1", "n1", { kind: "first" }),
			narratorSpec("dvp_a_2", "n2", {
				kind: "relative",
				referenceId: "dvp_nonexistent",
				direction: "right",
			}),
		];

		const plan = planSeedMaterialisation(specs, members);

		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[1].position).toBeUndefined();
	});

	test("a non-narrator spec is skipped rather than inventing a row id", () => {
		const members = [narratorMember("n1", 1000)];
		const specs: PanelSpec[] = [
			{
				id: "dvp_t_1",
				params: { panelType: "terminal", panelRowId: "row-t", terminalConfig: { cwd: "/x" } },
				title: "Terminal",
				placement: { kind: "first" },
			},
			narratorSpec("dvp_a_1", "n1", { kind: "first" }),
		];

		const plan = planSeedMaterialisation(specs, members);

		expect(plan.steps.map((step) => step.member.narratorId)).toEqual(["n1"]);
	});

	test("a narrator repeated across specs is placed once", () => {
		const members = [narratorMember("n1", 1000)];
		const specs: PanelSpec[] = [
			narratorSpec("dvp_a_1", "n1", { kind: "first" }),
			narratorSpec("dvp_a_2", "n1", {
				kind: "relative",
				referenceId: "dvp_a_1",
				direction: "right",
			}),
		];

		const plan = planSeedMaterialisation(specs, members);

		expect(plan.steps).toHaveLength(1);
		expect(plan.appended).toEqual([]);
	});
});

describe("decideSurfaceRefresh", () => {
	// THE STALE-CACHE BUG: the surface was built from a cached tree while the server
	// held a newer one, and nothing reconciled them — so the stale arrangement was
	// what the next persist wrote back.
	test("an incoming tree identical to the baseline is ignored", () => {
		expect(
			decideSurfaceRefresh({ localEdit: false, builtTree: "tree-a", incomingTree: "tree-a" }),
		).toBe("ignore");
	});

	test("a different tree with no local edits rebuilds from the server layout", () => {
		expect(
			decideSurfaceRefresh({ localEdit: false, builtTree: "tree-a", incomingTree: "tree-b" }),
		).toBe("rebuild");
	});

	test("a different tree WITH local edits keeps the surface and only advances the baseline", () => {
		expect(
			decideSurfaceRefresh({ localEdit: true, builtTree: "tree-a", incomingTree: "tree-b" }),
		).toBe("adopt-baseline");
	});

	test("null/undefined incoming trees compare equal to a null baseline", () => {
		expect(decideSurfaceRefresh({ localEdit: false, builtTree: null, incomingTree: null })).toBe(
			"ignore",
		);
		expect(
			decideSurfaceRefresh({ localEdit: false, builtTree: null, incomingTree: undefined }),
		).toBe("ignore");
	});

	test("an empty baseline with a real incoming tree rebuilds", () => {
		expect(
			decideSurfaceRefresh({ localEdit: false, builtTree: null, incomingTree: "tree-a" }),
		).toBe("rebuild");
	});
});
