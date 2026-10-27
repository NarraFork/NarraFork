/**
 * The /windows/panel host: render one dock panel standalone in its own window.
 *
 * Panels render their CONTENT components directly here — never the dockview
 * adapters — because a window has no dock: `props.api`/`containerApi` would have
 * to be faked. Every adapter already resolves identity as
 * `dock?.narratorId ?? params.narratorId`, so the params carried in the window
 * descriptor are authoritative here (this module's renderers take them the same
 * way). Cross-panel bridges that only exist on a dock (chat ↔ terminal push,
 * details context, file-reference publication) degrade to absent, exactly as
 * they do for a subagent session rendered outside a dock.
 *
 * The window owns its own narrator WS connection: StandaloneWindowLayout does
 * not connect (read-only git windows don't need it) and the window is a separate
 * JS realm, so the module-level singleton is fresh and private to this window.
 */

import { Box, Center, Loader } from "@mantine/core";
import type { FileTarget } from "@shared/file-reference";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useNarrator } from "../../hooks/useNarrator";
import { lazyWithRetry } from "../../lib/lazy-with-retry";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import type { OutlinePanelState } from "../../lib/outline-panel";
import { FileReferenceScopeProvider } from "../narrator/composer/FileReferenceScope";
import { NarratorDockContext } from "../narrator/dock/NarratorDockContext";
import { SubagentSessionPanelContent } from "../narrator/dock/panels";
import { FilePanelContent } from "../narrator/file-panel/FilePanelContent";
import type { TerminalLeafConfig, WebviewLeafConfig } from "../narrator/split-tree";
import { OutlineHostProvider } from "../outline/outline-host";
import {
	type PluginUiSessionContext,
	PluginUiSurfaceProvider,
	usePluginUiSurface,
} from "../plugins/PluginUiSurfaceContext";
import type { PluginDockPanelParams } from "../plugins/protocol";
import { useStandaloneWindowTitle } from "../StandaloneWindowLayout";
import {
	normalizePanelWindowDescriptor,
	openPanelInWindow,
	type PanelWindowDescriptor,
	panelWindowTitle,
	pluginPanelWindowHostContext,
} from "./panel-window";

const NarratorPanel = lazyWithRetry(() =>
	import("../narrator/NarratorPanel").then((m) => ({ default: m.NarratorPanel })),
);
const NarratorTerminal = lazy(() =>
	import("../terminal/NarratorTerminal").then((m) => ({ default: m.NarratorTerminal })),
);
const WorkspaceTerminalPanel = lazy(() =>
	import("../terminal/WorkspaceTerminalPanel").then((m) => ({ default: m.WorkspaceTerminalPanel })),
);
const WebviewPanel = lazy(() =>
	import("../narrator/browser/WebviewPanel").then((m) => ({ default: m.WebviewPanel })),
);
const NarratorDetailsPanel = lazy(() =>
	import("../narrator/details/NarratorDetailsPanel").then((m) => ({
		default: m.NarratorDetailsPanel,
	})),
);
const SpecPanel = lazy(() =>
	import("../narrator/spec/SpecPanel").then((m) => ({ default: m.SpecPanel })),
);
const GitPanel = lazy(() => import("../git/GitPanel").then((m) => ({ default: m.GitPanel })));
const BackgroundTasksPanel = lazy(() =>
	import("../narrator/background/BackgroundTasksDrawer").then((m) => ({
		default: m.BackgroundTasksPanel,
	})),
);
const NarratorSearchPanel = lazy(() =>
	import("../narrator/NarratorSearchPanel").then((m) => ({ default: m.NarratorSearchPanel })),
);
const NarratorUserChatPanel = lazy(() =>
	import("../chat/NarratorUserChatPanel").then((m) => ({ default: m.NarratorUserChatPanel })),
);
const AppearancePanel = lazy(() =>
	import("../narrator/AppearancePanel").then((m) => ({ default: m.AppearancePanel })),
);
const FileTreePanel = lazy(() =>
	import("../narrator/file-tree/FileTreePanel").then((m) => ({ default: m.FileTreePanel })),
);
const KnowledgeEntryPanelContent = lazy(() =>
	import("../narrator/knowledge/KnowledgeEntryPanelContent").then((m) => ({
		default: m.KnowledgeEntryPanelContent,
	})),
);
const ToolEditFileViewer = lazy(() =>
	import("../narrator/tool-call/ToolEditFileViewer").then((m) => ({
		default: m.ToolEditFileViewer,
	})),
);
const PluginDockPanelView = lazy(() =>
	import("../plugins/PluginDockPanel").then((m) => ({ default: m.PluginDockPanelView })),
);
const OutlinePanelContent = lazy(() =>
	import("../outline/OutlinePanelContent").then((m) => ({ default: m.OutlinePanelContent })),
);

