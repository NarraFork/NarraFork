import {
	applyNodeChanges,
	Background,
	Controls,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type OnConnect,
	ReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";
import { useCreateChapterEdge } from "@frontend/hooks/useChapterEdges";
import { useDeleteChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import { useUpdateGraphPositions } from "@frontend/hooks/useGraphPositions";
import { useRecentTabs } from "@frontend/hooks/useRecentTabs";
import type { GraphNode } from "@frontend/hooks/useStoryGraph";
import { assignEdgeHandles, useStoryGraph } from "@frontend/hooks/useStoryGraph";
import { api } from "@frontend/lib/api";
import { Box, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChapterNode } from "./ChapterNode";
import { CherryPickEdge } from "./CherryPickEdge";
import { DependencyEdge } from "./DependencyEdge";
import { ForkEdge } from "./ForkEdge";
import { GraphSidePanel } from "./GraphSidePanel";
import { MergeEdge } from "./MergeEdge";
import { NodeContextMenu } from "./NodeContextMenu";

const nodeTypes = { chapterNode: ChapterNode };
const edgeTypes = {
	fork: ForkEdge,
	merge: MergeEdge,
	dependency: DependencyEdge,
	cherry_pick: CherryPickEdge,
};

interface SelectedNodeData {
	id: string;
	title: string;
	status: string;
	role: string;
	branch: string;
	narratorCount: number;
	hasContainers: boolean;
	hasUpstreamUpdates: boolean;
	commitCount?: number;
	headCommitSha?: string | null;
}

interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string;
	nodeData: { title: string; status: string; role: string; isRoot?: boolean };
}

interface StoryNetworkProps {
	projectId: string;
}

export function StoryNetwork({ projectId }: StoryNetworkProps) {
	const { t } = useTranslation("graph");
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { nodes: graphNodes, edges, isLoading, error } = useStoryGraph(projectId);
	const { savePosition } = useUpdateGraphPositions(projectId);
	const createEdge = useCreateChapterEdge();
	const updateChapter = useUpdateChapter();

	const dormantMutation = useMutation({
		mutationFn: (id: string) => api.dormantChapter(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storyGraph"] }),
	});

	const wakeMutation = useMutation({
		mutationFn: (id: string) => api.wakeChapter(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storyGraph"] }),
	});

	const unmergeMutation = useMutation({
		mutationFn: (id: string) => api.unmergeChapter(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storyGraph"] }),
	});

	const deleteChapter = useDeleteChapter();
	const { removeTab } = useRecentTabs();

	const [selectedNode, setSelectedNode] = useState<SelectedNodeData | null>(null);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
	const [nodes, setNodes] = useState<Node[]>([]);

	// Recompute edge handles whenever local node positions change
	const computedEdges = useMemo(
		() => assignEdgeHandles(nodes as GraphNode[], edges),
		[nodes, edges],
	);

	// Sync local nodes state when upstream graph data changes
	useEffect(() => {
		setNodes(graphNodes as Node[]);
	}, [graphNodes]);

	const onNodesChange = useCallback((changes: NodeChange[]) => {
		setNodes((nds) => applyNodeChanges(changes, nds));
	}, []);

	const onNodeDragStop: NodeMouseHandler = useCallback(
		(_event, node) => {
			savePosition(node.id, node.position.x, node.position.y);
		},
		[savePosition],
	);

	const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
		// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
		const d = node.data as any;
		setSelectedNode({
			id: node.id,
			title: d.title ?? d.label ?? "",
			status: d.status ?? "",
			role: d.role ?? "branch",
			branch: d.branch ?? "",
			narratorCount: d.narratorCount ?? 0,
			hasContainers: d.hasContainers ?? false,
			hasUpstreamUpdates: d.hasUpstreamUpdates ?? false,
			commitCount: d.commitCount ?? 0,
			headCommitSha: d.headCommitSha ?? null,
		});
	}, []);

	const onNodeDoubleClick: NodeMouseHandler = useCallback(
		(_event, node) => {
			navigate({ to: "/chapters/$chapterId", params: { chapterId: node.id } });
		},
		[navigate],
	);

	const onNodeContextMenu: NodeMouseHandler = useCallback((event, node) => {
		event.preventDefault();
		// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
		const d = node.data as any;
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			nodeId: node.id,
			nodeData: {
				title: d.title ?? d.label ?? "",
				status: d.status ?? "",
				role: d.role ?? "branch",
				isRoot: d.isRoot ?? false,
			},
		});
	}, []);

	const onConnect: OnConnect = useCallback(
		(params) => {
			if (params.source && params.target) {
				createEdge.mutate({
					sourceId: params.source,
					targetId: params.target,
					type: "dependency",
				});
			}
		},
		[createEdge],
	);

	const onPaneClick = useCallback(() => {
		setContextMenu(null);
		setSelectedNode(null);
	}, []);

	const handleFork = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			navigate({ to: "/chapters/$chapterId", params: { chapterId: nodeId } });
		},
		[navigate],
	);

	const handleSetRole = useCallback(
		(nodeId: string, role: string) => {
			setContextMenu(null);
			updateChapter.mutate({ id: nodeId, data: { role } });
		},
		[updateChapter],
	);

	const handleDormant = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			dormantMutation.mutate(nodeId);
		},
		[dormantMutation],
	);

	const handleWake = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			wakeMutation.mutate(nodeId);
		},
		[wakeMutation],
	);

	const handleUnmerge = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			unmergeMutation.mutate(nodeId);
		},
		[unmergeMutation],
	);

	const handleDelete = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
			const node = nodes.find((n) => n.id === nodeId);
			const title = (node?.data as any)?.title ?? nodeId;
			setDeleteTarget({ id: nodeId, title });
		},
		[nodes],
	);

	const confirmDelete = useCallback(() => {
		if (!deleteTarget) return;
		deleteChapter.mutate(deleteTarget.id, {
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["storyGraph"] });
				queryClient.invalidateQueries({ queryKey: ["narrators"] });
				// Remove the chapter tab from recent tabs to prevent ghost entries
				removeTab("chapter", deleteTarget.id);
				setDeleteTarget(null);
			},
		});
	}, [deleteTarget, deleteChapter, queryClient, removeTab]);

	if (isLoading) {
		return (
			<Box
				style={{
					height: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				{t("loading")}
			</Box>
		);
	}

	if (error) {
		return (
			<Box
				style={{
					height: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					color: "var(--mantine-color-red-6)",
				}}
			>
				{t("loadFailed", { message: error instanceof Error ? error.message : t("error") })}
			</Box>
		);
	}

	if (nodes.length === 0) {
		return (
			<Box
				style={{
					height: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					color: "var(--mantine-color-dimmed)",
				}}
			>
				{t("noChapters")}
			</Box>
		);
	}

	return (
		<Box style={{ height: "100%", display: "flex" }}>
			<Box style={{ flex: 1, position: "relative" }}>
				<ReactFlow
					nodes={nodes}
					edges={computedEdges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onNodeDragStop={onNodeDragStop}
					onNodeClick={onNodeClick}
					onNodeDoubleClick={onNodeDoubleClick}
					onNodeContextMenu={onNodeContextMenu}
					onConnect={onConnect}
					onPaneClick={onPaneClick}
					nodesDraggable
					nodesConnectable
					elementsSelectable
					fitView
					fitViewOptions={{ padding: 0.2 }}
					proOptions={{ hideAttribution: true }}
				>
					<Background />
					<Controls />
				</ReactFlow>
				{contextMenu && (
					<NodeContextMenu
						x={contextMenu.x}
						y={contextMenu.y}
						nodeId={contextMenu.nodeId}
						nodeData={contextMenu.nodeData}
						onClose={() => setContextMenu(null)}
						onFork={handleFork}
						onSetRole={handleSetRole}
						onDormant={handleDormant}
						onWake={handleWake}
						onUnmerge={handleUnmerge}
						onDelete={handleDelete}
					/>
				)}
			</Box>
			{selectedNode && (
				<GraphSidePanel selectedNode={selectedNode} onClose={() => setSelectedNode(null)} />
			)}
			<Modal
				opened={deleteTarget !== null}
				onClose={() => setDeleteTarget(null)}
				title={t("contextMenu.deleteConfirmTitle")}
				centered
			>
				<Stack>
					<Text size="sm">
						{t("contextMenu.deleteConfirmMessage", { title: deleteTarget?.title ?? "" })}
					</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setDeleteTarget(null)}>
							{t("contextMenu.cancel", { defaultValue: "Cancel" })}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteChapter.isPending}>
							{t("contextMenu.delete")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Box>
	);
}
