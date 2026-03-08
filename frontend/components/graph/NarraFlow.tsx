import {
	applyNodeChanges,
	Background,
	ControlButton,
	Controls,
	type Edge,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type OnConnect,
	ReactFlow,
	useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import "@frontend/styles/react-flow-controls.css";
import { useCreateChapterEdge } from "@frontend/hooks/useChapterEdges";
import { useDeleteChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import { useUpdateGraphPositions } from "@frontend/hooks/useGraphPositions";
import type { GraphNode } from "@frontend/hooks/useNarraFlow";
import { assignEdgeHandles, useNarraFlow } from "@frontend/hooks/useNarraFlow";
import { useNarratorsListWS } from "@frontend/hooks/useNarratorWS";
import { useRecentTabs } from "@frontend/hooks/useRecentTabs";
import { api } from "@frontend/lib/api";
import { Box, Button, Group, Modal, Stack, Text, useMantineColorScheme } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconHandGrab, IconPointer } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChapterNode } from "./ChapterNode";
import { CherryPickEdge } from "./CherryPickEdge";
import { DependencyEdge } from "./DependencyEdge";
import type { DraftMode } from "./DraftNode";
import { DraftNode } from "./DraftNode";
import { ForkEdge } from "./ForkEdge";
import { LassoSelection } from "./LassoSelection";
import { MergeEdge } from "./MergeEdge";
import { NodeContextMenu } from "./NodeContextMenu";
import { SelectionToolbar } from "./SelectionToolbar";

const nodeTypes = { chapterNode: ChapterNode, draftNode: DraftNode };
const edgeTypes = {
	fork: ForkEdge,
	merge: MergeEdge,
	dependency: DependencyEdge,
	cherry_pick: CherryPickEdge,
};

interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string;
	nodeData: { title: string; status: string; role: string; isRoot?: boolean };
}

const PAN_SPEED = 1.5;

/** Mounted inside <ReactFlow> — intercepts Ctrl+wheel (vertical pan) and Shift+wheel (horizontal pan). */
function ModifierWheelPan() {
	const { getViewport, setViewport } = useReactFlow();

	useEffect(() => {
		const pane = document.querySelector(".react-flow") as HTMLElement | null;
		if (!pane) return;

		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.shiftKey) return;
			// Stop React Flow's zoom handler from seeing this event
			e.preventDefault();
			e.stopPropagation();
			const { x, y, zoom } = getViewport();
			const delta = e.deltaY || e.deltaX;
			if (e.shiftKey) {
				setViewport({ x: x - delta * PAN_SPEED, y, zoom });
			} else {
				setViewport({ x, y: y - delta * PAN_SPEED, zoom });
			}
		};

		// Capture phase so we intercept before React Flow's bubble-phase zoom handler
		pane.addEventListener("wheel", onWheel, { passive: false, capture: true });
		return () => pane.removeEventListener("wheel", onWheel, { capture: true });
	}, [getViewport, setViewport]);

	return null;
}

interface NarraFlowProps {
	projectId: string;
}