function PanelBoundary({ children }: { children: React.ReactNode }) {
	return (
		<Suspense
			fallback={
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			}
		>
			{children}
		</Suspense>
	);
}

const closeWindow = () => window.close();

/** The narrator whose title should name this window, per descriptor kind. */
function narratorIdOf(d: PanelWindowDescriptor): string | undefined {
	switch (d.panelType) {
		case "chat":
			return d.narratorId;
		case "subagent":
			return d.subagentNarratorId;
		case "terminal":
			return "narratorId" in d ? d.narratorId : d.terminalConfig.narratorId;
		case "narrator-tool":
			return d.narratorId;
		case "file":
			return d.fileNarratorId ?? d.hostNarratorId;
		case "knowledge":
			return d.hostNarratorId;
		default:
			return "narratorId" in d ? (d.narratorId as string | undefined) : undefined;
	}
}

function usePanelWindowTitle(descriptor: PanelWindowDescriptor): string {
	const narratorId = narratorIdOf(descriptor);
	const { data: narrator } = useNarrator(narratorId ?? "");
	// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator entity
	const live = ((narrator as any)?.title as string | undefined)?.trim();
	const base = panelWindowTitle(descriptor);
	if (!live) return base;
	if (descriptor.panelType === "chat" || descriptor.panelType === "subagent") return live;
	return `${base} · ${live}`;
}

export function StandalonePanelWindow({ descriptor }: { descriptor: PanelWindowDescriptor }) {
	useEffect(() => {
		narratorWSManager.connect();
		return () => narratorWSManager.disconnect();
	}, []);
	useStandaloneWindowTitle(usePanelWindowTitle(descriptor));
	return (
		<Box
			className="nf-panel-window"
			h="calc(100% - var(--nf-wco-strip-height, 0px))"
			style={{ minHeight: 0, overflow: "hidden" }}
		>
			<PanelBoundary>
				{/* A descriptor navigation owns fresh local params as well as a fresh host identity. */}
				<PanelContent key={JSON.stringify(descriptor)} descriptor={descriptor} />
			</PanelBoundary>
		</Box>
	);
}

function PanelContent({ descriptor }: { descriptor: PanelWindowDescriptor }) {
	const navigate = useNavigate();
	const openStandalonePage = useCallback(
		(narratorId: string) => {
			void navigate({ to: "/narrators/$narratorId", params: { narratorId } });
		},
		[navigate],
	);
	switch (descriptor.panelType) {
		case "chat":
			return <ChatWindow narratorId={descriptor.narratorId} />;
		case "subagent":
			return (
				<SubagentSessionPanelContent
					subagentNarratorId={descriptor.subagentNarratorId}
					compact={false}
					onClose={closeWindow}
					onOpenStandalonePage={openStandalonePage}
				/>
			);
		case "terminal":
			return "terminalConfig" in descriptor ? (
				<WorkspaceTerminalWindow config={descriptor.terminalConfig} />
			) : (
				<NarratorTerminal narratorId={descriptor.narratorId} onExit={closeWindow} />
			);
		case "webview":
			return <WebviewWindow initialConfig={descriptor.webviewConfig} />;
		case "narrator-tool":
			return (
				<NarratorToolWindow toolType={descriptor.toolType} narratorId={descriptor.narratorId} />
			);
		case "file":
			return <FileWindow descriptor={descriptor} />;
		case "knowledge":
			return (
				<KnowledgeEntryPanelContent
					entryId={descriptor.entryId}
					scope={descriptor.scope}
					onClose={closeWindow}
				/>
			);
		case "plugin":
			return <PluginWindow descriptor={descriptor} />;
		case "outline":
			return <OutlineWindow descriptor={descriptor} />;
		default:
			return <NarratorBoundWindow descriptor={descriptor} />;
	}
}

/** Whole-narrator window: the chat surface without a dock around it. */
function ChatWindow({ narratorId }: { narratorId: string }) {
	return (
		<NarratorDockContext.Provider value={null}>
			<PanelBoundary>
				<NarratorPanel key={narratorId} narratorId={narratorId} onClose={closeWindow} />
			</PanelBoundary>
		</NarratorDockContext.Provider>
	);
}

function WorkspaceTerminalWindow({ config }: { config: TerminalLeafConfig }) {
	return <WorkspaceTerminalPanel config={config} leafId="window-terminal" onClose={closeWindow} />;
}

