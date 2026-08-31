import { describe, expect, test } from "bun:test";
import { serializeSeedEnvelope } from "../panels/layout-envelope";
import { createBranch, createLeafWith } from "../split-tree";
import { DEFAULT_DIRECTOR_PRIMARY_RATIO } from "./director-constants";
import {
	componentForParams,
	nextWorkspacePanelId,
	resolveWorkspaceLayout,
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

	test("a seed envelope yields no arrangement (also server-backfilled)", () => {
		const seed = serializeSeedEnvelope(twoNarratorWorkspaceSeed("a", "b", "right"));
		expect(resolveWorkspaceLayout(seed).kind).toBe("none");
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