export function NarraFlow({ projectId }: NarraFlowProps) {
	const { t } = useTranslation("graph");
	const { colorScheme } = useMantineColorScheme();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { nodes: graphNodes, edges, isLoading, error } = useNarraFlow(projectId);
	const { savePosition, savePanelState } = useUpdateGraphPositions(projectId);
	const createEdge = useCreateChapterEdge();
	const updateChapter = useUpdateChapter();

	const dormantMutation = useMutation({
		mutationFn: (id: string) => api.dormantChapter(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["narraFlow"] }),
	});

	const wakeMutation = useMutation({
		mutationFn: (id: string) => api.wakeChapter(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["narraFlow"] }),
	});

	const unmergeMutation = useMutation({
		mutationFn: (id: string) => api.unmergeChapter(id),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["narraFlow"] }),
	});

	const deleteChapter = useDeleteChapter();
	const { removeTab } = useRecentTabs();

	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
	const [nodes, setNodes] = useState<Node[]>([]);

	// PC drag mode toggle: "select" = left-click drag draws lasso, "pan" = left-click drag pans
	const [pcDragMode, setPcDragMode] = useState<"select" | "pan">("select");
	const flowWrapperRef = useRef<HTMLDivElement>(null);
	const nodesRef = useRef<Node[]>(nodes);
	nodesRef.current = nodes;
	const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
	const expandedNodesRef = useRef(expandedNodes);
	expandedNodesRef.current = expandedNodes;
	// Track persisted panel sizes per node { chapterId -> { w, h } }
	const panelSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
	const initializedExpandRef = useRef(false);

	// Restore expanded state from server data on first load
	useEffect(() => {
		if (initializedExpandRef.current || graphNodes.length === 0) return;
		initializedExpandRef.current = true;
		const restored = new Set<string>();
		for (const node of graphNodes) {
			// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
			const d = (node as any).data;
			if (d?.panelExpanded) {
				restored.add(node.id);
				if (d.panelWidth && d.panelHeight) {
					panelSizesRef.current.set(node.id, { w: d.panelWidth, h: d.panelHeight });
				}
			}
		}
		if (restored.size > 0) setExpandedNodes(restored);
	}, [graphNodes]);

	const handleToggleExpand = useCallback(
		(chapterId: string) => {
			setExpandedNodes((prev) => {
				const next = new Set(prev);
				const willExpand = !next.has(chapterId);
				if (willExpand) {
					next.add(chapterId);
				} else {
					next.delete(chapterId);
					panelSizesRef.current.delete(chapterId);
				}
				// Persist — read latest position from ref to avoid stale closure
				const node = nodesRef.current.find((n) => n.id === chapterId);
				const x = node?.position?.x ?? 0;
				const y = node?.position?.y ?? 0;
				const size = panelSizesRef.current.get(chapterId);
				savePanelState(chapterId, x, y, willExpand, size?.w, size?.h);
				return next;
			});
		},
		[savePanelState],
	);

	// Subscribe to narrator status changes via WebSocket
	const narratorIdMap = useMemo(() => {
		const map = new Map<string, string>(); // narratorId → chapterId
		for (const node of graphNodes) {
			// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
			const nId = (node as any).data?.narratorId as string | undefined;
			if (nId) map.set(nId, node.id);
		}
		return map;
	}, [graphNodes]);

	const narratorIdsForWS = useMemo(() => [...narratorIdMap.keys()], [narratorIdMap]);

	const [liveStatuses, setLiveStatuses] = useState<Map<string, string>>(new Map());

	const handleNarratorWSUpdate = useCallback(
		(narratorId: string, event: { type: string; status?: string }) => {
			if (event.type === "status" && event.status) {
				const chapterId = narratorIdMap.get(narratorId);
				if (chapterId) {
					setLiveStatuses((prev) => {
						const next = new Map(prev);
						next.set(chapterId, event.status as string);
						return next;
					});
				}
			}
		},
		[narratorIdMap],
	);

	useNarratorsListWS(narratorIdsForWS, handleNarratorWSUpdate);

	// Inject expand state, live narrator status, and callback into node data
	const nodesWithExpand = useMemo(() => {
		return nodes.map((node) => {
			const isExpanded = expandedNodes.has(node.id);
			const size = panelSizesRef.current.get(node.id);
			const liveStatus = liveStatuses.get(node.id);
			return {
				...node,
				data: {
					...node.data,
					expanded: isExpanded,
					onToggleExpand: handleToggleExpand,
					...(liveStatus ? { narratorStatus: liveStatus } : {}),
				},
				...(isExpanded
					? {
							dragHandle: ".chapter-node-drag-handle",
							style: {
								width: size?.w ?? 380,
								height: size?.h ?? 640,
							},
						}
					: {}),
			};
		});
	}, [nodes, expandedNodes, liveStatuses, handleToggleExpand]);

	// Recompute edge handles whenever local node positions change
	// Include temporary dashed edges for draft nodes (fork: parent→draft, merge: sources→draft)
	const computedEdges = useMemo(() => {
		const baseEdges = assignEdgeHandles(nodes as GraphNode[], edges);
		const draftEdges: Edge[] = [];
		for (const n of nodes) {
			if (n.type !== "draftNode") continue;
			const draftMode = n.data?.mode as DraftMode | undefined;
			if (draftMode === "fork" && n.data?.parentChapterId) {
				draftEdges.push({
					id: `__draft_edge_${n.id}`,
					source: n.data.parentChapterId as string,
					target: n.id,
					type: "fork",
					sourceHandle: "bottom-src",
					targetHandle: "top",
					animated: true,
					style: { strokeDasharray: "6 3", opacity: 0.5 },
				});
			} else if (draftMode === "merge") {
				const sources = (n.data?.sourceChapterIds as string[]) ?? [];
				for (const srcId of sources) {
					draftEdges.push({
						id: `__draft_edge_${n.id}_${srcId}`,
						source: srcId,
						target: n.id,
						type: "merge",
						sourceHandle: "right-src",
						targetHandle: "left",
						animated: true,
						style: { strokeDasharray: "6 3", opacity: 0.5 },
					});
				}
			}
		}
		return [...baseEdges, ...draftEdges];
	}, [nodes, edges]);

	// Sync local nodes state when upstream graph data changes
	// Preserve any local-only draft nodes (type === "draftNode")
	useEffect(() => {
		setNodes((prev) => {
			const drafts = prev.filter((n) => n.type === "draftNode");
			return [...(graphNodes as Node[]), ...drafts];
		});
	}, [graphNodes]);

	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cleanup resize debounce timer on unmount
	useEffect(() => {
		return () => {
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
		};
	}, []);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			let hasResize = false;
			for (const change of changes) {
				// Track resize dimension changes for expanded nodes
				if (
					change.type === "dimensions" &&
					change.dimensions &&
					"id" in change &&
					expandedNodesRef.current.has(change.id)
				) {
					panelSizesRef.current.set(change.id, {
						w: change.dimensions.width,
						h: change.dimensions.height,
					});
					hasResize = true;
				}
			}
			setNodes((nds) => applyNodeChanges(changes, nds));
			// Debounce persist after resize — read refs for latest values
			if (hasResize) {
				if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
				resizeTimerRef.current = setTimeout(() => {
					for (const [chapterId, size] of panelSizesRef.current) {
						if (!expandedNodesRef.current.has(chapterId)) continue;
						const node = nodesRef.current.find((n) => n.id === chapterId);
						if (node) {
							savePanelState(chapterId, node.position.x, node.position.y, true, size.w, size.h);
						}
					}
				}, 800);
			}
		},
		[savePanelState],
	);

	const onNodeDragStop: NodeMouseHandler = useCallback(
		(_event, node) => {
			// Don't persist positions for temporary draft nodes
			if (node.type === "draftNode") return;
			savePosition(node.id, node.position.x, node.position.y);
		},
		[savePosition],
	);

	const onNodeDoubleClick: NodeMouseHandler = useCallback(
		(_event, node) => {
			if (node.type === "draftNode") return;
			// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
			const d = node.data as any;
			if (d.narratorId) {
				handleToggleExpand(node.id);
			} else {
				navigate({ to: "/chapters/$chapterId", params: { chapterId: node.id } });
			}
		},
		[handleToggleExpand, navigate],
	);

	const onNodeContextMenu: NodeMouseHandler = useCallback((event, node) => {
		if (node.type === "draftNode") return;
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
	}, []);

	const onLassoSelect = useCallback((selectedIds: Set<string>) => {
		setNodes((nds) =>
			nds.map((n) => ({
				...n,
				selected: selectedIds.has(n.id),
			})),
		);
	}, []);

	// Derive selected node IDs from nodes state (exclude draft nodes)
	const selectedNodeIds = useMemo(
		() => nodes.filter((n) => n.selected && n.type !== "draftNode").map((n) => n.id),
		[nodes],
	);

	// --- Unified draft node logic (fork + merge) ---
	const draftIdCounter = useRef(0);

	const removeDraft = useCallback((draftNodeId: string) => {
		setNodes((nds) => nds.filter((n) => n.id !== draftNodeId));
	}, []);

	const handleDraftConfirm = useCallback(
		(
			draftNodeId: string,
			payload: {
				title: string;
				description: string;
				inheritMode: string;
				mode: DraftMode;
				parentChapterId?: string;
				sourceChapterIds?: string[];
				targetChapterId?: string;
			},
		) => {
			if (payload.mode === "fork" && payload.parentChapterId) {
				const draftNode = nodesRef.current.find((n) => n.id === draftNodeId);
				const draftX = draftNode?.position?.x ?? 0;
				const draftY = draftNode?.position?.y ?? 0;

				api
					.forkChapter(payload.parentChapterId, {
						title: payload.title,
						description: payload.description || undefined,
						inheritMode: payload.inheritMode,
						positionX: draftX,
						positionY: draftY,
					})
					.then(() => {
						removeDraft(draftNodeId);
						queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
						queryClient.invalidateQueries({ queryKey: ["chapters"] });
						queryClient.invalidateQueries({ queryKey: ["narrators"] });
					})
					.catch((err) => {
						notifications.show({
							message: t("forkDraft.failed", {
								message: err instanceof Error ? err.message : "unknown",
							}),
							color: "red",
						});
					});
			} else if (payload.mode === "merge" && payload.sourceChapterIds?.length) {
				// For merge-new: first source is base, rest are sources
				// For merge-into: targetChapterId is base, all sourceChapterIds are sources
				const baseId = payload.targetChapterId ?? payload.sourceChapterIds[0];
				const sourceIds = payload.targetChapterId
					? payload.sourceChapterIds
					: payload.sourceChapterIds.slice(1);

				api
					.batchMerge({
						baseChapterId: baseId,
						sourceChapterIds: sourceIds,
						title: payload.title,
					})
					.then(() => {
						removeDraft(draftNodeId);
						queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
						queryClient.invalidateQueries({ queryKey: ["chapters"] });
						notifications.show({ message: t("selection.mergeSuccess"), color: "green" });
						setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
					})
					.catch((err) => {
						notifications.show({
							message: t("mergeDraft.failed", {
								message: err instanceof Error ? err.message : "unknown",
							}),
							color: "red",
						});
					});
			}
		},
		[queryClient, t, removeDraft],
	);

	/** Compute bounding box center-bottom for a set of node IDs */
	const getBboxBottom = useCallback((nodeIds: string[]) => {
		let maxY = Number.NEGATIVE_INFINITY;
		let sumX = 0;
		let count = 0;
		for (const id of nodeIds) {
			const n = nodesRef.current.find((nd) => nd.id === id);
			if (!n) continue;
			const h = n.measured?.height ?? n.height ?? 120;
			const w = n.measured?.width ?? n.width ?? 280;
			maxY = Math.max(maxY, n.position.y + h);
			sumX += n.position.x + w / 2;
			count++;
		}
		return { x: count > 0 ? sumX / count - 140 : 0, y: maxY + 60 };
	}, []);

	const spawnDraft = useCallback(
		(
			mode: DraftMode,
			position: { x: number; y: number },
			extra: Partial<{
				parentChapterId: string;
				sourceChapterIds: string[];
				targetChapterId: string;
				defaultTitle: string;
			}>,
		) => {
			const draftId = `__draft_${++draftIdCounter.current}`;
			const draftNode: Node = {
				id: draftId,
				type: "draftNode",
				position,
				data: {
					mode,
					...extra,
					onConfirm: handleDraftConfirm,
					onCancel: removeDraft,
				},
				selected: false,
			};
			setNodes((nds) => [...nds, draftNode]);
		},
		[handleDraftConfirm, removeDraft],
	);

	const handleFork = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			const sourceNode = nodesRef.current.find((n) => n.id === nodeId);
			const sourceX = sourceNode?.position?.x ?? 0;
			const sourceY = sourceNode?.position?.y ?? 0;
			const sourceH = sourceNode?.measured?.height ?? sourceNode?.height ?? 120;
			spawnDraft("fork", { x: sourceX, y: sourceY + sourceH + 60 }, { parentChapterId: nodeId });
		},
		[spawnDraft],
	);

	const handleMergeNew = useCallback(
		(nodeIds: string[]) => {
			if (nodeIds.length < 2) return;
			const titles = nodeIds
				.map((id) => {
					const n = nodesRef.current.find((nd) => nd.id === id);
					// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
					return (n?.data as any)?.title ?? id.slice(0, 6);
				})
				.join(", ");
			const pos = getBboxBottom(nodeIds);
			spawnDraft("merge", pos, {
				sourceChapterIds: nodeIds,
				defaultTitle: t("selection.mergeNewTitle", { titles }),
			});
			// Clear selection so toolbar hides
			setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
		},
		[spawnDraft, getBboxBottom, t],
	);

	const handleMergeInto = useCallback(
		(sourceNodeIds: string[], targetNodeId: string) => {
			if (sourceNodeIds.length === 0) return;
			const titles = sourceNodeIds
				.map((id) => {
					const n = nodesRef.current.find((nd) => nd.id === id);
					// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
					return (n?.data as any)?.title ?? id.slice(0, 6);
				})
				.join(", ");
			const pos = getBboxBottom([...sourceNodeIds, targetNodeId]);
			spawnDraft("merge", pos, {
				sourceChapterIds: sourceNodeIds,
				targetChapterId: targetNodeId,
				defaultTitle: t("selection.mergeNewTitle", { titles }),
			});
			setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
		},
		[spawnDraft, getBboxBottom, t],
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
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
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
			<Box ref={flowWrapperRef} style={{ flex: 1, position: "relative" }}>
				<ReactFlow
					colorMode={colorScheme === "auto" ? "system" : colorScheme}
					nodes={nodesWithExpand}
					edges={computedEdges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onNodeDragStop={onNodeDragStop}
					onNodeDoubleClick={onNodeDoubleClick}
					onNodeContextMenu={onNodeContextMenu}
					onConnect={onConnect}
					onPaneClick={onPaneClick}
					nodesDraggable
					nodesConnectable
					elementsSelectable
					panOnDrag={pcDragMode === "pan" ? true : [1]}
					selectionOnDrag={false}
					panOnScroll={false}
					fitView
					fitViewOptions={{ padding: 0.2 }}
					minZoom={0.1}
					maxZoom={4}
					proOptions={{ hideAttribution: true }}
				>
					<ModifierWheelPan />
					<LassoSelection pcDragMode={pcDragMode} onSelect={onLassoSelect} />
					<SelectionToolbar
						selectedNodeIds={selectedNodeIds}
						onFork={handleFork}
						onMergeNew={handleMergeNew}
						onMergeInto={handleMergeInto}
					/>
					<Background />
					<Controls>
						<ControlButton
							title={pcDragMode === "select" ? t("controls.selectMode") : t("controls.panMode")}
							onClick={() => setPcDragMode((m) => (m === "select" ? "pan" : "select"))}
						>
							{pcDragMode === "select" ? <IconPointer size={16} /> : <IconHandGrab size={16} />}
						</ControlButton>
					</Controls>
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
