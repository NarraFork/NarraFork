import { describe, expect, test } from "bun:test";
import type { DockviewApi } from "dockview-react";
import { swapPanels } from "./panel-swap";

interface MoveCall {
	panel: string;
	groupId: string;
	index: number | undefined;
	position: string | undefined;
}

interface SizeCall {
	groupId: string;
	width: number | undefined;
	height: number | undefined;
}

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Minimal Dockview API double. Panels belong to groups; each group exposes its
 * members (so `group.panels.length` and index lookups work), a boundingBox
 * (so `swapPanels` can derive relative side and restore proportions), and
 * setSize (so proportion restore is observable).
 *
 * `moveTo` with a `position` simulates the sole-member choreography: the moved
 * panel adopts a NEW group placed on the requested side of the target group,
 * both groups re-split the union of their pre-move boxes (Dockview-like), and
 * the source group is dropped when it empties. `moveTo` with only `index`
 * records a tab-slot swap without changing geometry.
 */
function makeApi(
	layout: Record<string, { group: string; index: number }>,
	boxes: Record<string, Box> = {},
): { api: DockviewApi; moves: MoveCall[]; activated: string[]; sizes: SizeCall[] } {
	const moves: MoveCall[] = [];
	const activated: string[] = [];
	const sizes: SizeCall[] = [];

	// Live group store — mutated by moveTo so post-swap geometry is realistic.
	const groups = new Map<
		string,
		{
			id: string;
			panels: { id: string }[];
			api: {
				boundingBox?: Box;
				setSize: (e: { width?: number; height?: number }) => void;
			};
		}
	>();

	const ensureGroup = (id: string, box?: Box) => {
		const existing = groups.get(id);
		if (existing) {
			if (box) existing.api.boundingBox = box;
			return existing;
		}
		const entry = {
			id,
			panels: [] as { id: string }[],
			api: {
				boundingBox: box,
				setSize: (e: { width?: number; height?: number }) => {
					sizes.push({ groupId: id, width: e.width, height: e.height });
					const entry = groups.get(id);
					const cur = entry?.api.boundingBox;
					if (!entry || !cur) return;
					entry.api.boundingBox = {
						...cur,
						width: e.width ?? cur.width,
						height: e.height ?? cur.height,
					};
				},
			},
		};
		groups.set(id, entry);
		return entry;
	};

	for (const [, { group }] of Object.entries(layout)) {
		ensureGroup(group, boxes[group]);
	}
	for (const [groupId, entry] of groups) {
		entry.panels = Object.entries(layout)
			.filter(([, cfg]) => cfg.group === groupId)
			.sort((a, b) => a[1].index - b[1].index)
			.map(([id]) => ({ id }));
	}

	// Which group a panel currently lives in (mutated by moveTo).
	const panelGroup = new Map<string, string>();
	for (const [panelId, cfg] of Object.entries(layout)) {
		panelGroup.set(panelId, cfg.group);
	}
	let nextGroupId = 1;

	/** Place a new group on `position` relative to `toward`, re-splitting both. */
	const placeBeside = (towardId: string, position: string, newId: string) => {
		const toward = groups.get(towardId);
		if (!toward?.api.boundingBox) return ensureGroup(newId);
		const t = toward.api.boundingBox;
		const created = ensureGroup(newId);
		// Re-split the toward group's current box: new group takes half on the
		// requested side (sufficient to flip geometric order after a swap).
		if (position === "left" || position === "right") {
			const half = t.width / 2;
			if (position === "left") {
				created.api.boundingBox = { left: t.left, top: t.top, width: half, height: t.height };
				toward.api.boundingBox = { ...t, left: t.left + half, width: half };
			} else {
				created.api.boundingBox = {
					left: t.left + half,
					top: t.top,
					width: half,
					height: t.height,
				};
				toward.api.boundingBox = { ...t, width: half };
			}
		} else if (position === "top" || position === "bottom") {
			const half = t.height / 2;
			if (position === "top") {
				created.api.boundingBox = { left: t.left, top: t.top, width: t.width, height: half };
				toward.api.boundingBox = { ...t, top: t.top + half, height: half };
			} else {
				created.api.boundingBox = {
					left: t.left,
					top: t.top + half,
					width: t.width,
					height: half,
				};
				toward.api.boundingBox = { ...t, height: half };
			}
		} else {
			created.api.boundingBox = { ...t };
		}
		return created;
	};

	const makePanel = (panelId: string) => {
		return {
			id: panelId,
			api: {
				get group() {
					const gid = panelGroup.get(panelId);
					return gid === undefined ? undefined : groups.get(gid);
				},
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
					const fromId = panelGroup.get(panelId);
					if (fromId === undefined) return;
					const from = groups.get(fromId);
					if (!from) return;

					// Tab-slot move within/across existing groups: membership only.
					if (position === undefined) {
						from.panels = from.panels.filter((p) => p.id !== panelId);
						const to = groups.get(group.id);
						if (!to) return;
						to.panels.splice(index ?? to.panels.length, 0, { id: panelId });
						panelGroup.set(panelId, group.id);
						if (from.panels.length === 0 && fromId !== group.id) groups.delete(fromId);
						return;
					}

					// Directional move: sole-member pane relocates beside the target.
					const target = groups.get(group.id);
					if (!target) return;
					from.panels = from.panels.filter((p) => p.id !== panelId);
					const newId = `g_new_${nextGroupId++}`;
					const created = placeBeside(group.id, position, newId);
					created.panels = [{ id: panelId }];
					panelGroup.set(panelId, created.id);
					if (from.panels.length === 0) groups.delete(fromId);
				},
				setActive: () => activated.push(panelId),
			},
		};
	};

	const api = {
		getPanel: (id: string) => (layout[id] ? makePanel(id) : undefined),
	} as unknown as DockviewApi;

	return { api, moves, activated, sizes };
}