function WebviewWindow({ initialConfig }: { initialConfig: WebviewLeafConfig }) {
	// Edits live in local state: the workspace row that would persist them is not
	// part of the descriptor (panelRowId is surface bookkeeping).
	const [config, setConfig] = useState(initialConfig);
	return (
		<WebviewPanel
			config={config}
			leafId="window-webview"
			onClose={closeWindow}
			onConfigChange={setConfig}
		/>
	);
}

/** The workspace's narrator-tool wrapper, resolved to the narrator-bound renderer. */
function NarratorToolWindow({ toolType, narratorId }: { toolType: string; narratorId: string }) {
	const d = normalizePanelWindowDescriptor({ panelType: toolType, narratorId });
	if (!d || !("narratorId" in d)) return null;
	return <NarratorBoundWindow descriptor={d} />;
}

/**
 * Singleton narrator-bound tool panels. These are the dock adapters' content
 * components with the dock bridges left absent — each already degrades that way
 * (`dock?.x` optional chaining).
 */
function NarratorBoundWindow({
	descriptor,
}: {
	descriptor: Extract<PanelWindowDescriptor, { narratorId: string }>;
}) {
	const { narratorId } = descriptor;
	switch (descriptor.panelType) {
		case "details":
			return <DetailsWindow narratorId={narratorId} />;
		case "spec":
			return <SpecPanel narratorId={narratorId} onClose={closeWindow} chromeless />;
		case "git":
			return <GitPanel narratorId={narratorId} />;
		case "browser":
			return <BrowserWindow narratorId={narratorId} />;
		case "tasks":
			return <BackgroundTasksPanel narratorId={narratorId} chromeless />;
		case "search":
			return <NarratorSearchPanel narratorId={narratorId} />;
		case "userchat":
			return <NarratorUserChatPanel narratorId={narratorId} />;
		case "appearance":
			return <AppearancePanel />;
		case "filetree":
			return <FileTreeWindow narratorId={narratorId} />;
		default:
			return null;
	}
}

function DetailsWindow({ narratorId }: { narratorId: string }) {
	const { data: narrator } = useNarrator(narratorId);
	if (!narrator)
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	return (
		// Viewers are a WS-subscription enrichment on the focus page; a window shows
		// the panel without the avatars row rather than not opening at all.
		<NarratorDetailsPanel
			opened
			onClose={closeWindow}
			narratorId={narratorId}
			// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator entity
			narrator={narrator as any}
			viewers={[]}
			displayMode="inline"
			chromeless
		/>
	);
}

function BrowserWindow({ narratorId }: { narratorId: string }) {
	return <BrowserPanelLazy narratorId={narratorId} chromeless />;
}

const BrowserPanelLazy = lazy(() =>
	import("../narrator/browser/BrowserPanel").then((m) => ({ default: m.BrowserPanel })),
);

function FileTreeWindow({ narratorId }: { narratorId: string }) {
	// A file opened from the tree gets its own window, recursively.
	const openFile = useCallback(
		(absolutePath: string, fileName: string) => {
			openPanelInWindow({
				panelType: "file",
				filePath: absolutePath,
				fileName,
				fileNarratorId: narratorId,
				deviceId: "local",
			});
		},
		[narratorId],
	);
	return <FileTreePanel narratorId={narratorId} onOpenFile={openFile} />;
}

/**
 * File viewer/editor window. The three-way branch mirrors FileDockPanel
 * (history viewer / editor / read-only preview), minus the dockview drag and
 * close guards — the window's own guard is `beforeunload` on a dirty editor.
 */
