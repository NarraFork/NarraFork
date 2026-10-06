import { describe, expect, test } from "bun:test";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { serializeSeedEnvelope } from "../panels/layout-envelope";
import { createBranch, createLeafWith } from "../split-tree";
import { DEFAULT_DIRECTOR_PRIMARY_RATIO } from "./director-constants";
import {
	componentForParams,
	DEFAULT_DIRECTOR_STATE,
	nextWorkspacePanelId,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
	twoNarratorWorkspaceSeed,
	WORKSPACE_LAYOUT_VERSION,
} from "./dockview-layout";
import { PANEL_COMPONENT } from "./panel-types";

// The `migrateLegacyTree` suite is gone with the function. Client-side legacy migration
// invented panels that had no membership row, which the surface then pruned on the next
// open. Reading legacy shapes is now the server's job, once, in
// `recoverPanelsFromLayout` — covered by `tests/server/services/workspace-panel-service.test.ts`
// ("backfill on first read"), including the split-tree and seed-envelope cases this
// suite used to assert.

test("workspace serialization drops navigation but preserves membership and device", () => {
	const toolEdit = {
		narratorId: "origin",
		toolUseId: "sdk-id",
		toolCallId: "row",
		executionAttempt: 2,
	};
	const layout = {
		panels: {
			chat: { params: { panelType: "narrator", narratorId: "n" } },
			file: {
				params: {
					panelType: "file",
					hostNarratorId: "n",
					filePath: "/a.ts",
					deviceId: "DeviceA",
					toolEdit,
					selection: {},
					highlightRequestId: "h1",
				},
			},
		},
	} as unknown as SerializedDockview;
	const api = { toJSON: () => layout } as unknown as DockviewApi;
	const saved = JSON.parse(serializeWorkspaceLayout(api, DEFAULT_DIRECTOR_STATE));
	expect(saved.layout.panels.chat.params.narratorId).toBe("n");
	expect(saved.layout.panels.file.params).toEqual({
		panelType: "file",
		hostNarratorId: "n",
		filePath: "/a.ts",
		deviceId: "DeviceA",
		toolEdit,
	});
	expect(layout.panels.file.params?.selection).toBeDefined();
});

function arrangementWithFloatingResources(): SerializedDockview {
	const group = (id: string, views: string[]) => ({ id, views, activeView: views[0] });
	const leaf = (id: string, views: string[]) => ({ type: "leaf", data: group(id, views) });
	const grid = (data: unknown[]) => ({
		root: { type: "branch", data },
		width: 1200,
		height: 800,
		orientation: "HORIZONTAL",
	});
	const panelIds = [
		"chat",
		"second",
		"persisted",
		"nested-persisted",
		"popout-persisted",
		"edge-persisted",
		"tmp-file",
		"tmp-grid",
		"tmp-popout",
		"tmp-edge",
	];
	return {
		grid: grid([
			leaf("main", ["chat"]),
			{
				type: "branch",
				data: [leaf("secondary", ["second"]), leaf("tmp-grid-group", ["tmp-grid"])],
			},
		]),
		panels: Object.fromEntries(
			panelIds.map((id) => [
				id,
				{
					id,
					contentComponent: "file",
					params: { panelType: "file", hostNarratorId: "n", filePath: `/repo/${id}.ts` },
				},
			]),
		),
		floatingGroups: [
			{
				data: group("temporary", ["tmp-file"]),
				position: { left: 10, top: 20, width: 400, height: 300 },
			},
			{
				data: group("persisted-float", ["persisted"]),
				position: { left: 40, top: 60, width: 500, height: 350 },
			},
			{
				grid: grid([
					leaf("nested", ["tmp-file", "nested-persisted"]),
					leaf("tmp-nested", ["tmp-grid"]),
				]),
				position: { left: 70, top: 80, width: 700, height: 450 },
			},
		],
		popoutGroups: [
			{ data: group("tmp-popout-group", ["tmp-popout"]), position: null },
			{
				grid: grid([leaf("popout", ["tmp-popout", "popout-persisted"])]),
				position: null,
				url: "/popout",
				gridReferenceGroup: "tmp-grid-group",
			},
		],
		edgeGroups: {
			left: { size: 200, visible: true, group: group("tmp-edge-group", ["tmp-edge"]) },
			right: { size: 250, visible: true, group: group("edge", ["tmp-edge", "edge-persisted"]) },
		},
		activeGroup: "temporary",
	} as unknown as SerializedDockview;
}

const transientResourceIds = new Set(["tmp-file", "tmp-grid", "tmp-popout", "tmp-edge"]);

