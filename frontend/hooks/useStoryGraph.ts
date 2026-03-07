import dagre from "@dagrejs/dagre";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";

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
		type?: "fork" | "merge" | "dependency" | "cherry_pick";
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

function assignEdgeHandles(nodes: GraphNode[], edges: GraphEdge[]): GraphEdge[] {
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
			return { ...edge, sourceHandle: "bottom-src", targetHandle: "top" };
		}

		if (edgeType === "merge") {
			// source = branch being merged, target = merge destination (trunk/root)
			// Connect from the side of the branch facing the root,
			// into the side of the root facing the branch.
			const dx = sourceNode.position.x - targetNode.position.x;
			const dy = sourceNode.position.y - targetNode.position.y;
			const absDx = Math.abs(dx);
			const absDy = Math.abs(dy);

			if (absDx >= absDy) {
				if (dx < 0) {
					// Branch is left of root → branch right side → root left side
					return { ...edge, sourceHandle: "right-src", targetHandle: "left" };
				}
				// Branch is right of root → branch left side → root right side
				return { ...edge, sourceHandle: "left-src", targetHandle: "right" };
			}
			if (dy < 0) {
				// Branch is above root → branch bottom → root top
				return { ...edge, sourceHandle: "bottom-src", targetHandle: "top" };
			}
			// Branch is below root → branch top → root bottom
			return { ...edge, sourceHandle: "top-src", targetHandle: "bottom" };
		}

		return assignAdaptiveHandles(edge, sourceNode, targetNode);
	});
}

export function useStoryGraph(projectId: string) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["storyGraph", projectId],
		queryFn: () => api.getProjectGraph(projectId),
		enabled: !!projectId,
		refetchInterval: 30_000, // Refresh every 30s to pick up git changes
	});

	const layoutData = useMemo(() => {
		if (!data)
			return {
				nodes: [] as GraphNode[],
				edges: [] as GraphEdge[],
				explorationGroups: [] as ExplorationGroup[],
			};
		const layoutNodes = applyDagreLayout(data.nodes as GraphNode[], data.edges as GraphEdge[]);
		const layoutEdges = assignEdgeHandles(layoutNodes, data.edges as GraphEdge[]);
		return {
			nodes: layoutNodes,
			edges: layoutEdges,
			explorationGroups: (data.explorationGroups ?? []) as ExplorationGroup[],
		};
	}, [data]);

	return { ...layoutData, isLoading, error };
}
