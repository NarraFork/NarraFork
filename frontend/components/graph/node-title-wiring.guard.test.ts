/**
 * node-title-wiring.guard.test.ts — an expanded chapter node must show its title
 * EXACTLY once, and its title controls must not be eaten by the canvas.
 *
 * Both properties fail silently, which is why they are pinned on the wiring rather
 * than left to a runtime test:
 *
 *  1. Two title rows. The node header renders the title, and the embedded
 *     `NarratorPanel` used to render it again — where its own dozen tool buttons
 *     squeezed it to zero width. Nothing errors: the node just shows a header full
 *     of icons and no readable title, which is the bug this guard exists for. The
 *     suppression runs through `dock.hostOwnsTitle`, so all three ends (context
 *     field, node dock passing it, panel gating on it) have to stay connected.
 *
 *  2. Missing `nodrag`. An expanded node uses its header as React Flow's
 *     `dragHandle`, and RF's drag filter is purely class-based — a button inside the
 *     handle starts a NODE DRAG on pointerdown and swallows the click. The controls
 *     stay visible and simply stop working, or worse, drag the node instead. No
 *     error, no warning.
 *
 * Zero-runtime, filesystem-only.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const GRAPH_DIR = import.meta.dir;
const FRONTEND_ROOT = resolve(GRAPH_DIR, "..", "..");

function read(...segments: string[]): string {
	return readFileSync(join(...segments), "utf8");
}

const titleEditor = () => read(GRAPH_DIR, "NodeTitleEditor.tsx");
const chapterNode = () => read(GRAPH_DIR, "ChapterNode.tsx");
const reviewNode = () => read(GRAPH_DIR, "ReviewNode.tsx");
const chapterNodeDock = () => read(GRAPH_DIR, "dock", "ChapterNodeDock.tsx");
const dockContext = () =>
	read(FRONTEND_ROOT, "components", "narrator", "dock", "NarratorDockContext.tsx");
const narratorPanel = () => read(FRONTEND_ROOT, "components", "narrator", "NarratorPanel.tsx");

describe("node title ownership", () => {
	it("both chapter-like nodes render their title through NodeTitleEditor", () => {
		for (const source of [chapterNode(), reviewNode()]) {
			expect(source).toContain('from "./NodeTitleEditor"');
			expect(source).toContain("<NodeTitleEditor");
		}
	});

	it("the node dock declares that the host owns the title", () => {
		const source = chapterNodeDock();
		expect(source).toContain("hostOwnsTitle");
		// On the provider, not smuggled into panel params: the panel reads it from
		// context, and a params-only value would never reach it.
		const providerStart = source.indexOf("<NarratorDockProvider");
		expect(providerStart).toBeGreaterThan(-1);
		const providerEnd = source.indexOf(">", source.indexOf("pluginSurface", providerStart));
		expect(source.slice(providerStart, providerEnd)).toContain("hostOwnsTitle");
	});

	it("the dock context carries hostOwnsTitle through its memoized value", () => {
		const source = dockContext();
		// Declared on the shape...
		expect(source).toMatch(/hostOwnsTitle\?: boolean/);
		// ...published in the value...
		expect(source).toMatch(/\n\t\t\thostOwnsTitle,/);
		// ...and in the dependency array, or the panel keeps the value from the render
		// in which the provider first mounted.
		expect(source).toMatch(/\n\t\thostOwnsTitle,/);
	});

	it("the chat panel gates its whole title block on hostOwnsTitle", () => {
		const source = narratorPanel();
		expect(source).toContain("const hostOwnsTitle = dock?.hostOwnsTitle === true;");
		// The title element itself...
		expect(source).toContain("{hostOwnsTitle ? null : editingTitle && !isWorkspacePreview ? (");
		// ...and the pencil / sparkles pair beside it. Leaving these would keep two
		// title buttons in a node header that already has its own.
		expect(source).toContain("{!isWorkspacePreview && !hostOwnsTitle && (");
	});
});

describe("node title controls survive the canvas", () => {
	it("every interactive control carries nodrag and nopan", () => {
		const source = titleEditor();
		// One shared constant, so a new control cannot be added without it.
		expect(source).toContain('const INTERACTIVE_CLASS = "nodrag nopan";');
		const usages = source.match(/className=\{INTERACTIVE_CLASS\}/g) ?? [];
		// Input + pencil + sparkles.
		expect(usages.length).toBe(3);
		// No control may hand-roll its className and miss the guard.
		expect(source).not.toMatch(/className="(?!nodrag nopan")/);
	});

	it("the editor stops the gestures the canvas would otherwise claim", () => {
		const source = titleEditor();
		// Double click on a node toggles expand/collapse, which would tear the editor
		// down mid-word when the reader double-clicks to select one.
		expect(source).toContain("onDoubleClick={(event) => event.stopPropagation()}");
		expect(source).toContain("onPointerDown={(event) => event.stopPropagation()}");
		// Both action clicks stop propagation so they do not also select the node.
		// Indentation-agnostic: the two buttons sit at different nesting depths.
		const stoppedClicks = source.match(/onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);/g);
		expect(stoppedClicks?.length).toBe(2);
	});
});
