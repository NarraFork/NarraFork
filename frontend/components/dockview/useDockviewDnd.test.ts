import { describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import type { PanelDragState } from "../../lib/panel-drag";
import type { DockviewDropTarget } from "./useDockviewDnd";
import { dropExistingPanel, isLocalPanelDrag } from "./useDockviewDnd";

/**
 * Regression coverage for dropExistingPanel — the function that turns a resolved
 * drop intent into a dockview mutation.
 *
 * The key regression: a MERGE must tab the panel into the target group via an
 * explicit `index`, NOT `position: "center"`. A bare center position is a no-op
 * when the dragged panel is the sole member of its source group, so the two
 * groups never collapse (found via the headless dock smoke test).
 */

interface MoveCall {
	panel: string;
	group?: string;
	position?: string;
	index?: number;
}

function makeApi(
	panels: Record<string, { groupId: string; groupPanelCount?: number }>,
	groups: string[],
): { api: DockviewApi; moves: MoveCall[]; activated: string[] } {
	const moves: MoveCall[] = [];
	const activated: string[] = [];

	const groupObjs = groups.map((id, i) => ({
		id,
		// Each group reports a panels array sized by groupPanelCount of any panel
		// that belongs to it (default 1) so `group.panels.length` is meaningful.
		get panels() {
			const owner = Object.values(panels).find((p) => p.groupId === id);
			return new Array(owner?.groupPanelCount ?? 1).fill({ id: "x" });
		},
		// Minimal group api with a boundingBox so swapPanels can derive sides.
		// Lay groups out left→right, 500px wide each.
		api: { boundingBox: { left: i * 500, top: 0, width: 500, height: 800 } },
	}));
	const groupById = (id: string) => groupObjs.find((g) => g.id === id);

	const makePanel = (panelId: string) => {
		const cfg = panels[panelId];
		return {
			id: panelId,
			api: {
				group: groupById(cfg.groupId),
				moveTo: (opts: { group?: { id: string }; position?: string; index?: number }) => {
					moves.push({
						panel: panelId,
						group: opts.group?.id,
						position: opts.position,
						index: opts.index,
					});
				},
				setActive: () => activated.push(panelId),
			},
		};
	};

	const api = {
		groups: groupObjs,
		getPanel: (id: string) => (panels[id] ? makePanel(id) : undefined),
	} as unknown as DockviewApi;

	return { api, moves, activated };
}

describe("dropExistingPanel", () => {
	test("no-op when panel or target group is missing", () => {
		const { api, moves } = makeApi({ a: { groupId: "g1" } }, ["g1"]);
		dropExistingPanel(api, "a", {
			groupId: "does-not-exist",
			intent: "merge",
			targetPanelId: undefined,
		});
		expect(moves).toHaveLength(0);
	});

	test("MERGE tabs the panel into the target group by index, not position:center", () => {
		// spec panel in g2, merging into g1 (which already has 1 panel).
		const { api, moves, activated } = makeApi(
			{ spec: { groupId: "g2" }, chat: { groupId: "g1", groupPanelCount: 1 } },
			["g1", "g2"],
		);
		const target: DockviewDropTarget = {
			groupId: "g1",
			intent: "merge",
			targetPanelId: "chat",
		};
		dropExistingPanel(api, "spec", target);
		expect(moves).toHaveLength(1);
		// Must move into g1 by index (append), NOT via a center position.
		expect(moves[0]).toMatchObject({ panel: "spec", group: "g1", index: 1 });
		expect(moves[0].position).toBeUndefined();
		expect(activated).toEqual(["spec"]);
	});

	test("MERGE into the group the panel already solely occupies is a no-op move", () => {
		const { api, moves, activated } = makeApi({ spec: { groupId: "g1" } }, ["g1"]);
		dropExistingPanel(api, "spec", {
			groupId: "g1",
			intent: "merge",
			targetPanelId: undefined,
		});
		// No moveTo — just re-activate.
		expect(moves).toHaveLength(0);
		expect(activated).toEqual(["spec"]);
	});

	test("SPLIT onto the panel's own sole-member group is a no-op (Bug 2 guard)", () => {
		// Dragging the lone panel of a group to that same group's edge would not
		// change the arrangement; moving it there tears down the group mid-move
		// and the panel vanishes. Every intent must no-op in this case.
		for (const intent of ["left", "right", "above", "below"] as const) {
			const { api, moves, activated } = makeApi({ solo: { groupId: "g1", groupPanelCount: 1 } }, [
				"g1",
			]);
			dropExistingPanel(api, "solo", { groupId: "g1", intent, targetPanelId: undefined });
			expect(moves).toHaveLength(0); // never calls moveTo
			expect(activated).toEqual(["solo"]);
		}
	});

	test("SPLIT into the panel's own MULTI-panel group still moves (arrangement changes)", () => {
		// When the source group has other panels, splitting off to an edge is a
		// real change, so moveTo must run.
		const { api, moves } = makeApi({ a: { groupId: "g1", groupPanelCount: 2 } }, ["g1"]);
		dropExistingPanel(api, "a", { groupId: "g1", intent: "right", targetPanelId: undefined });
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ panel: "a", group: "g1", position: "right" });
	});

	test("SPLIT keeps a directional position (left/right/above/below)", () => {
		const cases: Array<[DockviewDropTarget["intent"], string]> = [
			["left", "left"],
			["right", "right"],
			["above", "top"],
			["below", "bottom"],
		];
		for (const [intent, position] of cases) {
			const { api, moves } = makeApi({ spec: { groupId: "g2" }, chat: { groupId: "g1" } }, [
				"g1",
				"g2",
			]);
			dropExistingPanel(api, "spec", { groupId: "g1", intent, targetPanelId: undefined });
			expect(moves).toHaveLength(1);
			expect(moves[0]).toMatchObject({ panel: "spec", group: "g1", position });
			expect(moves[0].index).toBeUndefined();
		}
	});

	test("SWAP delegates to swapPanels (sole-member panes → single relocating move)", () => {
		// chat in g1 (left), spec in g2 (right), both sole members. swapPanels
		// relocates the dragged sole pane to the opposite side of the target,
		// swapping their positions with a single move (no group is orphaned).
		const { api, moves } = makeApi({ chat: { groupId: "g1" }, spec: { groupId: "g2" } }, [
			"g1",
			"g2",
		]);
		dropExistingPanel(api, "spec", {
			groupId: "g1",
			intent: "swap",
			targetPanelId: "chat",
		});
		// spec (sole, right) relocates to the opposite side of chat's group (left).
		expect(moves).toEqual([{ panel: "spec", group: "g1", position: "left", index: undefined }]);
	});

	test("SWAP onto itself is a no-op (no self-swap)", () => {
		const { api, moves } = makeApi({ spec: { groupId: "g1" } }, ["g1"]);
		dropExistingPanel(api, "spec", {
			groupId: "g1",
			intent: "swap",
			targetPanelId: "spec",
		});
		expect(moves).toHaveLength(0);
	});
});