describe("swapPanels", () => {
	test("no-op when either panel is missing", () => {
		const { api, moves, sizes } = makeApi({ a: { group: "g1", index: 0 } });
		swapPanels(api, "a", "does-not-exist");
		expect(moves).toHaveLength(0);
		expect(sizes).toHaveLength(0);
	});

	test("no-op when swapping a panel with itself", () => {
		const { api, moves } = makeApi({ a: { group: "g1", index: 0 } });
		swapPanels(api, "a", "a");
		expect(moves).toHaveLength(0);
	});

	test("same group → exchanges indices in both directions (no size restore)", () => {
		const { api, moves, sizes } = makeApi({
			a: { group: "g1", index: 0 },
			b: { group: "g1", index: 1 },
		});
		swapPanels(api, "a", "b");
		expect(moves).toEqual([
			{ panel: "a", groupId: "g1", index: 1, position: undefined },
			{ panel: "b", groupId: "g1", index: 0, position: undefined },
		]);
		// Tab order cannot change the split ratio; nothing to restore.
		expect(sizes).toHaveLength(0);
	});

	test("sole-member panes (side by side) → A relocates to the OPPOSITE side of B, then slot sizes are restored", () => {
		// Horizontal layout: editor pane on the left (300), narrator pane on the
		// right (700). Swapping content must NOT collapse the split to 50/50 —
		// the left slot stays 300 and the right slot stays 700.
		const { api, moves, activated, sizes } = makeApi(
			{ a: { group: "gA", index: 0 }, b: { group: "gB", index: 0 } },
			{
				gA: { left: 0, top: 0, width: 300, height: 800 },
				gB: { left: 300, top: 0, width: 700, height: 800 },
			},
		);
		swapPanels(api, "a", "b");
		expect(moves).toEqual([{ panel: "a", groupId: "gB", index: undefined, position: "right" }]);
		expect(activated).toEqual(["a"]);
		// Content moved; geometric slots keep their pre-swap widths.
		// After the simulated move B ends left and A right → left=300, right=700.
		const left = sizes.find((s) => s.width === 300 && s.height === undefined);
		const right = sizes.find((s) => s.width === 700 && s.height === undefined);
		expect(left).toBeDefined();
		expect(right).toBeDefined();
		if (!left || !right) throw new Error("expected both slot size restores");
		expect(left.groupId).not.toBe(right.groupId);
	});

	test("sole-member panes stacked vertically → opposite vertical side + height restore", () => {
		const { api, moves, sizes } = makeApi(
			{ a: { group: "gA", index: 0 }, b: { group: "gB", index: 0 } },
			{
				gA: { left: 0, top: 0, width: 800, height: 200 },
				gB: { left: 0, top: 200, width: 800, height: 600 },
			},
		);
		// A is above B → relocate A below B.
		swapPanels(api, "a", "b");
		expect(moves).toEqual([{ panel: "a", groupId: "gB", index: undefined, position: "bottom" }]);
		// Vertical slots keep original heights (top=200, bottom=600).
		expect(sizes.some((s) => s.height === 200 && s.width === undefined)).toBe(true);
		expect(sizes.some((s) => s.height === 600 && s.width === undefined)).toBe(true);
	});

	test("A shares its group but B is sole member → move B to the opposite side of A + restore slots", () => {
		// gA = [x, a] (multi-member, left 400), gB = [b] (sole, right 600).
		// Swapping a↔b must NOT tear down gA; B relocates left and both slots
		// keep their pre-swap widths.
		const { api, moves, sizes } = makeApi(
			{
				x: { group: "gA", index: 0 },
				a: { group: "gA", index: 1 },
				b: { group: "gB", index: 0 },
			},
			{
				gA: { left: 0, top: 0, width: 400, height: 800 },
				gB: { left: 400, top: 0, width: 600, height: 800 },
			},
		);
		swapPanels(api, "a", "b");
		// B (right, sole) relocates to the opposite side of A's group (left).
		expect(moves).toEqual([{ panel: "b", groupId: "gA", index: undefined, position: "left" }]);
		expect(sizes.some((s) => s.width === 400)).toBe(true);
		expect(sizes.some((s) => s.width === 600)).toBe(true);
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
