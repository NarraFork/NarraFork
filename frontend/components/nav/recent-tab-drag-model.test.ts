import { describe, expect, it } from "bun:test";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import {
	createRecentTabDragModel,
	planRecentTabInternalDrop,
	projectRecentTabDragOrder,
	recentTabDragIndicatorRows,
	recentTabDragMeasuredRow,
	resolveRecentTabInternalDrop,
} from "./recent-tab-drag-model";

const tab = (id: string, fields: Partial<RecentTab> = {}): RecentTab => ({
	type: "narrator",
	id,
	title: id,
	lastVisitedAt: 1,
	...fields,
});
const bounds = { left: 0, right: 200, top: 0, bottom: 500 };
const modelFor = (tabs: RecentTab[], grouped = false) =>
	createRecentTabDragModel(
		tabs,
		grouped,
		new Map(tabs.flatMap((item) => (item.subtitle ? [[item.subtitle, false] as const] : []))),
	);
function geometry(model: ReturnType<typeof modelFor>, keys: string[], heights: number[] = []) {
	let top = 0;
	return keys.map((key, index) => {
		const bottom = top + (heights[index] ?? 30);
		const row = recentTabDragMeasuredRow(model, key, top, bottom);
		top = bottom;
		if (!row) throw new Error(`Missing row: ${key}`);
		return row;
	});
}

