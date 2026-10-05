/**
 * The workspace surface page body, shared by the in-app route
 * (`/narrators/workspace/$workspaceId`) and the standalone window
 * (`/windows/workspaces/$workspaceId`).
 *
 * `chrome` selects the surrounding assumptions:
 * - "app" (default): lives inside the AppShell Main — full-bleed height cancels
 *   Main's padding, and visits record a recent tab.
 * - "window": lives under StandaloneWindowLayout — height leaves room for the
 *   WCO drag strip, and visits do NOT pollute recency (the window is a mirror
 *   of the workspace, not a new visit to it).
 */

import { ActionIcon, Box, Center, Group, Loader, Text, TextInput, Tooltip } from "@mantine/core";
import type { WorkspacePanel } from "@shared/workspace-panels";
import {
	IconArrowLeft,
	IconCheck,
	IconLayoutGrid,
	IconLayoutSidebarRight,
	IconPencil,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	recordRecentTabVisit,
	refreshRecentTabsLoadedWindow,
	updateRecentTabLocal,
} from "../../../hooks/useRecentTabs";
import { useUpdateWorkspace, useWorkspace, workspaceQueryKey } from "../../../hooks/useWorkspace";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "../../../lib/safe-area";
import type { PluginDockPanelParams } from "../../plugins/protocol";
import type { WebviewLeafConfig } from "../split-tree";
import { DirectorLayout } from "./DirectorLayout";
import { type DirectorControl, DockviewWorkspace } from "./DockviewWorkspace";
import { DEFAULT_DIRECTOR_PRIMARY_RATIO, type DirectorLeaf } from "./director-constants";
import type { WorkspaceDirectorState } from "./dockview-layout";

/** Height below the WCO drag strip in a standalone window; 100% elsewhere. */
const WINDOW_CONTENT_HEIGHT = "calc(100% - var(--nf-wco-strip-height, 0px))";

/**
 * Stable empty membership for the pre-load render.
 *
 * A fresh `[]` each render would be a new prop identity every time, re-running the
 * surface's membership-sync effect on every unrelated re-render.
 */
const EMPTY_PANELS: WorkspacePanel[] = [];

