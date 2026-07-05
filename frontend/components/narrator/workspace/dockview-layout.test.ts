import { describe, expect, test } from "bun:test";
import {
	createBranch,
	createLeafWith,
	createTerminalLeaf,
	createWebviewLeaf,
	type SplitNode,
} from "../split-tree";
import {
	migrateLegacyTree,
	resolveWorkspaceLayout,
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

	test("dockview envelope → restored verbatim", () => {
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
			expect(resolved.director).toEqual({ mode: "director", primaryPanelId: "p1" });
		}
	});

	test("malformed JSON → falls back to empty panel list", () => {
		const resolved = resolveWorkspaceLayout("{not valid json");
		expect(resolved.kind).toBe("panels");
	});
});
