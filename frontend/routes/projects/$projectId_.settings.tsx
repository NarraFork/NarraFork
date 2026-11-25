/**
 * The project settings page `/projects/$projectId/settings` (R2): the project page's 「…」 menu
 * opens it. Not nested under the project page (`$projectId_`), like the team page.
 */

import { Loader } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const ProjectSettingsPage = lazy(() =>
	import("../../components/project/ProjectSettingsPage").then((m) => ({
		default: m.ProjectSettingsPage,
	})),
);

export const Route = createFileRoute("/projects/$projectId_/settings")({
	component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
	const { projectId } = Route.useParams();
	return (
		<Suspense fallback={<Loader size="sm" />}>
			<ProjectSettingsPage projectId={projectId} />
		</Suspense>
	);
}
