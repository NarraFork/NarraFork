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
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNarrator } from "../../../hooks/useNarrator";
import { startPanelDrag } from "../../../lib/panel-drag";
import { NarratorPanel } from "../NarratorPanel";
import type { WebviewLeafConfig } from "../split-tree";
import { WebviewPanel } from "../WebviewPanel";
import {
	type NarratorPanelParams,
	PANEL_COMPONENT,
	type TerminalPanelParams,
	type WebviewPanelParams,
	type WorkspacePanelParams,
} from "./panel-types";

/**
 * Begin dragging an existing dockview panel via its own header bar. The
 * containing DockviewSurface listens on the panel-drag singleton, hit-tests
 * groups, and performs swap / merge / split on drop. `subjectId` falls back to
 * a synthetic marker for non-narrator panels so consumers can key off `panelId`.
 */
function usePanelHeaderDrag(
	props: IDockviewPanelProps<WorkspacePanelParams>,
	subjectId: string,
): (e: React.PointerEvent) => void {
	return useCallback(
		(e: React.PointerEvent) => {
			startPanelDrag({
				panelId: props.api.id,
				id: subjectId,
				title: props.api.title || subjectId,
				sourceGroupId: props.api.group?.id,
				x: e.clientX,
				y: e.clientY,
			});
		},
		[props.api, subjectId],
	);
}

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

/** Compact toolbar threshold — matches the legacy SplitPanelContainer value. */
const COMPACT_WIDTH_THRESHOLD = 640;

/** Observe panel width to decide whether to use compact toolbar. */
function usePanelCompact(): { ref: (el: HTMLDivElement | null) => void; compact: boolean } {
	const [compact, setCompact] = useState(true);
	const elRef = useRef<HTMLDivElement | null>(null);
	const roRef = useRef<ResizeObserver | null>(null);

	const ref = useCallback((el: HTMLDivElement | null) => {
		elRef.current = el;
		roRef.current?.disconnect();
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			setCompact(width < COMPACT_WIDTH_THRESHOLD);
		});
		ro.observe(el);
		roRef.current = ro;
	}, []);

	useEffect(() => () => roRef.current?.disconnect(), []);

	return { ref, compact };
}

/**
 * Narrator panel adapter. Maintains a local subagent view stack so opening a
 * subagent session stays inside this panel (mirrors the legacy leaf behavior),
 * and syncs the Dockview tab title with the narrator's title.
 */
function NarratorDockPanel(props: IDockviewPanelProps<NarratorPanelParams>) {
	const { narratorId } = props.params;
	const { ref, compact } = usePanelCompact();

	// Subagent view stack: last element is the currently-shown narrator id.
	const [subagentStack, setSubagentStack] = useState<string[]>([]);
	const currentNarratorId = subagentStack[subagentStack.length - 1] ?? narratorId;
	const isSubagentView = subagentStack.length > 0;

	const openSubagent = useCallback((subId: string) => {
		setSubagentStack((prev) => (prev[prev.length - 1] === subId ? prev : [...prev, subId]));
	}, []);
	const restoreParent = useCallback(() => {
		setSubagentStack((prev) => prev.slice(0, -1));
	}, []);

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

	return (
		<Box ref={ref} style={{ position: "relative", height: "100%", overflow: "hidden" }}>
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
		</Box>
	);
}

/** Terminal panel adapter. */
function TerminalDockPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
	const { terminalConfig } = props.params;
	const close = useCallback(() => props.api.close(), [props.api]);
	const onHeaderPointerDown = usePanelHeaderDrag(
		props as IDockviewPanelProps<WorkspacePanelParams>,
		"__terminal__",
	);

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
	const onHeaderPointerDown = usePanelHeaderDrag(
		props as IDockviewPanelProps<WorkspacePanelParams>,
		"__webview__",
	);

	const handleConfigChange = useCallback(
		(config: WebviewLeafConfig) => {
			props.api.updateParameters({ panelType: "webview", webviewConfig: config });
			if (config.title?.trim()) props.api.setTitle(config.title.trim());
		},
		[props.api],
	);

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
} satisfies Record<string, React.FunctionComponent<IDockviewPanelProps<never>>>;
