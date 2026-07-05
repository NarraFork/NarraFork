import { ActionIcon, Box, Center, Group, Loader, Text, TextInput, Tooltip } from "@mantine/core";
import {
	IconArrowLeft,
	IconCheck,
	IconLayoutGrid,
	IconLayoutSidebarRight,
	IconPencil,
} from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DockviewWorkspace } from "../../../components/narrator/workspace/DockviewWorkspace";
import {
	applyDirectorMode,
	exitDirectorMode,
} from "../../../components/narrator/workspace/director";
import type { WorkspaceDirectorState } from "../../../components/narrator/workspace/dockview-layout";
import { addRecentTab, updateRecentTabLocal } from "../../../hooks/useRecentTabs";
import { useUpdateWorkspace, useWorkspace } from "../../../hooks/useWorkspace";

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

	// ── Dockview api + director mode ──
	const dockApiRef = useRef<DockviewApi | null>(null);
	const [directorMode, setDirectorMode] = useState(false);

	const handleApiReady = useCallback((api: DockviewApi) => {
		dockApiRef.current = api;
	}, []);

	const handleDirectorStateChange = useCallback((state: WorkspaceDirectorState) => {
		setDirectorMode(state.mode === "director");
	}, []);

	const setMode = useCallback((mode: "grid" | "director") => {
		const api = dockApiRef.current;
		if (!api) return;
		if (mode === "director") {
			applyDirectorMode(api, {
				mode: "director",
				primaryPanelId: api.activePanel?.id ?? null,
			});
			setDirectorMode(true);
		} else {
			exitDirectorMode(api);
			setDirectorMode(false);
		}
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
			for (const nId of currentIds) {
				if (!prevIds.has(nId)) {
					addRecentTab({ type: "narrator", id: nId, title: "", workspaceId, updateOnly: true });
				}
			}
			for (const nId of prevIds) {
				if (!currentIds.has(nId)) {
					addRecentTab({
						type: "narrator",
						id: nId,
						title: "",
						workspaceId: null,
						updateOnly: true,
					});
				}
			}
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
				h="calc(100dvh - 60px)"
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
			h="calc(100dvh - 60px)"
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

			<Box style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>
				<DockviewWorkspace
					workspaceId={workspaceId}
					treeJson={treeJson}
					serverUpdatedAt={serverUpdatedAt}
					onApiReady={handleApiReady}
					onNarratorIdsChange={handleNarratorIdsChange}
					onDirectorStateChange={handleDirectorStateChange}
				/>
			</Box>
		</Box>
	);
}