/**
 * Which drags a surface may treat as "my own panel being rearranged".
 *
 * This guard is what stops a cross-surface drop from moving the WRONG panel.
 * Panel ids are global (`ndock-terminal`), so once several surfaces coexist — one
 * per expanded graph node — a surface receiving a foreign panel's drop would
 * resolve that id against its own api and silently move its own same-kind panel
 * while the dragged one stayed put.
 */
function drag(over: Partial<PanelDragState> = {}): PanelDragState {
	return { id: "subject", title: "t", x: 0, y: 0, ...over };
}

describe("isLocalPanelDrag", () => {
	test("a live panel from the same surface is local", () => {
		expect(
			isLocalPanelDrag(drag({ panelId: "ndock-terminal", surfaceId: "chap_1" }), "chap_1"),
		).toBe(true);
	});

	test("a live panel from ANOTHER surface is not local (the mis-move guard)", () => {
		// Node A's terminal dropped onto node B: B must not resolve
		// "ndock-terminal" against its own api and move its own terminal.
		expect(
			isLocalPanelDrag(drag({ panelId: "ndock-terminal", surfaceId: "chap_A" }), "chap_B"),
		).toBe(false);
	});

	test("a drag with no panelId is never local (sidebar tab / detached panel)", () => {
		expect(isLocalPanelDrag(drag({ surfaceId: "chap_1" }), "chap_1")).toBe(false);
		expect(isLocalPanelDrag(drag({ toolKind: "terminal" }), "chap_1")).toBe(false);
	});

	test("legacy drags without surfaceId stay local (single-surface behaviour preserved)", () => {
		// The focus page and the workspace worked before this field existed; a drag
		// that carries no surfaceId must keep being handled in-surface.
		expect(isLocalPanelDrag(drag({ panelId: "ndock-spec" }), "chap_1")).toBe(true);
		expect(isLocalPanelDrag(drag({ panelId: "ndock-spec" }), undefined)).toBe(true);
		expect(isLocalPanelDrag(drag({ panelId: "ndock-spec", surfaceId: "chap_1" }), undefined)).toBe(
			true,
		);
	});
});
