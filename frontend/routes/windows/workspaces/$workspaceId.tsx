import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { WorkspacePage } from "../../../components/narrator/workspace/WorkspacePage";
import { useStandaloneWindowTitle } from "../../../components/StandaloneWindowLayout";
import { useWorkspace } from "../../../hooks/useWorkspace";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";

export const Route = createFileRoute("/windows/workspaces/$workspaceId")({
	component: WorkspaceWindowRoute,
});

function WorkspaceWindowRoute() {
	const { workspaceId } = Route.useParams();
	const { data: workspace } = useWorkspace(workspaceId);
	// Narrator cells on the surface subscribe over the shared narrator WS; the
	// window is its own JS realm, so this connection is private to it.
	useEffect(() => {
		narratorWSManager.connect();
		return () => narratorWSManager.disconnect();
	}, []);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	const title = ((workspace as any)?.title as string | undefined)?.trim();
	useStandaloneWindowTitle(title || "Workspace");
	return <WorkspacePage key={workspaceId} workspaceId={workspaceId} chrome="window" />;
}
