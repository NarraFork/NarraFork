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
import type { DockviewApi, DockviewDidDropEvent } from "dockview-react";
import { fileDockPanelId } from "../../narrator/dock/dock-panel-types";
import type { NarratorDockContextValue } from "../../narrator/dock/NarratorDockContext";
import { handleForeignPanelDrop, shouldAcceptForeignPanel } from "./cross-surface-drop";
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

describe("historical file cross-surface drop", () => {
	it("rebuilds the historical panel without replacing an existing live editor", () => {
		const toolEdit = {
			narratorId: "origin",
			toolUseId: "sdk-id",
			toolCallId: "row",
			executionAttempt: 2,
		};
		const params = {
			panelType: "file",
			filePath: "/a.ts",
			deviceId: "Remote",
			referenceOrigin: true,
			toolEdit,
		};
		const historicalId = fileDockPanelId(params.filePath, params.deviceId, toolEdit);
		const liveId = fileDockPanelId(params.filePath, params.deviceId);
		const events: string[] = [];
		let sourceOpen = true;
		const sourcePanel = {
			id: historicalId,
			params,
			api: {
				close: () => {
					events.push("close");
					sourceOpen = false;
				},
			},
		};
		registerDetachedDock("source", "chapter", {
			apiRef: {
				current: {
					getPanel: (id: string) => (sourceOpen && id === historicalId ? sourcePanel : undefined),
				},
			},
		} as unknown as NarratorDockContextValue);
		const live = {
			id: liveId,
			params: { panelType: "file", filePath: "/a.ts", deviceId: "Remote" },
		};
		const added: Array<{ id: string; params: unknown }> = [];
		const api = {
			getPanel: (id: string) => (id === liveId ? live : undefined),
			addPanel: (panel: { id: string; params: unknown }) => {
				events.push("add");
				added.push(panel);
			},
		} as unknown as DockviewApi;
		expect(
			handleForeignPanelDrop(
				{ getData: () => ({ panelId: historicalId }) } as unknown as DockviewDidDropEvent,
				api,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(true);
		expect(events).toEqual(["close", "add"]);
		expect(added[0]).toMatchObject({ id: historicalId, component: "file", params });
		expect(api.getPanel(liveId)).toBe(live as never);
		expect(live.params).not.toHaveProperty("toolEdit");
	});
});

it("drops a child reader beside the host's same-path editor without rebinding authority", () => {
	const filePath = "/work/b/a.ts";
	const childId = fileDockPanelId(filePath, "local", undefined, "child");
	const hostId = fileDockPanelId(filePath);
	const params = {
		panelType: "file",
		filePath,
		deviceId: "local",
		referenceOrigin: true,
		fileNarratorId: "child",
		largeFileConfirmed: true,
	};
	const source = { id: childId, params, api: { close() {} } };
	registerDetachedDock("source", "chapter", {
		apiRef: { current: { getPanel: (id: string) => (id === childId ? source : undefined) } },
	} as unknown as NarratorDockContextValue);
	const host = { id: hostId, params: { panelType: "file", filePath } };
	const added: Array<{ id: string; params: unknown }> = [];
	const api = {
		getPanel: (id: string) => (id === hostId ? host : undefined),
		addPanel: (panel: { id: string; params: unknown }) => added.push(panel),
	} as unknown as DockviewApi;
	expect(
		handleForeignPanelDrop(
			{ getData: () => ({ panelId: childId }) } as unknown as DockviewDidDropEvent,
			api,
			{ narratorId: "parent", chapterId: "chapter" },
		),
	).toBe(true);
	expect(added[0]).toMatchObject({ id: childId, params });
	expect(api.getPanel(hostId)).toBe(host as never);
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
