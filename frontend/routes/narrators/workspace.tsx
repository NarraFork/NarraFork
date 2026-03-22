import { createFileRoute } from "@tanstack/react-router";
import { NarratorWorkspace } from "../../components/narrator/NarratorWorkspace";

export const Route = createFileRoute("/narrators/workspace")({
	component: WorkspacePage,
});

function WorkspacePage() {
	return <NarratorWorkspace />;
}
