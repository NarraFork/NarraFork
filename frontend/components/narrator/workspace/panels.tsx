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
import { lazy, Suspense, useCallback, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import type { NarratorDockPanelParams } from "../dock/dock-panel-types";
import { NarratorDockContext } from "../dock/NarratorDockContext";
import {
	BrowserDockPanel as BrowserToolAdapter,
	DetailsDockPanel as DetailsToolAdapter,
	FileModDockPanel as FileModToolAdapter,
	GitDockPanel as GitToolAdapter,
	SpecDockPanel as SpecToolAdapter,
	TasksDockPanel as TasksToolAdapter,
	TerminalDockPanel as TerminalToolAdapter,
} from "../dock/panels";
import { NarratorPanel } from "../NarratorPanel";
import { usePanelCompact, usePanelHeaderDrag, useSubagentStack } from "../panels/shared";
import type { WebviewLeafConfig } from "../split-tree";
import { WebviewPanel } from "../WebviewPanel";
import {
	type NarratorPanelParams,
	type NarratorToolPanelParams,
	PANEL_COMPONENT,
	type TerminalPanelParams,
	type WebviewPanelParams,
	type WorkspacePanelParams,
} from "./panel-types";
import { useWorkspaceDirectorActive, useWorkspaceNarratorDockValue } from "./workspace-dock";

export type {
	NarratorPanelParams,
	TerminalPanelParams,
	WebviewPanelParams,
	WorkspacePanelParams,
	WorkspacePanelType,
} from "./panel-types";
export { PANEL_COMPONENT } from "./panel-types";

const WorkspaceTerminalPanel = lazy(() =>
	import("../../terminal/WorkspaceTerminalPanel").then((m) => ({
		default: m.WorkspaceTerminalPanel,
	})),
);

/**
 * Narrator panel adapter. Maintains a local subagent view stack so opening a
 * subagent session stays inside this panel (mirrors the legacy leaf behavior),
 * and syncs the Dockview tab title with the narrator's title.
 */
function NarratorDockPanel(props: IDockviewPanelProps<NarratorPanelParams>) {
	const { narratorId } = props.params;
	const { ref, compact } = usePanelCompact();

	// While director mode is active, DirectorLayout hosts the live NarratorPanel
	// instance for this narrator. Rendering it here too would mount a second copy
	// (double WS subscription / duplicate streaming state), so suspend our content.
	const directorActive = useWorkspaceDirectorActive();

	// Subagent view stack: opening a subagent stays inside this panel.
	const { currentNarratorId, isSubagentView, openSubagent, restoreParent } =
		useSubagentStack(narratorId);

	const close = useCallback(() => {
		props.api.close();
	}, [props.api]);

	const onHeaderPointerDown = usePanelHeaderDrag(
		props as IDockviewPanelProps<WorkspacePanelParams>,
		narratorId,
	);

	// Sync Dockview tab title with the currently-shown narrator's title.
	const { data: narratorData } = useNarrator(currentNarratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON entity
	const narratorTitle = (narratorData as any)?.title as string | undefined;
	useLayoutEffect(() => {
		const title = narratorTitle?.trim();
		if (title && title !== props.api.title) props.api.setTitle(title);
	}, [narratorTitle, props.api]);

	// Bind a per-narrator dock context so this cell's chat behaves like the
	// focus page: tool buttons (terminal / details / spec / git / …) appear and
	// open as dockview sibling tabs scoped to this narrator.
	const dockValue = useWorkspaceNarratorDockValue(narratorId);

	// director-active: keep the mounted host box (so dockview sizing/DnD still
	// works) but render no NarratorPanel — the overlay owns the live instance.
	const content = (
		<Box ref={ref} style={{ position: "relative", height: "100%", overflow: "hidden" }}>
			{!directorActive && (
				<>
					{/* Base narrator (hidden while viewing a subagent) */}
					<Box
						style={{
							position: "absolute",
							inset: 0,
							visibility: isSubagentView ? "hidden" : "visible",
						}}
					>
						<NarratorPanel
							key={narratorId}
							narratorId={narratorId}
							compact={compact}
							onClose={close}
							onHeaderPointerDown={onHeaderPointerDown}
							onViewSubagentSession={openSubagent}
						/>
					</Box>
					{isSubagentView && (
						<Box style={{ position: "absolute", inset: 0 }}>
							<NarratorPanel
								key={currentNarratorId}
								narratorId={currentNarratorId}
								compact={compact}
								onClose={close}
								onBack={restoreParent}
								onHeaderPointerDown={onHeaderPointerDown}
								onViewSubagentSession={openSubagent}
							/>
						</Box>
					)}
				</>
			)}
		</Box>
	);

	// Outside a WorkspaceDockProvider (defensive) fall back to bare rendering.
	if (!dockValue) return content;
	return <NarratorDockContext.Provider value={dockValue}>{content}</NarratorDockContext.Provider>;
}

/**
 * Narrator-scoped tool panel adapter (terminal / details / filemod / spec /
 * git / browser). Reuses the focus dock's tool adapters verbatim — they read
 * `narratorId` / `chapterId` and published props from the dock context, so we
 * just provide a per-narrator context and delegate by `toolType`.
 */
function NarratorToolDockPanel(props: IDockviewPanelProps<NarratorToolPanelParams>) {
	const { toolType, narratorId } = props.params;
	const dockValue = useWorkspaceNarratorDockValue(narratorId);

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
	const adaptedParams: NarratorDockPanelParams = {
		panelType: toolType,
		narratorId,
		chapterId: props.params.chapterId,
	};
	const toolProps = {
		...props,
		params: adaptedParams,
	} as IDockviewPanelProps<NarratorDockPanelParams>;

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

	const handleConfigChange = useCallback(
		(config: WebviewLeafConfig) => {
			props.api.updateParameters({ panelType: "webview", webviewConfig: config });
			if (config.title?.trim()) props.api.setTitle(config.title.trim());
		},
		[props.api],
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

/** Component registry passed to <DockviewReact components={...} />. */
export const workspacePanelComponents = {
	[PANEL_COMPONENT.narrator]: NarratorDockPanel,
	[PANEL_COMPONENT.terminal]: TerminalDockPanel,
	[PANEL_COMPONENT.webview]: WebviewDockPanel,
	[PANEL_COMPONENT.narratorTool]: NarratorToolDockPanel,
	// biome-ignore lint/suspicious/noExplicitAny: dockview panel registry is heterogeneous
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>;
