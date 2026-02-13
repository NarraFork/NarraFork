import { useQuery } from "@tanstack/react-query";
import dagre from "@dagrejs/dagre";
import { useMemo } from "react";
import { api } from "../lib/api";

const NODE_WIDTH = 280;
const NODE_HEIGHT = 120;

function applyDagreLayout(nodes: any[], edges: any[]) {
	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 120 });

	for (const node of nodes) {
		g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}

	for (const edge of edges) {
		g.setEdge(edge.source, edge.target);
	}

	dagre.layout(g);

	return nodes.map((node) => {
		const pos = g.node(node.id);
		return {
			...node,
			position: {
				x: pos.x - NODE_WIDTH / 2,
				y: pos.y - NODE_HEIGHT / 2,
			},
		};
	});
}

export function useStoryGraph(projectId: string) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["graph", projectId],
		queryFn: () => api.getProjectGraph(projectId),
		enabled: !!projectId,
	});

	const layoutData = useMemo(() => {
		if (!data) return { nodes: [], edges: [] };
		const layoutNodes = applyDagreLayout(data.nodes, data.edges);
		return { nodes: layoutNodes, edges: data.edges };
	}, [data]);

	return { ...layoutData, isLoading, error };
}
