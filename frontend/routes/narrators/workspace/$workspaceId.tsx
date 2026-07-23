import { ActionIcon, Box, Center, Group, Loader, Text, TextInput, Tooltip } from "@mantine/core";
import {
	IconArrowLeft,
	IconCheck,
	IconLayoutGrid,
	IconLayoutSidebarRight,
	IconPencil,
} from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebviewLeafConfig } from "../../../components/narrator/split-tree";
import { DirectorLayout } from "../../../components/narrator/workspace/DirectorLayout";
import {
	type DirectorControl,
	DockviewWorkspace,
} from "../../../components/narrator/workspace/DockviewWorkspace";
import {
	DEFAULT_DIRECTOR_PRIMARY_RATIO,
	type DirectorLeaf,
} from "../../../components/narrator/workspace/director-constants";
import type { WorkspaceDirectorState } from "../../../components/narrator/workspace/dockview-layout";
import type { PluginDockPanelParams } from "../../../components/plugins/protocol";
import {
	addRecentTab,
	addRecentTabsBatch,
	updateRecentTabLocal,
} from "../../../hooks/useRecentTabs";
import { useUpdateWorkspace, useWorkspace } from "../../../hooks/useWorkspace";
import { APP_SHELL_SAFE_VIEWPORT_HEIGHT } from "../../../lib/safe-area";

export const Route = createFileRoute("/narrators/workspace/$workspaceId")({
	component: () => {
		const { workspaceId } = Route.useParams();
		return <WorkspacePage key={workspaceId} />;
	},
});

function WorkspacePage() {
	const { workspaceId } = Route.useParams();
	const navigate = useNavigate();
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
		(hostNarratorId: string, subagentNarratorId: string) => {
			directorControlRef.current?.openSubagentPanel(hostNarratorId, subagentNarratorId);
			setDirectorMode(false);
		},
		[],
	);

	const handleClosePanel = useCallback((panelId: string) => {
		directorControlRef.current?.closePanel(panelId);
	}, []);

	const handleUpdateWebviewConfig = useCallback((panelId: string, config: WebviewLeafConfig) => {
		directorControlRef.current?.updatePanelParams(panelId, {
			panelType: "webview",
			webviewConfig: config,
		});
	}, []);

	const handleUpdatePluginParams = useCallback((panelId: string, params: PluginDockPanelParams) => {
		directorControlRef.current?.updatePanelParams(panelId, params);
	}, []);

	const handleSetPanelTitle = useCallback((panelId: string, title: string) => {
		directorControlRef.current?.updatePanelTitle(panelId, title);
	}, []);

	// ── Record recent tab ──
	useEffect(() => {
		if (!workspace) return;
		addRecentTab({
			type: "workspace",
			id: workspaceId,
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
			title: (workspace as any).title || "Workspace",
		});
	}, [workspaceId, workspace]);

	// ── Sync child narrator tabs' workspaceId when the panel set changes ──
	const prevNarratorIdsRef = useRef<Set<string>>(new Set());
	const handleNarratorIdsChange = useCallback(
		(ids: string[]) => {
			const currentIds = new Set(ids);
			const prevIds = prevNarratorIdsRef.current;
			const updates = [
				...[...currentIds]
					.filter((narratorId) => !prevIds.has(narratorId))
					.map((narratorId) => ({
						type: "narrator" as const,
						id: narratorId,
						title: "",
						workspaceId,
						updateOnly: true,
					})),
				...[...prevIds]
					.filter((narratorId) => !currentIds.has(narratorId))
					.map((narratorId) => ({
						type: "narrator" as const,
						id: narratorId,
						title: "",
						workspaceId: null,
						updateOnly: true,
					})),
			];
			if (updates.length > 0) void addRecentTabsBatch(updates).catch(() => {});
			prevNarratorIdsRef.current = currentIds;
			// Navigate away when the workspace becomes empty.
			if (ids.length === 0 && prevIds.size > 0) {
				navigate({ to: "/narrators" });
			}
		},
		[workspaceId, navigate],
	);

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	const serverUpdatedAt = (workspace as any)?.updatedAt as number | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	const treeJson = (workspace as any)?.tree as string | undefined;

	if (isLoading || !workspace) {
		return (
			<Box
				h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}
				mx="calc(var(--mantine-spacing-md) * -1)"
				my="calc(var(--mantine-spacing-md) * -1)"
			>
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			</Box>
		);
	}

	return (
		<Box
			h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
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
				{/* Keep Dockview mounted for its API and persisted layout, but remove it from
				    the visual and hit-test trees while DirectorLayout owns the surface. */}
				<Box
					aria-hidden={directorMode || undefined}
					style={{
						height: "100%",
						width: "100%",
						visibility: directorMode ? "hidden" : "visible",
						pointerEvents: directorMode ? "none" : undefined,
					}}
				>
					<DockviewWorkspace
						workspaceId={workspaceId}
						treeJson={treeJson}
						serverUpdatedAt={serverUpdatedAt}
						directorControlRef={directorControlRef}
						onNarratorIdsChange={handleNarratorIdsChange}
						onPanelsChange={handlePanelsChange}
						onDirectorStateChange={handleDirectorStateChange}
					/>
				</Box>
				{directorMode && (
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
				)}
			</Box>
		</Box>
	);
}
