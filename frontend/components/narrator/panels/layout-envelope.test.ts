import { describe, expect, it } from "bun:test";
import type { SerializedDockview } from "dockview-react";
import { parseDetachedNodes } from "../../graph/dock/detached-panels";
import { parseChapterDockLayout } from "../../graph/dock/graph-node-dock-layout";
import { isRetiredFilemodPanel, removeRetiredFilemodPanels } from "./layout-envelope";

function group(id: string, views: string[], activeView = views[0]) {
	return { id, views, activeView, tabGroups: [{ id: "tabs", panelIds: views }] };
}
function leaf(id: string, views: string[]) {
	return { type: "leaf", data: group(id, views) };
}
function layout(): SerializedDockview {
	return {
		grid: {
			width: 100,
			height: 100,
			orientation: "HORIZONTAL",
			root: {
				type: "branch",
				data: [leaf("old-grid", ["old"]), leaf("main", ["chat", "old"])],
			},
		},
		panels: {
			old: { id: "old", component: "filemod", params: { panelType: "filemod" } },
			chat: { id: "chat", component: "chat", params: { panelType: "chat" } },
			file: { id: "file", component: "file", params: { panelType: "file", filePath: "a.ts" } },
		},
		activeGroup: "old-grid",
		floatingGroups: [
			{ data: group("old-float", ["old"]) },
			{ data: group("float", ["file", "old"], "old") },
		],
		popoutGroups: [
			{ data: group("old-pop", ["old"]) },
			{
				grid: { root: { type: "branch", data: [leaf("pop", ["file", "old"])] } },
				gridReferenceGroup: "old-grid",
			},
		],
		edgeGroups: {
			left: { group: group("old-edge", ["old"]) },
			right: { group: group("edge", ["file", "old"]) },
		},
	} as unknown as SerializedDockview;
}

describe("retired filemod layout compatibility", () => {
	it("recognizes both legacy params forms, but never file viewers", () => {
		expect(isRetiredFilemodPanel({ params: { panelType: "filemod" } })).toBe(true);
		expect(
			isRetiredFilemodPanel({ params: { panelType: "narrator-tool", toolType: "filemod" } }),
		).toBe(true);
		expect(isRetiredFilemodPanel({ params: { panelType: "file", filePath: "filemod" } })).toBe(
			false,
		);
	});

	it("prunes grid, floating, popout and edge references without mutating input", () => {
		const original = layout();
		const pruned = removeRetiredFilemodPanels(original);
		if (!pruned) throw new Error("Expected surviving layout");
		expect(Object.keys(pruned.panels)).toEqual(["chat", "file"]);
		expect(pruned.grid.root.data as unknown).toEqual([leaf("main", ["chat"])]);
		expect(pruned.floatingGroups as unknown).toEqual([{ data: group("float", ["file"]) }]);
		expect(pruned.popoutGroups as unknown).toEqual([
			{ grid: { root: { type: "branch", data: [leaf("pop", ["file"])] } } },
		]);
		expect(pruned.edgeGroups as unknown).toEqual({ right: { group: group("edge", ["file"]) } });
		expect(pruned.activeGroup).toBe("main");
		expect(original.panels.old).toBeDefined();
		expect(original.activeGroup).toBe("old-grid");
	});

	it("retains floating-only surviving layouts and defaults only when no panel survives", () => {
		const original = layout();
		original.grid.root.data = [leaf("old-grid", ["old"])] as never;
		delete original.panels.chat;
		const pruned = removeRetiredFilemodPanels(original);
		if (!pruned) throw new Error("Expected surviving layout");
		expect(pruned.grid.root.data as unknown).toEqual([]);
		expect(pruned.activeGroup).toBe("float");
		delete original.panels.file;
		expect(removeRetiredFilemodPanels(original)).toBeNull();
	});

	it("chapter parser filters legacy panels while keeping remaining panels", () => {
		const parsed = parseChapterDockLayout(JSON.stringify({ version: 1, layout: layout() }));
		if (!parsed) throw new Error("Expected surviving chapter layout");
		expect(Object.keys(parsed.panels)).toEqual(["chat", "file"]);
	});

	it("detached v3 nodes keep good tabs and drop retired-only nodes", () => {
		const retiredOnly = layout();
		delete retiredOnly.panels.chat;
		delete retiredOnly.panels.file;
		const nodes = parseDetachedNodes(
			JSON.stringify({
				version: 3,
				nodes: [
					{ id: "mixed", x: 1, y: 2, w: 400, h: 300, layout: layout() },
					{ id: "retired", x: 1, y: 2, w: 400, h: 300, layout: retiredOnly },
				],
			}),
		);
		expect(nodes).toHaveLength(1);
		expect(Object.keys(nodes[0].layout?.panels ?? {})).toEqual(["chat", "file"]);
	});
});
