import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react";
import { renderToString } from "react-dom/server";
import type { PanelDragState } from "../../../lib/panel-drag";
import type { DockviewSurfaceProps } from "../../dockview";
import { intentToDirection, intentToPosition } from "../../dockview/drop-intent";
import { fileDockPanelId } from "../../narrator/dock/dock-panel-types";
import {
	type NarratorDockContextValue,
	NarratorDockProvider,
} from "../../narrator/dock/NarratorDockContext";
import { type FilePanelParams, filePanelResourceId } from "../../narrator/panels/panel-kind";
import { type DetachedPanelEntry, makePanelEntry } from "./detached-panels";
import { __resetChapterDockRegistry, registerDetachedDock } from "./dock-registry";

let surface: DockviewSurfaceProps;
// Capture the public surface callbacks while leaving both production node docks
// and their narrator providers real. Editor content and layout transport are not
// needed to exercise moving and restoring file panels.
mock.module("../../dockview", () => ({
	DockviewSurface: (props: DockviewSurfaceProps) => {
		surface = props;
		return null;
	},
	intentToDirection,
	intentToPosition,
}));
mock.module("../../narrator/dock/panels", () => ({
	narratorDockComponents: {},
	narratorDockTabComponents: {},
}));
mock.module("../../../hooks/useChapterDockLayout", () => ({
	useChapterDockLayout: () => ({ layout: null, isReady: true, isError: false, save() {} }),
}));
mock.module("@xyflow/react", () => ({
	useStore: (select: (state: { transform: number[] }) => unknown) =>
		select({ transform: [0, 0, 1] }),
}));

const { ChapterNodeDock } = await import("./ChapterNodeDock");
const { DetachedNodeDock } = await import("./DetachedNodeDock");

afterAll(() => mock.restore());
afterEach(() => __resetChapterDockRegistry());

function fixtureApi(id: string) {
	const panels = new Map<string, IDockviewPanel>();
	const operations: string[] = [];
	let activePanel: IDockviewPanel | undefined;
	const api = {
		id,
		groups: [{ id: "group" }],
		get panels() {
			return [...panels.values()];
		},
		get activePanel() {
			return activePanel;
		},
		getPanel: (panelId: string) => panels.get(panelId),
		addPanel(options: { id: string; params: Record<string, unknown> }) {
			if (panels.has(options.id)) throw new Error(`Duplicate panel: ${options.id}`);
			operations.push("add");
			let currentParams = options.params;
			const panel = {
				id: options.id,
				get params() {
					return currentParams;
				},
				api: {
					close: () => {
						operations.push("close");
						panels.delete(options.id);
					},
					setActive: () => {
						operations.push("active");
						activePanel = panel;
					},
					moveTo: () => operations.push("move"),
					updateParameters: (params: Record<string, unknown>) => {
						operations.push("update");
						currentParams = { ...currentParams, ...params };
					},
				},
			} as unknown as IDockviewPanel;
			panels.set(options.id, panel);
			activePanel = panel;
			return panel;
		},
		toJSON: () =>
			({
				grid: {
					root: { type: "leaf", data: { views: [...panels.keys()], id: "group" } },
					height: 100,
					width: 100,
					orientation: "HORIZONTAL",
				},
				panels: Object.fromEntries(
					[...panels].map(([panelId, panel]) => [
						panelId,
						{ id: panelId, contentComponent: "file", params: panel.params },
					]),
				),
			}) as SerializedDockview,
		onDidLayoutChange: () => ({ dispose() {} }),
		onUnhandledDragOver: () => ({ dispose() {} }),
	} as unknown as DockviewApi;
	return { api, operations };
}

function renderSurface(kind: "chapter" | "detached", pendingPanels?: DetachedPanelEntry[]) {
	const dock =
		kind === "chapter" ? (
			<ChapterNodeDock chapterId="chapter" narratorId="target-host" />
		) : (
			<NarratorDockProvider narratorId="target-host" chapterId="chapter">
				<DetachedNodeDock
					nodeId="target-node"
					chapterId="chapter"
					narratorId="target-host"
					initialLayout={null}
					pendingPanels={pendingPanels}
					save={() => {}}
					onEmpty={() => {}}
				/>
			</NarratorDockProvider>
		);
	renderToString(<MantineProvider>{dock}</MantineProvider>);
	return surface;
}

