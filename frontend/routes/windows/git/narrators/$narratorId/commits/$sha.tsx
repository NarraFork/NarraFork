import { GitCommitPreviewPage } from "@frontend/components/chapter/GitCommitPreviewPage";
import { validateCommitPreviewSearch } from "@frontend/lib/git-commit-preview-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/windows/git/narrators/$narratorId/commits/$sha")({
	validateSearch: validateCommitPreviewSearch,
	component: NarratorCommitPreviewWindowRoute,
});

function NarratorCommitPreviewWindowRoute() {
	const { narratorId, sha } = Route.useParams();
	return (
		<GitCommitPreviewPage
			narratorId={narratorId}
			sha={sha}
			search={Route.useSearch()}
			mode="window"
		/>
	);
}
