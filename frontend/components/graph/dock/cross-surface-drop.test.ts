/**
 * cross-surface-drop — whether a foreign tab drag is offered a drop target.
 *
 * This decision is the difference between "I can drag this panel into that node" and
 * "that node looks undroppable": dockview's `canDisplayOverlay` returns
 * `event.isAccepted` for a drag it does not recognise, so **not** accepting means no
 * drop overlay is ever drawn. The failure is silent — nothing throws, the user just
 * cannot drop.
 *
 * The two rejection cases matter as much as the acceptance:
 *  - a panel this surface already owns must be left to dockview (tab reordering and
 *    splitting already work; accepting it here would put our handler in the way);
 *  - a panel nothing can rebuild must be refused, or the overlay would invite a drop
 *    that then does nothing.
 *
 * Tested through `shouldAcceptForeignPanel` rather than the event wrapper, because
 * dockview exports no setter for the module-level drag payload the wrapper reads.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { shouldAcceptForeignPanel } from "./cross-surface-drop";
import { __resetChapterDockRegistry, registerDetachedDock } from "./dock-registry";

/** A dockview api stub exposing just the panel lookup this module uses. */
function fakeApi(panels: Record<string, unknown>) {
	return {
		getPanel: (id: string) => (id in panels ? ({ id, params: panels[id] } as never) : undefined),
	};
}

/** Register a surface holding the given panels. */
function mountSurface(nodeId: string, panels: Record<string, unknown>) {
	registerDetachedDock(nodeId, "ch_1", {
		apiRef: { current: fakeApi(panels) },
		// biome-ignore lint/suspicious/noExplicitAny: only apiRef.getPanel is read
	} as any);
}

afterEach(() => {
	__resetChapterDockRegistry();
});

describe("shouldAcceptForeignPanel", () => {
	it("accepts a detachable panel held by another surface", () => {
		// Without this the target draws no overlay at all — the reported "cannot drag
		// into the detached node".
		mountSurface("dp_a", { "ndock-terminal": { panelType: "terminal" } });
		expect(shouldAcceptForeignPanel("ndock-terminal", fakeApi({}))).toBe(true);
	});

	it("refuses a panel this surface already owns", () => {
		// Same-surface drags are dockview's own business (reorder / split); interposing
		// here would break behaviour that already works.
		mountSurface("dp_a", { "ndock-terminal": { panelType: "terminal" } });
		expect(shouldAcceptForeignPanel("ndock-terminal", fakeApi({ "ndock-terminal": {} }))).toBe(
			false,
		);
	});

	it("refuses a panel no mounted surface holds", () => {
		// Nothing could rebuild it, so an overlay would invite a no-op drop.
		expect(shouldAcceptForeignPanel("ndock-terminal", fakeApi({}))).toBe(false);
	});

	it("refuses a non-detachable panel", () => {
		mountSurface("dp_a", { "ndock-chat": { panelType: "chat" } });
		expect(shouldAcceptForeignPanel("ndock-chat", fakeApi({}))).toBe(false);
	});

	it("refuses when there is no dragged panel id", () => {
		mountSurface("dp_a", { "ndock-terminal": { panelType: "terminal" } });
		expect(shouldAcceptForeignPanel(null, fakeApi({}))).toBe(false);
		expect(shouldAcceptForeignPanel(undefined, fakeApi({}))).toBe(false);
	});
});
