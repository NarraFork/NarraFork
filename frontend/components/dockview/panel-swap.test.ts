import { describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import { swapPanels } from "./panel-swap";

interface MoveCall {
	panel: string;
	groupId: string;
	index: number | undefined;
	position: string | undefined;
}

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Minimal Dockview API double. Panels belong to groups; each group exposes its
 * members (so `group.panels.length` and index lookups work) and a boundingBox
 * (so `swapPanels` can derive relative side). `moveTo` only RECORDS the call —
 * it does not mutate the layout — which is enough to assert the choreography.
 */
function makeApi(
	layout: Record<string, { group: string; index: number }>,
	boxes: Record<string, Box> = {},
): { api: DockviewApi; moves: MoveCall[]; activated: string[] } {
	const moves: MoveCall[] = [];
	const activated: string[] = [];

	const groups = new Map<
		string,
		{ id: string; panels: { id: string }[]; api: { boundingBox?: Box } }
	>();
	for (const [, { group }] of Object.entries(layout)) {
		if (!groups.has(group)) {
			groups.set(group, { id: group, panels: [], api: { boundingBox: boxes[group] } });
		}
	}
	for (const [group, entry] of groups) {
		entry.panels = Object.entries(layout)
			.filter(([, cfg]) => cfg.group === group)
			.sort((a, b) => a[1].index - b[1].index)
			.map(([id]) => ({ id }));
	}

	const makePanel = (panelId: string) => {
		const groupId = layout[panelId].group;
		return {
			id: panelId,
			api: {
				group: groups.get(groupId),
				moveTo: ({
					group,
					index,
					position,
				}: {
					group: { id: string };
					index?: number;
					position?: string;
				}) => {
					moves.push({ panel: panelId, groupId: group.id, index, position });
				},
				setActive: () => activated.push(panelId),
			},
		};
	};

	const api = {
		getPanel: (id: string) => (layout[id] ? makePanel(id) : undefined),
	} as unknown as DockviewApi;

	return { api, moves, activated };
}

describe("swapPanels", () => {
	test("no-op when either panel is missing", () => {
		const { api, moves } = makeApi({ a: { group: "g1", index: 0 } });
		swapPanels(api, "a", "does-not-exist");
		expect(moves).toHaveLength(0);
	});

	test("no-op when swapping a panel with itself", () => {
		const { api, moves } = makeApi({ a: { group: "g1", index: 0 } });
		swapPanels(api, "a", "a");
		expect(moves).toHaveLength(0);
	});

	test("same group → exchanges indices in both directions", () => {
		const { api, moves } = makeApi({
			a: { group: "g1", index: 0 },
			b: { group: "g1", index: 1 },
		});
		swapPanels(api, "a", "b");
		expect(moves).toEqual([
			{ panel: "a", groupId: "g1", index: 1, position: undefined },
			{ panel: "b", groupId: "g1", index: 0, position: undefined },
		]);
	});

	test("sole-member panes (side by side) → A relocates to the OPPOSITE side of B (single move)", () => {
		// Horizontal layout: A pane on the left, B pane on the right. Swapping
		// them = move A to the right of B (one move, no orphaned group, B pane
		// does NOT vanish). This is the real dock chat↔spec scenario.
		const { api, moves, activated } = makeApi(
			{ a: { group: "gA", index: 0 }, b: { group: "gB", index: 0 } },
			{
				gA: { left: 0, top: 0, width: 500, height: 800 },
				gB: { left: 500, top: 0, width: 500, height: 800 },
			},
		);
		swapPanels(api, "a", "b");
		expect(moves).toEqual([{ panel: "a", groupId: "gB", index: undefined, position: "right" }]);
		expect(activated).toEqual(["a"]);
	});

	test("sole-member panes stacked vertically → opposite vertical side", () => {
		const { api, moves } = makeApi(
			{ a: { group: "gA", index: 0 }, b: { group: "gB", index: 0 } },
			{
				gA: { left: 0, top: 0, width: 800, height: 500 },
				gB: { left: 0, top: 500, width: 800, height: 500 },
			},
		);
		// A is above B → relocate A below B.
		swapPanels(api, "a", "b");
		expect(moves).toEqual([{ panel: "a", groupId: "gB", index: undefined, position: "bottom" }]);
	});

	test("A shares its group but B is sole member → move B to the opposite side of A", () => {
		// gA = [x, a] (multi-member), gB = [b] (sole). Swapping a↔b must NOT tear
		// down gA; instead relocate B's pane to the opposite side of A's group.
		const { api, moves } = makeApi(
			{
				x: { group: "gA", index: 0 },
				a: { group: "gA", index: 1 },
				b: { group: "gB", index: 0 },
			},
			{
				gA: { left: 0, top: 0, width: 500, height: 800 },
				gB: { left: 500, top: 0, width: 500, height: 800 },
			},
		);
		swapPanels(api, "a", "b");
		// B (right, sole) relocates to the opposite side of A's group (left).
		expect(moves).toEqual([{ panel: "b", groupId: "gA", index: undefined, position: "left" }]);
	});

	test("both groups multi-member → cross-group index swap (neither group empties)", () => {
		const { api, moves, activated } = makeApi({
			x: { group: "gA", index: 0 },
			a: { group: "gA", index: 1 },
			b: { group: "gB", index: 0 },
			y: { group: "gB", index: 1 },
		});
		swapPanels(api, "a", "b");
		expect(moves).toEqual([
			{ panel: "a", groupId: "gB", index: 0, position: undefined },
			{ panel: "b", groupId: "gA", index: 1, position: undefined },
		]);
		expect(activated).toEqual(["a"]);
	});
});
