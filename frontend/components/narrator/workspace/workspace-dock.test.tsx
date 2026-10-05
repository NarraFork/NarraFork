import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	type DockviewApi,
	DockviewReact,
	type IDockviewPanelProps,
	type IDockviewReactProps,
	type SerializedDockview,
} from "dockview-react";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PluginContributionPick } from "../../plugins/PluginContributionPicker";
import { DEFAULT_DIRECTOR_STATE, serializeWorkspaceLayout } from "./dockview-layout";
import { PANEL_COMPONENT, type WorkspacePanelParams } from "./panel-types";
import {
	createWorkspaceDockStore,
	useWorkspaceDock,
	WorkspaceDockProvider,
	type WorkspaceDockStore,
	workspaceFilePanelId,
	workspaceKnowledgePanelId,
	workspaceResourceOwner,
	workspaceSubagentPanelId,
	workspaceToolPanelId,
} from "./workspace-dock";

// Only browser layout primitives are stubbed: all panels, groups, floating
// containers, events, portals and moves below belong to the real DockviewReact.
let root: Root;
let container: HTMLDivElement;
let api: DockviewApi;
let store: WorkspaceDockStore;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let nextInstance: number;
let mounts: Map<string, number>;
let cleanups: Map<string, number>;
let reveals: number;
let layoutEvents: number;
let disposables: { dispose(): void }[];
const globals = new Map<string, PropertyDescriptor | undefined>();
const prototypeProperties = new Map<string, PropertyDescriptor | undefined>();
let elementPrototype: object;

function rectangle(element: HTMLElement): DOMRect {
	let left = 0;
	let top = 0;
	let width: number | undefined;
	let height: number | undefined;
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		const px = (value: string | undefined) =>
			value?.endsWith("px") ? Number.parseFloat(value) : undefined;
		left += px(node.style.left) ?? 0;
		top += px(node.style.top) ?? 0;
		width ??= px(node.style.width);
		height ??= px(node.style.height);
	}
	return {
		left,
		top,
		width: width ?? 1200,
		height: height ?? 800,
		x: left,
		y: top,
		right: left + (width ?? 1200),
		bottom: top + (height ?? 800),
		toJSON() {
			return { left, top, width, height };
		},
	} as DOMRect;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	frames = new Map();
	frameId = 0;
	nextInstance = 0;
	mounts = new Map();
	cleanups = new Map();
	reveals = 0;
	layoutEvents = 0;
	disposables = [];
	const getComputedStyle = (element: HTMLElement) => ({
		getPropertyValue: (key: string) => element.style.getPropertyValue(key) || "0px",
		display: element.style.display || "block",
		position: element.style.position || "static",
	});
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		MutationObserver: window.MutationObserver,
		getComputedStyle,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			const id = ++frameId;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	window.getComputedStyle = getComputedStyle as unknown as typeof window.getComputedStyle;
	window.matchMedia = (media: string) => ({
		media,
		matches: false,
		onchange: null,
		dispatchEvent: () => false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	elementPrototype = window.HTMLElement.prototype;
	const geometry = {
		getBoundingClientRect: {
			value(this: HTMLElement) {
				return rectangle(this);
			},
		},
		clientWidth: {
			get(this: HTMLElement) {
				return rectangle(this).width;
			},
		},
		clientHeight: {
			get(this: HTMLElement) {
				return rectangle(this).height;
			},
		},
		offsetWidth: {
			get(this: HTMLElement) {
				return rectangle(this).width;
			},
		},
		offsetHeight: {
			get(this: HTMLElement) {
				return rectangle(this).height;
			},
		},
		scrollWidth: {
			get(this: HTMLElement) {
				return rectangle(this).width;
			},
		},
		scrollHeight: {
			get(this: HTMLElement) {
				return rectangle(this).height;
			},
		},
	};
	for (const [key, descriptor] of Object.entries(geometry)) {
		prototypeProperties.set(key, Object.getOwnPropertyDescriptor(elementPrototype, key));
		Object.defineProperty(elementPrototype, key, { configurable: true, ...descriptor });
	}
	container = document.createElement("div");
	container.style.width = "1200px";
	container.style.height = "800px";
	document.body.appendChild(container);
	root = createRoot(container);
	store = createWorkspaceDockStore({ current: null });
	store.onRevealGrid = () => reveals++;
});