function saveArrangement(layout: SerializedDockview, activeGroup?: string | null) {
	return JSON.parse(
		serializeWorkspaceLayout(
			{ toJSON: () => layout } as unknown as DockviewApi,
			DEFAULT_DIRECTOR_STATE,
			transientResourceIds,
			activeGroup,
		),
	).layout;
}

describe("durable workspace serialization", () => {
	test("temporary floats disappear without losing legacy and nested durable floating windows", () => {
		const layout = arrangementWithFloatingResources();
		const before = structuredClone(layout);
		const saved = saveArrangement(layout);
		expect(Object.keys(saved.panels)).toEqual([
			"chat",
			"second",
			"persisted",
			"nested-persisted",
			"popout-persisted",
			"edge-persisted",
		]);
		expect(saved.floatingGroups).toHaveLength(2);
		expect(saved.floatingGroups[0]).toEqual(before.floatingGroups?.[1]);
		expect(saved.floatingGroups[1].grid.root.data).toEqual([
			{
				type: "leaf",
				data: { id: "nested", views: ["nested-persisted"], activeView: "nested-persisted" },
			},
		]);
		expect(saved.activeGroup).toBe("main");
		expect(layout).toEqual(before);
		for (const id of transientResourceIds) expect(JSON.stringify(saved)).not.toContain(id);
	});

	test("nested grid, popout and edge references are pruned together", () => {
		const saved = saveArrangement(arrangementWithFloatingResources());
		expect(saved.grid.root.data[1].data).toEqual([
			{ type: "leaf", data: { id: "secondary", views: ["second"], activeView: "second" } },
		]);
		expect(saved.popoutGroups).toHaveLength(1);
		expect(saved.popoutGroups[0].url).toBe("/popout");
		expect(saved.popoutGroups[0].gridReferenceGroup).toBeUndefined();
		expect(saved.popoutGroups[0].grid.root.data[0].data.activeView).toBe("popout-persisted");
		expect(saved.edgeGroups.left).toBeUndefined();
		expect(saved.edgeGroups.right.group).toEqual({
			id: "edge",
			views: ["edge-persisted"],
			activeView: "edge-persisted",
		});
	});

	test("previous durable active group wins over temporary focus and missing groups fall back", () => {
		const layout = arrangementWithFloatingResources();
		expect(saveArrangement(layout, "secondary").activeGroup).toBe("secondary");
		expect(saveArrangement(layout, "missing").activeGroup).toBe("main");
		expect(saveArrangement(layout, null).activeGroup).toBe("main");
		expect(saveArrangement(layout, "temporary").activeGroup).toBe("main");
	});

	test("undefined durable focus preserves a surviving floating active group", () => {
		const layout = arrangementWithFloatingResources();
		layout.activeGroup = "persisted-float";
		expect(saveArrangement(layout).activeGroup).toBe("persisted-float");
		expect(saveArrangement(layout, null).activeGroup).toBe("main");
	});

	test("optional arguments preserve old arrangements verbatim and keep navigation stripping", () => {
		const layout = arrangementWithFloatingResources();
		const api = { toJSON: () => layout } as unknown as DockviewApi;
		layout.panels.persisted.params = {
			...layout.panels.persisted.params,
			highlightRequestId: "jump",
			selection: { startLine: 4 },
		};
		const before = structuredClone(layout);
		delete before.panels.persisted.params?.highlightRequestId;
		delete before.panels.persisted.params?.selection;
		const oldSaved = JSON.parse(serializeWorkspaceLayout(api, DEFAULT_DIRECTOR_STATE));
		const emptySetSaved = JSON.parse(
			serializeWorkspaceLayout(api, DEFAULT_DIRECTOR_STATE, new Set()),
		);
		expect(oldSaved.layout).toEqual(before);
		expect(emptySetSaved).toEqual(oldSaved);
		expect(resolveWorkspaceLayout(JSON.stringify(oldSaved))).toMatchObject({
			kind: "dockview",
			layout: before,
		});
		expect(saveArrangement(layout).panels.persisted.params.highlightRequestId).toBeUndefined();
		expect(saveArrangement(layout).panels.persisted.params.selection).toBeUndefined();
		expect(layout.panels.persisted.params?.highlightRequestId).toBe("jump");
	});

	test("temporary floating open leaves durable serialization byte-identical", () => {
		const baseline = arrangementWithFloatingResources();
		baseline.panels = { chat: baseline.panels.chat };
		baseline.grid.root = {
			type: "branch",
			data: [{ type: "leaf", data: { id: "main", views: ["chat"], activeView: "chat" } }],
		};
		baseline.activeGroup = "main";
		delete baseline.floatingGroups;
		delete baseline.popoutGroups;
		delete baseline.edgeGroups;
		const serialize = (layout: SerializedDockview, temporary?: ReadonlySet<string>) =>
			serializeWorkspaceLayout(
				{ toJSON: () => layout } as unknown as DockviewApi,
				DEFAULT_DIRECTOR_STATE,
				temporary,
			);
		const initial = serialize(baseline);
		const opened = structuredClone(baseline);
		opened.panels["tmp-file"] = arrangementWithFloatingResources().panels["tmp-file"];
		opened.floatingGroups = arrangementWithFloatingResources().floatingGroups?.slice(0, 1);
		opened.activeGroup = "temporary";
		const before = structuredClone(opened);
		expect(serialize(opened, new Set(["tmp-file"]))).toBe(initial);
		expect(opened).toEqual(before);

		const emptyCollections = {
			...baseline,
			floatingGroups: [],
			popoutGroups: [],
			edgeGroups: {},
		};
		expect(serialize(emptyCollections)).toBe(initial);
		expect(emptyCollections.floatingGroups).toEqual([]);
		expect(emptyCollections.popoutGroups).toEqual([]);
		expect(emptyCollections.edgeGroups).toEqual({});
	});

	test("an all-temporary layout serializes a legal empty root with no dangling active refs", () => {
		const layout = arrangementWithFloatingResources();
		const saved = JSON.parse(
			serializeWorkspaceLayout(
				{ toJSON: () => layout } as unknown as DockviewApi,
				{ ...DEFAULT_DIRECTOR_STATE, primaryPanelId: "tmp-file" },
				new Set(Object.keys(layout.panels)),
				"secondary",
			),
		);
		expect(saved.layout.grid.root).toEqual({ type: "branch", data: [] });
		expect(saved.layout.panels).toEqual({});
		expect(saved.layout.floatingGroups).toBeUndefined();
		expect(saved.layout.popoutGroups).toBeUndefined();
		expect(saved.layout.edgeGroups).toBeUndefined();
		expect(saved.layout.activeGroup).toBeUndefined();
		expect(saved.director.primaryPanelId).toBeNull();
	});

	test("float-only durable layouts keep their window when the main grid becomes empty", () => {
		const layout = arrangementWithFloatingResources();
		const saved = JSON.parse(
			serializeWorkspaceLayout(
				{ toJSON: () => layout } as unknown as DockviewApi,
				DEFAULT_DIRECTOR_STATE,
				new Set(Object.keys(layout.panels).filter((id) => id !== "persisted")),
			),
		).layout;
		expect(saved.grid.root).toEqual({ type: "branch", data: [] });
		expect(saved.floatingGroups).toHaveLength(1);
		expect(saved.floatingGroups[0].data.views).toEqual(["persisted"]);
		expect(saved.activeGroup).toBe("persisted-float");
	});
});

