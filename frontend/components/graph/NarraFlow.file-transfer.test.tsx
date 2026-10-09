import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Node, ReactFlowProps } from "@xyflow/react";
import type { DockviewApi } from "dockview-react";
import { parseHTML } from "linkedom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { startPanelDrag } from "../../lib/panel-drag";
import type { NarratorDockContextValue } from "../narrator/dock/NarratorDockContext";
import { filePanelResourceId } from "../narrator/panels/panel-kind";
import {
	__resetChapterDockRegistry,
	registerChapterDock,
	registerDetachedDock,
} from "./dock/dock-registry";

let transfer: { panelId: string; viewId?: string } | undefined;
let flowProps: ReactFlowProps;
const graphNodes: Node[] = [
	{
		id: "chapter",
		type: "chapterNode",
		position: { x: 0, y: 0 },
		data: { title: "chapter", narratorId: "chapter-host" },
	},
];
const persisted: Array<{ chapterId: string; json: string }> = [];

// Render the real canvas and its drop handlers. Replace graph drawing and remote
// data hooks; the live registry, detached-node mutations and persistence payloads
// stay on the production path.
mock.module("@xyflow/react", () => ({
	applyNodeChanges: (_changes: unknown, nodes: Node[]) => nodes,
	useReactFlow: () => ({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }), setViewport() {} }),
	ReactFlow: (props: ReactFlowProps) => {
		flowProps = props;
		useEffect(() => {
			props.onInit?.({ fitView() {}, screenToFlowPosition: (point: unknown) => point } as never);
		}, [props.onInit]);
		return <div data-testid="flow" />;
	},
	Background: () => null,
	Controls: () => null,
	ControlButton: () => null,
}));
mock.module("dockview-react", () => ({ getPanelData: () => transfer }));
mock.module("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
mock.module("@frontend/hooks/useNarraFlow", () => ({
	useNarraFlow: () => ({
		nodes: graphNodes,
		edges: [],
		detachedPanels: [],
		graphRuntimeStatus: { degraded: false },
		isLoading: false,
	}),
}));
mock.module("@frontend/hooks/useChapters", () => ({
	useUpdateChapter: () => ({}),
	useDeleteChapter: () => ({}),
}));
mock.module("@frontend/hooks/useGraphPositions", () => ({
	useUpdateGraphPositions: () => ({ savePosition() {}, savePanelState() {} }),
}));
mock.module("@frontend/hooks/useNarratorWS", () => ({ useNarratorsListWS() {} }));
mock.module("@frontend/hooks/usePlatform", () => ({
	useChapterBatchMergeCapability: () => ({ supported: false }),
	useFsRevealCapability: () => ({ supported: false }),
	useNarratorReviewToolsCapability: () => ({ supported: false }),
}));
mock.module("@frontend/hooks/useUserPreferences", () => ({
	useUserPreferences: () => ({ data: {} }),
}));
mock.module("@frontend/lib/api", () => ({
	api: {
		updateChapterDetachedPanels: async (chapterId: string, json: string) => {
			persisted.push({ chapterId, json });
		},
	},
}));
mock.module("@frontend/lib/narrator-ws-manager", () => ({ narratorWSManager: { send() {} } }));
mock.module("./ChapterNode", () => ({ ChapterNode: () => null, MIN_RESIZE_WIDTH: 480 }));
mock.module("./DraftNode", () => ({ DraftNode: () => null, DRAFT_NODE_WIDTH: 480 }));
mock.module("./dock/DetachedPanelNode", () => ({
	DetachedPanelNode: () => null,
	DETACHED_GRIP_CLASS: "grip",
}));
for (const component of [
	"CherryPickEdge",
	"ForkEdge",
	"MergeEdge",
	"ReviewEdge",
	"ReviewNode",
	"TerminalEdge",
	"LassoSelection",
	"SelectionToolbar",
	"NodeContextMenu",
]) {
	mock.module(`./${component}`, () => ({ [component]: () => null }));
}

const { NarraFlow } = await import("./NarraFlow");
let root: Root;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();
let elementPrototype: object;
let originalRectangle: PropertyDescriptor | undefined;

beforeEach(async () => {
	transfer = undefined;
	persisted.length = 0;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const media = (): {
		matches: boolean;
		addEventListener(): void;
		removeEventListener(): void;
	} => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	Object.assign(window, { matchMedia: media });
	elementPrototype = window.HTMLElement.prototype;
	originalRectangle = Object.getOwnPropertyDescriptor(elementPrototype, "getBoundingClientRect");
	window.HTMLElement.prototype.getBoundingClientRect = () => ({
		left: 0,
		top: 0,
		right: 1000,
		bottom: 800,
		width: 1000,
		height: 800,
		x: 0,
		y: 0,
		toJSON() {},
	});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		localStorage: { getItem: () => null },
		matchMedia: media,
		requestAnimationFrame: (): number => 0,
		cancelAnimationFrame() {},
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () => {
		root.render(
			<MantineProvider forceColorScheme="dark">
				<QueryClientProvider client={new QueryClient()}>
					<NarraFlow projectId="project" />
				</QueryClientProvider>
			</MantineProvider>,
		);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	__resetChapterDockRegistry();
	if (originalRectangle)
		Object.defineProperty(elementPrototype, "getBoundingClientRect", originalRectangle);
	else Reflect.deleteProperty(elementPrototype, "getBoundingClientRect");
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
afterAll(() => mock.restore());

function sourceDock(viewId: string, filePath: string, veto = false) {
	let open = true;
	const panel = {
		id: "shared-panel",
		params: { panelType: "file", filePath },
		api: {
			close: () => {
				if (!veto) open = false;
			},
		},
	};
	const api = {
		id: viewId,
		getPanel: (id: string) => (open && id === panel.id ? panel : undefined),
		get panels() {
			return open ? [panel] : [];
		},
	} as unknown as DockviewApi;
	return {
		panel,
		api,
		dock: { narratorId: "source-host", apiRef: { current: api } } as NarratorDockContextValue,
	};
}

async function dropNative(viewId?: string) {
	transfer = { panelId: "shared-panel", viewId };
	const event = new window.Event("drop", { bubbles: true, cancelable: true });
	Object.assign(event, { clientX: 100, clientY: 100 });
	await act(async () => {
		container.querySelector('[data-testid="flow"]')?.dispatchEvent(event);
	});
}

function detachedNodes() {
	return flowProps.nodes?.filter((node) => node.type === "detachedPanelNode") ?? [];
}

describe("canvas file transfer", () => {
	test("detaches an ordinary chapter tab through the native canvas callback", async () => {
		const source = sourceDock("source-view", "/ordinary.ts");
		registerChapterDock("chapter", source.dock);
		await dropNative(source.api.id);
		expect(source.api.getPanel(source.panel.id)).toBeUndefined();
		expect(detachedNodes()).toHaveLength(1);
		expect(detachedNodes()[0].data).toMatchObject({
			chapterId: "chapter",
			pendingPanels: [{ filePath: "/ordinary.ts" }],
		});
	});

	test("detaches only the requested surface when its panel id also exists in the chapter dock", async () => {
		const wrong = sourceDock("chapter-view", "/wrong.ts");
		const source = sourceDock("detached-view", "/requested.ts");
		registerChapterDock("chapter", wrong.dock);
		registerDetachedDock("source-node", "chapter", source.dock);
		await dropNative(source.api.id);
		expect(wrong.api.getPanel(wrong.panel.id)).toBe(wrong.panel as never);
		expect(source.api.getPanel(source.panel.id)).toBeUndefined();
		expect(detachedNodes()[0].data).toMatchObject({
			chapterId: "chapter",
			pendingPanels: [{ filePath: "/requested.ts" }],
		});
		expect(persisted[0].chapterId).toBe("chapter");
	});

	test("does not create or persist a canvas node when closing the source is vetoed", async () => {
		const source = sourceDock("source-view", "/a.ts", true);
		registerChapterDock("chapter", source.dock);
		await dropNative(source.api.id);
		expect(source.api.getPanel(source.panel.id)).toBe(source.panel as never);
		expect(detachedNodes()).toHaveLength(0);
		expect(persisted).toEqual([]);
	});

	test.each([
		undefined,
		"missing-view",
	])("rejects absent or wrong native view %s", async (viewId) => {
		const source = sourceDock("source-view", "/a.ts");
		registerChapterDock("chapter", source.dock);
		await dropNative(viewId);
		expect(source.api.getPanel(source.panel.id)).toBe(source.panel as never);
		expect(detachedNodes()).toHaveLength(0);
		expect(persisted).toEqual([]);
	});

	test.each([
		"chapter",
		"source-node",
	])("preserves implicit pointer authority and chapter ownership from %s", async (surfaceId) => {
		const source = sourceDock("source-view", "/a.ts");
		if (surfaceId === "chapter") registerChapterDock("chapter", source.dock);
		else registerDetachedDock(surfaceId, "chapter", source.dock);
		await act(async () => {
			startPanelDrag({
				id: source.panel.id,
				panelId: source.panel.id,
				surfaceId,
				subjectKind: "tool",
				toolKind: "file",
				title: "file",
				resourceId: filePanelResourceId("/a.ts", "local", false, undefined, "source-host"),
				x: 90,
				y: 90,
			});
			for (const type of ["pointermove", "pointerup"]) {
				const event = new window.Event(type, { bubbles: true });
				Object.assign(event, { clientX: 100, clientY: 100 });
				document.dispatchEvent(event);
			}
		});
		expect(source.api.getPanel(source.panel.id)).toBeUndefined();
		expect(detachedNodes()).toHaveLength(1);
		expect(detachedNodes()[0].data.chapterId).toBe("chapter");
		const entries = detachedNodes()[0].data.pendingPanels as Array<{ fileNarratorId?: string }>;
		expect(entries[0]).not.toHaveProperty("fileNarratorId");
	});
});
