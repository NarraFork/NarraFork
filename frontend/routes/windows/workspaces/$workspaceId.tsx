import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "../../../components/narrator/workspace/WorkspacePage";
import { useStandaloneWindowTitle } from "../../../components/StandaloneWindowLayout";
import { useWorkspace } from "../../../hooks/useWorkspace";

export const Route = createFileRoute("/windows/workspaces/$workspaceId")({
	component: WorkspaceWindowRoute,
});

function WorkspaceWindowRoute() {
	const { workspaceId } = Route.useParams();
	const { data: workspace } = useWorkspace(workspaceId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	const title = ((workspace as any)?.title as string | undefined)?.trim();
	useStandaloneWindowTitle(title || "Workspace");
	return <WorkspacePage key={workspaceId} workspaceId={workspaceId} chrome="window" />;
}
