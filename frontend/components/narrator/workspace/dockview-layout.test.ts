import { describe, expect, test } from "bun:test";
import { serializeSeedEnvelope } from "../panels/layout-envelope";
import {
	createBranch,
	createLeafWith,
	createTerminalLeaf,
	createWebviewLeaf,
	type SplitNode,
} from "../split-tree";
import { DEFAULT_DIRECTOR_PRIMARY_RATIO } from "./director-constants";
import {
	migrateLegacyTree,
	nextWorkspacePanelId,
	resolveWorkspaceLayout,
	twoNarratorWorkspaceSeed,
	WORKSPACE_LAYOUT_VERSION,
} from "./dockview-layout";

describe("migrateLegacyTree", () => {
	test("single narrator leaf → one panel, placed first", () => {
		const tree: SplitNode = createLeafWith("narr_1");
		const specs = migrateLegacyTree(tree);
		expect(specs).toHaveLength(1);
		expect(specs[0].params).toEqual({ panelType: "narrator", narratorId: "narr_1" });
		expect(specs[0].placement).toEqual({ kind: "first" });
	});

	test("horizontal branch → second panel placed to the right of the first", () => {
		const tree = createBranch("horizontal", [createLeafWith("a"), createLeafWith("b")]);
		const specs = migrateLegacyTree(tree);
		expect(specs).toHaveLength(2);
		expect(specs[0].placement).toEqual({ kind: "first" });
		expect(specs[1].placement).toMatchObject({
			kind: "relative",
			referenceId: specs[0].id,
			direction: "right",
		});
	});

	test("vertical branch → second panel placed below the first", () => {
		const tree = createBranch("vertical", [createLeafWith("a"), createLeafWith("b")]);
		const specs = migrateLegacyTree(tree);
		expect(specs[1].placement).toMatchObject({ kind: "relative", direction: "below" });
	});

	test("terminal and webview leaves are preserved with their config", () => {
		const tree = createBranch("horizontal", [
			createLeafWith("narr"),
			createTerminalLeaf({ narratorId: "narr" }),
			createWebviewLeaf({ url: "https://example.com", title: "Docs" }),
		]);
		const specs = migrateLegacyTree(tree);
		expect(specs).toHaveLength(3);
		expect(specs[1].params).toEqual({
			panelType: "terminal",
			terminalConfig: { narratorId: "narr" },
		});
		expect(specs[2].params).toEqual({
			panelType: "webview",
			webviewConfig: { url: "https://example.com", title: "Docs" },
		});
		expect(specs[2].title).toBe("Docs");
	});

	test("empty narrator leaf (no id) is dropped", () => {
		const tree = createBranch("horizontal", [createLeafWith("a"), { ...createLeafWith("") }]);
		// createLeafWith("") still has narratorId "" which is falsy → dropped
		const specs = migrateLegacyTree(tree);
		expect(specs).toHaveLength(1);
		expect(specs[0].params).toEqual({ panelType: "narrator", narratorId: "a" });
	});

	test("nested branches flatten into a linear placement chain", () => {
		// H[ a, V[ b, c ] ]
		const tree = createBranch("horizontal", [
			createLeafWith("a"),
			createBranch("vertical", [createLeafWith("b"), createLeafWith("c")]),
		]);
		const specs = migrateLegacyTree(tree);
		expect(specs.map((s) => (s.params as { narratorId: string }).narratorId)).toEqual([
			"a",
			"b",
			"c",
		]);
		// first child of nested branch inherits parent direction (right),
		// sibling stacks along the branch axis (below)
		expect(specs[1].placement).toMatchObject({ direction: "right" });
		expect(specs[2].placement).toMatchObject({ direction: "below" });
	});
});

describe("resolveWorkspaceLayout", () => {
	test("null/empty → empty panel list with grid director state", () => {
		const resolved = resolveWorkspaceLayout(null);
		expect(resolved.kind).toBe("panels");
		if (resolved.kind === "panels") {
			expect(resolved.panels).toHaveLength(0);
			expect(resolved.director.mode).toBe("grid");
		}
	});

	test("legacy split-tree JSON → migrated panel list", () => {
		const legacy = JSON.stringify(
			createBranch("horizontal", [createLeafWith("a"), createLeafWith("b")]),
		);
		const resolved = resolveWorkspaceLayout(legacy);
		expect(resolved.kind).toBe("panels");
		if (resolved.kind === "panels") {
			expect(resolved.panels).toHaveLength(2);
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

	test("malformed JSON → falls back to empty panel list", () => {
		const resolved = resolveWorkspaceLayout("{not valid json");
		expect(resolved.kind).toBe("panels");
	});

	test("seed envelope → materialised panel list (no split-tree round-trip)", () => {
		const seed = serializeSeedEnvelope(twoNarratorWorkspaceSeed("a", "b", "right"));
		const resolved = resolveWorkspaceLayout(seed);
		expect(resolved.kind).toBe("panels");
		if (resolved.kind === "panels") {
			expect(resolved.panels).toHaveLength(2);
			expect(resolved.panels[0].params).toEqual({ panelType: "narrator", narratorId: "a" });
			expect(resolved.panels[0].placement).toEqual({ kind: "first" });
			expect(resolved.panels[1].params).toEqual({ panelType: "narrator", narratorId: "b" });
			expect(resolved.panels[1].placement).toMatchObject({
				kind: "relative",
				direction: "right",
			});
		}
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
