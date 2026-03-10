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
	type ReactFlowInstance,
	useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import "@frontend/styles/react-flow-controls.css";
import { useCreateChapterEdge } from "@frontend/hooks/useChapterEdges";
import { useDeleteChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import { useUpdateGraphPositions } from "@frontend/hooks/useGraphPositions";
import { useNarraFlow } from "@frontend/hooks/useNarraFlow";
import { useNarratorsListWS } from "@frontend/hooks/useNarratorWS";
import { useRecentTabs } from "@frontend/hooks/useRecentTabs";
import { useCreateTerminal, useDeleteTerminal, useTerminals } from "@frontend/hooks/useTerminals";
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
import { DRAFT_NODE_WIDTH, DraftNode } from "./DraftNode";
import { ForkEdge } from "./ForkEdge";
import { LassoSelection } from "./LassoSelection";
import { MergeEdge } from "./MergeEdge";
import { NodeContextMenu } from "./NodeContextMenu";
import type { TerminalBubble } from "./SelectionToolbar";
import { SelectionToolbar } from "./SelectionToolbar";
import { TerminalEdge } from "./TerminalEdge";
import { TerminalNode } from "./TerminalNode";

const nodeTypes = {
	chapterNode: ChapterNode,
	draftNode: DraftNode,
	terminalNode: TerminalNode,
};
const edgeTypes = {
	fork: ForkEdge,
	merge: MergeEdge,
	dependency: DependencyEdge,
	cherry_pick: CherryPickEdge,
	terminal: TerminalEdge,
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

type HandleableNode = Pick<Node, "id" | "position">;
type HandleableEdge = Pick<Edge, "id" | "source" | "target" | "type" | "data"> &
	Partial<Pick<Edge, "sourceHandle" | "targetHandle">>;

const DRAFT_EDGE_PREFIX = "__draft_edge_";
const TERMINAL_EDGE_PREFIX = "__terminal_edge_";

function assignEdgeHandlesForNodeMap<T extends HandleableEdge>(
	edge: T,
	nodeMap: Map<string, HandleableNode>,
): T {
	const sourceNode = nodeMap.get(edge.source);
	const targetNode = nodeMap.get(edge.target);
	if (!sourceNode || !targetNode) return edge;

	const edgeType = edge.type ?? (edge.data as { type?: string } | undefined)?.type;

	if (edgeType === "fork") {
		const dy = targetNode.position.y - sourceNode.position.y;
		return {
			...edge,
			sourceHandle: dy >= 0 ? "bottom-src" : "top-src",
			targetHandle: dy >= 0 ? "top" : "bottom",
		};
	}

	if (edgeType === "merge") {
		const dx = sourceNode.position.x - targetNode.position.x;
		return {
			...edge,
			sourceHandle: dx <= 0 ? "right-src" : "left-src",
			targetHandle: dx <= 0 ? "left" : "right",
		};
	}

	const dx = targetNode.position.x - sourceNode.position.x;
	const dy = targetNode.position.y - sourceNode.position.y;
	if (Math.abs(dx) > Math.abs(dy) * 0.8) {
		return {
			...edge,
			sourceHandle: dx > 0 ? "right-src" : "left-src",
			targetHandle: dx > 0 ? "left" : "right",
		};
	}

	return {
		...edge,
		sourceHandle: dy > 0 ? "bottom-src" : "top-src",
		targetHandle: dy > 0 ? "top" : "bottom",
	};
}

function isLocalEdgeId(edgeId: string) {
	return edgeId.startsWith(DRAFT_EDGE_PREFIX) || edgeId.startsWith(TERMINAL_EDGE_PREFIX);
}

interface NarraFlowProps {
	projectId: string;
	focusChapterId?: string;
}

export function NarraFlow({ projectId, focusChapterId }: NarraFlowProps) {
	const { t } = useTranslation("graph");
	const { colorScheme } = useMantineColorScheme();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { nodes: graphNodes, edges, isLoading, error, openedTerminals } = useNarraFlow(projectId);
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
	const [computedEdges, setComputedEdges] = useState<Edge[]>([]);

	// PC drag mode toggle: "select" = left-click drag draws lasso, "pan" = left-click drag pans
	const [pcDragMode, setPcDragMode] = useState<"select" | "pan">(() => {
		const saved = localStorage.getItem("narrafork_drag_mode");
		return saved === "pan" ? "pan" : "select";
	});
	const setAndPersistDragMode = useCallback(
		(updater: (prev: "select" | "pan") => "select" | "pan") => {
			setPcDragMode((prev) => {
				const next = updater(prev);
				localStorage.setItem("narrafork_drag_mode", next);
				return next;
			});
		},
		[],
	);
	const flowWrapperRef = useRef<HTMLDivElement>(null);
	const reactFlowRef = useRef<ReactFlowInstance | null>(null);
	const focusAppliedRef = useRef(false);

	// Reset the guard when the target chapter changes so consecutive
	// navigations back from different narrators each trigger a focus.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when focusChapterId changes
	useEffect(() => {
		focusAppliedRef.current = false;
	}, [focusChapterId]);

	// Shared helper: focus the graph on a specific chapter node (used by both
	// the useEffect watcher and the onInit callback to cover all timing cases).
	const tryFocusChapter = useCallback(() => {
		if (!focusChapterId || focusAppliedRef.current || !reactFlowRef.current) return;
		const targetNode = nodesRef.current.find((n) => n.id === focusChapterId);
		if (!targetNode) return;
		focusAppliedRef.current = true;
		const instance = reactFlowRef.current;
		requestAnimationFrame(() => {
			instance.fitView({ padding: 0.3, duration: 300, nodes: [targetNode] });
		});
	}, [focusChapterId]);
	const nodesRef = useRef<Node[]>(nodes);
	nodesRef.current = nodes;
	const computedEdgesRef = useRef<Edge[]>(computedEdges);
	computedEdgesRef.current = computedEdges;
	const movedNodeIdsRef = useRef<Set<string>>(new Set());
	const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
	const expandedNodesRef = useRef(expandedNodes);
	expandedNodesRef.current = expandedNodes;
	// Track persisted panel sizes per node { chapterId -> { w, h } }
	const panelSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
	const renderedNodeCacheRef = useRef<
		Map<
			string,
			{
				sourceNode: Node;
				renderedNode: Node;
				expanded: boolean;
				width: number;
				height: number;
				narratorStatus: string | null;
				onToggleExpand: (chapterId: string) => void;
			}
		>
	>(new Map());
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

	// Focus on a specific chapter node when navigating back from narrator page.
	// `nodes` is intentionally in the dep array: tryFocusChapter reads nodesRef
	// which updates when nodes change, so we need to re-attempt when new nodes arrive.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-attempt focus when nodes update
	useEffect(() => {
		tryFocusChapter();
	}, [tryFocusChapter, nodes]);

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

	const edgeIdsByNodeId = useMemo(() => {
		const map = new Map<string, Set<string>>();
		for (const edge of edges) {
			for (const nodeId of [edge.source, edge.target]) {
				const existing = map.get(nodeId);
				if (existing) {
					existing.add(edge.id);
				} else {
					map.set(nodeId, new Set([edge.id]));
				}
			}
		}
		return map;
	}, [edges]);

	const buildLocalEdges = useCallback((nextNodes: Node[]) => {
		const localEdges: Edge[] = [];
		const nodeMap = new Map<string, HandleableNode>(nextNodes.map((node) => [node.id, node]));

		for (const n of nextNodes) {
			// Draft edges
			if (n.type === "draftNode") {
				const draftData = n.data as {
					mode?: DraftMode;
					parentChapterId?: string;
					sourceChapterIds?: string[];
					targetChapterId?: string;
				};

				if (draftData.mode === "fork" && draftData.parentChapterId) {
					localEdges.push(
						assignEdgeHandlesForNodeMap(
							{
								id: `${DRAFT_EDGE_PREFIX}${n.id}`,
								source: draftData.parentChapterId,
								target: n.id,
								type: "fork",
								animated: true,
								style: { strokeDasharray: "6 3", opacity: 0.5 },
							} as Edge,
							nodeMap,
						),
					);
				} else if (draftData.mode === "merge") {
					for (const srcId of draftData.sourceChapterIds ?? []) {
						localEdges.push(
							assignEdgeHandlesForNodeMap(
								{
									id: `${DRAFT_EDGE_PREFIX}${n.id}_${srcId}`,
									source: srcId,
									target: n.id,
									type: "merge",
									animated: true,
									style: { strokeDasharray: "6 3", opacity: 0.5 },
								} as Edge,
								nodeMap,
							),
						);
					}

					if (draftData.targetChapterId) {
						localEdges.push(
							assignEdgeHandlesForNodeMap(
								{
									id: `${DRAFT_EDGE_PREFIX}${n.id}_to_target`,
									source: n.id,
									target: draftData.targetChapterId,
									type: "merge",
									animated: true,
									style: { strokeDasharray: "6 3", opacity: 0.5 },
								} as Edge,
								nodeMap,
							),
						);
					}
				}
			}

			// Terminal edges
			if (n.type === "terminalNode") {
				const termData = n.data as { chapterId?: string };
				if (termData.chapterId && nodeMap.has(termData.chapterId)) {
					localEdges.push(
						assignEdgeHandlesForNodeMap(
							{
								id: `${TERMINAL_EDGE_PREFIX}${n.id}`,
								source: termData.chapterId,
								target: n.id,
								type: "terminal",
							} as Edge,
							nodeMap,
						),
					);
				}
			}
		}

		return localEdges;
	}, []);

	const recomputeEdges = useCallback(
		(nextNodes: Node[], opts?: { affectedNodeIds?: Iterable<string>; full?: boolean }) => {
			const nodeMap = new Map<string, HandleableNode>(nextNodes.map((node) => [node.id, node]));
			const prevEdgeMap = new Map(computedEdgesRef.current.map((edge) => [edge.id, edge]));
			const affectedNodeIds =
				opts?.full || !opts?.affectedNodeIds ? null : new Set(opts.affectedNodeIds);
			let affectedBaseEdgeIds: Set<string> | null = null;

			if (affectedNodeIds) {
				affectedBaseEdgeIds = new Set<string>();
				for (const nodeId of affectedNodeIds) {
					for (const edgeId of edgeIdsByNodeId.get(nodeId) ?? []) {
						affectedBaseEdgeIds.add(edgeId);
					}
				}
			}

			const nextBaseEdges = edges.map((edge) => {
				const prevEdge = prevEdgeMap.get(edge.id);
				if (
					affectedBaseEdgeIds &&
					!affectedBaseEdgeIds.has(edge.id) &&
					prevEdge &&
					!isLocalEdgeId(prevEdge.id)
				) {
					return prevEdge;
				}
				return assignEdgeHandlesForNodeMap(edge as Edge, nodeMap);
			});

			const shouldRecomputeLocalEdges =
				!affectedNodeIds ||
				nextNodes.some((node) => {
					if (node.type === "terminalNode") {
						if (affectedNodeIds.has(node.id)) return true;
						const termData = node.data as { chapterId?: string };
						return !!termData.chapterId && affectedNodeIds.has(termData.chapterId);
					}
					if (node.type !== "draftNode") return false;
					if (affectedNodeIds.has(node.id)) return true;
					const draftData = node.data as {
						parentChapterId?: string;
						sourceChapterIds?: string[];
						targetChapterId?: string;
					};
					return (
						(draftData.parentChapterId && affectedNodeIds.has(draftData.parentChapterId)) ||
						(draftData.targetChapterId && affectedNodeIds.has(draftData.targetChapterId)) ||
						(draftData.sourceChapterIds?.some((id) => affectedNodeIds.has(id)) ?? false)
					);
				});

			const nextLocalEdges = shouldRecomputeLocalEdges
				? buildLocalEdges(nextNodes)
				: computedEdgesRef.current.filter((edge) => isLocalEdgeId(edge.id));

			const nextEdges = [...nextBaseEdges, ...nextLocalEdges];
			computedEdgesRef.current = nextEdges;
			setComputedEdges(nextEdges);
		},
		[buildLocalEdges, edgeIdsByNodeId, edges],
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

	// Inject expand state and live narrator status into node data while preserving object
	// identity for untouched nodes. This keeps heavy custom nodes out of the drag hot path.
	const nodesWithExpand = useMemo(() => {
		const nextCache = new Map<
			string,
			{
				sourceNode: Node;
				renderedNode: Node;
				expanded: boolean;
				width: number;
				height: number;
				narratorStatus: string | null;
				onToggleExpand: (chapterId: string) => void;
			}
		>();

		const renderedNodes = nodes.map((node) => {
			const isExpanded = expandedNodes.has(node.id);
			const size = panelSizesRef.current.get(node.id);
			const width = size?.w ?? 380;
			const height = size?.h ?? 640;
			const baseNarratorStatus =
				(node.data as { narratorStatus?: string | null }).narratorStatus ?? null;
			const narratorStatus = liveStatuses.get(node.id) ?? baseNarratorStatus;
			const cached = renderedNodeCacheRef.current.get(node.id);

			if (
				cached &&
				cached.sourceNode === node &&
				cached.expanded === isExpanded &&
				cached.width === width &&
				cached.height === height &&
				cached.narratorStatus === narratorStatus &&
				cached.onToggleExpand === handleToggleExpand
			) {
				nextCache.set(node.id, cached);
				return cached.renderedNode;
			}

			const renderedNode: Node = {
				...node,
				data: {
					...node.data,
					expanded: isExpanded,
					onToggleExpand: handleToggleExpand,
					narratorStatus,
				},
				...(isExpanded
					? {
							dragHandle: ".chapter-node-drag-handle",
							style: { width, height },
						}
					: {}),
			};

			const cacheEntry = {
				sourceNode: node,
				renderedNode,
				expanded: isExpanded,
				width,
				height,
				narratorStatus,
				onToggleExpand: handleToggleExpand,
			};
			nextCache.set(node.id, cacheEntry);
			return renderedNode;
		});

		renderedNodeCacheRef.current = nextCache;
		return renderedNodes;
	}, [nodes, expandedNodes, liveStatuses, handleToggleExpand]);

	// Sync local nodes state when upstream graph data changes.
	// Incrementally merge: preserve positions of nodes the user has dragged,
	// keep local-only draft/terminal nodes, and only update nodes whose data
	// actually changed — so React Flow doesn't re-render the entire graph and
	// lose focus / input state inside DraftNode etc.
	const prevGraphNodesRef = useRef(graphNodes);
	useEffect(() => {
		const prev = prevGraphNodesRef.current;
		prevGraphNodesRef.current = graphNodes;

		const localOnly = nodesRef.current.filter(
			(n) => n.type === "draftNode" || n.type === "terminalNode",
		);

		// Fast path: if the upstream array reference is the same, nothing changed.
		// Exception: if local nodes are empty but graphNodes has data (e.g. component
		// mounted with cached query data), we must still initialise.
		if (prev === graphNodes && nodesRef.current.length > 0) return;

		const currentNodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));

		// Build a set of node IDs whose server data actually changed so we can
		// skip touching nodes that are identical.
		const prevMap = new Map(prev.map((n) => [n.id, n]));
		const changedIds = new Set<string>();
		const incomingIds = new Set<string>();
		for (const node of graphNodes) {
			incomingIds.add(node.id);
			const old = prevMap.get(node.id);
			if (old !== node) changedIds.add(node.id);
		}
		// Detect removed nodes
		for (const old of prev) {
			if (!incomingIds.has(old.id)) changedIds.add(old.id);
		}

		// If nothing actually changed, skip the update entirely.
		if (changedIds.size === 0) return;

		const mergedServerNodes = (graphNodes as Node[]).map((incoming) => {
			const existing = currentNodeMap.get(incoming.id);
			// If this node wasn't changed, reuse the existing object identity
			// to avoid unnecessary React re-renders.
			if (existing && !changedIds.has(incoming.id)) {
				return existing;
			}
			// If the user has dragged this node, preserve their position.
			if (existing && movedNodeIdsRef.current.has(incoming.id)) {
				return { ...incoming, position: existing.position };
			}
			return incoming;
		});

		const nextNodes = [...mergedServerNodes, ...localOnly];
		nodesRef.current = nextNodes;
		movedNodeIdsRef.current.clear();
		setNodes(nextNodes);
		recomputeEdges(nextNodes, { full: true });
	}, [graphNodes, recomputeEdges]);

	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const terminalSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
	const terminalResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cleanup timers on unmount
	useEffect(() => {
		return () => {
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
			if (terminalResizeTimerRef.current) clearTimeout(terminalResizeTimerRef.current);
		};
	}, []);

	/** Persist terminal graph state (fire-and-forget) */
	const persistTerminalGraph = useCallback(
		(
			terminalId: string,
			state: {
				graphOpened?: boolean;
				graphX?: number;
				graphY?: number;
				graphWidth?: number;
				graphHeight?: number;
			},
		) => {
			api.updateTerminalGraphState(terminalId, state).catch(() => {});
		},
		[],
	);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			let hasResize = false;
			let hasTerminalResize = false;
			const movedNodeIds = new Set<string>();
			for (const change of changes) {
				if (change.type === "position" && "id" in change) {
					movedNodeIds.add(change.id);
				}
				// Track resize dimension changes for expanded nodes
				if (change.type === "dimensions" && change.dimensions && "id" in change) {
					if (expandedNodesRef.current.has(change.id)) {
						panelSizesRef.current.set(change.id, {
							w: change.dimensions.width,
							h: change.dimensions.height,
						});
						hasResize = true;
					}
					// Track terminal node resize
					const node = nodesRef.current.find((n) => n.id === change.id);
					if (node?.type === "terminalNode") {
						terminalSizesRef.current.set(change.id, {
							w: change.dimensions.width,
							h: change.dimensions.height,
						});
						hasTerminalResize = true;
					}
				}
			}
			if (movedNodeIds.size > 0) {
				for (const nodeId of movedNodeIds) movedNodeIdsRef.current.add(nodeId);
			}
			setNodes((nds) => {
				const nextNodes = applyNodeChanges(changes, nds);
				nodesRef.current = nextNodes;
				return nextNodes;
			});
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
			if (hasTerminalResize) {
				if (terminalResizeTimerRef.current) clearTimeout(terminalResizeTimerRef.current);
				terminalResizeTimerRef.current = setTimeout(() => {
					for (const [nodeId, size] of terminalSizesRef.current) {
						const node = nodesRef.current.find((n) => n.id === nodeId);
						if (!node || node.type !== "terminalNode") continue;
						const tid = (node.data as { terminalId?: string }).terminalId;
						if (tid) {
							persistTerminalGraph(tid, { graphWidth: size.w, graphHeight: size.h });
						}
					}
					terminalSizesRef.current.clear();
				}, 800);
			}
		},
		[savePanelState, persistTerminalGraph],
	);

	const onNodeDragStop: NodeMouseHandler = useCallback(
		(_event, node) => {
			const affectedNodeIds = new Set(movedNodeIdsRef.current);
			affectedNodeIds.add(node.id);
			movedNodeIdsRef.current.clear();
			recomputeEdges(nodesRef.current, { affectedNodeIds });
			for (const nodeId of affectedNodeIds) {
				const movedNode = nodesRef.current.find((n) => n.id === nodeId);
				if (!movedNode || movedNode.type === "draftNode") continue;
				if (movedNode.type === "terminalNode") {
					const tid = (movedNode.data as { terminalId?: string }).terminalId;
					if (tid) {
						persistTerminalGraph(tid, {
							graphX: movedNode.position.x,
							graphY: movedNode.position.y,
						});
					}
					continue;
				}
				savePosition(movedNode.id, movedNode.position.x, movedNode.position.y);
			}
		},
		[recomputeEdges, savePosition, persistTerminalGraph],
	);

	const onNodeDoubleClick: NodeMouseHandler = useCallback(
		(_event, node) => {
			if (node.type === "draftNode" || node.type === "terminalNode") return;
			// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
			const d = node.data as any;
			if (d.narratorId) {
				handleToggleExpand(node.id);
			} else {
				navigate({
					to: "/chapters/$chapterId",
					params: { chapterId: node.id },
					search: { from: "graph" },
				});
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
		// Clear lasso selection when clicking blank canvas
		setNodes((nds) => {
			if (nds.every((n) => !n.selected)) return nds;
			return nds.map((n) => (n.selected ? { ...n, selected: false } : n));
		});
	}, []);

	const onLassoSelect = useCallback((selectedIds: Set<string>) => {
		setNodes((nds) =>
			nds.map((n) => ({
				...n,
				selected: selectedIds.has(n.id),
			})),
		);
	}, []);

	// Derive selected node IDs from nodes state (exclude draft and terminal nodes)
	const selectedNodeIds = useMemo(
		() =>
			nodes
				.filter((n) => n.selected && n.type !== "draftNode" && n.type !== "terminalNode")
				.map((n) => n.id),
		[nodes],
	);

	// --- Terminal bubbles for selected chapter ---
	const selectedChapterId = selectedNodeIds.length === 1 ? selectedNodeIds[0] : "";
	const { data: chapterTerminals } = useTerminals(selectedChapterId);
	const createTerminalMut = useCreateTerminal(selectedChapterId);
	const deleteTerminalMut = useDeleteTerminal(selectedChapterId);

	// Collect terminal IDs already opened as nodes
	const openedTerminalIds = useMemo(() => {
		const ids = new Set<string>();
		for (const n of nodes) {
			if (n.type === "terminalNode") {
				const tid = (n.data as { terminalId?: string }).terminalId;
				if (tid) ids.add(tid);
			}
		}
		return ids;
	}, [nodes]);

	const terminalBubbles: TerminalBubble[] = useMemo(
		() =>
			(chapterTerminals ?? [])
				.filter(
					(t: { id: string; status?: string }) =>
						t.status === "running" && !openedTerminalIds.has(t.id),
				)
				.map((t: { id: string; name?: string }) => ({
					id: t.id,
					name: t.name ?? "Terminal",
				})),
		[chapterTerminals, openedTerminalIds],
	);

	const terminalNodeIdCounter = useRef(0);

	/** Minimize: remove the node from the graph (terminal keeps running) */
	const minimizeTerminalNode = useCallback(
		(nodeId: string) => {
			const node = nodesRef.current.find((n) => n.id === nodeId);
			const terminalId = (node?.data as { terminalId?: string })?.terminalId;
			if (terminalId) persistTerminalGraph(terminalId, { graphOpened: false });
			const nextNodes = nodesRef.current.filter((n) => n.id !== nodeId);
			nodesRef.current = nextNodes;
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
		},
		[recomputeEdges, persistTerminalGraph],
	);

	/** Close: kill the terminal process and remove the node */
	const closeTerminalNode = useCallback(
		(nodeId: string, terminalId: string) => {
			persistTerminalGraph(terminalId, { graphOpened: false });
			deleteTerminalMut.mutate(terminalId);
			const nextNodes = nodesRef.current.filter((n) => n.id !== nodeId);
			nodesRef.current = nextNodes;
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
		},
		[recomputeEdges, deleteTerminalMut, persistTerminalGraph],
	);

	/** Rename: update name on server and in the node data */
	const renameTerminalNode = useCallback((terminalId: string, name: string) => {
		api.renameTerminal(terminalId, name).catch(() => {});
		// Update node data in-place so the name reflects immediately
		setNodes((nds) =>
			nds.map((n) => {
				if (
					n.type !== "terminalNode" ||
					(n.data as { terminalId?: string }).terminalId !== terminalId
				)
					return n;
				return { ...n, data: { ...n.data, terminalName: name } };
			}),
		);
	}, []);

	const spawnTerminalNode = useCallback(
		(
			terminalId: string,
			terminalName: string,
			chapterId: string,
			position: { x: number; y: number },
			size?: { w: number; h: number },
		) => {
			// Don't add duplicate terminal nodes
			if (
				nodesRef.current.some(
					(n) =>
						n.type === "terminalNode" &&
						(n.data as { terminalId?: string }).terminalId === terminalId,
				)
			) {
				return;
			}
			const w = size?.w ?? 480;
			const h = size?.h ?? 360;
			const nodeId = `__terminal_${++terminalNodeIdCounter.current}`;
			const termNode: Node = {
				id: nodeId,
				type: "terminalNode",
				position,
				dragHandle: ".terminal-node-drag-handle",
				style: { width: w, height: h },
				data: {
					terminalId,
					terminalName,
					chapterId,
					onMinimize: minimizeTerminalNode,
					onClose: closeTerminalNode,
					onRename: renameTerminalNode,
				},
				selected: false,
			};
			const nextNodes = [...nodesRef.current, termNode];
			nodesRef.current = nextNodes;
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
			// Persist opened state
			persistTerminalGraph(terminalId, {
				graphOpened: true,
				graphX: position.x,
				graphY: position.y,
				graphWidth: w,
				graphHeight: h,
			});
		},
		[
			recomputeEdges,
			minimizeTerminalNode,
			closeTerminalNode,
			renameTerminalNode,
			persistTerminalGraph,
		],
	);

	// Restore terminal nodes from persisted openedTerminals on first load
	const restoredTerminalsRef = useRef(false);
	useEffect(() => {
		if (restoredTerminalsRef.current || openedTerminals.length === 0) return;
		restoredTerminalsRef.current = true;
		for (const t of openedTerminals) {
			if (!t.chapterId) continue;
			const chapterNode = nodesRef.current.find((n) => n.id === t.chapterId);
			const x = t.graphX ?? (chapterNode?.position?.x ?? 0) + 320;
			const y = t.graphY ?? chapterNode?.position?.y ?? 0;
			spawnTerminalNode(
				t.id,
				t.name,
				t.chapterId,
				{ x, y },
				{
					w: t.graphWidth ?? 480,
					h: t.graphHeight ?? 360,
				},
			);
		}
	}, [openedTerminals, spawnTerminalNode]);

	const handleOpenTerminal = useCallback(
		(chapterId: string, terminalId: string, terminalName: string) => {
			// Place to the right of the chapter node
			const chapterNode = nodesRef.current.find((n) => n.id === chapterId);
			const x = (chapterNode?.position?.x ?? 0) + (chapterNode?.measured?.width ?? 280) + 40;
			const y = chapterNode?.position?.y ?? 0;
			spawnTerminalNode(terminalId, terminalName, chapterId, { x, y });
		},
		[spawnTerminalNode],
	);

	const handleCreateTerminal = useCallback(
		(chapterId: string) => {
			createTerminalMut.mutate(undefined, {
				onSuccess: (data: { id: string; name?: string }) => {
					const chapterNode = nodesRef.current.find((n) => n.id === chapterId);
					const x = (chapterNode?.position?.x ?? 0) + (chapterNode?.measured?.width ?? 280) + 40;
					const y = chapterNode?.position?.y ?? 0;
					spawnTerminalNode(data.id, data.name ?? "Terminal", chapterId, { x, y });
				},
			});
		},
		[createTerminalMut, spawnTerminalNode],
	);

	const handleDragTerminal = useCallback(
		(
			chapterId: string,
			terminal: { id: string; name: string } | "new",
			screenX: number,
			screenY: number,
		) => {
			const rfInstance = reactFlowRef.current;
			if (!rfInstance) return;
			const flowPos = rfInstance.screenToFlowPosition({ x: screenX, y: screenY });

			if (terminal === "new") {
				createTerminalMut.mutate(undefined, {
					onSuccess: (data: { id: string; name?: string }) => {
						spawnTerminalNode(data.id, data.name ?? "Terminal", chapterId, flowPos);
					},
				});
			} else {
				spawnTerminalNode(terminal.id, terminal.name, chapterId, flowPos);
			}
		},
		[createTerminalMut, spawnTerminalNode],
	);

	// --- Unified draft node logic (fork + merge) ---
	const draftIdCounter = useRef(0);

	const removeDraft = useCallback(
		(draftNodeId: string) => {
			const nextNodes = nodesRef.current.filter((n) => n.id !== draftNodeId);
			nodesRef.current = nextNodes;
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
		},
		[recomputeEdges],
	);

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
		return { x: count > 0 ? sumX / count - DRAFT_NODE_WIDTH / 2 : 0, y: maxY + 60 };
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
			const nextNodes = [...nodesRef.current, draftNode];
			nodesRef.current = nextNodes;
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
			// Fit view to draft node and its related nodes
			const fitNodeIds = new Set([draftId]);
			if (extra.parentChapterId) fitNodeIds.add(extra.parentChapterId);
			if (extra.targetChapterId) fitNodeIds.add(extra.targetChapterId);
			for (const id of extra.sourceChapterIds ?? []) fitNodeIds.add(id);
			requestAnimationFrame(() => {
				reactFlowRef.current?.fitView({
					padding: 0.2,
					duration: 200,
					nodes: nextNodes.filter((n) => fitNodeIds.has(n.id)),
				});
			});
		},
		[handleDraftConfirm, recomputeEdges, removeDraft],
	);

	const handleFork = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			const sourceNode = nodesRef.current.find((n) => n.id === nodeId);
			const sourceX = sourceNode?.position?.x ?? 0;
			const sourceY = sourceNode?.position?.y ?? 0;
			const sourceW = sourceNode?.measured?.width ?? sourceNode?.width ?? DRAFT_NODE_WIDTH;
			const sourceH = sourceNode?.measured?.height ?? sourceNode?.height ?? 120;
			const draftX = sourceX + sourceW / 2 - DRAFT_NODE_WIDTH / 2;
			spawnDraft("fork", { x: draftX, y: sourceY + sourceH + 60 }, { parentChapterId: nodeId });
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
			const node = nodes.find((n) => n.id === nodeId);
			const title = (node?.data as { title?: string } | undefined)?.title ?? nodeId;
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
					onInit={(instance) => {
						reactFlowRef.current = instance;
						tryFocusChapter();
					}}
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
					onlyRenderVisibleElements
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
						terminals={terminalBubbles}
						onOpenTerminal={handleOpenTerminal}
						onCreateTerminal={handleCreateTerminal}
						onDragTerminal={handleDragTerminal}
					/>
					<Background />
					<Controls>
						<ControlButton
							title={pcDragMode === "select" ? t("controls.selectMode") : t("controls.panMode")}
							onClick={() => setAndPersistDragMode((m) => (m === "select" ? "pan" : "select"))}
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
