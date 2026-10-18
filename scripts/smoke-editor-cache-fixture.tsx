// Real Dockview + FilePanelContent/LargeFileGate + Monaco. Transport is the isolated real host.
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import {
	type DockviewApi,
	DockviewReact,
	type IDockviewPanelProps,
	type SerializedDockview,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import i18next from "i18next";
import type { editor } from "monaco-editor";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { editorDiskStateRegistry } from "../frontend/components/narrator/file-editor/editor-disk-state";
import { editorDocumentRegistry } from "../frontend/components/narrator/file-editor/editor-document-registry";
import { editorDraftScheduler } from "../frontend/components/narrator/file-editor/editor-draft-checkpoint";
import {
	editorDraftStore,
	editorDraftWriterId,
} from "../frontend/components/narrator/file-editor/editor-draft-store";
import { getEditorWorkerDiagnostics } from "../frontend/components/narrator/file-editor/editor-worker-client";
import { getEditorViewDiagnostics } from "../frontend/components/narrator/file-editor/MonacoEditor";
import { loadMonaco } from "../frontend/components/narrator/file-editor/monaco-loader";
import {
	FilePanelContent,
	type FilePanelContentProps,
} from "../frontend/components/narrator/file-panel/FilePanelContent";
import { NarratorPanelVisibilityProvider } from "../frontend/components/narrator/narrator-panel-visibility";
import { WorkspaceResourceFrame } from "../frontend/components/narrator/workspace/WorkspaceResourceFrame";
import { editorDocumentApi } from "../frontend/lib/api/editor-documents";
import translations from "../frontend/locales/en/narrator.json";

export async function runEditorCacheFixture(config: { path: string; narratorId: string }) {
	const monaco = await loadMonaco();
	const i18n = i18next.createInstance();
	await i18n.use(initReactI18next).init({
		lng: "en",
		resources: { en: { narrator: translations } },
		interpolation: { escapeValue: false },
	});
	let dock: DockviewApi | undefined;
	let setWorkspaceVisible: (visible: boolean) => void = () => {};
	const views = new Set<editor.IStandaloneCodeEditor>();
	let nextLifetime = 0;
	let nextNavigation = 0;
	const lifetimes = new WeakMap<editor.IStandaloneCodeEditor, number>();
	const subscription = monaco.editor.onDidCreateEditor((instance) => {
		const view = instance as editor.IStandaloneCodeEditor;
		views.add(view);
		lifetimes.set(view, ++nextLifetime);
		view.onDidDispose(() => views.delete(view));
	});
	function FilePane(
		props: IDockviewPanelProps<
			{ path: string; fixtureRevision?: number } & Pick<
				FilePanelContentProps,
				"selection" | "navigationRequestId"
			>
		>,
	) {
		return (
			<WorkspaceResourceFrame props={props}>
				<div data-cache-pane={props.api.id} style={{ height: "100%" }}>
					<FilePanelContent
						key={props.params.fixtureRevision ?? 0}
						rawProtocol={false}
						filePath={props.params.path}
						narratorId={config.narratorId}
						selection={props.params.selection}
						navigationRequestId={props.params.navigationRequestId}
						referenceOrigin
					/>
				</div>
			</WorkspaceResourceFrame>
		);
	}
	const panels: SerializedDockview["panels"] = {};
	const left: string[] = [],
		right: string[] = [];
	for (let index = 0; index < 1000; index++) {
		const id = `file-${index}`;
		const path =
			index < 2
				? config.path
				: config.path.replace(/[^/]+$/, index === 16 ? "cache-markdown.md" : `cache-${index}.txt`);
		panels[id] = { id, contentComponent: "file", title: id, params: { path } };
		(index % 2 === 0 ? left : right).push(id);
	}
	for (const side of ["left", "right"])
		panels[`blank-${side}`] = { id: `blank-${side}`, contentComponent: "blank", title: "Blank" };
	left.push("blank-left");
	right.push("blank-right");
	const layout = {
		grid: {
			root: {
				type: "branch",
				data: [
					{ type: "leaf", size: 600, data: { id: "left", views: left, activeView: "file-0" } },
					{ type: "leaf", size: 600, data: { id: "right", views: right, activeView: "file-1" } },
				],
			},
			width: 1200,
			height: 800,
			orientation: "HORIZONTAL",
		},
		panels,
		activeGroup: "left",
	} as SerializedDockview;
	function App() {
		const [visible, setVisible] = useState(true);
		setWorkspaceVisible = setVisible;
		return (
			<MantineProvider forceColorScheme="dark">
				<I18nextProvider i18n={i18n}>
					<NarratorPanelVisibilityProvider value={visible}>
						<div
							className="dockview-theme-dark"
							style={{ height: "100vh", display: visible ? "block" : "none" }}
						>
							<DockviewReact
								components={{ file: FilePane, blank: () => null }}
								defaultRenderer="always"
								onReady={({ api }) => {
									dock = api;
									api.fromJSON(layout);
								}}
							/>
						</div>
					</NarratorPanelVisibilityProvider>
				</I18nextProvider>
			</MantineProvider>
		);
	}
	const host = document.getElementById("root");
	if (!host) throw new Error("Missing cache fixture root");
	const root = createRoot(host);
	root.render(<App />);
	const viewFor = (id: string) => {
		const view = [...views].find(
			(entry) =>
				entry.getDomNode()?.closest<HTMLElement>("[data-cache-pane]")?.dataset.cachePane === id,
		);
		if (!view) throw new Error(`No real Monaco view: ${id}`);
		return view;
	};
	return {
		snapshot() {
			return {
				ready: !!dock,
				tabs: dock?.panels.filter((panel) => panel.id.startsWith("file-")).length ?? 0,
				registry: editorDocumentRegistry.diagnostics(),
				drafts: {
					...editorDraftStore.diagnostics,
					writerId: editorDraftWriterId,
					...editorDraftScheduler.diagnostics(),
				},
				...getEditorViewDiagnostics(),
				disk: { ...editorDiskStateRegistry.diagnostics, entries: editorDiskStateRegistry.size },
				monacoModels: monaco.editor.getModels().length,
				workers: getEditorWorkerDiagnostics(),
				panes: [...views].map((view) => ({
					id: view.getDomNode()?.closest<HTMLElement>("[data-cache-pane]")?.dataset.cachePane,
					lifetime: lifetimes.get(view),
					position: view.getPosition(),
					scroll: view.getScrollTop(),
					firstLine: view.getModel()?.getLineContent(1),
					active: dock?.getPanel(
						view.getDomNode()?.closest<HTMLElement>("[data-cache-pane]")?.dataset.cachePane ?? "",
					)?.api.isActive,
					visible: dock?.getPanel(
						view.getDomNode()?.closest<HTMLElement>("[data-cache-pane]")?.dataset.cachePane ?? "",
					)?.api.isVisible,
				})),
			};
		},
		async tryCheckpointCleanup() {
			const scope = await editorDocumentApi.recoveryScope(config.narratorId, {
				deviceId: "local",
				origin: "reference",
			});
			const row = (await editorDraftStore.list(scope.recoveryKey)).find(
				(row) => row.writerId === editorDraftWriterId,
			);
			if (!row) return { attempted: false, failed: false };
			try {
				await editorDraftStore.removeSaved(
					row.writerId,
					row.scope.resourceKey,
					row.revision,
					row.modelLifetime,
				);
				return { attempted: true, failed: false };
			} catch {
				return { attempted: true, failed: true };
			}
		},
		show(id: string) {
			dock?.getPanel(id)?.api.setActive();
		},
		reopen(id: string) {
			const panel = dock?.getPanel(id);
			if (!panel?.params) throw new Error(`Missing explicit reopen panel ${id}`);
			panel.api.updateParameters({
				...panel.params,
				fixtureRevision: (panel.params.fixtureRevision ?? 0) + 1,
			});
		},
		mode(id: string, value: string) {
			const input = document.querySelector<HTMLInputElement>(
				`[data-cache-pane="${id}"] input[value="${value}"]`,
			);
			if (!input) throw new Error(`Missing real mode control ${value}`);
			input.click();
		},
		workspaceVisible(value: boolean) {
			setWorkspaceVisible(value);
		},
		navigate(id: string, line: number) {
			const panel = dock?.getPanel(id);
			if (!panel) throw new Error(`Missing navigation panel ${id}`);
			panel.api.updateParameters({
				...panel.params,
				selection: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
				navigationRequestId: `fixture-navigation-${++nextNavigation}`,
			});
		},
		position(id: string, line: number, scroll: number) {
			const view = viewFor(id);
			view.setPosition({ lineNumber: line, column: 3 });
			view.setScrollTop(scroll);
		},
		edit(id: string, text: string) {
			const view = viewFor(id);
			view.pushUndoStop();
			view.executeEdits("fixture", [
				{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text },
			]);
			view.pushUndoStop();
		},
		undo(id: string) {
			viewFor(id).trigger("fixture", "undo", null);
		},
		canUndo(id: string) {
			const model = viewFor(id).getModel() as
				| (editor.ITextModel & { canUndo?: () => boolean })
				| null;
			return !!model?.canUndo?.();
		},
		paneState(id: string) {
			const view = viewFor(id);
			const pane = document.querySelector(`[data-cache-pane="${id}"]`);
			return {
				lifetime: lifetimes.get(view),
				text: view.getModel()?.getValue() ?? null,
				position: view.getPosition(),
				scroll: view.getScrollTop(),
				hint:
					pane?.querySelector<HTMLElement>("[data-editor-external-disk]")?.dataset
						.editorExternalDisk ?? null,
				readOnly: !!view.getOption(monaco.editor.EditorOption.readOnly),
				session: editorDiskStateRegistry.inspect(view.getModel()),
			};
		},
		redo(id: string) {
			viewFor(id).trigger("fixture", "redo", null);
		},
		focus(id: string) {
			viewFor(id).focus();
		},
		dispose() {
			root.unmount();
			subscription.dispose();
			editorDocumentRegistry.shutdown();
		},
	};
}

declare global {
	interface Window {
		__editorCache: Awaited<ReturnType<typeof runEditorCacheFixture>>;
	}
}
const response = await fetch("/api/fixture/config", { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`Cache fixture config: ${response.status}`);
window.__editorCache = await runEditorCacheFixture(await response.json());
