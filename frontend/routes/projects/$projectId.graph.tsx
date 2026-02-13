import { ActionIcon, Group, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { StoryNetwork } from "../../components/graph/StoryNetwork";

export const Route = createFileRoute("/projects/$projectId/graph")({
	component: GraphPage,
});

function GraphPage() {
	const { projectId } = Route.useParams();

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 100px)" }}>
			<Group justify="space-between" mb="sm">
				<Title order={3}>Story Network</Title>
				<Link to="/projects/$projectId" params={{ projectId }}>
					<ActionIcon variant="subtle" size="lg">
						&larr;
					</ActionIcon>
				</Link>
			</Group>
			<div style={{ flex: 1, minHeight: 0 }}>
				<StoryNetwork projectId={projectId} />
			</div>
		</div>
	);
}
