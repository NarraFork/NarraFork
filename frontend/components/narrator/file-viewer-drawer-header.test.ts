/**
 * The mobile file viewer drawer's header must keep its close button reachable.
 *
 * The bug: the drawer title rendered the FULL path in a `<Text truncate>`. Mantine's
 * modal header is a flex row (`justify-content: space-between`) whose title child has
 * no `min-width: 0`, so a flex item's automatic minimum size — its content width —
 * applied. A long unbroken path (`/home/user/projects/.../api-request-<ts>-<id>.json`)
 * therefore refused to shrink, `text-overflow: ellipsis` never engaged, and the close
 * button was pushed out of the viewport.
 *
 * That is worse on mobile than the same bug in the dock panel: the drawer is the
 * off-dock host (see file-panel-offdock-fallback.test.ts), it opens at `size="100%"`,
 * and touch has no Escape key — so with the button gone there is no way to close it
 * except a hardware Back gesture that may navigate away instead.
 *
 * Asserted against the source because NarratorPanel is not unit-mountable (it owns
 * queries, a WS subscription and a scroll container), matching that sibling suite.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PANEL = readFileSync(join(import.meta.dir, "NarratorPanel.tsx"), "utf8");

/** The drawer block, so these assertions cannot pass by matching another drawer. */
const DRAWER = (() => {
	const start = PANEL.indexOf("{internalFileViewerPath && (");
	if (start === -1) throw new Error("internal file viewer drawer not found");
	const end = PANEL.indexOf("</Drawer>", start);
	if (end === -1) throw new Error("drawer end not found");
	return PANEL.slice(start, end);
})();

describe("internal file viewer drawer header", () => {
	it("lets the title shrink so the close button keeps its space", () => {
		// `minWidth: 0` is the half that actually permits the shrink; `flex: 1` alone
		// still floors at the content width.
		expect(DRAWER).toContain('title: { minWidth: 0, flex: 1, overflow: "hidden" }');
	});

	// A right-clipped path keeps the directories and drops the filename — the one part
	// that says which file this is. TruncatedPath ellipsizes from the left instead.
	it("clips the path from the left so the filename stays visible", () => {
		expect(DRAWER).toContain("<TruncatedPath path={internalFileViewerPath}");
	});

	it("no longer right-truncates the raw path in a plain Text", () => {
		// The exact shape of the regression, so a revert fails here rather than only
		// showing up on a phone.
		expect(DRAWER).not.toMatch(/<Text[^>]*truncate[^>]*>\s*\{internalFileViewerPath\}/);
	});

	it("still renders a close button for the drawer", () => {
		// The affordance the layout bug hid. If this is ever dropped, the mobile drawer
		// becomes uncloseable without a Back gesture.
		expect(DRAWER).toContain("closeButtonProps=");
		expect(DRAWER).toContain("onClose={() => setInternalFileViewerPath(null)}");
	});
});