describe("recent tab drag model", () => {
	it("models all ordinary types and pinned workspace children without altering source", () => {
		const tabs = [
			tab("p", { type: "project", pinned: true }),
			tab("ws", { type: "workspace", pinned: true }),
			tab("c", { type: "chapter", workspaceId: "ws" }),
			tab("s", { type: "subagent" }),
			tab("g", { type: "group" }),
		];
		const model = modelFor(tabs);
		expect(model.entries.get("chapter:c")).toMatchObject({
			pinned: true,
			workspaceId: "ws",
			role: "workspace-member",
			keyBlock: ["workspace:ws", "chapter:c"],
		});
		expect(model.entries.size).toBe(5);
		expect(tabs[2].pinned).toBeUndefined();
	});
	it("uses unequal height workspace unit centres and both edges", () => {
		const model = modelFor([
			tab("a"),
			tab("w", { type: "workspace" }),
			tab("c", { workspaceId: "w" }),
			tab("b"),
		]);
		const rows = geometry(
			model,
			["narrator:a", "workspace:w", "narrator:c", "narrator:b"],
			[20, 20, 100, 20],
		);
		expect(
			resolveRecentTabInternalDrop(model, "narrator:a", rows, { x: 50, y: 70 }, bounds),
		).toEqual({ kind: "before", key: "workspace:w" });
		expect(
			resolveRecentTabInternalDrop(model, "narrator:a", rows, { x: 50, y: 120 }, bounds),
		).toEqual({ kind: "after", key: "narrator:c" });
		const plan = planRecentTabInternalDrop(model, "narrator:a", {
			kind: "after",
			key: "narrator:c",
		});
		expect(plan?.finalTabs.map((item) => item.id)).toEqual(["w", "c", "a", "b"]);
	});
	it("rejects outside sidebar, cross pinned, own unit and missing source", () => {
		const model = modelFor([tab("p", { pinned: true }), tab("a"), tab("b")]);
		const rows = geometry(model, ["narrator:p", "narrator:a", "narrator:b"]);
		for (const pointer of [
			{ x: -1, y: 70 },
			{ x: 201, y: 70 },
			{ x: 50, y: -1 },
			{ x: 50, y: 501 },
			{ x: 50, y: 10 },
			{ x: 50, y: 40 },
		]) {
			expect(resolveRecentTabInternalDrop(model, "narrator:a", rows, pointer, bounds)).toBeNull();
		}
		expect(
			planRecentTabInternalDrop(model, "narrator:p", { kind: "before", key: "narrator:a" }),
		).toBeNull();
		expect(resolveRecentTabInternalDrop(model, "gone", rows, { x: 50, y: 70 }, bounds)).toBeNull();
	});
	it("orders same workspace members but never changes membership", () => {
		const model = modelFor([
			tab("w", { type: "workspace" }),
			tab("a", { workspaceId: "w" }),
			tab("b", { workspaceId: "w" }),
			tab("outside"),
		]);
		const rows = geometry(model, ["workspace:w", "narrator:a", "narrator:b", "narrator:outside"]);
		expect(
			resolveRecentTabInternalDrop(model, "narrator:a", rows, { x: 50, y: 88 }, bounds),
		).toEqual({ kind: "after", key: "narrator:b" });
		const plan = planRecentTabInternalDrop(model, "narrator:a", {
			kind: "after",
			key: "narrator:b",
		});
		expect(plan?.finalTabs.map((item) => item.id)).toEqual(["w", "b", "a", "outside"]);
		expect(plan?.finalTabs.find((item) => item.id === "a")?.workspaceId).toBe("w");
		expect(
			planRecentTabInternalDrop(model, "narrator:a", { kind: "before", key: "narrator:outside" }),
		).toBeNull();
	});
	it("directory mode workspace children remain draggable but have no internal sort targets", () => {
		const model = modelFor(
			[
				tab("w", { type: "workspace" }),
				tab("a", { workspaceId: "w" }),
				tab("b", { workspaceId: "w" }),
			],
			true,
		);
		expect(model.entries.has("narrator:a")).toBe(true);
		expect(
			recentTabDragIndicatorRows(
				model,
				"narrator:a",
				geometry(model, ["workspace:w", "narrator:a", "narrator:b"]),
			),
		).toEqual([]);
		expect(
			planRecentTabInternalDrop(model, "narrator:a", { kind: "after", key: "narrator:b" }),
		).toBeNull();
	});
	it("directory member orders only stamp dirSortOrder and have individual indicators", () => {
		const tabs = [
			tab("a", { subtitle: "/repo" }),
			tab("b", { type: "subagent", subtitle: "/repo" }),
			tab("x"),
		];
		const model = modelFor(tabs, true);
		const rows = geometry(model, ["dir:/repo", "narrator:a", "subagent:b", "narrator:x"]);
		expect(
			recentTabDragIndicatorRows(model, "narrator:a", rows).map((row) => row.keyBlock),
		).toEqual([["narrator:a"], ["narrator:a"], ["subagent:b"]]);
		const plan = planRecentTabInternalDrop(model, "narrator:a", {
			kind: "after",
			key: "subagent:b",
		});
		expect(plan?.directoryKeys).toEqual(["subagent:b", "narrator:a"]);
		expect(plan?.moves).toEqual([]);
		expect(plan?.finalTabs.map((item) => item.id)).toEqual(["a", "b", "x"]);
		expect(plan?.finalTabs.map((item) => item.dirSortOrder)).toEqual([1, 0, undefined]);
		expect(
			planRecentTabInternalDrop(model, "narrator:a", { kind: "after", key: "narrator:x" }),
		).toBeNull();
	});
	it("directory headers reorder blocks using visible group centre, including collapsed groups", () => {
		const tabs = [
			tab("a", { subtitle: "/a" }),
			tab("x", { subtitle: "/b" }),
			tab("b", { subtitle: "/a" }),
			tab("y", { subtitle: "/b" }),
		];
		const model = modelFor(tabs, true);
		const rows = geometry(
			model,
			["dir:/a", "narrator:a", "narrator:b", "dir:/b", "narrator:x", "narrator:y"],
			[20, 40, 40, 20, 40, 80],
		);
		expect(resolveRecentTabInternalDrop(model, "dir:/a", rows, { x: 50, y: 130 }, bounds)).toEqual({
			kind: "before",
			key: "narrator:x",
		});
		const target = resolveRecentTabInternalDrop(model, "dir:/a", rows, { x: 50, y: 225 }, bounds);
		expect(target).toEqual({ kind: "after", key: "narrator:y" });
		const plan = planRecentTabInternalDrop(model, "dir:/a", target ?? { kind: "empty" });
		expect(plan?.finalTabs.map((item) => item.id)).toEqual(["x", "y", "a", "b"]);
		const collapsed = createRecentTabDragModel(tabs, true, new Map([["/b", true]]));
		expect(collapsed.entries.has("narrator:x")).toBe(false);
		expect(collapsed.entries.get("dir:/b")?.keyBlock).toEqual(["narrator:x", "narrator:y"]);
		expect(
			planRecentTabInternalDrop(collapsed, "dir:/a", {
				kind: "after",
				key: "narrator:y",
			})?.finalTabs.map((item) => item.id),
		).toEqual(["x", "y", "a", "b"]);
		expect(createRecentTabDragModel(tabs, true, new Map()).entries.has("narrator:a")).toBe(false);
	});
	it("excludes zero-height and unknown DOM rows", () => {
		const model = modelFor([tab("a")]);
		expect(recentTabDragMeasuredRow(model, "narrator:a", 20, 20)).toBeNull();
		expect(recentTabDragMeasuredRow(model, "foreign", 0, 30)).toBeNull();
	});
	it("projects order over latest WS titles, membership, runtime and newly arriving rows", () => {
		const a = tab("a");
		const b = tab("b");
		const latest = [
			{ ...a, title: "WS title", status: "running", workspaceId: "new", dirSortOrder: 9 },
			tab("new"),
			{ ...b, viewerCount: 3 },
		];
		const projected = projectRecentTabDragOrder(latest, [b, a], new Set());
		expect(projected.map((item) => item.id)).toEqual(["b", "new", "a"]);
		expect(projected[2]).toBe(latest[0]);
		expect(projected[0]).toBe(latest[2]);
		expect(projectRecentTabDragOrder([b], [a, b])).toEqual([b]);
	});
});