export function WorkspacePage({
	workspaceId,
	chrome = "app",
}: {
	workspaceId: string;
	chrome?: "app" | "window";
}) {
	const qc = useQueryClient();
	const { t } = useTranslation("narrators");
	const { data: workspace, isLoading } = useWorkspace(workspaceId);
	const updateWorkspace = useUpdateWorkspace();
	const updateRef = useRef(updateWorkspace);
	updateRef.current = updateWorkspace;

	// ── Editable title ──
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	const serverTitle = (workspace as any)?.title as string | undefined;
	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState("");

	const startEditing = useCallback(() => {
		setEditTitle(serverTitle || "");
		setEditing(true);
	}, [serverTitle]);

	const commitTitle = useCallback(() => {
		setEditing(false);
		const trimmed = editTitle.trim();
		if (trimmed && trimmed !== serverTitle) {
			updateRef.current.mutate({ id: workspaceId, title: trimmed });
			updateRecentTabLocal("workspace", workspaceId, { title: trimmed });
		}
	}, [editTitle, serverTitle, workspaceId]);

	// ── Director mode ──
	// DockviewWorkspace owns the dockview api + persistence; director mode is a
	// pure overlay rendered here. We drive mutations through an imperative handle
	// and mirror the persisted director state locally for the overlay + toolbar.
	const directorControlRef = useRef<DirectorControl | null>(null);
	const [directorMode, setDirectorMode] = useState(false);
	const [directorLeaves, setDirectorLeaves] = useState<DirectorLeaf[]>([]);
	const [primaryPanelId, setPrimaryPanelId] = useState<string | null>(null);
	const [primaryRatio, setPrimaryRatio] = useState(DEFAULT_DIRECTOR_PRIMARY_RATIO);
	// Live ratio while dragging the divider (not yet persisted).
	const [ratioDraft, setRatioDraft] = useState<number | null>(null);

	const handleDirectorStateChange = useCallback((state: WorkspaceDirectorState) => {
		setDirectorMode(state.mode === "director");
		setPrimaryPanelId(state.primaryPanelId);
		setPrimaryRatio(state.primaryRatio);
	}, []);

	const handlePanelsChange = useCallback((leaves: DirectorLeaf[]) => {
		setDirectorLeaves(leaves);
	}, []);

	const setMode = useCallback((mode: "grid" | "director") => {
		directorControlRef.current?.setMode(mode);
		setDirectorMode(mode === "director");
	}, []);

	const handleActivate = useCallback((panelId: string) => {
		directorControlRef.current?.setPrimary(panelId);
		setPrimaryPanelId(panelId);
	}, []);

	const handlePreviewRatio = useCallback((ratio: number) => {
		setRatioDraft(ratio);
	}, []);

	const handleCommitRatio = useCallback((ratio: number) => {
		setRatioDraft(null);
		setPrimaryRatio(ratio);
		directorControlRef.current?.setRatio(ratio);
	}, []);

	const handleViewSubagentSession = useCallback(
		(hostNarratorId: string, subagentNarratorId: string, messageId?: string) => {
			directorControlRef.current?.openSubagentPanel(hostNarratorId, subagentNarratorId, messageId);
		},
		[],
	);

	const handleClosePanel = useCallback((panelId: string) => {
		directorControlRef.current?.closePanel(panelId);
	}, []);

	const handleUpdateWebviewConfig = useCallback((panelId: string, config: WebviewLeafConfig) => {
		// Delegated rather than rebuilt here: the surface owns keeping the panel's
		// `panelRowId` and persisting the config to its membership row.
		directorControlRef.current?.updateWebviewConfig(panelId, config);
	}, []);

	const handleUpdatePluginParams = useCallback((panelId: string, params: PluginDockPanelParams) => {
		directorControlRef.current?.updatePanelParams(panelId, params);
	}, []);

	const handleSetPanelTitle = useCallback((panelId: string, title: string) => {
		directorControlRef.current?.updatePanelTitle(panelId, title);
	}, []);

	// ── Record recent tab (app chrome only — a window mirrors the workspace) ──
	useEffect(() => {
		if (!workspace || chrome === "window") return;
		void recordRecentTabVisit({
			type: "workspace",
			id: workspaceId,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
			title: (workspace as any).title || "Workspace",
		});
	}, [workspaceId, workspace, chrome]);

	/**
	 * Re-read membership after the surface changed it (a panel was closed).
	 *
	 * Awaited by the caller so the surface is only considered converged once its
	 * authoritative input reflects the change. Also refreshes the sidebar window,
	 * because removing a narrator panel releases its tab back to the top level —
	 * server-side, in the same transaction.
	 */
	const handleMembershipChanged = useCallback(async () => {
		await qc.invalidateQueries({ queryKey: workspaceQueryKey(workspaceId) });
		void refreshRecentTabsLoadedWindow(qc).catch(() => {});
	}, [qc, workspaceId]);

	// The sidebar projection is NOT maintained here any more.
	//
	// This route used to diff the live narrator-id set against the previous one and
	// write `workspaceId` onto recent tabs accordingly. Two problems, both structural:
	// the initial "previous" set was empty, so the diff could only ever ATTACH and
	// never detach; and it made the client a second writer of membership, racing the
	// layout save. Both are gone — `workspace-panel-service` now writes the panel row
	// and its projection in one transaction.

	const treeJson = workspace?.layout ?? workspace?.tree;
	const panels = workspace?.panels ?? EMPTY_PANELS;
	const layoutRevision = workspace?.layoutRevision ?? 0;

	// In a window there is no AppShell Main padding to cancel; the height just
	// leaves room for the WCO drag strip (0px outside WCO).
	const shellBoxProps =
		chrome === "window"
			? { h: WINDOW_CONTENT_HEIGHT }
			: {
					h: APP_SHELL_FULL_BLEED_HEIGHT,
					mx: "calc(var(--mantine-spacing-md) * -1)",
					my: "calc(var(--mantine-spacing-md) * -1)",
				};

	if (isLoading || !workspace) {
		return (
			<Box {...shellBoxProps}>
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			</Box>
		);
	}

	return (
		<Box
			{...shellBoxProps}
			style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
		>
			{/* Toolbar with editable title */}
			<Group px="sm" py={4} gap="xs" style={{ flexShrink: 0 }}>
				<Tooltip label={t("listView")}>
					<ActionIcon size="sm" variant="subtle" component={Link} to="/narrators">
						<IconArrowLeft size={16} />
					</ActionIcon>
				</Tooltip>
				{editing ? (
					<TextInput
						size="xs"
						value={editTitle}
						onChange={(e) => setEditTitle(e.currentTarget.value)}
						onBlur={commitTitle}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitTitle();
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
						styles={{ input: { minWidth: 120 } }}
						rightSection={
							<ActionIcon size="xs" variant="subtle" onClick={commitTitle}>
								<IconCheck size={14} />
							</ActionIcon>
						}
					/>
				) : (
					<Group gap={4} style={{ cursor: "pointer" }} onClick={startEditing}>
						<Text size="sm" fw={500}>
							{serverTitle || "Workspace"}
						</Text>
						<IconPencil size={14} color="var(--mantine-color-dimmed)" />
					</Group>
				)}
				<Box style={{ flex: 1 }} />
				<Group gap={4}>
					<Tooltip label={t("workspaceSplitMode")}>
						<ActionIcon
							size="sm"
							variant={directorMode ? "subtle" : "light"}
							onClick={() => setMode("grid")}
						>
							<IconLayoutGrid size={16} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("workspaceDirectorMode")}>
						<ActionIcon
							size="sm"
							variant={directorMode ? "light" : "subtle"}
							onClick={() => setMode("director")}
						>
							<IconLayoutSidebarRight size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			<Box style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", position: "relative" }}>
				{/*
				 * An explicit empty state, rather than a blank surface.
				 *
				 * A workspace with no members is now a real, reachable state (the last panel
				 * was closed), and it used to render as an unexplained void. Deliberately does
				 * NOT navigate away on its own: creation persists the workspace before its
				 * first panel, so an automatic redirect would bounce the user out of a
				 * workspace that is about to receive one.
				 */}
				{panels.length === 0 && (
					<Center h="100%" style={{ flexDirection: "column", gap: 8 }}>
						<Text size="sm" c="dimmed">
							{t("workspaceEmpty")}
						</Text>
						<ActionIcon
							variant="light"
							size="lg"
							component={Link}
							to="/narrators"
							aria-label={t("listView")}
						>
							<IconArrowLeft size={18} />
						</ActionIcon>
					</Center>
				)}
				{/* Director shares the workspace provider and stacking surface with native
				    floating resources. Only the empty workspace hides the entire dock. */}
				<Box
					aria-hidden={panels.length === 0 || undefined}
					style={{
						height: "100%",
						width: "100%",
						visibility: panels.length === 0 ? "hidden" : "visible",
						pointerEvents: panels.length === 0 ? "none" : undefined,
					}}
				>
					<DockviewWorkspace
						workspaceId={workspaceId}
						panels={panels}
						treeJson={treeJson}
						layoutRevision={layoutRevision}
						directorControlRef={directorControlRef}
						onMembershipChanged={handleMembershipChanged}
						onPanelsChange={handlePanelsChange}
						onDirectorStateChange={handleDirectorStateChange}
						directorOverlay={
							directorMode ? (
								<DirectorLayout
									workspaceId={workspaceId}
									leaves={directorLeaves}
									primaryPanelId={primaryPanelId}
									primaryRatio={ratioDraft ?? primaryRatio}
									onActivate={handleActivate}
									onPreviewRatio={handlePreviewRatio}
									onCommitRatio={handleCommitRatio}
									onViewSubagentSession={handleViewSubagentSession}
									onClosePanel={handleClosePanel}
									onUpdateWebviewConfig={handleUpdateWebviewConfig}
									onUpdatePluginParams={handleUpdatePluginParams}
									onSetPanelTitle={handleSetPanelTitle}
								/>
							) : null
						}
					/>
				</Box>
			</Box>
		</Box>
	);
}