describe("resolveWorkspaceLayout", () => {
	// "No usable arrangement" must never be read as "no panels": membership is a
	// separate, authoritative input, so the caller still places every member at a
	// default position.
	test("null input yields no arrangement, with default director state", () => {
		const resolved = resolveWorkspaceLayout(null);
		expect(resolved.kind).toBe("none");
		expect(resolved.director.mode).toBe("grid");
	});

	test("a legacy split-tree yields no arrangement (the server backfills membership)", () => {
		const legacy = JSON.stringify(
			createBranch("horizontal", [createLeafWith("a"), createLeafWith("b")]),
		);
		expect(resolveWorkspaceLayout(legacy).kind).toBe("none");
	});

	test("a seed envelope resolves to the seed branch, preserving specs and placement", () => {
		// The seed carries PLACEMENT only (membership is server-backfilled): resolving
		// it as "no arrangement" collapsed a freshly created workspace into one tab
		// group, losing the split the user dragged at creation time.
		const seedEnvelope = twoNarratorWorkspaceSeed("a", "b", "right");
		const resolved = resolveWorkspaceLayout(serializeSeedEnvelope(seedEnvelope));
		expect(resolved.kind).toBe("seed");
		if (resolved.kind === "seed") {
			expect(resolved.specs).toHaveLength(2);
			expect(resolved.specs[0].placement).toEqual({ kind: "first" });
			expect(resolved.specs[1].placement).toMatchObject({ kind: "relative", direction: "right" });
			expect(resolved.director).toEqual({
				mode: "grid",
				primaryPanelId: null,
				primaryRatio: DEFAULT_DIRECTOR_PRIMARY_RATIO,
			});
		}
	});

	test("dockview envelope → restored verbatim (legacy director without ratio → default)", () => {
		const envelope = JSON.stringify({
			version: WORKSPACE_LAYOUT_VERSION,
			kind: "dockview",
			layout: {
				grid: { root: {}, width: 100, height: 100, orientation: "HORIZONTAL" },
				panels: {},
			},
			director: { mode: "director", primaryPanelId: "p1" },
		});
		const resolved = resolveWorkspaceLayout(envelope);
		expect(resolved.kind).toBe("dockview");
		if (resolved.kind === "dockview") {
			// Back-compat: older envelopes had no primaryRatio → filled with default.
			expect(resolved.director).toEqual({
				mode: "director",
				primaryPanelId: "p1",
				primaryRatio: DEFAULT_DIRECTOR_PRIMARY_RATIO,
			});
		}
	});

	test("dockview envelope preserves canonical plugin ownership for fromJSON restore", () => {
		const pluginParams = {
			panelType: "plugin",
			schemaVersion: 1,
			pluginId: "com.example.review",
			contributionId: "dashboard",
			panelInstanceId: "pui-review",
			binding: {
				kind: "workspace-narrator",
				workspaceId: "workspace-1",
				ownerNarratorId: "narrator-1",
			},
		};
		const envelope = JSON.stringify({
			version: WORKSPACE_LAYOUT_VERSION,
			kind: "dockview",
			layout: {
				grid: { root: {}, width: 100, height: 100, orientation: "HORIZONTAL" },
				panels: { "pui-review": { id: "pui-review", params: pluginParams } },
			},
			director: { mode: "grid", primaryPanelId: null },
		});
		const resolved = resolveWorkspaceLayout(envelope);
		expect(resolved.kind).toBe("dockview");
		if (resolved.kind === "dockview") {
			expect((resolved.layout.panels["pui-review"] as { params: unknown }).params).toEqual(
				pluginParams,
			);
		}
	});

	test("dockview envelope → preserves an explicit primaryRatio", () => {
		const envelope = JSON.stringify({
			version: WORKSPACE_LAYOUT_VERSION,
			kind: "dockview",
			layout: {
				grid: { root: {}, width: 100, height: 100, orientation: "HORIZONTAL" },
				panels: {},
			},
			director: { mode: "director", primaryPanelId: "p1", primaryRatio: 0.8 },
		});
		const resolved = resolveWorkspaceLayout(envelope);
		expect(resolved.kind).toBe("dockview");
		if (resolved.kind === "dockview") {
			expect(resolved.director.primaryRatio).toBe(0.8);
		}
	});

	test("malformed JSON yields no arrangement rather than throwing", () => {
		expect(resolveWorkspaceLayout("{not valid json").kind).toBe("none");
	});
});

