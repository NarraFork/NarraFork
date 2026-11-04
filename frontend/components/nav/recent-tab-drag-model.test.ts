import { describe, expect, it } from "bun:test";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import {
	createRecentTabDragModel,
	type FolderDisplay,
	type FolderViewOptions,
	planRecentTabDrop,
	projectRecentTabDragOrder,
	recentTabDragMeasuredRow,
} from "./recent-tab-drag-model";

function tab(id: string, overrides: Partial<RecentTab> = {}): RecentTab {
	return { type: "narrator", id, title: id, lastVisitedAt: 1, ...overrides };
}

function folder(id: string, overrides: Partial<RecentTab> = {}): RecentTab {
	return tab(id, { type: "folder", ...overrides });
}

function options(
	displays: Record<string, FolderDisplay> = {},
	forced: string[] = [],
): FolderViewOptions {
	return {
		displayOf: (id) => displays[id],
		defaultPreview: 2,
		isForcedVisible: (member) => forced.includes(member.id),
	};
}

const keys = (tabs: RecentTab[]) =>
	tabs.map(
		(item) => `${item.pinned ? "*" : ""}${item.id}${item.folderId ? `>${item.folderId}` : ""}`,
	);

// [a] [F: m1 m2 m3] [b]
const BASE = [
	tab("a"),
	folder("F"),
	tab("m1", { folderId: "F" }),
	tab("m2", { folderId: "F" }),
	tab("m3", { folderId: "F" }),
	tab("b"),
];

describe("folder views", () => {
	it("preview shows the first N members, collapsed none, expanded all", () => {
		const preview = createRecentTabDragModel(BASE, options());
		expect(preview.folderViews.get("F")?.visible.map((item) => item.id)).toEqual(["m1", "m2"]);
		expect(preview.folderViews.get("F")?.hidden.map((item) => item.id)).toEqual(["m3"]);
		// Hidden members are not rows, so they cannot be hit-tested.
		expect(preview.entries.has("narrator:m3")).toBe(false);

		const collapsed = createRecentTabDragModel(BASE, options({ F: "collapsed" }));
		expect(collapsed.folderViews.get("F")?.visible).toEqual([]);
		const expanded = createRecentTabDragModel(BASE, options({ F: "expanded" }));
		expect(expanded.folderViews.get("F")?.visible).toHaveLength(3);
	});

	it("honours the folder's own preview count and keeps the open page visible", () => {
		const tabs = BASE.map((item) => (item.id === "F" ? { ...item, folderPreviewCount: 0 } : item));
		const model = createRecentTabDragModel(tabs, options({}, ["m3"]));
		expect(model.folderViews.get("F")?.visible.map((item) => item.id)).toEqual(["m3"]);
	});

	it("measured rows carry their kind and folder", () => {
		const model = createRecentTabDragModel(BASE, options());
		expect(recentTabDragMeasuredRow(model, "narrator:m1", 0, 10)).toMatchObject({
			kind: "member",
			folderId: "F",
			canNest: true,
		});
		expect(recentTabDragMeasuredRow(model, "folder:F", 0, 10)).toMatchObject({
			kind: "folder",
			canNest: false,
		});
		expect(recentTabDragMeasuredRow(model, "narrator:ghost", 0, 10)).toBeNull();
		expect(recentTabDragMeasuredRow(model, "narrator:a", 10, 10)).toBeNull();
	});
});

describe("planRecentTabDrop", () => {
	const model = createRecentTabDragModel(BASE, options({ F: "expanded" }));

	it("merge asks the server to create a folder and previews it at the target's slot", () => {
		const plan = planRecentTabDrop(
			model,
			"narrator:b",
			{ kind: "merge", key: "narrator:a" },
			"New",
		);
		expect(plan).toMatchObject({ kind: "merge", targetKey: "narrator:a", sourceKey: "narrator:b" });
		expect(plan && keys(plan.finalTabs)).toEqual([
			"__pending__",
			"a>__pending__",
			"b>__pending__",
			"F",
			"m1>F",
			"m2>F",
			"m3>F",
		]);
	});

	it("merging a folder's last member elsewhere drops the emptied folder from the preview", () => {
		const tabs = [tab("a"), folder("G"), tab("g", { folderId: "G" })];
		const plan = planRecentTabDrop(
			createRecentTabDragModel(tabs, options({ G: "expanded" })),
			"narrator:g",
			{ kind: "merge", key: "narrator:a" },
		);
		expect(plan && keys(plan.finalTabs)).toEqual(["__pending__", "a>__pending__", "g>__pending__"]);
	});

	it("joining a folder appends and previews the result", () => {
		const plan = planRecentTabDrop(model, "narrator:a", { kind: "into-folder", folderId: "F" });
		expect(plan).toMatchObject({ kind: "move", key: "narrator:a", target: { folderId: "F" } });
		expect(plan?.kind === "move" && keys(plan.finalTabs)).toEqual([
			"F",
			"m1>F",
			"m2>F",
			"m3>F",
			"a>F",
			"b",
		]);
	});

	it("joining the folder a member is already in is a no-op", () => {
		expect(
			planRecentTabDrop(model, "narrator:m1", { kind: "into-folder", folderId: "F" }),
		).toBeNull();
	});

	it("reorders inside a folder", () => {
		const plan = planRecentTabDrop(model, "narrator:m3", {
			kind: "member-before",
			folderId: "F",
			key: "narrator:m1",
		});
		expect(plan).toMatchObject({ target: { beforeKey: "narrator:m1", folderId: "F" } });
		expect(plan?.kind === "move" && keys(plan.finalTabs)).toEqual([
			"a",
			"F",
			"m3>F",
			"m1>F",
			"m2>F",
			"b",
		]);
	});

	it("drags a member out to the top level", () => {
		const plan = planRecentTabDrop(model, "narrator:m2", { kind: "after", key: "narrator:b" });
		expect(plan).toMatchObject({ target: { afterKey: "narrator:b", folderId: null } });
		expect(plan?.kind === "move" && keys(plan.finalTabs)).toEqual([
			"a",
			"F",
			"m1>F",
			"m3>F",
			"b",
			"m2",
		]);
	});

	it("a top-level move does not send a membership change", () => {
		const plan = planRecentTabDrop(model, "narrator:a", { kind: "after", key: "narrator:b" });
		expect(plan).toMatchObject({ target: { afterKey: "narrator:b" } });
		expect(plan?.kind === "move" && "folderId" in plan.target).toBe(false);
	});

	it("moves a folder with its members", () => {
		const plan = planRecentTabDrop(model, "folder:F", { kind: "after", key: "narrator:b" });
		expect(plan?.kind === "move" && keys(plan.finalTabs)).toEqual([
			"a",
			"b",
			"F",
			"m1>F",
			"m2>F",
			"m3>F",
		]);
	});

	it("dropping in place is a no-op", () => {
		expect(planRecentTabDrop(model, "narrator:a", { kind: "before", key: "folder:F" })).toBeNull();
	});
});

describe("projectRecentTabDragOrder", () => {
	it("keeps the optimistic order and membership with the latest content", () => {
		const latest = [tab("a", { status: "working" }), tab("b"), tab("c")];
		const optimistic = [tab("b"), tab("a", { folderId: "F" })];
		const projected = projectRecentTabDragOrder(latest, optimistic);
		expect(projected.map((item) => [item.id, item.folderId, item.status])).toEqual([
			["b", undefined, undefined],
			["a", "F", "working"],
			["c", undefined, undefined],
		]);
	});
});
