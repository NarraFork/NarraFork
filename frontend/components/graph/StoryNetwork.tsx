import { Loader, Text } from "@mantine/core";
import { Background, Controls, type EdgeTypes, type NodeTypes, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStoryGraph } from "../../hooks/useStoryGraph";
import { ChapterNode } from "./ChapterNode";
import { ForkEdge } from "./ForkEdge";
import { MergeEdge } from "./MergeEdge";

const nodeTypes: NodeTypes = {
	chapterNode: ChapterNode,
};

const edgeTypes: EdgeTypes = {
	forkEdge: ForkEdge,
	mergeEdge: MergeEdge,
};

interface StoryNetworkProps {
	projectId: string;
}

export function StoryNetwork({ projectId }: StoryNetworkProps) {
	const { nodes, edges, isLoading, error } = useStoryGraph(projectId);
	const { t } = useTranslation("graph");

	const defaultEdgeOptions = useMemo(
		() => ({
			animated: false,
		}),
		[],
	);

	if (isLoading) return <Loader />;
	if (error) return <Text c="red">{t("loadFailed", { message: error.message })}</Text>;
	if (nodes.length === 0) return <Text c="dimmed">{t("noChapters")}</Text>;

	return (
		<div style={{ width: "100%", height: "100%" }}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				defaultEdgeOptions={defaultEdgeOptions}
				fitView
				fitViewOptions={{ padding: 0.2 }}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
			>
				<Background />
				<Controls showInteractive={false} />
			</ReactFlow>
		</div>
	);
}
