import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "../../../components/narrator/workspace/WorkspacePage";

export const Route = createFileRoute("/narrators/workspace/$workspaceId")({
	component: () => {
		const { workspaceId } = Route.useParams();
		return <WorkspacePage key={workspaceId} workspaceId={workspaceId} />;
	},
});
