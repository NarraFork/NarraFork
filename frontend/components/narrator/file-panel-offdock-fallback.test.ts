/**
 * file-panel-offdock-fallback.test.ts — "open in panel" must reach a viewer on
 * surfaces that have no dockview host.
 *
 * The regression this locks down: `handleOpenFilePanel` was derived from
 * `dock.openFilePanel` alone, so on the MOBILE narrator page — which renders
 * NarratorPanel directly with no NarratorDockProvider — the handler stayed
 * undefined and every consumer hid its affordance. The row menus gate on the
 * handler by design (a host with nowhere to open must not offer a dead control),
 * so the loss is completely silent: the swipe menu still opens, just one item
 * shorter, on the one surface where a swipe menu is the ONLY way to reach the
 * viewer (there is no right-click on touch).
 *
 * Asserted against the source because NarratorPanel is not unit-mountable (it
 * owns queries, a WS subscription and a scroll container), matching
 * selection-anchor-overlay.wiring.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PANEL = readFileSync(join(import.meta.dir, "NarratorPanel.tsx"), "utf8");
/**
 * The route SELECTION (dock panel vs off-dock drawer) now lives in this hook; the
 * panel keeps only the Drawer that hosts the viewer. Both halves are asserted, so
 * neither the routing rule nor the drawer host can be dropped unnoticed.
 */
const VIEWER_HOOK = readFileSync(
	join(import.meta.dir, "interaction", "use-internal-file-viewer.ts"),
	"utf8",
);

function declarationExpression(name: string): string {
	const expression = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(VIEWER_HOOK)?.[1];
	if (!expression) throw new Error(`File-viewer capability declaration missing: ${name}`);
	return expression;
}
const internalViewerEnabled = new Function(
	"REMOTE_BUILD",
	"dockOpenFilePanel",
	"isWorkspacePreview",
	`return Boolean(${declarationExpression("useInternalViewer")});`,
) as (remote: boolean, hasDock: boolean, preview: boolean) => boolean;
const referenceViewerEnabled = new Function(
	"REMOTE_BUILD",
	"dockOpenFilePanel",
	"isWorkspacePreview",
	"useInternalViewer",
	`return Boolean(${declarationExpression("canOpenReferencedFile")});`,
) as (remote: boolean, hasDock: boolean, preview: boolean, internal: boolean) => boolean;

describe("off-dock file viewer fallback", () => {
	it("keeps the dock panel as the preferred route", () => {
		// A dockview host must still open a real tab beside the chat rather than a
		// drawer that covers the conversation it was opened from.
		expect(VIEWER_HOOK).toContain(
			"if (dockOpenFilePanel) return (filePath: string) => dockOpenFilePanel(filePath);",
		);
	});

	it("falls back to the internal drawer when there is no dock", () => {
		expect(internalViewerEnabled(false, false, false)).toBe(true);
		expect(internalViewerEnabled(false, true, false)).toBe(false);
		expect(internalViewerEnabled(true, false, false)).toBe(false);
		expect(VIEWER_HOOK).toMatch(
			/if \(useInternalViewer\)[\s\S]*?setInternalFileViewerPath\(filePath\);/,
		);
	});

	it("still leaves workspace previews without a viewer", () => {
		// Previews stay lightweight (same rule as the internal spec drawer), so their
		// rows hide the affordance instead of opening a drawer inside a thumbnail.
		for (const remote of [false, true]) {
			for (const hasDock of [false, true]) {
				expect(internalViewerEnabled(remote, hasDock, true)).toBe(false);
				// The reference affordance must reject previews even if a host or a stale
				// internal-viewer flag is present, not merely rely on the fallback route.
				expect(referenceViewerEnabled(remote, hasDock, true, true)).toBe(false);
			}
		}
		expect(referenceViewerEnabled(false, true, false, false)).toBe(true);
		expect(referenceViewerEnabled(false, false, false, true)).toBe(true);
		expect(referenceViewerEnabled(false, false, false, false)).toBe(false);
		expect(referenceViewerEnabled(true, true, false, true)).toBe(false);
	});

	it("mounts the drawer only while a path is selected", () => {
		// Mounted-on-demand and torn down on close: a session that never opens a file
		// must not pay for the viewer's module graph.
		const gate = /\{\s*(!REMOTE_BUILD\s*&&\s*internalFileViewerPath)\s*&&\s*\(/.exec(PANEL)?.[1];
		if (!gate) throw new Error("Remote-gated internal file-viewer drawer missing");
		const drawerMounted = new Function(
			"REMOTE_BUILD",
			"internalFileViewerPath",
			`return Boolean(${gate});`,
		) as (remote: boolean, path: string | null) => boolean;
		expect(drawerMounted(false, "/work/readme.md")).toBe(true);
		expect(drawerMounted(false, null)).toBe(false);
		expect(drawerMounted(false, "")).toBe(false);
		expect(drawerMounted(true, "/work/readme.md")).toBe(false);
		expect(PANEL).toContain("onClose={() => setInternalFileViewerPath(null)}");
	});

	it("renders the same viewer body the dock's file panel renders", () => {
		// Two viewers would drift; the drawer is only a different HOST for the same
		// content.
		const dock = readFileSync(join(import.meta.dir, "dock", "panels.tsx"), "utf8");
		expect(PANEL).toContain('import("./file-panel/FilePanelContent")');
		expect(dock).toContain('import("../file-panel/FilePanelContent")');
		expect(PANEL).toContain("<FilePanelContent");
		expect(dock).toContain("<FilePanelContent");
		expect(PANEL).toContain("onDirtyChange={onFileEditorDirtyChange}");
		expect(PANEL).toContain("canExitFileEditor,");
		expect(PANEL).not.toContain("legacyViewer");
		expect(PANEL).toContain("referenceOrigin={!!internalFileViewerTarget}");
		expect(PANEL).toContain("selection={internalFileViewerTarget?.selection}");
	});
});
