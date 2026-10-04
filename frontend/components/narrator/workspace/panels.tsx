/**
 * Dockview panel adapters for NarraFork workspace.
 *
 * Each adapter maps Dockview's `props.params` to an existing NarraFork panel
 * component (NarratorPanel / WorkspaceTerminalPanel / WebviewPanel). Dockview
 * owns the layout (split / tab / resize / close), so these adapters no longer
 * need the legacy split-tree callbacks — closing goes through `props.api.close()`
 * and layout mutations go through the containing DockviewApi.
 */

import { Box, Center, Text } from "@mantine/core";
import type { IDockviewPanelProps } from "dockview-react";
import { lazy, Suspense, useCallback, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import { api as apiClient } from "../../../lib/api";
import { PluginDockPanel } from "../../plugins/PluginDockPanel";
import { WebviewPanel } from "../browser/WebviewPanel";
import { NarratorDockContext } from "../dock/NarratorDockContext";
import {
	BrowserDockPanel as BrowserToolAdapter,
	DetailsDockPanel as DetailsToolAdapter,
	FileModDockPanel as FileModToolAdapter,
	FileTreeDockPanel as FileTreeToolAdapter,
	FileDockPanel as FileViewerAdapter,
	GitDockPanel as GitToolAdapter,
	KnowledgeDockPanel as KnowledgePanelAdapter,
	SearchDockPanel as SearchToolAdapter,
	SpecDockPanel as SpecToolAdapter,
	SubagentSessionPanelContent,
	TasksDockPanel as TasksToolAdapter,
	TerminalDockPanel as TerminalToolAdapter,
	ToolPanelShell,
	UserChatDockPanel as UserChatToolAdapter,
} from "../dock/panels";
import { useFilePanelSourceOpener } from "../file-panel/file-panel-navigation";
import { NarratorPanel } from "../NarratorPanel";
import { NarratorPanelVisibilityProvider } from "../narrator-panel-visibility";
import type {
	FilePanelParams,
	KnowledgePanelParams,
	NarratorBoundPanelParams,
} from "../panels/panel-kind";
import { usePanelCompact, usePanelGeometryReady, usePanelHeaderDrag } from "../panels/shared";
import type { WebviewLeafConfig } from "../split-tree";
import {
	type NarratorPanelParams,
	type NarratorToolPanelParams,
	PANEL_COMPONENT,
	type SubagentPanelParams,
	type TerminalPanelParams,
	type WebviewPanelParams,
	type WorkspaceFilePanelParams,
	type WorkspaceKnowledgePanelParams,
	type WorkspacePanelParams,
} from "./panel-types";
import { WorkspaceResourceFrame } from "./WorkspaceResourceFrame";
import {
	useWorkspaceDirectorActive,
	useWorkspaceId,
	useWorkspaceNarratorDockValue,
	workspaceResourceOwner,
} from "./workspace-dock";

export type {
	NarratorPanelParams,
	SubagentPanelParams,
	TerminalPanelParams,
	WebviewPanelParams,
	WorkspaceFilePanelParams,
	WorkspaceKnowledgePanelParams,
	WorkspacePanelParams,
	WorkspacePanelType,
} from "./panel-types";
export { PANEL_COMPONENT } from "./panel-types";

const WorkspaceTerminalPanel = lazy(() =>
	import("../../terminal/WorkspaceTerminalPanel").then((m) => ({
		default: m.WorkspaceTerminalPanel,
	})),
);

/** Narrator cell adapter. Child sessions use the shared temporary resource window. */
function NarratorDockPanel(props: IDockviewPanelProps<NarratorPanelParams>) {
	const { narratorId } = props.params;
	const { ref: compactRef, compact } = usePanelCompact();
	const { ref, geometryReady } = usePanelGeometryReady(compactRef);
	const directorActive = useWorkspaceDirectorActive();
	const [isActive, setIsActive] = useState(props.api.isActive);

	useLayoutEffect(() => {
		setIsActive(props.api.isActive);
		const disposable = props.api.onDidActiveChange(() => setIsActive(props.api.isActive));
		return () => disposable.dispose();
	}, [props.api]);
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(
		props as IDockviewPanelProps<WorkspacePanelParams>,
		narratorId,
	);
	const { data: narratorData } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	const narratorTitle = (narratorData as any)?.title as string | undefined;
	const dockValue = useWorkspaceNarratorDockValue(narratorId, props.api.id);

	useLayoutEffect(() => {
		const title = narratorTitle?.trim();
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [narratorTitle, props.api]);

	const content = (
		<Box ref={ref} style={{ height: "100%", overflow: "hidden" }}>
			{geometryReady && !directorActive && (
				<NarratorPanelVisibilityProvider value={isActive}>
					<NarratorPanel
						key={narratorId}
						narratorId={narratorId}
						compact={compact}
						onClose={close}
						onHeaderPointerDown={onHeaderPointerDown}
						onViewSubagentSession={dockValue?.openSubagentPanel}
					/>
				</NarratorPanelVisibilityProvider>
			)}
		</Box>
	);

	if (!dockValue) return content;
	return <NarratorDockContext.Provider value={dockValue}>{content}</NarratorDockContext.Provider>;
}

function SubagentDockPanel(props: IDockviewPanelProps<SubagentPanelParams>) {
	const { hostNarratorId, subagentNarratorId, highlightMessageId, highlightRequestId } =
		props.params;
	const { ref, compact } = usePanelCompact();
	const dockValue = useWorkspaceNarratorDockValue(hostNarratorId, props.api.id);
	const openFilePanel = useFilePanelSourceOpener(
		dockValue?.openFilePanel,
		props.api.id,
		subagentNarratorId,
	);
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(props, subagentNarratorId, "tool");
	const handleTitleChange = useCallback(
		(title: string) => {
			if (title !== props.api.title) props.api.setTitle(title);
		},
		[props.api],
	);

	return (
		<Box ref={ref} style={{ height: "100%", overflow: "hidden" }}>
			<SubagentSessionPanelContent
				subagentNarratorId={subagentNarratorId}
				compact={compact}
				onClose={close}
				onHeaderPointerDown={onHeaderPointerDown}
				onViewSubagentSession={dockValue?.openSubagentPanel}
				onOpenFilePanel={openFilePanel}
				onTitleChange={handleTitleChange}
				highlightMessageId={highlightMessageId}
				highlightRequestId={highlightRequestId}
			/>
		</Box>
	);
}

/**
 * Narrator-scoped tool panel adapter (terminal / details / filemod / spec /
 * git / browser). Reuses the focus dock's tool adapters verbatim — they read
 * `narratorId` / `chapterId` and published props from the dock context, so we
 * just provide a per-narrator context and delegate by `toolType`.
 */
function NarratorToolDockPanel(props: IDockviewPanelProps<NarratorToolPanelParams>) {
	const { toolType, narratorId } = props.params;
	const dockValue = useWorkspaceNarratorDockValue(narratorId, props.api.id);

	if (!dockValue) {
		return (
			<Center h="100%">
				<Text size="sm" c="dimmed">
					No workspace context
				</Text>
			</Center>
		);
	}

	// Adapt the narrator-tool params to the NarratorBoundPanelParams shape the
	// dock adapters expect. `toolType` (ResourcePanelKind) is a subset of the
	// dock's panel types, so it maps directly onto `panelType`. Building a real
	// params object (rather than a blanket `as unknown as`) keeps narratorId /
	// chapterId type-checked; only the IDockviewPanelProps wrapper is asserted,
	// since its api fields are identical across both param generics.
	const adaptedParams: NarratorBoundPanelParams = {
		panelType: toolType,
		narratorId,
		chapterId: props.params.chapterId,
	};
	const toolProps = {
		...props,
		params: adaptedParams,
	} as IDockviewPanelProps<NarratorBoundPanelParams>;

	let inner: React.ReactNode;
	switch (toolType) {
		case "terminal":
			inner = <TerminalToolAdapter {...toolProps} />;
			break;
		case "details":
			inner = <DetailsToolAdapter {...toolProps} />;
			break;
		case "filemod":
			inner = <FileModToolAdapter {...toolProps} />;
			break;
		case "spec":
			inner = <SpecToolAdapter {...toolProps} />;
			break;
		case "git":
			inner = <GitToolAdapter {...toolProps} />;
			break;
		case "browser":
			inner = <BrowserToolAdapter {...toolProps} />;
			break;
		case "tasks":
			inner = <TasksToolAdapter {...toolProps} />;
			break;
		case "search":
			inner = <SearchToolAdapter {...toolProps} />;
			break;
		case "userchat":
			inner = <UserChatToolAdapter {...toolProps} />;
			break;
		case "filetree":
			inner = <FileTreeToolAdapter {...toolProps} />;
			break;
		default:
			inner = null;
	}

	return <NarratorDockContext.Provider value={dockValue}>{inner}</NarratorDockContext.Provider>;
}

/** Terminal panel adapter. */
function TerminalDockPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
	const { t } = useTranslation("terminal");
	const { terminalConfig } = props.params;
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(props, "__terminal__", "tool");
	// Director overlay hosts the live terminal instance; avoid a second mount
	// (which would attach a duplicate xterm to the same backend terminal).
	const directorActive = useWorkspaceDirectorActive();

	// Sync Dockview tab title with localization
	useLayoutEffect(() => {
		const title = t("terminal");
		if (title && title !== props.api.title) {
			props.api.setTitle(title);
		}
	}, [t, props.api]);

	if (directorActive) return null;

	return (
		<Suspense fallback={null}>
			<WorkspaceTerminalPanel
				key={props.api.id}
				config={terminalConfig}
				leafId={props.api.id}
				onClose={close}
				onHeaderPointerDown={onHeaderPointerDown}
			/>
		</Suspense>
	);
}

/** Webview panel adapter. Persists config edits back onto the panel params. */
function WebviewDockPanel(props: IDockviewPanelProps<WebviewPanelParams>) {
	const { webviewConfig } = props.params;
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(props, "__webview__", "tool");
	// Director overlay hosts the live webview instance; avoid a second mount.
	const directorActive = useWorkspaceDirectorActive();

	const workspaceId = useWorkspaceId();

	const handleConfigChange = useCallback(
		(config: WebviewLeafConfig) => {
			// Spread the live params rather than rebuilding them: a fresh object drops
			// `panelRowId`, and without it this panel can no longer find the row that owns
			// its config — every later edit would be layout-only.
			props.api.updateParameters({ ...props.params, webviewConfig: config });
			if (config.title?.trim()) props.api.setTitle(config.title.trim());
			// The config is row state, not arrangement. Writing only the layout blob meant
			// the edit survived until the layout was discarded (a revision conflict, a
			// corrupt tree) and then silently reverted to the previous URL.
			const panelRowId = props.params.panelRowId;
			if (!workspaceId || !panelRowId) return;
			void apiClient
				.updateWorkspacePanelConfig(workspaceId, panelRowId, {
					panelType: "webview",
					webviewConfig: config,
				})
				.catch((error) => {
					console.warn("[workspace] failed to persist webview config", {
						workspaceId,
						panelRowId,
						error,
					});
				});
		},
		[props.api, props.params, workspaceId],
	);

	if (directorActive) return null;

	if (!webviewConfig) {
		return (
			<Center h="100%">
				<Text size="sm" c="dimmed">
					No webview configured
				</Text>
			</Center>
		);
	}

	return (
		<WebviewPanel
			key={props.api.id}
			config={webviewConfig}
			leafId={props.api.id}
			onClose={close}
			onHeaderPointerDown={onHeaderPointerDown}
			onConfigChange={handleConfigChange}
		/>
	);
}

/**
 * File viewer adapter. Delegates to the focus dock's `FileDockPanel` — it reads
 * file-operation identity from params, while the host context owns layout and
 * selection publication. Preserve both identities through the adapter.
 */
function WorkspaceFileDockPanel(props: IDockviewPanelProps<WorkspaceFilePanelParams>) {
	// Preserve the host bridge and resource identity, including device and navigation.
	const dockValue = useWorkspaceNarratorDockValue(props.params.hostNarratorId, props.api.id);

	const adaptedParams: FilePanelParams = { ...props.params, panelType: "file" };
	const fileProps = { ...props, params: adaptedParams } as IDockviewPanelProps<FilePanelParams>;
	return (
		<NarratorDockContext.Provider value={dockValue}>
			<FileViewerAdapter {...fileProps} />
		</NarratorDockContext.Provider>
	);
}

/**
 * Knowledge entry panel adapter. Delegates to the focus dock's
 * `KnowledgeDockPanel` — it reads identity from params (a resource), so the
 * only adaptation is dropping the workspace-only `hostNarratorId`.
 */
function WorkspaceKnowledgeDockPanel(props: IDockviewPanelProps<WorkspaceKnowledgePanelParams>) {
	const adaptedParams: KnowledgePanelParams = {
		panelType: "knowledge",
		entryId: props.params.entryId,
		scope: props.params.scope,
		hostNarratorId: props.params.hostNarratorId,
	};
	const knowledgeProps = {
		...props,
		params: adaptedParams,
	} as IDockviewPanelProps<KnowledgePanelParams>;
	return <KnowledgePanelAdapter {...knowledgeProps} />;
}

function WorkspacePluginDockPanel(props: Parameters<typeof PluginDockPanel>[0]) {
	const directorActive = useWorkspaceDirectorActive();
	const owner = workspaceResourceOwner(props.params);
	const [title, setTitle] = useState(props.api.title);
	useLayoutEffect(() => {
		const subscription = props.api.onDidTitleChange(({ title }) => setTitle(title));
		return () => subscription.dispose();
	}, [props.api]);
	// Surface-owned plugins still have a Director counterpart; resources do not.
	if (directorActive && !owner) return null;
	if (!owner) return <PluginDockPanel {...props} />;
	return (
		<ToolPanelShell
			props={props}
			subjectId={owner}
			title={title || props.params.fallback?.title || props.params.pluginId}
		>
			<PluginDockPanel {...props} />
		</ToolPanelShell>
	);
}

/** Stable wrappers preserve resource instances across floating and pinned locations. */
function withResourceFrame<P extends WorkspacePanelParams>(
	Panel: React.FunctionComponent<IDockviewPanelProps<P>>,
) {
	return function ResourcePanel(props: IDockviewPanelProps<P>) {
		return (
			<WorkspaceResourceFrame props={props}>
				<Panel {...props} />
			</WorkspaceResourceFrame>
		);
	};
}

/** Component registry passed to <DockviewReact components={...} />. */
export const workspacePanelComponents = {
	[PANEL_COMPONENT.narrator]: NarratorDockPanel,
	[PANEL_COMPONENT.terminal]: TerminalDockPanel,
	[PANEL_COMPONENT.webview]: WebviewDockPanel,
	[PANEL_COMPONENT.narratorTool]: withResourceFrame(NarratorToolDockPanel),
	[PANEL_COMPONENT.subagent]: withResourceFrame(SubagentDockPanel),
	[PANEL_COMPONENT.file]: withResourceFrame(WorkspaceFileDockPanel),
	[PANEL_COMPONENT.knowledge]: withResourceFrame(WorkspaceKnowledgeDockPanel),
	[PANEL_COMPONENT.plugin]: withResourceFrame(WorkspacePluginDockPanel),
	// biome-ignore lint/suspicious/noExplicitAny: dockview panel registry is heterogeneous
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>;
