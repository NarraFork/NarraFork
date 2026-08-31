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
import {
	livePanelIdentity,
	memberIdentity,
	panelDomId,
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
