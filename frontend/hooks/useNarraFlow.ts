import dagre from "@dagrejs/dagre";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { type DetachedNode, parseDetachedNodes } from "../components/graph/dock/detached-panels";
import { api } from "../lib/api";
import type { ProjectGraphResponse } from "../lib/api/projects";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 120;

export interface GraphNode {
	id: string;
	type?: string;
	data: {
		label: string;
		status: string;
		role?: string;
		color?: string;
		groupLabel?: string;
		explorationGroupId?: string;
		hasUpstreamUpdates?: boolean;
		[key: string]: unknown;
	};
	/**
	 * Nullable until laid out: the server sends null for a chapter never placed by
	 * hand on the classic canvas, and `applyDagreLayout` fills those in.
	 *
	 * `useNarraFlow` only ever returns {@link PositionedGraphNode}, so consumers see
	 * concrete numbers as React Flow requires; the nulls exist strictly between the
	 * fetch and the layout pass.
	 */
	position: { x: number | null; y: number | null };
}

/** A {@link GraphNode} after layout, with both coordinates resolved. */
export interface PositionedGraphNode extends GraphNode {
	position: { x: number; y: number };
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	type?: string;
	sourceHandle?: string;
	targetHandle?: string;
	data?: {
		type?: "fork" | "merge" | "dependency" | "cherry_pick" | "review";
		[key: string]: unknown;
	};
}

// `ExplorationGroup` used to be exported here and populated from the graph response on
// every fetch, but no component ever rendered it, and its `chapterIds` field was never
// sent by the server — anyone writing UI against it would have read `undefined`. The
// graph endpoint no longer returns the rows at all.

/**
 * A node the user has positioned by hand, and which dagre must therefore leave alone.
 *
 * Keyed off an explicit null check rather than "not at the origin". The server sends
 * null for a chapter never placed on THIS canvas, so 0,0 is now a real, respected
 * position instead of a sentinel — dragging a node to the origin used to make the
 * next load treat it as unplaced and auto-lay it out somewhere else.
 */
function isManuallyPlaced(node: GraphNode): boolean {
	return node.position != null && node.position.x != null && node.position.y != null;
}

export function applyDagreLayout(nodes: GraphNode[], edges: GraphEdge[]): PositionedGraphNode[] {
	const manualNodes: PositionedGraphNode[] = [];
	const autoNodes: GraphNode[] = [];

	for (const node of nodes) {
		if (isManuallyPlaced(node)) {
			manualNodes.push(node as PositionedGraphNode);
		} else {
			autoNodes.push(node);
		}
	}

	if (autoNodes.length === 0) return manualNodes;

	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 120 });

	for (const node of autoNodes) {
		g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}

	const autoNodeIds = new Set(autoNodes.map((n) => n.id));
	for (const edge of edges) {
		if (autoNodeIds.has(edge.source) && autoNodeIds.has(edge.target)) {
			// Only fork edges participate in dagre vertical ranking.
			// Merge edges connect horizontally and should not affect the hierarchy.
			const edgeType = edge.type ?? edge.data?.type;
			if (edgeType !== "merge") {
				g.setEdge(edge.source, edge.target);
			}
		}
	}

	dagre.layout(g);

	const layoutAutoNodes: PositionedGraphNode[] = autoNodes.map((node) => {
		const pos = g.node(node.id);
		return {
			...node,
			position: {
				x: pos.x - NODE_WIDTH / 2,
				y: pos.y - NODE_HEIGHT / 2,
			},
		};
	});

	return [...manualNodes, ...layoutAutoNodes];
}

function assignAdaptiveHandles(
	edge: GraphEdge,
	sourceNode: PositionedGraphNode,
	targetNode: PositionedGraphNode,
): GraphEdge {
	const dx = targetNode.position.x - sourceNode.position.x;
	const dy = targetNode.position.y - sourceNode.position.y;
	const absDx = Math.abs(dx);
	const absDy = Math.abs(dy);

	if (absDx > absDy * 0.8) {
		if (dx > 0) {
			return { ...edge, sourceHandle: "right-src", targetHandle: "left" };
		}
		return { ...edge, sourceHandle: "left-src", targetHandle: "right" };
	}

	if (dy > 0) {
		return { ...edge, sourceHandle: "bottom-src", targetHandle: "top" };
	}
	return { ...edge, sourceHandle: "top-src", targetHandle: "bottom" };
}

