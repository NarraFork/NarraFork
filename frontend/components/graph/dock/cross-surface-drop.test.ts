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
import type { DockviewApi, DockviewDidDropEvent, IDockviewPanel } from "dockview-react";
import { fileDockPanelId } from "../../narrator/dock/dock-panel-types";
import type { NarratorDockContextValue } from "../../narrator/dock/NarratorDockContext";
import { handleForeignPanelDrop, shouldAcceptForeignPanel } from "./cross-surface-drop";
import { __resetChapterDockRegistry, registerDetachedDock } from "./dock-registry";

/** A dockview api stub exposing just the panel lookup this module uses. */
function fakeApi(panels: Record<string, unknown>, id = "target-view") {
	return {
		id,
		getPanel: (id: string) => (id in panels ? ({ id, params: panels[id] } as never) : undefined),
	};
}

/** Register a surface holding the given panels. */
function mountSurface(nodeId: string, panels: Record<string, unknown>) {
	registerDetachedDock(nodeId, "ch_1", {
		apiRef: { current: fakeApi(panels, `${nodeId}-view`) },
		// biome-ignore lint/suspicious/noExplicitAny: only apiRef.getPanel is read
	} as any);
}

afterEach(() => {
	__resetChapterDockRegistry();
});

function transferApi(id: string) {
	const panels = new Map<string, IDockviewPanel>();
	let activePanel: IDockviewPanel | undefined;
	const api = {
		id,
		get panels() {
			return [...panels.values()];
		},
		get activePanel() {
			return activePanel;
		},
		getPanel: (panelId: string) => panels.get(panelId),
		addPanel(options: { id: string; params: Record<string, unknown> }) {
			if (panels.has(options.id)) throw new Error(`Duplicate panel: ${options.id}`);
			let currentParams = options.params;
			const panel = {
				id: options.id,
				get params() {
					return currentParams;
				},
				api: {
					close: () => panels.delete(options.id),
					setActive: () => {
						activePanel = panel;
					},
					moveTo() {},
					updateParameters: (params: Record<string, unknown>) => {
						currentParams = { ...currentParams, ...params };
					},
				},
			} as unknown as IDockviewPanel;
			panels.set(options.id, panel);
			activePanel = panel;
			return panel;
		},
	} as unknown as DockviewApi;
	return api;
}