describe("twoNarratorWorkspaceSeed", () => {
	test("stacks second narrator below the first when direction is below", () => {
		const seed = twoNarratorWorkspaceSeed("first", "second", "below");
		expect(seed.kind).toBe("seed");
		expect(seed.seed).toHaveLength(2);
		expect(seed.seed[1].placement).toMatchObject({ kind: "relative", direction: "below" });
		// The two generated panel ids must be distinct.
		expect(seed.seed[0].id).not.toBe(seed.seed[1].id);
	});
});

describe("componentForParams", () => {
	test("maps subagent sessions to the dedicated workspace component", () => {
		expect(
			componentForParams({
				panelType: "subagent",
				hostNarratorId: "host-1",
				subagentNarratorId: "subagent-1",
			}),
		).toBe(PANEL_COMPONENT.subagent);
	});

	test("maps plugin panels to the stable host component", () => {
		expect(
			componentForParams({
				panelType: "plugin",
				schemaVersion: 1,
				pluginId: "com.example.plugin",
				contributionId: "view.main",
				panelInstanceId: "panel-1",
				binding: { kind: "workspace", workspaceId: "workspace-1" },
			}),
		).toBe(PANEL_COMPONENT.plugin);
	});

	// Without this mapping a file panel would fall through to `default` and render
	// as an empty narrator cell on every api-free path (seed / pending handoff /
	// external drop).
	test("maps file viewers to the file component", () => {
		expect(
			componentForParams({
				panelType: "file",
				hostNarratorId: "host-1",
				filePath: "/repo/README.md",
			}),
		).toBe(PANEL_COMPONENT.file);
	});
});

describe("nextWorkspacePanelId", () => {
	test("generates unique ids even within the same millisecond", () => {
		// A monotonic counter (not Date.now() alone) guarantees uniqueness when
		// several panels are added back-to-back in the same tick.
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) ids.add(nextWorkspacePanelId());
		expect(ids.size).toBe(1000);
	});

	test("ids carry the dvp_ prefix", () => {
		expect(nextWorkspacePanelId().startsWith("dvp_")).toBe(true);
	});
});