export function assignEdgeHandles(nodes: PositionedGraphNode[], edges: GraphEdge[]): GraphEdge[] {
	const nodeMap = new Map<string, PositionedGraphNode>();
	for (const node of nodes) {
		nodeMap.set(node.id, node);
	}

	return edges.map((edge) => {
		const sourceNode = nodeMap.get(edge.source);
		const targetNode = nodeMap.get(edge.target);
		if (!sourceNode || !targetNode) return edge;

		const edgeType = edge.type ?? edge.data?.type;

		if (edgeType === "fork") {
			// Fork: always vertical. Pick top or bottom based on child position.
			const dy = targetNode.position.y - sourceNode.position.y;
			if (dy >= 0) {
				return { ...edge, sourceHandle: "bottom-src", targetHandle: "top" };
			}
			return { ...edge, sourceHandle: "top-src", targetHandle: "bottom" };
		}

		if (edgeType === "merge") {
			// Merge: always horizontal. Pick left or right based on branch position.
			const dx = sourceNode.position.x - targetNode.position.x;
			if (dx <= 0) {
				// Branch is left of root → branch right side → root left side
				return { ...edge, sourceHandle: "right-src", targetHandle: "left" };
			}
			// Branch is right of root → branch left side → root right side
			return { ...edge, sourceHandle: "left-src", targetHandle: "right" };
		}

		return assignAdaptiveHandles(edge, sourceNode, targetNode);
	});
}

/**
 * One chapter's detached canvas nodes, parsed from the graph response. Each node
 * hosts one or more tool panels (several once nodes have been merged).
 */
export interface ChapterDetachedPanels {
	chapterId: string;
	nodes: DetachedNode[];
}

const NARRA_FLOW_GC_TIME_MS = 60_000;

/**
 * `degraded` and `fallbackMessages` come from fields the graph route really sends
 * (`degraded`, `fallbacks`) and drive the banner in `NarraFlow`.
 *
 * There used to be a third field, `graphReadRefresh`, read from
 * `graph.capabilities.commitSync.graphReadRefresh`. The graph route sends no `capabilities`
 * object at all, so it was always false, and no component consumed it either — a small
 * replica of the health-capabilities layer removed from `usePlatform.ts`.
 */
export interface GraphRuntimeStatus {
	degraded: boolean;
	fallbackMessages: string[];
}

type ProjectGraphFallback = NonNullable<ProjectGraphResponse["fallbacks"]>[number];

function fallbackText(fallback: ProjectGraphFallback, key: string): string {
	const value = fallback[key];
	return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatGraphFallbackMessage(fallback: ProjectGraphFallback): string {
	const feature = fallbackText(fallback, "feature") || "graph";
	const reason =
		fallbackText(fallback, "reason") ||
		fallbackText(fallback, "message") ||
		fallbackText(fallback, "error") ||
		fallbackText(fallback, "code") ||
		"fallback";
	const detail = fallbackText(fallback, "message") || fallbackText(fallback, "error");
	return detail && detail !== reason
		? `${feature}: ${reason} — ${detail}`
		: `${feature}: ${reason}`;
}

export function summarizeGraphRuntimeState(graph?: ProjectGraphResponse): GraphRuntimeStatus {
	const fallbacks = Array.isArray(graph?.fallbacks) ? graph.fallbacks : [];
	const fallbackMessages = fallbacks.map((fallback) => formatGraphFallbackMessage(fallback));
	return {
		degraded: graph?.degraded === true || fallbackMessages.length > 0,
		fallbackMessages,
	};
}

export function useNarraFlow(projectId: string) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["narraFlow", projectId],
		queryFn: () => api.getProjectGraph(projectId),
		enabled: !!projectId,
		refetchInterval: 60_000, // Fallback polling for external git changes not covered by WS events
		gcTime: NARRA_FLOW_GC_TIME_MS,
	});

	const layoutData = useMemo(() => {
		if (!data)
			return {
				nodes: [] as PositionedGraphNode[],
				edges: [] as GraphEdge[],
				detachedPanels: [] as ChapterDetachedPanels[],
			};
		// The graph endpoint sends classic's own coordinates (chapters.graphX/graphY),
		// already in React Flow's world space, with null meaning "never placed here".
		//
		// It used to send ruler's anchorCommitSha/axisOffset/crossOffset and this mapped
		// axisOffset → x, crossOffset → y while dropping the anchor. Those offsets are
		// relative to a commit tick (240px apart), so a chapter deep in history carried
		// a five-figure offset: read as world coordinates the nodes landed far off
		// screen, fitView zoomed out to near-nothing, and the canvas looked blank.
		const mappedNodes = (
			data.nodes as Array<
				Omit<GraphNode, "position"> & {
					position: { x: number | null; y: number | null };
				}
			>
		).map((n) => ({
			...n,
			position: { x: n.position.x, y: n.position.y },
		}));
		const layoutNodes = applyDagreLayout(mappedNodes, data.edges as GraphEdge[]);
		return {
			nodes: layoutNodes,
			edges: data.edges as GraphEdge[],
			// Parsed here so the raw envelope format has a single parser, and entries
			// that survive validation are the only ones the canvas ever sees. Chapters
			// whose list is empty after validation are dropped entirely.
			detachedPanels: (data.detachedPanels ?? []).reduce<ChapterDetachedPanels[]>((acc, entry) => {
				const nodes = parseDetachedNodes(entry.panels);
				if (nodes.length > 0) acc.push({ chapterId: entry.chapterId, nodes });
				return acc;
			}, []),
		};
	}, [data]);

	const graphRuntimeStatus = useMemo(() => summarizeGraphRuntimeState(data), [data]);

	return { ...layoutData, graphRuntimeStatus, isLoading, error };
}