function FileWindow({
	descriptor,
}: {
	descriptor: Extract<PanelWindowDescriptor, { panelType: "file" }>;
}) {
	const { filePath, deviceId = "local", referenceOrigin, toolEdit } = descriptor;
	const fileNarratorId = descriptor.fileNarratorId ?? descriptor.hostNarratorId;
	const [dirty, setDirty] = useState(false);
	const [largeFileConfirmed, setLargeFileConfirmed] = useState(
		descriptor.largeFileConfirmed === true,
	);
	const confirmLargeFile = useCallback(() => {
		const confirmed = normalizePanelWindowDescriptor({ ...descriptor, largeFileConfirmed: true });
		if (!confirmed) return;
		const url = new URL(window.location.href);
		url.searchParams.set("d", JSON.stringify(confirmed));
		// Keep consent private to this window and survive reload without granting
		// another panel (or another file opened from a reference) permission.
		window.history.replaceState(window.history.state, "", url.toString());
		setLargeFileConfirmed(true);
	}, [descriptor]);
	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	// File references inside the viewer open further file windows; there is no
	// dock to receive a reference or a selection here.
	const scope = useMemo(
		() => ({
			narratorId: fileNarratorId,
			openFile: (target: FileTarget) => {
				openPanelInWindow({
					panelType: "file",
					filePath: target.path,
					deviceId: target.deviceId,
					fileNarratorId,
					referenceOrigin: true,
				});
			},
		}),
		[fileNarratorId],
	);

	return (
		<FileReferenceScopeProvider value={scope}>
			<PanelBoundary>
				{toolEdit ? (
					<ToolEditFileViewer key={filePath} reference={toolEdit} filePath={filePath} />
				) : (
					<FilePanelContent
						key={`${fileNarratorId}:${deviceId}:${filePath}`}
						filePath={filePath}
						narratorId={fileNarratorId}
						deviceId={deviceId}
						referenceOrigin={referenceOrigin}
						onDirtyChange={setDirty}
						confirmed={largeFileConfirmed}
						onConfirm={confirmLargeFile}
					/>
				)}
			</PanelBoundary>
		</FileReferenceScopeProvider>
	);
}

/**
 * Outline window: the panel's content, navigated in place. Each navigation replaces the
 * window's descriptor in its URL (no history entry), so a reload shows the same place; a
 * Ctrl/Cmd-click opens another window, and an agent commit's session opens in a chat window.
 */
function OutlineWindow({
	descriptor,
}: {
	descriptor: Extract<PanelWindowDescriptor, { panelType: "outline" }>;
}) {
	const [state, setState] = useState<OutlinePanelState>(() => {
		const { panelType: _panelType, ...initial } = descriptor;
		return initial;
	});
	const navigate = useCallback((next: OutlinePanelState) => {
		setState(next);
		const replaced = normalizePanelWindowDescriptor({ panelType: "outline", ...next });
		if (!replaced) return;
		try {
			const url = new URL(window.location.href);
			url.searchParams.set("d", JSON.stringify(replaced));
			window.history.replaceState(window.history.state, "", url.toString());
		} catch {
			// The place still shows; only a reload would lose it.
		}
	}, []);
	const openNew = useCallback(
		(next: OutlinePanelState) => openPanelInWindow({ panelType: "outline", ...next }),
		[],
	);
	const openSession = useCallback(
		(narratorId: string) => openPanelInWindow({ panelType: "chat", narratorId }),
		[],
	);
	return (
		<OutlineHostProvider openSession={openSession}>
			<PanelBoundary>
				<OutlinePanelContent state={state} onChange={navigate} onOpenNew={openNew} />
			</PanelBoundary>
		</OutlineHostProvider>
	);
}

/** Plugin contribution window: the dock-free hostApi the view layer supports. */
function PluginWindow({
	descriptor,
}: {
	descriptor: Extract<PanelWindowDescriptor, { panelType: "plugin" }>;
}) {
	// Parameters (viewState) persist to the dock layout on a real surface; a
	// window keeps them in state for the session instead.
	const [params, setParams] = useState<PluginDockPanelParams>(() => {
		const { hostContext: _hostContext, ...rawParams } = descriptor;
		return rawParams;
	});
	const hostContext = useMemo(() => pluginPanelWindowHostContext(descriptor), [descriptor]);
	const hostApi = useMemo(
		() => ({
			title: undefined,
			isActive: true,
			setTitle: () => {},
			updateParameters: (next: PluginDockPanelParams) => setParams(next),
			setActive: () => {},
			close: closeWindow,
		}),
		[],
	);
	const content = (
		<PanelBoundary>
			<PluginDockPanelView rawParams={params} hostApi={hostApi} />
		</PanelBoundary>
	);
	// A URL selects context; the backend still authorizes each real session.
	// Missing identities in legacy links must not be guessed from another host.
	return hostContext ? (
		<PluginUiSurfaceProvider hostContext={hostContext}>
			<FixedPluginWindowContext panelInstanceId={params.panelInstanceId} context={hostContext} />
			{content}
		</PluginUiSurfaceProvider>
	) : (
		content
	);
}

function FixedPluginWindowContext({
	panelInstanceId,
	context,
}: {
	panelInstanceId: string;
	context: PluginUiSessionContext;
}) {
	const surface = usePluginUiSurface();
	useLayoutEffect(() => {
		surface?.setSessionContext(panelInstanceId, context);
	}, [surface, panelInstanceId, context]);
	return null;
}
