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
			g.setEdge(edge.source, edge.target);
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

export function useStoryGraph(projectId: string) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["storyGraph", projectId],
		queryFn: () => api.getProjectGraph(projectId),
		enabled: !!projectId,
	});

	const layoutData = useMemo(() => {
		if (!data)
			return {
				nodes: [] as GraphNode[],
				edges: [] as GraphEdge[],
				explorationGroups: [] as ExplorationGroup[],
			};
		const layoutNodes = applyDagreLayout(data.nodes as GraphNode[], data.edges as GraphEdge[]);
		return {
			nodes: layoutNodes,
			edges: data.edges as GraphEdge[],
			explorationGroups: (data.explorationGroups ?? []) as ExplorationGroup[],
		};
	}, [data]);

	return { ...layoutData, isLoading, error };
}
