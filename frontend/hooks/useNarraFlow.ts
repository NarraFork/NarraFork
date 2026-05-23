import dagre from "@dagrejs/dagre";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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

export interface ExplorationGroup {
	id: string;
	title: string;
	status: string;
	chapterIds: string[];
	[key: string]: unknown;
}

function applyDagreLayout(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
	const manualNodes: GraphNode[] = [];
	const autoNodes: GraphNode[] = [];

	for (const node of nodes) {
		if (node.position && (node.position.x !== 0 || node.position.y !== 0)) {
			manualNodes.push(node);
		} else {
			autoNodes.push(node);
		}
	}

	if (autoNodes.length === 0) return nodes;

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

	const layoutAutoNodes = autoNodes.map((node) => {
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
	sourceNode: GraphNode,
	targetNode: GraphNode,
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

export function assignEdgeHandles(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
	const nodeMap = new Map<string, GraphNode>();
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

export interface OpenedTerminal {
	id: string;
	chapterId: string;
	name: string;
	graphX: number | null;
	graphY: number | null;
	graphWidth: number | null;
	graphHeight: number | null;
}

const NARRA_FLOW_GC_TIME_MS = 60_000;

export interface GraphRuntimeStatus {
	degraded: boolean;
	graphReadRefresh: boolean;
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
	const graphReadRefresh = graph?.capabilities?.commitSync?.graphReadRefresh === true;
	return {
		degraded: graph?.degraded === true || fallbackMessages.length > 0,
		graphReadRefresh,
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
				nodes: [] as GraphNode[],
				edges: [] as GraphEdge[],
				explorationGroups: [] as ExplorationGroup[],
				openedTerminals: [] as OpenedTerminal[],
			};
		// Map server position format (anchorCommitSha/axisOffset/crossOffset) to React Flow x/y.
		// In classic mode, axisOffset → x, crossOffset → y.
		const mappedNodes = (
			data.nodes as Array<
				Omit<GraphNode, "position"> & {
					position: { anchorCommitSha?: string | null; axisOffset: number; crossOffset: number };
				}
			>
		).map((n) => ({
			...n,
			position: {
				x: n.position.axisOffset ?? 0,
				y: n.position.crossOffset ?? 0,
			},
		}));
		const layoutNodes = applyDagreLayout(mappedNodes, data.edges as GraphEdge[]);
		return {
			nodes: layoutNodes,
			edges: data.edges as GraphEdge[],
			explorationGroups: (data.explorationGroups ?? []) as ExplorationGroup[],
			openedTerminals: (data.openedTerminals ?? []) as OpenedTerminal[],
		};
	}, [data]);

	const graphRuntimeStatus = useMemo(() => summarizeGraphRuntimeState(data), [data]);

	return { ...layoutData, graphRuntimeStatus, isLoading, error };
}
