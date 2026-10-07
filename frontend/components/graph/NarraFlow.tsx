import {
	applyNodeChanges,
	Background,
	ControlButton,
	Controls,
	type Edge,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	ReactFlow,
	type ReactFlowInstance,
	useReactFlow,
	type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import "@frontend/styles/react-flow-controls.css";
import { useDeleteChapter, useUpdateChapter } from "@frontend/hooks/useChapters";
import { useUpdateGraphPositions } from "@frontend/hooks/useGraphPositions";
import { useNarraFlow } from "@frontend/hooks/useNarraFlow";
import { type NarratorListWSEvent, useNarratorsListWS } from "@frontend/hooks/useNarratorWS";
import {
	useChapterBatchMergeCapability,
	useFsRevealCapability,
	useNarratorReviewToolsCapability,
} from "@frontend/hooks/usePlatform";

import { useUserPreferences } from "@frontend/hooks/useUserPreferences";
import { api } from "@frontend/lib/api";
import { buildDraftForkRequest } from "@frontend/lib/chapter-fork-options";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { notifyResultWarnings } from "@frontend/lib/operation-warnings";
import { onPanelDragEnd, onPanelDragMove, type PanelDragState } from "@frontend/lib/panel-drag";
import { Z } from "@frontend/lib/z-index";
import {
	Alert,
	Box,
	Button,
	Group,
	Modal,
	Paper,
	Stack,
	Text,
	useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconHandGrab, IconPointer } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
// Re-exported by dockview-react from dockview-core; publishes the panel behind an
// in-flight tab drag (native DnD gives us no other way to identify it).
import { getPanelData, type SerializedDockview } from "dockview-react";
import { useTranslation } from "react-i18next";
import { ChapterNode, MIN_RESIZE_WIDTH as MIN_EXPANDED_NODE_WIDTH } from "./ChapterNode";
import { CherryPickEdge } from "./CherryPickEdge";
import { DRAFT_NODE_WIDTH, type DraftMode, DraftNode } from "./DraftNode";
import { resolvePanelDragSource } from "./dock/cross-surface-drop";
import { DETACHED_GRIP_CLASS, DetachedPanelNode } from "./dock/DetachedPanelNode";
import { resolveCanvasDropTarget, toRect } from "./dock/detach-hit-test";
import { isDetachablePanelKind } from "./dock/detachable";
import {
	addDetachedNode,
	type DetachedNode,
	type DetachedPanelEntry,
	generateDetachedPanelId,
	makePanelEntry,
	removeDetachedNode,
	serializeDetachedNodes,
	setDetachedLayout,
} from "./dock/detached-panels";
import { getSurfaceChapterId } from "./dock/dock-registry";
import { resolveExpandRequest } from "./dock/expand-limit";
import { resolveTabDetachSubject } from "./dock/tab-detach";
import { ForkEdge } from "./ForkEdge";
import { LassoSelection } from "./LassoSelection";
import { MergeEdge } from "./MergeEdge";
import { NodeContextMenu } from "./NodeContextMenu";
import { ReviewEdge } from "./ReviewEdge";
import { ReviewNode } from "./ReviewNode";
import { SelectionToolbar } from "./SelectionToolbar";
import { TerminalEdge } from "./TerminalEdge";

const nodeTypes = {
	chapterNode: ChapterNode,
	draftNode: DraftNode,
	reviewNode: ReviewNode,
	detachedPanelNode: DetachedPanelNode,
};
const edgeTypes = {
	fork: ForkEdge,
	merge: MergeEdge,
	cherry_pick: CherryPickEdge,
	terminal: TerminalEdge,
	review: ReviewEdge,
};

/**
 * Build the React Flow node for a detached panel node.
 *
 * `dragHandle` is the node's own grip bar, and only that: the dockview surface
 * below owns its whole tab strip (including the blank area, which dockview uses to
 * drag a group), so pointing the handle at anything inside it would stack two drag
 * mechanisms on one element.
 *
 * `previous` carries over the live React Flow state (selection, measured size) when
 * the node already existed.
 */
function detachedNodeToFlowNode(entry: DetachedNode, chapterId: string, previous?: Node): Node {
	return {
		...(previous ?? {}),
		id: entry.id,
		type: "detachedPanelNode",
		position: previous?.position ?? { x: entry.x, y: entry.y },
		dragHandle: `.${DETACHED_GRIP_CLASS}`,
		style: previous?.style ?? { width: entry.w, height: entry.h },
		data: {
			...((previous?.data as Record<string, unknown>) ?? {}),
			panelId: entry.id,
			chapterId,
			...(entry.layout ? { layout: entry.layout } : {}),
			...(entry.pendingPanels ? { pendingPanels: entry.pendingPanels } : {}),
		},
		selected: previous?.selected ?? false,
	};
}

function areStringArraysEqual(a?: readonly string[] | null, b?: readonly string[] | null): boolean {
	const left = a ?? [];
	const right = b ?? [];
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

type MergeProgressEvent = {
	type: string;
	mergeSessionId?: string;
	projectId?: string;
	targetChapterId?: string;
	sourceChapterId?: string;
	sourceChapterIds?: string[];
	currentIndex?: number;
	index?: number;
	mergedCount?: number;
	totalCount?: number;
	total?: number;
	conflictFiles?: string[];
	narratorId?: string;
	error?: string;
	message?: string;
};

type MergeDecision = "continue" | "cancel";

type PendingMergeSession = {
	draftNodeId?: string;
	sourceChapterIds: string[];
	targetChapterId?: string;
};

interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string;
	nodeData: {
		title: string;
		status: string;
		role: string;
		isRoot?: boolean;
		worktreePath?: string | null;
		reviewStatus?: string | null;
	};
}

const PAN_SPEED = 1.5;

/**
 * Delegated Ctrl+wheel passthrough for all `.nowheel` containers inside graph nodes.
 * Instead of each node registering its own wheel listener, this single capture-phase
 * listener on the ReactFlow root temporarily removes `.nowheel` so the event bubbles
 * through to ReactFlow's zoom handler.
 */
function NowheelPassthrough() {
	useEffect(() => {
		const root = document.querySelector(".react-flow") as HTMLElement | null;
		if (!root) return;

		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			const el = (e.target as HTMLElement).closest?.(".nowheel") as HTMLElement | null;
			if (!el || !root.contains(el)) return;
			el.classList.remove("nowheel");
			requestAnimationFrame(() => el.classList.add("nowheel"));
		};

		root.addEventListener("wheel", onWheel, { capture: true, passive: true });
		return () => root.removeEventListener("wheel", onWheel, { capture: true });
	}, []);

	return null;
}

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
const DETACHED_PANEL_EDGE_PREFIX = "__detached_panel_edge_";

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
	return edgeId.startsWith(DRAFT_EDGE_PREFIX) || edgeId.startsWith(DETACHED_PANEL_EDGE_PREFIX);
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
	const reviewToolsCapability = useNarratorReviewToolsCapability();
	const fsRevealCapability = useFsRevealCapability();
	const batchMergeCapability = useChapterBatchMergeCapability();
	const batchMergeSupported =
		batchMergeCapability.supported && batchMergeCapability.startRouteSupported;
	const reviewActions = useMemo(
		() => ({
			request: reviewToolsCapability.supported,
			convertToSubagent: reviewToolsCapability.supported && reviewToolsCapability.convertToSubagent,
			promote: reviewToolsCapability.supported && reviewToolsCapability.promote,
			dismiss: reviewToolsCapability.supported && reviewToolsCapability.dismiss,
		}),
		[
			reviewToolsCapability.supported,
			reviewToolsCapability.convertToSubagent,
			reviewToolsCapability.promote,
			reviewToolsCapability.dismiss,
		],
	);
	const { data: prefs } = useUserPreferences();
	const {
		nodes: graphNodes,
		edges,
		graphRuntimeStatus,
		isLoading,
		error,
		detachedPanels: detachedPanelGroups,
	} = useNarraFlow(projectId);
	const { savePosition, savePanelState } = useUpdateGraphPositions(projectId);
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
		onSuccess: (result) => {
			// An unmerge can succeed while leaving state behind — a restored worktree it
			// could not clean, snapshot content it could not verify. The server joins
			// those into `warning`; invalidating and moving on discarded them.
			notifyResultWarnings(t("unmergeWarning"), result);
			queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
		},
	});

	const deleteChapter = useDeleteChapter();
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	// `hasWorktree` decides which confirmation text is shown. The server only reaches its
	// `deleteBranch` call inside an `if (chapter.worktreePath)` block, so a chapter
	// without one — every snapshot-merged chapter, whose worktreePath is cleared on
	// merge — keeps its git branch after deletion. Promising "the branch will be
	// removed" there was simply untrue.
	const [deleteTarget, setDeleteTarget] = useState<{
		id: string;
		title: string;
		hasWorktree: boolean;
	} | null>(null);
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
	const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const nodesRef = useRef<Node[]>(nodes);
	nodesRef.current = nodes;
	const computedEdgesRef = useRef<Edge[]>(computedEdges);
	computedEdgesRef.current = computedEdges;
	const movedNodeIdsRef = useRef<Set<string>>(new Set());

	// Parse server-side viewport map and keep in a ref for synchronous access
	const savedViewportsRef = useRef<Record<string, Viewport>>({});
	useMemo(() => {
		try {
			const raw = (prefs as Record<string, unknown> | undefined)?.graphViewports;
			if (typeof raw === "string") {
				savedViewportsRef.current = JSON.parse(raw);
			} else if (raw && typeof raw === "object") {
				savedViewportsRef.current = raw as Record<string, Viewport>;
			}
		} catch {
			savedViewportsRef.current = {};
		}
	}, [prefs]);

	// Debounced viewport save — fires after user stops panning/zooming
	const handleMoveEnd = useCallback(
		(_event: unknown, viewport: Viewport) => {
			if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
			viewportSaveTimerRef.current = setTimeout(() => {
				savedViewportsRef.current[projectId] = viewport;
				api.saveGraphViewport(projectId, viewport);
			}, 500);
		},
		[projectId],
	);

	// Cleanup viewport save timer on unmount
	useEffect(() => {
		return () => {
			if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
		};
	}, []);

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

	// Restore saved viewport or fitView on init
	const restoreViewport = useCallback(
		(instance: ReactFlowInstance) => {
			if (focusChapterId) {
				tryFocusChapter();
				return;
			}
			const saved = savedViewportsRef.current[projectId];
			if (saved) {
				instance.setViewport(saved);
				return;
			}
			instance.fitView({ padding: 0.2 });
		},
		[projectId, focusChapterId, tryFocusChapter],
	);

	const handleInit = useCallback(
		(instance: ReactFlowInstance) => {
			reactFlowRef.current = instance;
			restoreViewport(instance);
		},
		[restoreViewport],
	);

	// When projectId changes without remount (e.g. switching projects in nav),
	// save the old viewport and restore the new project's viewport.
	const prevProjectIdRef = useRef(projectId);
	useEffect(() => {
		if (prevProjectIdRef.current === projectId) return;
		const instance = reactFlowRef.current;
		// Save viewport for the project we're leaving
		if (instance) {
			const vp = instance.getViewport();
			savedViewportsRef.current[prevProjectIdRef.current] = vp;
			api.saveGraphViewport(prevProjectIdRef.current, vp);
		}
		prevProjectIdRef.current = projectId;
		// Restore viewport for the new project once nodes are ready
		if (instance) {
			restoreViewport(instance);
		}
	}, [projectId, restoreViewport]);

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
				narratorSubstatus: string[] | null;
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
					// Sizes persisted before the node hosted a dockview can be narrower
					// than a cluster needs (the old minimum was 280px). Restoring one
					// verbatim would show a squeezed surface whose split tool panel is
					// unusable, so widen it to the current minimum.
					panelSizesRef.current.set(node.id, {
						w: Math.max(d.panelWidth, MIN_EXPANDED_NODE_WIDTH),
						h: d.panelHeight,
					});
				}
			}
		}
		if (restored.size > 0) setExpandedNodes(restored);
	}, [graphNodes]);

	// Drop UI-only graph state for nodes that disappeared from the server graph.
	useEffect(() => {
		const validNodeIds = new Set(graphNodes.map((node) => node.id));
		for (const nodeId of panelSizesRef.current.keys()) {
			if (!validNodeIds.has(nodeId)) panelSizesRef.current.delete(nodeId);
		}
		setExpandedNodes((prev) => {
			let changed = false;
			const next = new Set<string>();
			for (const nodeId of prev) {
				if (validNodeIds.has(nodeId)) {
					next.add(nodeId);
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
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
			// Each expanded node hosts a live dockview surface (its own ResizeObserver,
			// splitview, and every open panel's WebSocket / xterm session), so the
			// number of them is capped. Collapsing is always permitted.
			const request = resolveExpandRequest(expandedNodesRef.current, chapterId);
			if (request.action === "refuse") {
				notifications.show({
					message: t("nodeDock.expandLimitReached", { limit: request.limit }),
					color: "yellow",
				});
				return;
			}

			setExpandedNodes((prev) => {
				const next = new Set(prev);
				const willExpand = request.action === "expand";
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
		[savePanelState, t],
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

			// Detached tool panels link back to the chapter they were torn out of.
			// `type: "terminal"` is the ATTACHMENT edge style (dashed, teal): it denotes
			// "a thing belonging to this chapter" rather than a fork/merge relationship
			// in the story. The name is historical — it once served terminal nodes too.
			if (n.type === "detachedPanelNode") {
				const panelData = n.data as { chapterId?: string };
				if (panelData.chapterId && nodeMap.has(panelData.chapterId)) {
					localEdges.push(
						assignEdgeHandlesForNodeMap(
							{
								id: `${DETACHED_PANEL_EDGE_PREFIX}${n.id}`,
								source: panelData.chapterId,
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
					// An attachment node's edge depends on BOTH ends, so a change to either
					// the node or its chapter has to rebuild it.
					if (node.type === "detachedPanelNode") {
						if (affectedNodeIds.has(node.id)) return true;
						const panelData = node.data as { chapterId?: string };
						return !!panelData.chapterId && affectedNodeIds.has(panelData.chapterId);
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

	// ── Detached tool panels ──
	//
	// The nodes live in `nodes` state (like terminal nodes) because React Flow applies
	// drag and resize changes there. `nodes` is therefore the single source of truth
	// while mounted; the server column is written from it, per chapter.

	/** Read a detached React Flow node back into its stored shape. */
	const readDetachedNode = useCallback((node: Node): DetachedNode | null => {
		const d = node.data as {
			panelId?: string;
			layout?: SerializedDockview;
			pendingPanels?: DetachedPanelEntry[];
		};
		// Neither a layout nor a pending list means nothing to render or restore.
		if (!d.panelId || (!d.layout && !d.pendingPanels?.length)) return null;
		const size = detachedSizesRef.current.get(node.id);
		return {
			id: d.panelId,
			x: node.position.x,
			y: node.position.y,
			w: size?.w ?? (node.style?.width as number) ?? 480,
			h: size?.h ?? (node.style?.height as number) ?? 360,
			...(d.layout ? { layout: d.layout } : {}),
			...(d.pendingPanels ? { pendingPanels: d.pendingPanels } : {}),
		};
	}, []);

	/** Rebuild one chapter's stored list from the live nodes and persist it. */
	const persistDetachedForChapter = useCallback(
		(chapterId: string, allNodes: Node[]) => {
			const detached: DetachedNode[] = [];
			for (const node of allNodes) {
				if (node.type !== "detachedPanelNode") continue;
				if ((node.data as { chapterId?: string }).chapterId !== chapterId) continue;
				const entry = readDetachedNode(node);
				if (entry) detached.push(entry);
			}
			const serialized = serializeDetachedNodes(detached);
			// null means over the size cap; the request would be rejected, so skip it
			// rather than fire a doomed write.
			if (serialized === null) return;
			api.updateChapterDetachedPanels(chapterId, serialized).catch(() => {});
		},
		[readDetachedNode],
	);

	/** Live sizes of detached nodes, tracked from resize changes (like terminals). */
	const detachedSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());

	/**
	 * Apply a change to the detached nodes of ONE chapter: swap in the new list,
	 * rebuild the React Flow nodes from it, and persist.
	 *
	 * Every mutation (a layout change, a node added or removed) goes through here so
	 * the live nodes and the stored column cannot drift apart.
	 */
	const applyDetachedChange = useCallback(
		(chapterId: string, mutate: (current: DetachedNode[]) => DetachedNode[] | null) => {
			const current: DetachedNode[] = [];
			for (const node of nodesRef.current) {
				if (node.type !== "detachedPanelNode") continue;
				if ((node.data as { chapterId?: string }).chapterId !== chapterId) continue;
				const entry = readDetachedNode(node);
				if (entry) current.push(entry);
			}
			const next = mutate(current);
			if (!next) return;

			const byId = new Map(next.map((n) => [n.id, n]));
			const seen = new Set<string>();
			const rebuilt: Node[] = [];
			for (const node of nodesRef.current) {
				const isDetachedHere =
					node.type === "detachedPanelNode" &&
					(node.data as { chapterId?: string }).chapterId === chapterId;
				if (!isDetachedHere) {
					rebuilt.push(node);
					continue;
				}
				const entry = byId.get(node.id);
				// Absent from the new list: merged away or closed.
				if (!entry) {
					detachedSizesRef.current.delete(node.id);
					continue;
				}
				seen.add(entry.id);
				rebuilt.push(detachedNodeToFlowNode(entry, chapterId, node));
			}
			// Nodes the mutation created (a tab split out into its own node).
			for (const entry of next) {
				if (seen.has(entry.id)) continue;
				detachedSizesRef.current.set(entry.id, { w: entry.w, h: entry.h });
				rebuilt.push(detachedNodeToFlowNode(entry, chapterId));
			}

			nodesRef.current = rebuilt;
			setNodes(rebuilt);
			recomputeEdges(rebuilt, { full: true });
			persistDetachedForChapter(chapterId, rebuilt);
		},
		[persistDetachedForChapter, readDetachedNode, recomputeEdges],
	);

	/** Chapter owning a live detached node, or undefined when it is not one. */
	const chapterOfDetachedNode = useCallback((nodeId: string): string | undefined => {
		const node = nodesRef.current.find((n) => n.id === nodeId);
		if (node?.type !== "detachedPanelNode") return undefined;
		return (node.data as { chapterId?: string }).chapterId;
	}, []);

	/**
	 * Store a detached node's dockview layout.
	 *
	 * This is the ONLY writer of a node's contents now: everything that used to be a
	 * separate operation (merge, split, close a tab, activate a tab) happens inside
	 * dockview and arrives here as "the layout changed".
	 */
	const saveDetachedLayout = useCallback(
		(nodeId: string, layout: SerializedDockview) => {
			const chapterId = chapterOfDetachedNode(nodeId);
			if (!chapterId) return;
			applyDetachedChange(chapterId, (current) => {
				const next = setDetachedLayout(current, nodeId, layout);
				// Same reference means the node is gone from the list; nothing to write.
				return next === current ? null : next;
			});
		},
		[applyDetachedChange, chapterOfDetachedNode],
	);

	/**
	 * Remove a whole detached node — its surface ran empty, the user closed it, or
	 * another surface took its panels.
	 */
	const removeDetachedPanelNode = useCallback(
		(nodeId: string) => {
			const chapterId = chapterOfDetachedNode(nodeId);
			if (!chapterId) return;
			applyDetachedChange(chapterId, (current) => removeDetachedNode(current, nodeId));
		},
		[applyDetachedChange, chapterOfDetachedNode],
	);

	/** Materialise the chapters' stored detached panels once, on first graph load. */
	const restoredDetachedRef = useRef(false);
	useEffect(() => {
		if (restoredDetachedRef.current || detachedPanelGroups.length === 0) return;
		restoredDetachedRef.current = true;
		const spawned: Node[] = [];
		for (const group of detachedPanelGroups) {
			for (const entry of group.nodes) {
				// `narratorId` is left out here and injected by `nodesForFlow` from live
				// graph data, so a fork or split cannot leave a stale id behind.
				spawned.push(detachedNodeToFlowNode(entry, group.chapterId));
				detachedSizesRef.current.set(entry.id, { w: entry.w, h: entry.h });
			}
		}
		if (spawned.length === 0) return;
		const nextNodes = [...nodesRef.current, ...spawned];
		nodesRef.current = nextNodes;
		setNodes(nextNodes);
		recomputeEdges(nextNodes, { full: true });
	}, [detachedPanelGroups, recomputeEdges]);

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

	type LiveNarratorStatus = { status?: string; substatus?: string[] };
	const liveStatusesRef = useRef(new Map<string, LiveNarratorStatus>());
	const [liveStatusesTick, setLiveStatusesTick] = useState(0);
	// Snapshot the mutable ref for consumers. The copy is what makes this work:
	// the ref holds one Map that is mutated in place, so handing it out directly
	// produced a value that was `Object.is`-equal on every tick — and the memo that
	// renders node status lists it as a dependency, so it never recomputed. Live
	// status only reached the graph when the chapters query happened to refetch.
	// biome-ignore lint/correctness/useExhaustiveDependencies: liveStatusesTick is intentionally used to trigger re-read of the mutable ref
	const liveStatuses = useMemo(() => new Map(liveStatusesRef.current), [liveStatusesTick]);

	const handleNarratorWSUpdate = useCallback(
		(narratorId: string, event: NarratorListWSEvent) => {
			if (event.type !== "status") return;
			const chapterId = narratorIdMap.get(narratorId);
			if (!chapterId) return;

			const prev = liveStatusesRef.current.get(chapterId) ?? {};
			const next = {
				...prev,
				...(event.status !== undefined ? { status: event.status } : {}),
				...(event.substatus !== undefined ? { substatus: event.substatus } : {}),
			};
			if (prev.status !== next.status || !areStringArraysEqual(prev.substatus, next.substatus)) {
				liveStatusesRef.current.set(chapterId, next);
				setLiveStatusesTick((t) => t + 1);
			}
		},
		[narratorIdMap],
	);

	const notifiedMergeSessionsRef = useRef(new Map<string, string>());
	const pendingMergeSessionsRef = useRef(new Map<string, PendingMergeSession>());
	useEffect(() => {
		if (!projectId) return;
		notifiedMergeSessionsRef.current.clear();
		pendingMergeSessionsRef.current.clear();
	}, [projectId]);
	const sendMergeDecision = useCallback(
		(mergeSessionId: string, decision: MergeDecision, notificationId: string) => {
			const sent = narratorWSManager.send({
				type: "merge_decision",
				mergeSessionId,
				decision,
			});
			if (sent) {
				notifications.hide(notificationId);
				notifications.show({
					message:
						decision === "continue"
							? t("selection.mergeDecisionContinueSent")
							: t("selection.mergeDecisionCancelSent"),
					color: decision === "continue" ? "blue" : "yellow",
				});
			} else {
				notifications.show({
					message: t("selection.mergeDecisionFailed"),
					color: "red",
				});
			}
		},
		[t],
	);

	const removePendingDraftNode = useCallback(
		(draftNodeId: string) => {
			const nextNodes = nodesRef.current.filter((n) => n.id !== draftNodeId);
			nodesRef.current = nextNodes;
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
		},
		[recomputeEdges],
	);

	const mergeEventBelongsToCurrentProject = useCallback(
		(event: MergeProgressEvent) => {
			if (event.projectId) return event.projectId === projectId;
			if (event.mergeSessionId && pendingMergeSessionsRef.current.has(event.mergeSessionId)) {
				return true;
			}
			const eventChapterIds = [
				event.targetChapterId,
				event.sourceChapterId,
				...(event.sourceChapterIds ?? []),
			].filter((value): value is string => typeof value === "string" && value.length > 0);
			if (eventChapterIds.length === 0) return false;
			const currentChapterIds = new Set(nodesRef.current.map((node) => node.id));
			return eventChapterIds.some((id) => currentChapterIds.has(id));
		},
		[projectId],
	);

	const handleMergeProgressEvent = useCallback(
		(event: MergeProgressEvent) => {
			if (!event.mergeSessionId || !mergeEventBelongsToCurrentProject(event)) return;
			const pending = pendingMergeSessionsRef.current.get(event.mergeSessionId);
			const notificationKey = `${event.mergeSessionId}:${event.type}:${event.index ?? event.currentIndex ?? ""}:${event.sourceChapterId ?? ""}`;
			const isDuplicate =
				notifiedMergeSessionsRef.current.get(event.mergeSessionId) === notificationKey;
			if (isDuplicate && event.type !== "merge:conflict") return;
			notifiedMergeSessionsRef.current.set(event.mergeSessionId, notificationKey);

			if (event.type === "merge:completed") {
				if (pending?.draftNodeId) removePendingDraftNode(pending.draftNodeId);
				const targetId = event.targetChapterId ?? pending?.targetChapterId;
				const sourceIds = pending?.sourceChapterIds ?? event.sourceChapterIds ?? [];
				if (targetId || sourceIds.length) {
					setExpandedNodes((prev) => {
						const next = new Set(prev);
						for (const id of sourceIds) {
							next.delete(id);
							panelSizesRef.current.delete(id);
						}
						if (targetId) next.add(targetId);
						return next;
					});
				}
				pendingMergeSessionsRef.current.delete(event.mergeSessionId);
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["chapters"] });
				notifications.show({
					message: t("selection.mergeSuccess"),
					color: "green",
				});
			} else if (event.type === "merge:cancelled") {
				pendingMergeSessionsRef.current.delete(event.mergeSessionId);
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["chapters"] });
				notifications.show({
					message: t("selection.mergeCancelled"),
					color: "yellow",
				});
			} else if (event.type === "merge:error") {
				pendingMergeSessionsRef.current.delete(event.mergeSessionId);
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["chapters"] });
				notifications.show({
					message: t("selection.mergeFailed", {
						message: event.error ?? event.message ?? "unknown",
					}),
					color: "red",
				});
			} else if (event.type === "merge:ai_resolving") {
				const targetId = event.targetChapterId ?? pending?.targetChapterId;
				if (targetId) {
					setExpandedNodes((prev) => {
						const next = new Set(prev);
						next.add(targetId);
						return next;
					});
				}
				notifications.show({
					message: t("selection.mergeAiResolving"),
					color: "blue",
				});
			} else if (event.type === "merge:conflict") {
				const notificationId = `merge-conflict-${event.mergeSessionId}`;
				const files = event.conflictFiles?.join(", ") || "unknown";
				const targetId = event.targetChapterId ?? pending?.targetChapterId;
				const openTargetChapter = () => {
					if (pending?.draftNodeId) {
						removePendingDraftNode(pending.draftNodeId);
						pendingMergeSessionsRef.current.set(event.mergeSessionId ?? "", {
							...pending,
							draftNodeId: undefined,
							targetChapterId: targetId ?? pending.targetChapterId,
						});
					}
					if (targetId) {
						setExpandedNodes((prev) => {
							const next = new Set(prev);
							next.add(targetId);
							return next;
						});
					}
					queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
					queryClient.invalidateQueries({ queryKey: ["chapters"] });
				};
				openTargetChapter();
				notifications.show({
					id: notificationId,
					title: t("selection.mergeConflictTitle"),
					message: (
						<Paper bg="transparent" shadow="none">
							<Text size="sm" mb="xs">
								{t("selection.mergeConflict", { files })}
							</Text>
							<Group gap="xs">
								<Button size="xs" variant="light" onClick={openTargetChapter}>
									{t("selection.mergeConflictOpen")}
								</Button>
								<Button
									size="xs"
									onClick={() =>
										sendMergeDecision(event.mergeSessionId ?? "", "continue", notificationId)
									}
								>
									{t("selection.mergeDecisionContinue")}
								</Button>
								<Button
									size="xs"
									variant="light"
									color="red"
									onClick={() =>
										sendMergeDecision(event.mergeSessionId ?? "", "cancel", notificationId)
									}
								>
									{t("selection.mergeDecisionCancel")}
								</Button>
							</Group>
						</Paper>
					),
					color: "yellow",
					autoClose: false,
				});
			}
		},
		[mergeEventBelongsToCurrentProject, queryClient, removePendingDraftNode, sendMergeDecision, t],
	);

	useNarratorsListWS(narratorIdsForWS, handleNarratorWSUpdate, (event) => {
		if (event.type.startsWith("merge:")) handleMergeProgressEvent(event as MergeProgressEvent);
	});

	// Clean up liveStatuses entries for chapters no longer in the graph
	useEffect(() => {
		const validChapterIds = new Set(narratorIdMap.values());
		let changed = false;
		for (const chId of liveStatusesRef.current.keys()) {
			if (!validChapterIds.has(chId)) {
				liveStatusesRef.current.delete(chId);
				changed = true;
			}
		}
		if (changed) setLiveStatusesTick((t) => t + 1);
	}, [narratorIdMap]);

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
				narratorSubstatus: string[] | null;
				onToggleExpand: (chapterId: string) => void;
			}
		>();

		const renderedNodes = nodes.map((node) => {
			const isExpanded = expandedNodes.has(node.id);
			const size = panelSizesRef.current.get(node.id);
			const width = size?.w ?? 380;
			const height = size?.h ?? 640;
			const nodeData = node.data as {
				narratorStatus?: string | null;
				narratorSubstatus?: string[] | null;
			};
			const liveNarratorStatus = liveStatuses.get(node.id);
			const baseNarratorStatus = nodeData.narratorStatus ?? null;
			const baseNarratorSubstatus = nodeData.narratorSubstatus ?? null;
			const narratorStatus = liveNarratorStatus?.status ?? baseNarratorStatus;
			const narratorSubstatus = liveNarratorStatus?.substatus ?? baseNarratorSubstatus;
			const cached = renderedNodeCacheRef.current.get(node.id);

			if (
				cached &&
				cached.sourceNode === node &&
				cached.expanded === isExpanded &&
				cached.width === width &&
				cached.height === height &&
				cached.narratorStatus === narratorStatus &&
				areStringArraysEqual(cached.narratorSubstatus, narratorSubstatus) &&
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
					narratorSubstatus,
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
				narratorSubstatus,
				onToggleExpand: handleToggleExpand,
			};
			nextCache.set(node.id, cacheEntry);
			return renderedNode;
		});

		renderedNodeCacheRef.current = nextCache;
		return renderedNodes;
	}, [nodes, expandedNodes, liveStatuses, handleToggleExpand]);

	/**
	 * Inject the live narrator id (and the close handler) into detached panel nodes.
	 *
	 * The nodes themselves live in `nodes` state like terminal nodes do — React Flow
	 * applies drag/resize changes there, so a derived list could not be moved. Only
	 * the narrator id is injected here, resolved from the same graph data the chapter
	 * node uses: that is why a fork or split which changes a chapter's primary
	 * narrator needs no rewrite of the stored entries.
	 */
	const nodesForFlow = useMemo(() => {
		const narratorByChapter = new Map<string, string | null>();
		for (const node of graphNodes) {
			// biome-ignore lint/suspicious/noExplicitAny: graph node data is dynamic
			narratorByChapter.set(node.id, ((node as any).data?.narratorId as string) ?? null);
		}
		let touched = false;
		const next = nodesWithExpand.map((node) => {
			if (node.type !== "detachedPanelNode") return node;
			const data = node.data as { chapterId?: string; narratorId?: string | null };
			const narratorId = narratorByChapter.get(data.chapterId ?? "") ?? null;
			if (
				data.narratorId === narratorId &&
				node.data.onLayoutChange === saveDetachedLayout &&
				node.data.onCloseNode === removeDetachedPanelNode
			) {
				return node;
			}
			touched = true;
			return {
				...node,
				data: {
					...node.data,
					narratorId,
					onLayoutChange: saveDetachedLayout,
					// Also how a source node disappears after its last panel is dragged
					// away: the surface reports itself empty and this removes it.
					onCloseNode: removeDetachedPanelNode,
				},
			};
		});
		return touched ? next : nodesWithExpand;
	}, [nodesWithExpand, graphNodes, saveDetachedLayout, removeDetachedPanelNode]);

	/** Whether any detached panel node is currently on the canvas. */
	const hasDetachedPanels = useMemo(
		() => nodesForFlow.some((n) => n.type === "detachedPanelNode"),
		[nodesForFlow],
	);

	// Sync local nodes state when upstream graph data changes.
	// Incrementally merge: preserve positions of nodes the user has dragged,
	// keep local-only draft/terminal nodes, and only update nodes whose data
	// actually changed — so React Flow doesn't re-render the entire graph and
	// lose focus / input state inside DraftNode etc.
	const prevGraphNodesRef = useRef(graphNodes);
	useEffect(() => {
		const prev = prevGraphNodesRef.current;
		prevGraphNodesRef.current = graphNodes;

		// Client-owned nodes that must survive a graph refetch: drafts, plus detached
		// tool panels (their positions live in the chapter's own `detachedPanelsJson`,
		// not in the graph node payload).
		const localOnly = nodesRef.current.filter(
			(n) => n.type === "draftNode" || n.type === "detachedPanelNode",
		);

		// Fast path: if the upstream array reference is the same, nothing changed.
		// Exception: if local nodes are empty but graphNodes has data (e.g. component
		// re-mounted with cached query data), we must still initialise.
		const isFirstInit = nodesRef.current.length === 0 && graphNodes.length > 0;
		if (prev === graphNodes && !isFirstInit) return;

		const currentNodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));

		// On first initialisation after remount, treat all nodes as changed so
		// we don't skip the update due to identical references.
		if (isFirstInit) {
			const nextNodes = [...(graphNodes as Node[]), ...localOnly];
			nodesRef.current = nextNodes;
			movedNodeIdsRef.current.clear();
			setNodes(nextNodes);
			recomputeEdges(nextNodes, { full: true });
			return;
		}

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
	/** Chapters whose detached panels were resized, pending a debounced write. */
	const detachedResizeChaptersRef = useRef<Set<string>>(new Set());
	const detachedResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Cleanup timers on unmount
	useEffect(() => {
		return () => {
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
			if (detachedResizeTimerRef.current) clearTimeout(detachedResizeTimerRef.current);
		};
	}, []);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			let hasResize = false;
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
					// Track detached panel resize (persisted per owning chapter below).
					const node = nodesRef.current.find((n) => n.id === change.id);
					if (node?.type === "detachedPanelNode") {
						detachedSizesRef.current.set(change.id, {
							w: change.dimensions.width,
							h: change.dimensions.height,
						});
						const chapterId = (node.data as { chapterId?: string }).chapterId;
						if (chapterId) detachedResizeChaptersRef.current.add(chapterId);
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
			if (detachedResizeChaptersRef.current.size > 0) {
				if (detachedResizeTimerRef.current) clearTimeout(detachedResizeTimerRef.current);
				detachedResizeTimerRef.current = setTimeout(() => {
					for (const chapterId of detachedResizeChaptersRef.current) {
						persistDetachedForChapter(chapterId, nodesRef.current);
					}
					detachedResizeChaptersRef.current.clear();
				}, 800);
			}
		},
		[savePanelState, persistDetachedForChapter],
	);

	const onNodeDragStop: NodeMouseHandler = useCallback(
		(_event, node) => {
			const affectedNodeIds = new Set(movedNodeIdsRef.current);
			affectedNodeIds.add(node.id);
			movedNodeIdsRef.current.clear();
			recomputeEdges(nodesRef.current, { affectedNodeIds });
			// Collected so one write covers every panel moved in this gesture.
			const movedDetachedChapters = new Set<string>();
			for (const nodeId of affectedNodeIds) {
				const movedNode = nodesRef.current.find((n) => n.id === nodeId);
				if (!movedNode || movedNode.type === "draftNode") continue;
				if (movedNode.type === "detachedPanelNode") {
					// Detached panels are stored per chapter, not as graph node positions.
					const chapterId = (movedNode.data as { chapterId?: string }).chapterId;
					if (chapterId) movedDetachedChapters.add(chapterId);
					continue;
				}
				savePosition(movedNode.id, movedNode.position.x, movedNode.position.y);
			}
			for (const chapterId of movedDetachedChapters) {
				persistDetachedForChapter(chapterId, nodesRef.current);
			}
		},
		[recomputeEdges, savePosition, persistDetachedForChapter],
	);

	const onNodeDoubleClick: NodeMouseHandler = useCallback(
		(_event, node) => {
			// Only chapter-like nodes expand or navigate; the rest are attachments.
			if (node.type === "draftNode" || node.type === "detachedPanelNode") return;
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
		// Drafts have no menu; a detached tool panel is not a chapter, so the chapter
		// menu (fork / review / dormant / delete) would act on a non-existent chapter.
		if (node.type === "draftNode" || node.type === "detachedPanelNode") return;
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
				worktreePath: d.worktreePath ?? null,
				reviewStatus: d.reviewStatus ?? null,
			},
		});
	}, []);

	// No `onConnect`: dragging between two node handles used to create a `dependency` edge.
	// Nothing read those edges, and the canvas had no `onEdgesChange`/`onEdgesDelete`, so a
	// stray drag left a permanent orange line the user could not remove. See
	// `server/services/chapter-edge-service.ts` for why the edge type was dropped.

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

	// Derive selected node IDs from nodes state. Only chapter-like nodes count: the
	// selection toolbar offers fork/merge, which are meaningless for an attachment
	// (draft, terminal, detached tool panel) and whose ids are not chapter ids.
	const selectedNodeIds = useMemo(
		() =>
			nodes
				.filter((n) => n.selected && n.type !== "draftNode" && n.type !== "detachedPanelNode")
				.map((n) => n.id),
		[nodes],
	);

	// ── Tear a dock panel out onto the canvas ──
	//
	// The panel-drag singleton is shared by every dockview surface, so this listener
	// sees tool-panel header drags from any node's dock. Releasing over blank canvas
	// detaches; releasing over a dock is that dock's business (its own onDropSubject).
	const detachHintRef = useRef<{ x: number; y: number } | null>(null);
	const [detachHint, setDetachHint] = useState<{ x: number; y: number } | null>(null);

	/** Screen rects of every mounted node dock, in node render order. */
	const collectDockRects = useCallback(() => {
		const rects: Array<{ surfaceId: string; rect: ReturnType<typeof toRect> }> = [];
		for (const el of document.querySelectorAll<HTMLElement>("[data-chapter-node-dock]")) {
			const surfaceId = el.dataset.chapterNodeDock;
			if (!surfaceId) continue;
			rects.push({ surfaceId, rect: toRect(el.getBoundingClientRect()) });
		}
		return rects;
	}, []);

	/** Screen rects of every standalone panel node, in node render order. */
	const collectDetachedRects = useCallback(() => {
		const rects: Array<{ nodeId: string; rect: ReturnType<typeof toRect> }> = [];
		for (const el of document.querySelectorAll<HTMLElement>("[data-detached-node]")) {
			const nodeId = el.dataset.detachedNode;
			if (!nodeId) continue;
			rects.push({ nodeId, rect: toRect(el.getBoundingClientRect()) });
		}
		return rects;
	}, []);

	/**
	 * Classify a viewport point as blank canvas (`detach`), over some node's dock
	 * (`dock`, that dock's business), over a standalone panel node (`detachedNode`,
	 * a merge target), or off-canvas (`outside`).
	 */
	const resolveDropPoint = useCallback(
		(x: number, y: number) => {
			const wrapper = flowWrapperRef.current;
			return resolveCanvasDropTarget(
				wrapper ? toRect(wrapper.getBoundingClientRect()) : null,
				collectDockRects(),
				x,
				y,
				collectDetachedRects(),
			);
		},
		[collectDockRects, collectDetachedRects],
	);

	/** Whether this drag is a tool panel that may be torn out. */
	const isDetachableDrag = useCallback((state: PanelDragState) => {
		return (
			state.subjectKind === "tool" &&
			!!state.panelId && // a live dock panel (a detached one has none)
			isDetachablePanelKind(state.toolKind)
		);
	}, []);

	/**
	 * Guard a whole-node drag that started on a detached node's grip bar.
	 *
	 * Very little happens here, because each release point already has an owner:
	 *
	 *  - over another surface (detached node or chapter dock) → that surface's
	 *    `onDropSubject` takes the panel and releases the source node
	 *  - over blank canvas → React Flow already moved the node and
	 *    `onNodeDragStop` persisted it
	 *  - outside the canvas → cancelled
	 *
	 * The one thing this must still do is refuse a cross-chapter drop: detached nodes
	 * are persisted per chapter, so a surface cannot hold panels from two chapters —
	 * there would be no column to store the result in. Without this the drop would
	 * appear to work and then vanish on reload.
	 */
	const guardDetachedNodeDrop = useCallback(
		(final: PanelDragState) => {
			const chapterId = chapterOfDetachedNode(final.id);
			if (!chapterId) return;
			const target = resolveDropPoint(final.x, final.y);
			const targetChapter =
				target.kind === "detachedNode"
					? chapterOfDetachedNode(target.nodeId)
					: target.kind === "dock"
						? target.surfaceId
						: undefined;
			if (targetChapter && targetChapter !== chapterId) {
				notifications.show({ message: t("nodeDock.mergeForeignChapter"), color: "yellow" });
			}
		},
		[chapterOfDetachedNode, resolveDropPoint, t],
	);

	/**
	 * Move a live dock panel onto the canvas as its own node.
	 *
	 * Shared by BOTH tear-out routes — a panel header drag (pointer-driven, via the
	 * panel-drag singleton) and a dockview tab drag (HTML5 native DnD) — because the
	 * ordering here is a correctness requirement, not a preference: the source panel
	 * must be closed BEFORE the node is placed, or a failure in between leaves the
	 * same panel living in two places at once. Two copies of that would drift.
	 *
	 * `screenX/screenY` are viewport coordinates of the release point.
	 */
	const detachPanelToCanvas = useCallback(
		(input: {
			chapterId: string;
			surfaceId: string;
			panelId: string;
			kind: string | undefined;
			resourceId?: string;
			largeFileConfirmed?: boolean;
			screenX: number;
			screenY: number;
		}) => {
			const { chapterId, panelId, kind, resourceId } = input;
			if (!isDetachablePanelKind(kind)) return;

			// The canvas holds no DockviewApi of its own, so it reaches the originating
			// dock through the registry. If that lookup fails — node collapsed mid-drag,
			// panel already closed — abandon the tear-out entirely: placing the node
			// anyway would leave the same panel both on the canvas and in the dock.
			const source = resolvePanelDragSource({
				surfaceId: input.surfaceId,
				panelId,
				toolKind: kind,
				resourceId,
				largeFileConfirmed: input.largeFileConfirmed,
			});
			if (!source) return;

			const position = reactFlowRef.current?.screenToFlowPosition({
				x: input.screenX,
				y: input.screenY,
			}) ?? { x: 0, y: 0 };

			let refusal: "limit" | "duplicate" | null = null;
			let limit = 0;
			applyDetachedChange(chapterId, (current) => {
				const result = addDetachedNode(current, {
					id: generateDetachedPanelId(),
					x: position.x,
					y: position.y,
					w: 480,
					h: 360,
					// No layout yet: the surface builds one on first mount and persists it.
					pendingPanels: [makePanelEntry(kind, source.subject.resourceId, source.subject)],
				});
				if (!result.ok) {
					refusal = result.reason;
					if (result.reason === "limit") limit = result.limit;
					return null;
				}
				// Close the dock panel BEFORE the node is placed. If this order were
				// reversed and the close failed, the same panel would exist in both
				// places. Inside the mutator so it only runs once the rules passed.
				source.panel.api.close();
				if (source.api.getPanel(panelId)) return null;
				return result.nodes;
			});

			if (refusal) {
				notifications.show({
					message:
						refusal === "limit"
							? t("nodeDock.detachLimitReached", { limit })
							: t("nodeDock.detachDuplicate"),
					color: "yellow",
				});
			}
		},
		[applyDetachedChange, t],
	);

	useEffect(() => {
		const clearHint = () => {
			if (detachHintRef.current) {
				detachHintRef.current = null;
				setDetachHint(null);
			}
		};

		const unsubMove = onPanelDragMove((state) => {
			// Only a tear-out gets a hint. An already-detached panel being moved needs
			// none: the node itself follows the pointer, so a label trailing it would
			// just be noise restating what is already visible.
			if (!isDetachableDrag(state)) {
				clearHint();
				return;
			}
			const target = resolveDropPoint(state.x, state.y);
			if (target.kind === "detach") {
				detachHintRef.current = { x: state.x, y: state.y };
				setDetachHint({ x: state.x, y: state.y });
			} else {
				clearHint();
			}
		});

		const unsubEnd = onPanelDragEnd((final) => {
			const hint = detachHintRef.current;
			clearHint();
			if (!final) return;

			// A whole-node drag from a grip bar: no `panelId` (it denotes no single
			// panel) and no `toolKind` (a node may hold several kinds).
			if (final.subjectKind === "tool" && !final.panelId && !final.toolKind) {
				guardDetachedNodeDrop(final);
				return;
			}

			// Otherwise a tear-out from a dock. Dragging INTO a dock is that dock's
			// onDropSubject, so only a release over blank canvas reaches here.
			if (!hint || !isDetachableDrag(final)) return;
			const surfaceId = final.surfaceId;
			const chapterId = getSurfaceChapterId(surfaceId);
			const panelId = final.panelId;
			if (!chapterId || !surfaceId || !panelId) return;
			detachPanelToCanvas({
				chapterId,
				surfaceId,
				panelId,
				kind: final.toolKind,
				...(final.resourceId ? { resourceId: final.resourceId } : {}),
				...(final.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
				screenX: hint.x,
				screenY: hint.y,
			});
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [detachPanelToCanvas, guardDetachedNodeDrop, isDetachableDrag, resolveDropPoint]);

	// ── Tear a dock panel out by dragging its TAB (HTML5 native DnD) ──
	//
	// A tab drag never reaches the pointer-driven listeners above, so the canvas has
	// to be a real native drop target. Dockview publishes the dragged panel through
	// `getPanelData()` for the duration of the drag; `resolveTabDetachSubject` turns
	// that into a chapter + kind. See `./dock/tab-detach` for why the hooks dockview
	// appears to offer are unusable.

	/** The in-flight tab drag, when it is one we would accept. */
	const tabDragSubject = useCallback(() => {
		const transfer = getPanelData();
		return resolveTabDetachSubject(transfer?.panelId, transfer?.viewId);
	}, []);

	const handleCanvasDragOver = useCallback(
		(e: React.DragEvent) => {
			const subject = tabDragSubject();
			// Not a droppable tab (chat, details, a foreign drag): do NOT preventDefault,
			// so the browser keeps showing the "cannot drop" cursor rather than inviting
			// a release that would silently do nothing.
			if (!subject) return;
			const target = resolveDropPoint(e.clientX, e.clientY);
			if (target.kind !== "detach") {
				// Over a dock: that dock handles the drop natively. Leaving it
				// un-prevented here keeps this from competing with it.
				if (detachHintRef.current) {
					detachHintRef.current = null;
					setDetachHint(null);
				}
				return;
			}
			// Required by native DnD: without preventDefault on dragover/dragenter the
			// drop event never fires at all.
			e.preventDefault();
			detachHintRef.current = { x: e.clientX, y: e.clientY };
			setDetachHint({ x: e.clientX, y: e.clientY });
		},
		[resolveDropPoint, tabDragSubject],
	);

	const handleCanvasDragLeave = useCallback((e: React.DragEvent) => {
		// Native dragleave also fires when moving BETWEEN descendants, so clearing
		// unconditionally would make the hint flicker while crossing nodes. Only a
		// pointer that left the wrapper entirely counts.
		const next = e.relatedTarget as globalThis.Node | null;
		if (next && flowWrapperRef.current?.contains(next)) return;
		detachHintRef.current = null;
		setDetachHint(null);
	}, []);

	const handleCanvasDrop = useCallback(
		(e: React.DragEvent) => {
			detachHintRef.current = null;
			setDetachHint(null);
			const subject = tabDragSubject();
			if (!subject) return;
			// Re-check the drop point rather than trusting that dockview stopped the
			// event: its droptarget only calls stopPropagation when it actually took
			// the drop (i.e. when it had shown an overlay), and it bails out earlier in
			// several cases — locked group, no quadrant, overlay suppressed. Without
			// this guard a drop over a dock could both merge AND detach the panel.
			if (resolveDropPoint(e.clientX, e.clientY).kind !== "detach") return;
			e.preventDefault();
			detachPanelToCanvas({
				chapterId: subject.chapterId,
				surfaceId: subject.surfaceId,
				panelId: subject.panelId,
				kind: subject.kind,
				...(subject.resourceId ? { resourceId: subject.resourceId } : {}),
				...(subject.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
				screenX: e.clientX,
				screenY: e.clientY,
			});
		},
		[detachPanelToCanvas, resolveDropPoint, tabDragSubject],
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

	// `async` so every exit — including the "neither branch matched" fallthrough —
	// hands the draft node a promise to await. Returning a bare boolean from one
	// path would throw there instead of re-enabling the button.
	const handleDraftConfirm = useCallback(
		async (
			draftNodeId: string,
			payload: {
				title: string;
				description: string;
				inheritMode: string;
				worktreeSource: "workspace" | "commit";
				mode: DraftMode;
				parentChapterId?: string;
				sourceChapterIds?: string[];
				targetChapterId?: string;
			},
		) => {
			if (payload.mode === "fork" && payload.parentChapterId) {
				const draftNode = nodesRef.current.find((n) => n.id === draftNodeId);
				// No `Math.max(0, …)` on y: these are React Flow world coordinates, where
				// negative is simply above the origin. Clamping moved a fork created from a
				// draft dragged above y=0 down onto the axis.
				const draftX = draftNode?.position?.x ?? 0;
				const draftY = draftNode?.position?.y ?? 0;

				return api
					.forkChapter(
						payload.parentChapterId,
						buildDraftForkRequest({
							title: payload.title,
							description: payload.description,
							inheritMode: payload.inheritMode as "fresh" | "compressed" | "full",
							worktreeSource: payload.worktreeSource,
							x: draftX,
							y: draftY,
						}),
					)
					.then(() => {
						removeDraft(draftNodeId);
						queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
						queryClient.invalidateQueries({ queryKey: ["chapters"] });
						queryClient.invalidateQueries({ queryKey: ["narrators"] });
						return true;
					})
					.catch((err) => {
						notifications.show({
							message: t("forkDraft.failed", {
								message: err instanceof Error ? err.message : "unknown",
							}),
							color: "red",
						});
						// The draft stays on the canvas, so it stays the user's to retry.
						return false;
					});
			} else if (payload.mode === "merge" && payload.sourceChapterIds?.length) {
				if (!batchMergeSupported) {
					notifications.show({
						message: batchMergeCapability.reason ?? t("mergeDraft.unsupported"),
						color: "yellow",
					});
					return false;
				}
				// For merge-new: first source is base, rest are sources
				// For merge-into: targetChapterId is base, all sourceChapterIds are sources
				const baseId = payload.targetChapterId ?? payload.sourceChapterIds[0];
				const sourceIds = payload.targetChapterId
					? payload.sourceChapterIds
					: payload.sourceChapterIds.slice(1);

				// All chapters involved as sources (to collapse after merge)
				const allSourceIds = payload.sourceChapterIds;

				return api
					.batchMerge({
						baseChapterId: baseId,
						sourceChapterIds: sourceIds,
						title: payload.title,
					})
					.then((res) => {
						if (res?.mergeSessionId) {
							pendingMergeSessionsRef.current.set(res.mergeSessionId, {
								draftNodeId,
								sourceChapterIds: allSourceIds,
								targetChapterId: res.targetChapterId,
							});
							notifications.show({
								message: t("selection.mergeStarted"),
								color: "blue",
							});
							setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
							return true;
						}
						removeDraft(draftNodeId);
						queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
						queryClient.invalidateQueries({ queryKey: ["chapters"] });
						notifications.show({
							message: t("selection.mergeSuccess"),
							color: "green",
						});
						setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));

						// Collapse merged source nodes, expand the target node
						const targetId = res?.targetChapterId;
						if (targetId || allSourceIds.length) {
							setExpandedNodes((prev) => {
								const next = new Set(prev);
								for (const id of allSourceIds) {
									next.delete(id);
									panelSizesRef.current.delete(id);
								}
								if (targetId) next.add(targetId);
								return next;
							});
						}
						return true;
					})
					.catch((err) => {
						notifications.show({
							message: t("mergeDraft.failed", {
								message: err instanceof Error ? err.message : "unknown",
							}),
							color: "red",
						});
						// The draft stays on the canvas, so it stays the user's to retry.
						return false;
					});
			}
			return false;
		},
		[batchMergeCapability.reason, batchMergeSupported, queryClient, t, removeDraft],
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

	const handleReview = useCallback(
		async (nodeId: string) => {
			setContextMenu(null);
			if (!reviewActions.request) return;
			try {
				const sourceNode = nodesRef.current.find((n) => n.id === nodeId);
				// Classic world coordinates, so no clamp on y (negative is above the
				// origin) and they go in the classic fields rather than ruler's offsets.
				const posX = (sourceNode?.position?.x ?? 0) + 380;
				const posY = sourceNode?.position?.y ?? 0;
				await api.createReview(nodeId, { graphX: posX, graphY: posY });
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["graph"] });
			} catch (err) {
				notifications.show({
					message: err instanceof Error ? err.message : "Failed to create review",
					color: "red",
				});
			}
		},
		[queryClient, reviewActions.request],
	);

	const handleConvertToSubagent = useCallback(
		async (nodeId: string) => {
			setContextMenu(null);
			if (!reviewActions.convertToSubagent) return;
			try {
				await api.convertReviewToSubagent(nodeId);
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["graph"] });
			} catch (err) {
				notifications.show({
					message: err instanceof Error ? err.message : "Failed to convert to subagent",
					color: "red",
				});
			}
		},
		[queryClient, reviewActions.convertToSubagent],
	);

	const handlePromoteReview = useCallback(
		async (nodeId: string) => {
			setContextMenu(null);
			if (!reviewActions.promote) return;
			try {
				await api.promoteReview(nodeId);
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["graph"] });
			} catch (err) {
				notifications.show({
					message: err instanceof Error ? err.message : "Failed to promote review",
					color: "red",
				});
			}
		},
		[queryClient, reviewActions.promote],
	);

	const handleDismissReview = useCallback(
		async (nodeId: string) => {
			setContextMenu(null);
			if (!reviewActions.dismiss) return;
			try {
				await api.dismissReview(nodeId);
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["graph"] });
			} catch (err) {
				notifications.show({
					message: err instanceof Error ? err.message : "Failed to dismiss review",
					color: "red",
				});
			}
		},
		[queryClient, reviewActions.dismiss],
	);

	const handleMergeNew = useCallback(
		(nodeIds: string[]) => {
			if (nodeIds.length < 2) return;
			if (!batchMergeSupported) {
				notifications.show({
					message: batchMergeCapability.reason ?? t("mergeDraft.unsupported"),
					color: "yellow",
				});
				setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
				return;
			}
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
		[batchMergeCapability.reason, batchMergeSupported, spawnDraft, getBboxBottom, t],
	);

	const handleMergeInto = useCallback(
		(sourceNodeIds: string[], targetNodeId: string) => {
			if (sourceNodeIds.length === 0) return;
			if (!batchMergeSupported) {
				notifications.show({
					message: batchMergeCapability.reason ?? t("mergeDraft.unsupported"),
					color: "yellow",
				});
				setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
				return;
			}

			// Merge directly into the existing target chapter — no draft node, no new chapter
			api
				.batchMerge({
					baseChapterId: targetNodeId,
					sourceChapterIds: sourceNodeIds,
					targetChapterId: targetNodeId,
				})
				.then((res) => {
					if (res?.mergeSessionId) {
						pendingMergeSessionsRef.current.set(res.mergeSessionId, {
							sourceChapterIds: sourceNodeIds,
							targetChapterId: targetNodeId,
						});
						notifications.show({
							message: t("selection.mergeStarted"),
							color: "blue",
						});
						setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
						return;
					}
					queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
					queryClient.invalidateQueries({ queryKey: ["chapters"] });
					notifications.show({
						message: t("selection.mergeSuccess"),
						color: "green",
					});
					setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));

					// Collapse merged source nodes, expand the target node
					setExpandedNodes((prev) => {
						const next = new Set(prev);
						for (const id of sourceNodeIds) {
							next.delete(id);
							panelSizesRef.current.delete(id);
						}
						next.add(targetNodeId);
						return next;
					});
				})
				.catch((err) => {
					notifications.show({
						message: t("mergeDraft.failed", {
							message: err instanceof Error ? err.message : "unknown",
						}),
						color: "red",
					});
				});
		},
		[batchMergeCapability.reason, batchMergeSupported, queryClient, t],
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
			const data = node?.data as { title?: string; worktreePath?: string | null } | undefined;
			const title = data?.title ?? nodeId;
			setDeleteTarget({ id: nodeId, title, hasWorktree: !!data?.worktreePath });
		},
		[nodes],
	);

	const handleReveal = useCallback(
		(nodeId: string) => {
			setContextMenu(null);
			if (!fsRevealCapability.supported) return;
			const node = nodes.find((n) => n.id === nodeId);
			const path = (node?.data as { worktreePath?: string | null } | undefined)?.worktreePath;
			if (path) {
				api.fsReveal(path).catch(() => {});
			}
		},
		[fsRevealCapability.supported, nodes],
	);

	const confirmDelete = useCallback(() => {
		if (!deleteTarget) return;
		deleteChapter.mutate(deleteTarget.id, {
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
				queryClient.invalidateQueries({ queryKey: ["narrators"] });
				// Cascade cleanup after the chapter entity is gone. Bypasses removeTab and
				// marks `cascade` so no undo token is minted for a ghost entry.
				api.removeRecentTab("chapter", deleteTarget.id, { cascade: true }).catch(() => {});
				setDeleteTarget(null);
			},
		});
	}, [deleteTarget, deleteChapter, queryClient]);

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
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
			{graphRuntimeStatus.degraded && (
				<Stack gap="xs" p="sm" style={{ flex: "none" }}>
					<Alert color="yellow" variant="light" title={t("runtimeDegradedTitle")}>
						<Text size="sm">{t("runtimeDegradedDesc")}</Text>
					</Alert>
				</Stack>
			)}
			{/* Native DnD handlers, for tearing a panel out by its dockview TAB. dragEnter
			    shares dragOver's logic because native DnD requires preventDefault on both
			    before it will deliver a drop. */}
			<Box
				ref={flowWrapperRef}
				onDragEnter={handleCanvasDragOver}
				onDragOver={handleCanvasDragOver}
				onDragLeave={handleCanvasDragLeave}
				onDrop={handleCanvasDrop}
				style={{ flex: 1, position: "relative", minHeight: 0 }}
			>
				<ReactFlow
					onInit={handleInit}
					onMoveEnd={handleMoveEnd}
					colorMode={colorScheme === "auto" ? "system" : colorScheme}
					nodes={nodesForFlow}
					edges={computedEdges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onNodeDragStop={onNodeDragStop}
					onNodeDoubleClick={onNodeDoubleClick}
					onNodeContextMenu={onNodeContextMenu}
					onPaneClick={onPaneClick}
					nodesDraggable
					elementsSelectable
					// Culling off-screen nodes unmounts them, which for an EXPANDED node means
					// tearing down a whole dockview surface: its terminals lose their xterm,
					// its chat loses its WebSocket, every panel rebuilds on the way back. A
					// DETACHED panel node holds the same kind of live session on its own. So
					// the optimization is disabled while either exists. A collapsed node is
					// just a Card, so rendering all of them costs far less than destroying one
					// live session; with nothing expanded or detached, culling returns.
					onlyRenderVisibleElements={expandedNodes.size === 0 && !hasDetachedPanels}
					panOnDrag={pcDragMode === "pan" ? true : [1]}
					selectionOnDrag={false}
					panOnScroll={false}
					minZoom={0.1}
					maxZoom={4}
					proOptions={{ hideAttribution: true }}
				>
					<ModifierWheelPan />
					<NowheelPassthrough />
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
						reviewActions={reviewActions}
						onClose={() => setContextMenu(null)}
						onFork={handleFork}
						onReview={handleReview}
						onSetRole={handleSetRole}
						onDormant={handleDormant}
						onWake={handleWake}
						onUnmerge={handleUnmerge}
						onDelete={handleDelete}
						onReveal={handleReveal}
						onConvertToSubagent={handleConvertToSubagent}
						onPromoteReview={handlePromoteReview}
						onDismissReview={handleDismissReview}
					/>
				)}
				{/* Tear-out hint: shown while a dock tool panel is dragged over blank
				    canvas, so "release here to detach" is discoverable rather than
				    something the user has to guess. */}
				{detachHint && (
					<Box
						style={{
							position: "fixed",
							left: detachHint.x + 14,
							top: detachHint.y + 14,
							zIndex: Z.graphOverlay,
							pointerEvents: "none",
							padding: "4px 10px",
							borderRadius: "var(--mantine-radius-sm)",
							border: "1px dashed var(--mantine-color-indigo-5)",
							background: "var(--mantine-color-body)",
							whiteSpace: "nowrap",
						}}
					>
						<Text size="xs" c="dimmed">
							{t("nodeDock.releaseToDetach")}
						</Text>
					</Box>
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
						{deleteTarget?.hasWorktree
							? t("contextMenu.deleteConfirmMessage", { title: deleteTarget?.title ?? "" })
							: t("contextMenu.deleteConfirmMessageNoWorktree", {
									title: deleteTarget?.title ?? "",
								})}
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
