import { ActionIcon, Group, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { StoryNetwork } from "../../components/graph/StoryNetwork";

export const Route = createFileRoute("/projects/$projectId/graph")({
	component: GraphPage,
});

function GraphPage() {
	const { projectId } = Route.useParams();
	const { t } = useTranslation("graph");

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 100px)" }}>
			<Group justify="space-between" mb="sm">
				<Title order={3}>{t("storyNetwork")}</Title>
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
