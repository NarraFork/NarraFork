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

describe("off-dock file viewer fallback", () => {
	it("keeps the dock panel as the preferred route", () => {
		// A dockview host must still open a real tab beside the chat rather than a
		// drawer that covers the conversation it was opened from.
		expect(PANEL).toContain(
			"if (dockOpenFilePanel) return (filePath: string) => dockOpenFilePanel(filePath);",
		);
	});

	it("falls back to the internal drawer when there is no dock", () => {
		expect(PANEL).toContain(
			"const useInternalFileViewer = !dockOpenFilePanel && !isWorkspacePreview;",
		);
		expect(PANEL).toMatch(
			/if \(useInternalFileViewer\)[\s\S]*?setInternalFileViewerTarget\(null\);[\s\S]*?setInternalFileViewerPath\(filePath\);/,
		);
	});

	it("still leaves workspace previews without a viewer", () => {
		// Previews stay lightweight (same rule as the internal spec drawer), so their
		// rows hide the affordance instead of opening a drawer inside a thumbnail.
		expect(PANEL).toMatch(/useInternalFileViewer = !dockOpenFilePanel && !isWorkspacePreview/);
	});

	it("mounts the drawer only while a path is selected", () => {
		// Mounted-on-demand and torn down on close: a session that never opens a file
		// must not pay for the viewer's module graph.
		expect(PANEL).toContain("{internalFileViewerPath && (");
		expect(PANEL).toContain("onClose={() => setInternalFileViewerPath(null)}");
	});

	it("renders the same viewer body the dock's file panel renders", () => {
		// Two viewers would drift; the drawer is only a different HOST for the same
		// content.
		expect(PANEL).toContain('import("./file-viewer/FileViewerContent")');
		expect(PANEL).toMatch(/<FileViewerContent\s+key=\{internalFileViewerPath\}/);
		expect(PANEL).toContain("referenceOrigin={!!internalFileViewerTarget}");
		expect(PANEL).toContain("selection={internalFileViewerTarget?.selection}");
	});
});