describe("file identity during native transfer", () => {
	it.each([
		["ordinary", "/repo/first.txt", "/repo/second.txt"],
		["colliding", "/repo/collide-1f7f9218.txt", "/repo/collide-08c374cf.txt"],
	])("moves the %s file without changing the target's existing file", (_label, first, second) => {
		const source = transferApi("source-view");
		const target = transferApi("target-view");
		const sourcePanel = source.addPanel({
			id: fileDockPanelId(second),
			component: "file",
			params: { panelType: "file", filePath: second },
		});
		const retained = target.addPanel({
			id: fileDockPanelId(first),
			component: "file",
			params: { panelType: "file", filePath: first },
		});
		const retainedParams = retained.params;
		registerDetachedDock("source-node", "chapter", {
			narratorId: "source-host",
			apiRef: { current: source },
		} as NarratorDockContextValue);

		expect(
			handleForeignPanelDrop(
				{
					getData: () => ({ panelId: sourcePanel.id, viewId: source.id }),
				} as unknown as DockviewDidDropEvent,
				target,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(true);
		expect(source.getPanel(sourcePanel.id)).toBeUndefined();
		expect(target.getPanel(retained.id)).toBe(retained);
		expect(retained.params === retainedParams).toBe(true);
		expect(retained.params?.filePath).toBe(first);
		expect(target.panels).toHaveLength(2);
		expect(target.activePanel?.params?.filePath).toBe(second);
	});

	it("reuses an existing suffixed target and keeps its sticky reference state", () => {
		const source = transferApi("source-view");
		const target = transferApi("target-view");
		const first = "/repo/collide-1f7f9218.txt";
		const second = "/repo/collide-08c374cf.txt";
		const sourcePanel = source.addPanel({
			id: "restored-source-b",
			component: "file",
			params: { panelType: "file", filePath: second, largeFileConfirmed: true },
		});
		const retained = target.addPanel({
			id: fileDockPanelId(first),
			component: "file",
			params: { panelType: "file", filePath: first },
		});
		const existing = target.addPanel({
			id: `${retained.id}-4`,
			component: "file",
			params: { panelType: "file", filePath: second, referenceOrigin: true },
		});
		registerDetachedDock("source", "chapter", {
			narratorId: "source-host",
			apiRef: { current: source },
		} as NarratorDockContextValue);
		expect(
			handleForeignPanelDrop(
				{ getData: () => ({ panelId: sourcePanel.id, viewId: source.id }) } as DockviewDidDropEvent,
				target,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(true);
		expect(source.panels).toHaveLength(0);
		expect(target.panels).toHaveLength(2);
		expect(target.activePanel).toBe(existing);
		expect(existing.params).toMatchObject({
			filePath: second,
			referenceOrigin: true,
			largeFileConfirmed: true,
		});
		expect(retained.params?.filePath).toBe(first);
	});

	it("uses viewId to close the requested source when two surfaces share a panel id", () => {
		const wrong = transferApi("wrong-view");
		const source = transferApi("source-view");
		const target = transferApi("target-view");
		for (const [api, filePath] of [
			[wrong, "/wrong.ts"],
			[source, "/requested.ts"],
		] as const) {
			api.addPanel({
				id: "shared-panel",
				component: "file",
				params: { panelType: "file", filePath },
			});
			registerDetachedDock(api.id, "chapter", {
				narratorId: "host",
				apiRef: { current: api },
			} as NarratorDockContextValue);
		}
		expect(
			handleForeignPanelDrop(
				{ getData: () => ({ panelId: "shared-panel", viewId: source.id }) } as DockviewDidDropEvent,
				target,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(true);
		expect(wrong.panels).toHaveLength(1);
		expect(source.panels).toHaveLength(0);
		expect(target.activePanel?.params?.filePath).toBe("/requested.ts");
	});

	it.each([
		undefined,
		"missing-view",
		"target-view",
	])("refuses invalid or local viewId %s", (viewId) => {
		const source = transferApi("source-view");
		const target = transferApi("target-view");
		source.addPanel({
			id: "dragged",
			component: "file",
			params: { panelType: "file", filePath: "/a.ts" },
		});
		registerDetachedDock("source", "chapter", {
			narratorId: "source-host",
			apiRef: { current: source },
		} as NarratorDockContextValue);
		expect(
			handleForeignPanelDrop(
				{ getData: () => ({ panelId: "dragged", viewId }) } as DockviewDidDropEvent,
				target,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(false);
		expect(source.panels).toHaveLength(1);
		expect(target.panels).toHaveLength(0);
	});

	it("leaves the target unchanged when the source close guard vetoes", () => {
		const source = transferApi("source-view");
		const target = transferApi("target-view");
		const panel = source.addPanel({
			id: "dragged",
			component: "file",
			params: { panelType: "file", filePath: "/a.ts", referenceOrigin: true },
		});
		panel.api.close = () => {};
		const retained = target.addPanel({
			id: fileDockPanelId("/a.ts"),
			component: "file",
			params: { panelType: "file", filePath: "/a.ts" },
		});
		const originalParams = retained.params;
		registerDetachedDock("source", "chapter", {
			narratorId: "source-host",
			apiRef: { current: source },
		} as NarratorDockContextValue);
		expect(
			handleForeignPanelDrop(
				{ getData: () => ({ panelId: panel.id, viewId: source.id }) } as DockviewDidDropEvent,
				target,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(false);
		expect(source.getPanel(panel.id)).toBe(panel);
		expect(target.panels).toHaveLength(1);
		expect(retained.params === originalParams).toBe(true);
	});

	it("does not close a file whose source has no reconstructable resource", () => {
		const source = transferApi("source-view");
		const target = transferApi("target-view");
		const panel = source.addPanel({
			id: "invalid",
			component: "file",
			params: { panelType: "file" },
		});
		registerDetachedDock("source", "chapter", {
			apiRef: { current: source },
		} as NarratorDockContextValue);
		expect(
			handleForeignPanelDrop(
				{ getData: () => ({ panelId: panel.id, viewId: source.id }) } as DockviewDidDropEvent,
				target,
				{ narratorId: "target-host", chapterId: "chapter" },
			),
		).toBe(false);
		expect(source.getPanel(panel.id)).toBe(panel);
		expect(target.panels).toHaveLength(0);
	});
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
					id: "source-view",
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
			id: "target-view",
			panels: [live],
			getPanel: (id: string) => (id === liveId ? live : undefined),
			addPanel: (panel: { id: string; params: unknown }) => {
				events.push("add");
				added.push(panel);
			},
		} as unknown as DockviewApi;
		expect(
			handleForeignPanelDrop(
				{
					getData: () => ({ panelId: historicalId, viewId: "source-view" }),
				} as unknown as DockviewDidDropEvent,
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
	let sourceOpen = true;
	const source = {
		id: childId,
		params,
		api: {
			close() {
				sourceOpen = false;
			},
		},
	};
	registerDetachedDock("source", "chapter", {
		apiRef: {
			current: {
				id: "source-view",
				getPanel: (id: string) => (sourceOpen && id === childId ? source : undefined),
			},
		},
	} as unknown as NarratorDockContextValue);
	const host = { id: hostId, params: { panelType: "file", filePath } };
	const added: Array<{ id: string; params: unknown }> = [];
	const api = {
		id: "target-view",
		panels: [host],
		getPanel: (id: string) => (id === hostId ? host : undefined),
		addPanel: (panel: { id: string; params: unknown }) => added.push(panel),
	} as unknown as DockviewApi;
	expect(
		handleForeignPanelDrop(
			{
				getData: () => ({ panelId: childId, viewId: "source-view" }),
			} as unknown as DockviewDidDropEvent,
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
		expect(shouldAcceptForeignPanel("ndock-terminal", fakeApi({}), "dp_a-view")).toBe(true);
	});

	it("refuses a panel this surface already owns", () => {
		// Same-surface drags are dockview's own business (reorder / split); interposing
		// here would break behaviour that already works.
		mountSurface("dp_a", { "ndock-terminal": { panelType: "terminal" } });
		expect(
			shouldAcceptForeignPanel("ndock-terminal", fakeApi({ "ndock-terminal": {} }), "target-view"),
		).toBe(false);
	});

	it("refuses a panel no mounted surface holds", () => {
		// Nothing could rebuild it, so an overlay would invite a no-op drop.
		expect(shouldAcceptForeignPanel("ndock-terminal", fakeApi({}), "missing-view")).toBe(false);
	});

	it("refuses a non-detachable panel", () => {
		mountSurface("dp_a", { "ndock-chat": { panelType: "chat" } });
		expect(shouldAcceptForeignPanel("ndock-chat", fakeApi({}), "dp_a-view")).toBe(false);
	});

	it("refuses when there is no dragged panel id", () => {
		mountSurface("dp_a", { "ndock-terminal": { panelType: "terminal" } });
		expect(shouldAcceptForeignPanel(null, fakeApi({}), "dp_a-view")).toBe(false);
		expect(shouldAcceptForeignPanel(undefined, fakeApi({}), "dp_a-view")).toBe(false);
	});
});