function seedFile(
	api: DockviewApi,
	params: FilePanelParams,
	id = fileDockPanelId(params.filePath, params.deviceId, params.toolEdit, params.fileNarratorId),
) {
	return api.addPanel({ id, component: "file", params });
}

function registerSource(api: DockviewApi) {
	registerDetachedDock("source-node", "chapter", {
		narratorId: "source-host",
		apiRef: { current: api },
	} as NarratorDockContextValue);
}

function dragFile(panel: IDockviewPanel, readerFromHeader = false): PanelDragState {
	const params = panel.params as FilePanelParams;
	return {
		id: panel.id,
		panelId: panel.id,
		surfaceId: "source-node",
		title: "file",
		x: 0,
		y: 0,
		toolKind: "file",
		resourceId: filePanelResourceId(
			params.filePath,
			params.deviceId,
			params.referenceOrigin,
			params.toolEdit,
			params.fileNarratorId ??
				(readerFromHeader ? (params.toolEdit?.narratorId ?? "source-host") : undefined),
		),
		...(params.largeFileConfirmed ? { largeFileConfirmed: true } : {}),
	};
}

describe.each(["chapter", "detached"] as const)("%s file pointer transfers", (kind) => {
	test.each([
		["ordinary", "/repo/first.txt", "/repo/second.txt"],
		["colliding", "/repo/pending-a8981753.txt", "/repo/pending-c4d2a637.txt"],
	])("moves the %s file while retaining the target file", (_label, first, second) => {
		const { api: source } = fixtureApi("source-view");
		const { api: target } = fixtureApi("target-view");
		const retained = seedFile(target, {
			panelType: "file",
			filePath: first,
			fileNarratorId: "child",
		});
		const originalParams = retained.params;
		const moved = seedFile(source, {
			panelType: "file",
			filePath: second,
			fileNarratorId: "child",
		});
		registerSource(source);
		renderSurface(kind).onDropSubject?.(
			dragFile(moved),
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		expect(source.panels).toHaveLength(0);
		expect(target.panels).toHaveLength(2);
		expect(target.getPanel(retained.id)).toBe(retained);
		expect(retained.params === originalParams).toBe(true);
		expect(target.activePanel?.params).toMatchObject({ filePath: second, fileNarratorId: "child" });
	});

	test("reuses a suffixed target while preserving reference and loading consent", () => {
		const { api: source } = fixtureApi("source-view");
		const { api: target } = fixtureApi("target-view");
		const first = "/repo/pending-a8981753.txt";
		const second = "/repo/pending-c4d2a637.txt";
		const retained = seedFile(target, {
			panelType: "file",
			filePath: first,
			fileNarratorId: "child",
		});
		const existing = seedFile(
			target,
			{ panelType: "file", filePath: second, fileNarratorId: "child", referenceOrigin: true },
			`${retained.id}-7`,
		);
		const moved = seedFile(source, {
			panelType: "file",
			filePath: second,
			fileNarratorId: "child",
			largeFileConfirmed: true,
		});
		registerSource(source);
		renderSurface(kind).onDropSubject?.(
			dragFile(moved),
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		expect(source.panels).toHaveLength(0);
		expect(target.panels).toHaveLength(2);
		expect(target.activePanel).toBe(existing);
		expect(existing.params).toMatchObject({
			referenceOrigin: true,
			largeFileConfirmed: true,
			filePath: second,
		});
		expect(retained.params).not.toHaveProperty("largeFileConfirmed");
	});

	test("does not touch the target when a source close guard vetoes", () => {
		const { api: source } = fixtureApi("source-view");
		const { api: target, operations } = fixtureApi("target-view");
		const moved = seedFile(source, {
			panelType: "file",
			filePath: "/a.ts",
			fileNarratorId: "child",
			referenceOrigin: true,
		});
		moved.api.close = () => {};
		const retained = seedFile(target, {
			panelType: "file",
			filePath: "/a.ts",
			fileNarratorId: "child",
		});
		const originalParams = retained.params;
		operations.length = 0;
		registerSource(source);
		renderSurface(kind).onDropSubject?.(
			dragFile(moved),
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		expect(source.getPanel(moved.id)).toBe(moved);
		expect(operations).toEqual([]);
		expect(retained.params === originalParams).toBe(true);
	});

	test("rejects a resource that no longer matches the live source", () => {
		const { api: source, operations } = fixtureApi("source-view");
		const { api: target } = fixtureApi("target-view");
		const moved = seedFile(source, { panelType: "file", filePath: "/a.ts" });
		operations.length = 0;
		registerSource(source);
		renderSurface(kind).onDropSubject?.(
			{ ...dragFile(moved), resourceId: "/another.ts" },
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		expect(source.getPanel(moved.id)).toBe(moved);
		expect(operations).toEqual([]);
		expect(target.panels).toHaveLength(0);
	});

	test("rehosts an implicit header reader through the target context", () => {
		const { api: source } = fixtureApi("source-view");
		const { api: target } = fixtureApi("target-view");
		const retained = seedFile(target, {
			panelType: "file",
			filePath: "/a.ts",
			referenceOrigin: true,
		});
		const moved = seedFile(source, { panelType: "file", filePath: "/a.ts" });
		registerSource(source);
		renderSurface(kind).onDropSubject?.(
			dragFile(moved, true),
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		expect(source.panels).toHaveLength(0);
		expect(target.panels).toHaveLength(1);
		expect(target.activePanel).toBe(retained);
		expect(retained.params).not.toHaveProperty("fileNarratorId");
		expect(retained.params?.referenceOrigin).toBe(true);
	});

	test("keeps explicit child readers and historical references through the target context", () => {
		const { api: source } = fixtureApi("source-view");
		const { api: target } = fixtureApi("target-view");
		seedFile(target, { panelType: "file", filePath: "/a.ts" });
		const child = seedFile(source, {
			panelType: "file",
			filePath: "/a.ts",
			fileNarratorId: "child",
			referenceOrigin: true,
		});
		const toolEdit = { narratorId: "origin", toolUseId: "edit", executionAttempt: 2 };
		const history = seedFile(source, {
			panelType: "file",
			filePath: "/a.ts",
			toolEdit,
			fileNarratorId: "child",
			referenceOrigin: true,
		});
		registerSource(source);
		const callback = renderSurface(kind).onDropSubject;
		callback?.(
			dragFile(child, true),
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		callback?.(
			dragFile(history, true),
			{ groupId: "group", intent: "merge", targetPanelId: undefined },
			target,
		);
		expect(source.panels).toHaveLength(0);
		expect(target.panels).toHaveLength(3);
		expect(target.getPanel(child.id)?.params).toMatchObject({
			fileNarratorId: "child",
			referenceOrigin: true,
		});
		expect(target.getPanel(history.id)?.params).toMatchObject({
			fileNarratorId: "child",
			toolEdit,
			referenceOrigin: true,
		});
	});
});

describe("detached file pending mount", () => {
	test.each([
		["ordinary", "/repo/first.txt", "/repo/second.txt"],
		["colliding", "/repo/collide-1f7f9218.txt", "/repo/collide-08c374cf.txt"],
	])("restores both %s pending paths through the real onReady", (_label, first, second) => {
		const { api } = fixtureApi("target-view");
		renderSurface("detached", [
			makePanelEntry("file", first),
			makePanelEntry("file", second),
		]).onReady?.(api);
		expect(api.panels).toHaveLength(2);
		expect(api.panels.map((panel) => panel.params?.filePath)).toEqual([first, second]);
	});

	test("deduplicates implicit and explicit target readers only after their host is known", () => {
		const { api } = fixtureApi("target-view");
		renderSurface("detached", [
			makePanelEntry("file", "/a.ts"),
			makePanelEntry("file", filePanelResourceId("/a.ts", "local", true, undefined, "target-host")),
			makePanelEntry("file", filePanelResourceId("/a.ts", "local", true, undefined, "child")),
		]).onReady?.(api);
		expect(api.panels).toHaveLength(2);
		expect(api.panels[0].params?.referenceOrigin).toBe(true);
		expect(api.panels[1].params?.fileNarratorId).toBe("child");
	});
});