afterEach(async () => {
	store.disposeTemporaryResourceChrome();
	for (const disposable of disposables) disposable.dispose();
	await act(async () => root.unmount());
	container.remove();
	frames.clear();
	for (const [key, descriptor] of prototypeProperties) {
		if (descriptor) Object.defineProperty(elementPrototype, key, descriptor);
		else Reflect.deleteProperty(elementPrototype, key);
	}
	prototypeProperties.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

function ResourceWrapper({ api: panelApi }: IDockviewPanelProps) {
	const dock = useWorkspaceDock();
	const [instance] = useState(() => ++nextInstance);
	useEffect(() => {
		mounts.set(panelApi.id, (mounts.get(panelApi.id) ?? 0) + 1);
		return () => {
			cleanups.set(panelApi.id, (cleanups.get(panelApi.id) ?? 0) + 1);
		};
	}, [panelApi.id]);
	return (
		<div data-panel-id={panelApi.id} data-instance={instance} data-store={dock === store}>
			{panelApi.id}
		</div>
	);
}

// Drain native buffered layout events AND the overlay's animation-frame writes.
// No invented Dockview events or mocked moveTo/setActive methods are involved.
async function change(action: () => void = () => {}) {
	await act(async () => {
		action();
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (let round = 0; round < 5 && frames.size > 0; round++) {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
			await Promise.resolve();
		}
	});
}

async function mountWorkspace(count = 2, registry?: IDockviewReactProps["components"]) {
	await change(() => {
		root.render(
			<MantineProvider env="test">
				<WorkspaceDockProvider store={store} workspaceId="workspace">
					<DockviewReact
						defaultRenderer="always"
						components={
							registry ??
							Object.fromEntries(
								Object.values(PANEL_COMPONENT).map((name) => [name, ResourceWrapper]),
							)
						}
						tabComponents={{ "workspace-resource": () => <span>resource</span> }}
						onReady={(event) => {
							api = event.api;
							store.apiRef.current = api;
							api.layout(1200, 800);
							for (let index = 0; index < count; index++) {
								api.addPanel({
									id: `n${index}`,
									component: PANEL_COMPONENT.narrator,
									params: { panelType: "narrator", narratorId: `n${index}` },
									...(index
										? { position: { referencePanel: `n${index - 1}`, direction: "right" as const } }
										: {}),
								});
							}
							api.layout(1200, 800);
							disposables.push(
								api.onDidLayoutChange(() => {
									layoutEvents++;
									store.reconcileTemporaryResources();
									store.refreshOpenToolTypes(api);
									store.pruneOrphanedClusters(api);
								}),
								api.onDidRemovePanel((panel) => store.forgetResource(panel.id)),
							);
						}}
					/>
				</WorkspaceDockProvider>
			</MantineProvider>,
		);
	});
	await change();
	expect(api.panels).toHaveLength(count);
}

function gridSizes() {
	return api.groups
		.filter((group) => group.api.location.type === "grid")
		.map((group) => ({
			id: group.id,
			width: group.api.width,
			height: group.api.height,
		}));
}

function requiredPanel(id: string) {
	const panel = api.getPanel(id);
	if (!panel) throw new Error(`missing Dockview panel ${id}`);
	return panel;
}

function selection(line: number) {
	return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
}

function content(id: string) {
	const node = container.querySelector(`[data-panel-id="${id}"]`);
	if (!node) throw new Error(`missing mounted resource ${id}`);
	return node;
}

const pluginPick: PluginContributionPick = {
	pluginId: "plugin",
	contributionId: "view",
	title: "Plugin view",
	version: "1.0.0",
	hash: "a".repeat(64),
};

function openPlugin(owner: string) {
	store.openPluginPanel(owner, pluginPick, {
		surface: "workspace",
		workspaceId: "workspace",
		narratorId: owner,
		presentation: "grid",
	});
}

function serializedLayout(): SerializedDockview {
	return JSON.parse(
		serializeWorkspaceLayout(api, DEFAULT_DIRECTOR_STATE, store.getTemporaryPanelIds()),
	).layout;
}

describe("real workspace Dockview resource lifecycle", () => {
	test.each([
		2, 3,
	])("first open with %s narrator groups floats without resizing the grid or premature native-event pin", async (count) => {
		await mountWorkspace(count);
		const before = gridSizes();
		const grid = structuredClone(api.toJSON().grid);
		const events = layoutEvents;
		const opens = [
			() => store.openToolPanel("n0", "terminal", null),
			() => store.openFilePanel("n0", "/repo/a.ts"),
			() => store.openSubagentPanel("n0", "child"),
			() => store.openKnowledgePanel("n0", "entry"),
			() => openPlugin("n0"),
		];
		for (const open of opens) {
			await change(open);
			expect(gridSizes()).toEqual(before);
			expect(api.toJSON().grid).toEqual(grid);
			expect(api.activePanel?.api.location.type).toBe("floating");
			expect(store.isTemporary(api.activePanel?.id ?? "")).toBe(true);
		}
		expect(layoutEvents).toBeGreaterThan(events);
		expect(store.getTemporaryPanelIds().size).toBe(5);
		expect(api.toJSON().floatingGroups).toHaveLength(5);
		expect(
			new Set(
				api.panels.filter((panel) => store.isTemporary(panel.id)).map((panel) => panel.group.id),
			).size,
		).toBe(5);
		for (const panel of api.panels.filter((panel) => store.isTemporary(panel.id))) {
			expect(panel.group.panels).toEqual([panel]);
			expect(panel.group.header.hidden).toBe(true);
			// Each native group still owns its renderer; only the current managed
			// preview is exposed above the workspace, without unmounting siblings.
			expect(panel.api.isVisible).toBe(true);
			expect(store.isActivePreview(panel.id)).toBe(panel === api.activePanel);
			expect(
				panel.group.element
					.closest(".dv-resize-container")
					?.classList.contains("workspace-resource-inactive-preview"),
			).toBe(panel !== api.activePanel);
		}
		expect(reveals).toBe(0);
		for (let index = 0; index < count; index++)
			expect(api.getPanel(`n${index}`)?.api.isVisible).toBe(true);
	});

	test("center pin preserves panel, React instance and grid dimensions; repeat open focuses the same resource", async () => {
		await mountWorkspace(3);
		const before = gridSizes();
		await change(() => store.openFilePanel("n0", "/repo/a.ts"));
		const id = workspaceFilePanelId("n0", "/repo/a.ts");
		const panel = api.getPanel(id);
		const node = content(id);
		const instance = node.getAttribute("data-instance");
		expect(node.getAttribute("data-store")).toBe("true");
		const target = store.getPinTargets(id)[0];
		expect(target.group).toBe(requiredPanel("n1").group);
		await change(() => expect(store.pinResource(id, target.group.id)).toBe(true));
		expect(api.getPanel(id)).toBe(panel);
		expect(content(id)).toBe(node);
		expect(content(id).getAttribute("data-instance")).toBe(instance);
		expect(mounts.get(id)).toBe(1);
		expect(cleanups.get(id) ?? 0).toBe(0);
		expect(store.isTemporary(id)).toBe(false);
		expect(panel?.group).toBe(target.group);
		expect(panel?.group.header.hidden).toBe(false);
		expect(gridSizes()).toEqual(before);
		expect(api.getPanel("n0")?.api.isVisible).toBe(true);
		expect(reveals).toBeGreaterThan(0);
		await change(() => api.getPanel("n0")?.api.setActive());
		await change(() =>
			store.openFilePanel("n0", "/repo/a.ts", undefined, { selection: selection(8) }),
		);
		expect(api.activePanel).toBe(panel);
		expect(panel?.params?.selection).toEqual(selection(8));
		expect(api.panels).toHaveLength(4);
		expect(mounts.get(id)).toBe(1);
		expect(content(id)).toBe(node);
	});

	test("single grid slot pins directly into a right split without replacing the resource", async () => {
		await mountWorkspace(1);
		await change(() => store.openToolPanel("n0", "terminal", null));
		const id = workspaceToolPanelId("n0", "terminal");
		const panel = requiredPanel(id);
		const node = content(id);
		const source = requiredPanel("n0");
		expect(store.getPinTargets(id)).toEqual([]);
		expect(store.hasSingleGridSlot()).toBe(true);
		expect(store.canPinResource(id)).toBe(true);
		expect(panel.group.header.hidden).toBe(true);
		await change(() => expect(store.pinResource(id)).toBe(true));
		expect(gridSizes()).toHaveLength(2);
		expect(store.hasSingleGridSlot()).toBe(false);
		expect(api.getPanel(id)).toBe(panel);
		expect(content(id)).toBe(node);
		expect(mounts.get(id)).toBe(1);
		expect(cleanups.get(id) ?? 0).toBe(0);
		expect(source.api.isVisible).toBe(true);
		expect(panel.group).not.toBe(source.group);
		expect(panel.group.api.location.type).toBe("grid");
		expect(panel.group.header.hidden).toBe(false);
		expect(panel.group.element.getBoundingClientRect().left).toBeGreaterThan(
			source.group.element.getBoundingClientRect().left,
		);
		expect(store.isTemporary(id)).toBe(false);
		expect(store.canPinResource(id)).toBe(false);
		expect(reveals).toBe(1);
	});

	test.each([
		"durable",
		"temporary",
	] as const)("mixed floating group with %s restores native tabs instead of hiding other members", async (kind) => {
		await mountWorkspace();
		await change(() => store.openToolPanel("n0", "terminal", null));
		const id = workspaceToolPanelId("n0", "terminal");
		const resource = requiredPanel(id);
		const group = resource.group;
		expect(group.header.hidden).toBe(true);
		if (kind === "temporary") await change(() => store.openFilePanel("n0", "/repo/mixed.ts"));
		const companion =
			kind === "durable"
				? requiredPanel("n0")
				: requiredPanel(workspaceFilePanelId("n0", "/repo/mixed.ts"));
		await change(() => companion.api.moveTo({ group, position: "center" }));
		expect(group.panels).toContain(resource);
		expect(group.panels).toContain(companion);
		expect(group.header.hidden).toBe(false);
		expect(store.isManagedPreview(id)).toBe(false);
		expect(group.element.classList.contains("workspace-resource-floating-group")).toBe(false);
		expect(
			api.toJSON().floatingGroups?.find((entry) => entry.data?.id === group.id)?.data?.hideHeader ??
				false,
		).toBe(false);
		if (kind === "durable") {
			const saved = serializedLayout();
			const savedGroup = saved.floatingGroups?.find((entry) => entry.data?.views.includes("n0"));
			expect(savedGroup?.data?.views).toEqual(["n0"]);
			expect(savedGroup?.data?.hideHeader ?? false).toBe(false);
			await change(() => api.fromJSON(saved));
			expect(requiredPanel("n0").group.header.hidden).toBe(false);
			expect(requiredPanel("n0").api.isVisible).toBe(true);
		}
	});

	test.each([
		"active",
		"pin",
		"close",
	] as const)("temporary capture/restore retains %s preview state without resurrecting hidden resources", async (action) => {
		await mountWorkspace();
		await change(() => {
			store.openToolPanel("n0", "terminal", null);
			store.openToolPanel("n0", "browser", null);
		});
		const a = workspaceToolPanelId("n0", "terminal");
		const b = workspaceToolPanelId("n0", "browser");
		expect(store.isActivePreview(a)).toBe(false);
		expect(store.isActivePreview(b)).toBe(true);
		if (action === "pin") await change(() => store.pinResource(b));
		else if (action === "close") await change(() => requiredPanel(b).api.close());
		const captured = store.captureTemporaryResources();
		expect(captured.filter((entry) => entry.wasActive).map((entry) => entry.id)).toEqual(
			action === "active" ? [b] : [],
		);
		const saved = serializedLayout();
		await change(() => api.fromJSON(saved));
		await change(() => store.restoreTemporaryResources(captured));
		expect(store.isActivePreview(a)).toBe(false);
		expect(store.isActivePreview(b)).toBe(action === "active");
		expect(
			requiredPanel(a)
				.group.element.closest(".dv-resize-container")
				?.classList.contains("workspace-resource-inactive-preview"),
		).toBe(true);
		const restored = requiredPanel(a);
		const restoredNode = content(a);
		await change(() => {
			if (action === "close") store.toggleToolPanel("n0", "terminal", null);
			else store.openToolPanel("n0", "terminal", null);
		});
		expect(requiredPanel(a)).toBe(restored);
		expect(content(a)).toBe(restoredNode);
		expect(store.isActivePreview(a)).toBe(true);
		expect(
			requiredPanel(a)
				.group.element.closest(".dv-resize-container")
				?.classList.contains("workspace-resource-inactive-preview"),
		).toBe(false);
	});

	test("native drag into a grid reconciles as pin without replacing the renderer", async () => {
		await mountWorkspace();
		await change(() => store.openKnowledgePanel("n0", "entry"));
		const id = workspaceKnowledgePanelId("n0", "entry");
		const panel = api.getPanel(id);
		const node = content(id);
		const before = gridSizes();
		await change(() => panel?.api.moveTo({ group: requiredPanel("n1").group, position: "center" }));
		expect(store.isTemporary(id)).toBe(false);
		expect(panel?.api.location.type).toBe("grid");
		expect(api.getPanel(id)).toBe(panel);
		expect(content(id)).toBe(node);
		expect(mounts.get(id)).toBe(1);
		expect(gridSizes()).toEqual(before);
		expect(reveals).toBeGreaterThan(0);
	});

	test("all resource identities are owner-scoped, including repeated plugin contributions", async () => {
		await mountWorkspace();
		const openOwner = (owner: string) => {
			store.openToolPanel(owner, "terminal", null);
			store.openFilePanel(owner, "/repo/shared.ts");
			store.openSubagentPanel(owner, "shared-child", "message");
			store.openKnowledgePanel(owner, "shared-entry");
			openPlugin(owner);
		};
		await change(() => {
			openOwner("n0");
			openOwner("n1");
		});
		expect(api.panels).toHaveLength(12);
		expect(store.getTemporaryPanelIds().size).toBe(10);
		expect(api.toJSON().floatingGroups).toHaveLength(10);
		expect(
			new Set(
				api.panels.filter((panel) => store.isTemporary(panel.id)).map((panel) => panel.group.id),
			).size,
		).toBe(10);
		const panels = [...api.panels];
		for (const owner of ["n0", "n1"]) {
			const owned = panels.filter(
				(panel) =>
					workspaceResourceOwner(panel.params as WorkspacePanelParams | undefined) === owner,
			);
			expect(owned).toHaveLength(5);
			expect(owned.map((panel) => panel.params?.panelType).sort()).toEqual([
				"file",
				"knowledge",
				"narrator-tool",
				"plugin",
				"subagent",
			]);
			for (const panel of owned) expect(panel.api.location.type).toBe("floating");
		}
		for (const panel of panels) expect(mounts.get(panel.id)).toBe(1);
		const pluginPanels = panels.filter((panel) => panel.params?.panelType === "plugin");
		expect(pluginPanels[0].id).not.toBe(pluginPanels[1].id);
		await change(() => {
			openOwner("n0");
			openOwner("n1");
		});
		expect(api.panels).toEqual(panels);
		for (const panel of panels) expect(mounts.get(panel.id)).toBe(1);
		for (const owner of ["n0", "n1"]) {
			await change(() => openPlugin(owner));
			expect(api.activePanel).toBe(
				pluginPanels.find(
					(panel) =>
						workspaceResourceOwner(panel.params as WorkspacePanelParams | undefined) === owner,
				),
			);
			expect(store.getSnapshot(owner).openToolTypes.has("terminal")).toBe(true);
		}
	});

	test("file identity distinguishes device, child narrator and tool execution without duplicating a repeat", async () => {
		await mountWorkspace();
		const filePath = "/repo/a.ts";
		const edit = { narratorId: "child", toolUseId: "tool", toolCallId: "row", executionAttempt: 1 };
		await change(() => {
			store.openFilePanel("n0", filePath);
			store.openFilePanel("n0", filePath, undefined, { deviceId: "remote" });
			store.openFilePanel("n0", filePath, undefined, { fileNarratorId: "child" });
			store.openFilePanel("n0", filePath, undefined, { toolEdit: edit });
		});
		const ids = [
			workspaceFilePanelId("n0", filePath),
			workspaceFilePanelId("n0", filePath, "remote"),
			workspaceFilePanelId("n0", filePath, "local", undefined, "child"),
			workspaceFilePanelId("n0", filePath, "local", edit),
		];
		expect(new Set(ids).size).toBe(4);
		for (const id of ids) expect(api.getPanel(id)?.params?.hostNarratorId).toBe("n0");
		const panel = api.getPanel(ids[0]);
		await change(() =>
			store.openFilePanel("n0", filePath, undefined, {
				fileNarratorId: "n0",
				referenceOrigin: true,
			}),
		);
		expect(api.activePanel).toBe(panel);
		expect(panel?.params?.referenceOrigin).toBe(true);
		await change(() => store.openFilePanel("n0", filePath));
		expect(panel?.params?.referenceOrigin).toBe(true);
		expect(api.panels).toHaveLength(6);
	});

	test("nested subagent navigation updates the existing panel and chooses the explicit source group", async () => {
		await mountWorkspace(3);
		await change(() => store.openSubagentPanel("n0", "child", "first-message"));
		const id = workspaceSubagentPanelId("n0", "child");
		const child = api.getPanel(id);
		const firstRequest = child?.params?.highlightRequestId;
		const node = content(id);
		await change(() => store.openSubagentPanel("n0", "child", "first-message"));
		expect(api.activePanel).toBe(child);
		expect(child?.params?.highlightMessageId).toBe("first-message");
		expect(child?.params?.highlightRequestId).not.toBe(firstRequest);
		await change(() => store.pinResource(id, requiredPanel("n1").group.id));
		await change(() =>
			store.openFilePanel("n0", "/repo/child.ts", undefined, {
				fileNarratorId: "child",
				sourcePanelId: id,
			}),
		);
		const fileId = workspaceFilePanelId("n0", "/repo/child.ts", "local", undefined, "child");
		expect(store.getPinTargets(fileId)[0].group).toBe(requiredPanel("n2").group);
		expect(store.getPinTargets(fileId).some((target) => target.group === child?.group)).toBe(false);
		await change(() => store.openSubagentPanel("n0", "grandchild", "nested-message"));
		expect(api.getPanel(workspaceSubagentPanelId("n0", "grandchild"))?.params).toMatchObject({
			hostNarratorId: "n0",
			subagentNarratorId: "grandchild",
			highlightMessageId: "nested-message",
		});
		await change(() => store.openSubagentPanel("n0", "child", "second-message"));
		expect(api.activePanel).toBe(child);
		expect(child?.params?.highlightMessageId).toBe("second-message");
		expect(content(id)).toBe(node);
		expect(mounts.get(id)).toBe(1);
		expect(api.getPanel("n0")?.api.isVisible).toBe(true);
	});

	test("a child already present as a root narrator receives message navigation without another panel", async () => {
		await mountWorkspace();
		const messages: string[] = [];
		const unregister = store.registerScrollToMessage("n1", (id) => messages.push(id));
		await change(() => store.openSubagentPanel("n0", "n1", "message"));
		expect(api.activePanel).toBe(api.getPanel("n1"));
		expect(api.panels).toHaveLength(2);
		expect(messages).toEqual(["message"]);
		expect(store.getTemporaryPanelIds().size).toBe(0);
		expect(reveals).toBeGreaterThan(0);
		await change(() => store.openSubagentPanel("n0", "n1", "message"));
		expect(messages).toEqual(["message", "message"]);
		unregister();
	});

	test("closing an owner removes floating and pinned orphans, not another owner's resources", async () => {
		await mountWorkspace();
		await change(() => {
			store.openToolPanel("n0", "terminal", null);
			store.openFilePanel("n0", "/repo/shared.ts");
			store.openSubagentPanel("n0", "child");
			store.openKnowledgePanel("n0", "entry");
			openPlugin("n0");
			store.openFilePanel("n1", "/repo/shared.ts");
			openPlugin("n1");
		});
		const orphanIds = api.panels
			.filter(
				(panel) =>
					workspaceResourceOwner(panel.params as WorkspacePanelParams | undefined) === "n0",
			)
			.map((panel) => panel.id);
		const retained = api.panels.filter(
			(panel) => workspaceResourceOwner(panel.params as WorkspacePanelParams | undefined) === "n1",
		);
		await change(() =>
			store.pinResource(
				workspaceFilePanelId("n0", "/repo/shared.ts"),
				requiredPanel("n1").group.id,
			),
		);
		await change(() => api.getPanel("n0")?.api.close());
		await change();
		for (const id of orphanIds) {
			expect(api.getPanel(id)).toBeUndefined();
			expect(store.isTemporary(id)).toBe(false);
			expect(cleanups.get(id)).toBe(1);
		}
		for (const panel of retained) {
			expect(api.getPanel(panel.id)).toBe(panel);
			expect(store.isTemporary(panel.id)).toBe(true);
			expect(mounts.get(panel.id)).toBe(1);
		}
		expect(store.getSnapshot("n0").openToolTypes.size).toBe(0);
		expect(api.panels).toHaveLength(3);
	});

	test("closing a temporary resource clears its registration and reopening creates only one new instance", async () => {
		await mountWorkspace();
		await change(() => store.openToolPanel("n0", "terminal", null));
		const id = workspaceToolPanelId("n0", "terminal");
		const original = api.getPanel(id);
		await change(() => store.closeToolPanel("n0", "terminal"));
		expect(api.getPanel(id)).toBeUndefined();
		expect(store.getTemporaryPanelIds().size).toBe(0);
		expect(store.captureTemporaryResources()).toEqual([]);
		expect(store.getSnapshot("n0").openToolTypes.size).toBe(0);
		expect(cleanups.get(id)).toBe(1);
		await change(() => store.openToolPanel("n0", "terminal", null));
		expect(api.getPanel(id)).not.toBe(original);
		expect(store.isTemporary(id)).toBe(true);
		expect(mounts.get(id)).toBe(2);
	});

	test("serialization excludes temporary resources, while pinned resources really restore through fromJSON", async () => {
		await mountWorkspace();
		await change(() =>
			store.openFilePanel("n0", "/repo/a.ts", undefined, { selection: selection(4) }),
		);
		const id = workspaceFilePanelId("n0", "/repo/a.ts");
		const temporaryLayout = serializedLayout();
		expect(temporaryLayout.panels[id]).toBeUndefined();
		expect(temporaryLayout.floatingGroups ?? []).toHaveLength(0);
		await change(() => api.fromJSON(temporaryLayout));
		expect(api.getPanel(id)).toBeUndefined();
		expect(api.panels).toHaveLength(2);
		expect(store.getTemporaryPanelIds().size).toBe(0);
		await change(() =>
			store.openFilePanel("n0", "/repo/a.ts", undefined, { selection: selection(4) }),
		);
		await change(() => expect(store.pinResource(id)).toBe(true));
		const pinnedLayout = serializedLayout();
		expect(pinnedLayout.panels[id].params).toMatchObject({
			panelType: "file",
			hostNarratorId: "n0",
			filePath: "/repo/a.ts",
		});
		expect(pinnedLayout.panels[id].params?.selection).toBeUndefined();
		expect(pinnedLayout.panels[id].params?.highlightRequestId).toBeUndefined();
		await change(() => api.fromJSON(pinnedLayout));
		expect(api.getPanel(id)?.api.location.type).toBe("grid");
		expect(api.getPanel(id)?.group).toBe(requiredPanel("n1").group);
		expect(api.panels).toHaveLength(3);
		expect(store.isTemporary(id)).toBe(false);
	});

	test("capture/restore preserves temporary metadata only for owners surviving an external rebuild", async () => {
		await mountWorkspace();
		await change(() => {
			store.openFilePanel("n0", "/repo/a.ts", "A", {
				fileNarratorId: "child",
				selection: selection(5),
			});
			store.openSubagentPanel("n0", "child", "message");
			openPlugin("n0");
			store.openKnowledgePanel("n1", "entry");
		});
		const captured = store.captureTemporaryResources();
		expect(captured).toHaveLength(4);
		await change(() => api.fromJSON(serializedLayout()));
		expect(store.getTemporaryPanelIds().size).toBe(0);
		await change(() => api.getPanel("n1")?.api.close());
		await change(() => store.restoreTemporaryResources(captured));
		expect(store.getTemporaryPanelIds().size).toBe(3);
		for (const resource of captured.filter((resource) => resource.origin.hostNarratorId === "n0")) {
			expect(api.getPanel(resource.id)?.params).toEqual(resource.params);
			expect(api.getPanel(resource.id)?.api.location.type).toBe("floating");
		}
		expect(api.getPanel(workspaceKnowledgePanelId("n1", "entry"))).toBeUndefined();
		expect(gridSizes()).toHaveLength(1);
	});

	test.each([
		"browser",
		"subagent",
	] as const)("Director %s opener uses its host, not the hidden grid's last pinned resource", async (kind) => {
		await mountWorkspace(3);
		await change(() => store.openFilePanel("n0", "/repo/pinned.ts"));
		const pinnedId = workspaceFilePanelId("n0", "/repo/pinned.ts");
		await change(() =>
			expect(store.pinResource(pinnedId, requiredPanel("n1").group.id)).toBe(true),
		);
		const pinned = requiredPanel(pinnedId);
		expect(api.activePanel).toBe(pinned);
		expect(pinned.group).toBe(requiredPanel("n1").group);
		await change(() => store.setDirectorActive(true));
		expect(api.activePanel).toBe(pinned);
		const before = gridSizes();
		await change(() => {
			if (kind === "browser") store.openToolPanel("n0", "browser", null);
			else store.openSubagentPanel("n0", "child");
		});
		const id =
			kind === "browser"
				? workspaceToolPanelId("n0", "browser")
				: workspaceSubagentPanelId("n0", "child");
		const targets = store.getPinTargets(id);
		expect(targets[0].group).toBe(requiredPanel("n1").group);
		expect(targets.some((target) => target.group === requiredPanel("n0").group)).toBe(false);
		expect(
			store.captureTemporaryResources().find((resource) => resource.id === id)?.origin
				.sourcePanelId,
		).toBe("n0");
		expect(requiredPanel(id).api.location.type).toBe("floating");
		expect(store.getDirectorActive()).toBe(true);
		expect(gridSizes()).toEqual(before);
	});

	test("explicit child source controls tool, nested session and knowledge pin targets", async () => {
		await mountWorkspace(3);
		await change(() => store.openSubagentPanel("n0", "child"));
		const childId = workspaceSubagentPanelId("n0", "child");
		await change(() => expect(store.pinResource(childId, requiredPanel("n1").group.id)).toBe(true));
		await change(() => store.setDirectorActive(true));
		await change(() => {
			store.openToolPanel("n0", "browser", null, childId);
			store.openSubagentPanel("n0", "grandchild", "message", childId);
			store.openKnowledgePanel("n0", "child-entry", "personal", childId);
		});
		const ids = [
			workspaceToolPanelId("n0", "browser"),
			workspaceSubagentPanelId("n0", "grandchild"),
			workspaceKnowledgePanelId("n0", "child-entry"),
		];
		for (const id of ids) {
			const targets = store.getPinTargets(id);
			expect(targets[0].group).toBe(requiredPanel("n2").group);
			expect(targets.some((target) => target.group === requiredPanel(childId).group)).toBe(false);
			expect(
				store.captureTemporaryResources().find((resource) => resource.id === id)?.origin
					.sourcePanelId,
			).toBe(childId);
			expect(workspaceResourceOwner(requiredPanel(id).params as WorkspacePanelParams)).toBe("n0");
		}
	});

	test.each([
		"default",
		"preferred-grid",
		"preferred-floating",
		"missing",
	] as const)("membership addition with %s position stays in the grid despite floating focus", async (preference) => {
		await mountWorkspace();
		await change(() => store.openToolPanel("n0", "browser", null));
		const temporaryId = workspaceToolPanelId("n0", "browser");
		const floating = requiredPanel(temporaryId);
		expect(api.activePanel).toBe(floating);
		const preferredGroupId =
			preference === "preferred-grid"
				? requiredPanel("n1").group.id
				: preference === "preferred-floating"
					? floating.group.id
					: preference === "missing"
						? "missing-group"
						: undefined;
		const before = gridSizes();
		await change(() =>
			api.addPanel({
				id: "n2",
				component: PANEL_COMPONENT.narrator,
				params: { panelType: "narrator", narratorId: "n2" },
				position: store.getMemberPosition(preferredGroupId),
			}),
		);
		const member = requiredPanel("n2");
		expect(member.api.location.type).toBe("grid");
		expect(member.group).toBe(requiredPanel(preference === "preferred-grid" ? "n1" : "n0").group);
		expect(gridSizes()).toEqual(before);
		expect(floating.group.panels).not.toContain(member);
		expect(store.isTemporary(temporaryId)).toBe(true);
		const saved = serializedLayout();
		expect(saved.panels.n2.params?.narratorId).toBe("n2");
		expect(saved.panels[temporaryId]).toBeUndefined();
		await change(() => api.fromJSON(saved));
		expect(requiredPanel("n2").api.location.type).toBe("grid");
		expect(api.panels).toHaveLength(3);
	});

	test("membership creates a durable grid when only floating groups remain", async () => {
		await mountWorkspace(1);
		await change(() => store.openFilePanel("n0", "/repo/a.ts"));
		const temporaryId = workspaceFilePanelId("n0", "/repo/a.ts");
		await change(() => api.addFloatingGroup(requiredPanel("n0")));
		await change(() => requiredPanel(temporaryId).api.setActive());
		expect(gridSizes()).toHaveLength(0);
		expect(api.groups.every((group) => group.api.location.type === "floating")).toBe(true);
		const temporary = requiredPanel(temporaryId);
		await change(() =>
			api.addPanel({
				id: "n2",
				component: PANEL_COMPONENT.narrator,
				params: { panelType: "narrator", narratorId: "n2" },
				position: store.getMemberPosition(temporary.group.id),
			}),
		);
		expect(requiredPanel("n2").api.location.type).toBe("grid");
		expect(gridSizes()).toHaveLength(1);
		expect(temporary.api.location.type).toBe("floating");
		expect(store.isTemporary(temporaryId)).toBe(true);
		const saved = serializedLayout();
		expect(saved.panels.n2.params?.narratorId).toBe("n2");
		expect(saved.panels[temporaryId]).toBeUndefined();
		await change(() => api.fromJSON(saved));
		expect(requiredPanel("n2").api.location.type).toBe("grid");
		expect(requiredPanel("n0").api.location.type).toBe("floating");
		expect(api.getPanel(temporaryId)).toBeUndefined();
		expect(gridSizes()).toHaveLength(1);
	});

	test("temporary opens, repeated focus, navigation and closes leave durable serialization byte-identical", async () => {
		await mountWorkspace(3);
		const durableActiveGroupId = api.activeGroup?.id;
		if (!durableActiveGroupId) throw new Error("expected initial durable focus");
		const save = () =>
			serializeWorkspaceLayout(
				api,
				DEFAULT_DIRECTOR_STATE,
				store.getTemporaryPanelIds(),
				durableActiveGroupId,
			);
		const initial = save();
		const before = gridSizes();
		const actions = [
			() => store.openToolPanel("n0", "browser", null),
			() => store.openSubagentPanel("n0", "child", "message"),
			() => store.openFilePanel("n0", "/repo/a.ts", undefined, { selection: selection(4) }),
			() => store.openKnowledgePanel("n0", "entry"),
			() => openPlugin("n0"),
			() => store.openSubagentPanel("n0", "child", "next-message"),
			() => store.openFilePanel("n0", "/repo/a.ts", undefined, { selection: selection(8) }),
			() => openPlugin("n0"),
		];
		for (const action of actions) {
			await change(action);
			expect(save()).toBe(initial);
			expect(gridSizes()).toEqual(before);
			expect(api.activeGroup?.api.location.type).toBe("floating");
		}
		expect(store.getTemporaryPanelIds().size).toBe(5);
		expect(reveals).toBe(0);
		for (const id of [...store.getTemporaryPanelIds()]) {
			await change(() => requiredPanel(id).api.close());
			expect(save()).toBe(initial);
		}
		expect(store.getTemporaryPanelIds().size).toBe(0);
		expect(JSON.parse(save()).layout.activeGroup).toBe(durableActiveGroupId);
	});

	test("production resource wrappers keep their leaf instances across Director changes and floating-to-grid pin", async () => {
		// Mock only query/transport-heavy leaves, NOT workspace adapters, ownership,
		// director gating, file-source navigation, provider hooks or Dockview.
		mock.module("../../../hooks/useNarrator", () => ({
			useNarrator: (id: string) => ({ data: { id, chapterId: null } }),
		}));
		mock.module("../NarratorPanel", () => ({ NarratorPanel: () => null }));
		mock.module("../browser/WebviewPanel", () => ({ WebviewPanel: () => null }));
		mock.module("../../plugins/PluginDockPanel", () => ({ PluginDockPanel: ResourceWrapper }));
		mock.module("../dock/panels", () => ({
			// This unit test only measures adapter/leaf lifetime. The browser suite
			// separately mounts the real ToolPanelShell/header/drag implementation.
			ToolPanelShell: ({ children }: { children: ReactNode }) => <>{children}</>,
			BrowserDockPanel: ResourceWrapper,
			DetailsDockPanel: ResourceWrapper,
			FileTreeDockPanel: ResourceWrapper,
			FileDockPanel: ResourceWrapper,
			GitDockPanel: ResourceWrapper,
			KnowledgeDockPanel: ResourceWrapper,
			SearchDockPanel: ResourceWrapper,
			SpecDockPanel: ResourceWrapper,
			TasksDockPanel: ResourceWrapper,
			TerminalDockPanel: ResourceWrapper,
			UserChatDockPanel: ResourceWrapper,
			SubagentSessionPanelContent: ({ subagentNarratorId }: { subagentNarratorId: string }) => {
				const panel = requiredPanel(workspaceSubagentPanelId("n0", subagentNarratorId));
				return <ResourceWrapper api={panel.api} containerApi={api} params={panel.params ?? {}} />;
			},
		}));
		const { workspacePanelComponents } = await import("./panels");
		await mountWorkspace(2, { ...workspacePanelComponents, narrator: ResourceWrapper });
		await change(() => {
			store.openToolPanel("n0", "terminal", null);
			store.openFilePanel("n0", "/repo/a.ts");
			store.openSubagentPanel("n0", "child");
			store.openKnowledgePanel("n0", "entry");
			openPlugin("n0");
		});
		const resources = api.panels.filter((panel) => store.isTemporary(panel.id));
		expect(resources).toHaveLength(5);
		const nodes = new Map(resources.map((panel) => [panel.id, content(panel.id)]));
		await change(() => store.setDirectorActive(true));
		for (const panel of resources) {
			expect(nodes.get(panel.id)).toBe(content(panel.id));
			expect(cleanups.get(panel.id) ?? 0).toBe(0);
		}
		const before = gridSizes();
		store.onRevealGrid = () => {
			reveals++;
			store.setDirectorActive(false);
		};
		for (const panel of resources) {
			await change(() => expect(store.pinResource(panel.id)).toBe(true));
			expect(api.getPanel(panel.id)).toBe(panel);
			expect(nodes.get(panel.id)).toBe(content(panel.id));
			expect(mounts.get(panel.id)).toBe(1);
			expect(cleanups.get(panel.id) ?? 0).toBe(0);
		}
		expect(store.getDirectorActive()).toBe(false);
		expect(gridSizes()).toEqual(before);
		expect(requiredPanel("n0").api.isVisible).toBe(true);
	});
});
