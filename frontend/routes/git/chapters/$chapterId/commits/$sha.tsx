import { GitCommitPreviewPage } from "@frontend/components/chapter/GitCommitPreviewPage";
import { validateCommitPreviewSearch } from "@frontend/lib/git-commit-preview-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/git/chapters/$chapterId/commits/$sha")({
	validateSearch: validateCommitPreviewSearch,
	component: ChapterCommitPreviewRoute,
});

function ChapterCommitPreviewRoute() {
	const { chapterId, sha } = Route.useParams();
	return <GitCommitPreviewPage chapterId={chapterId} sha={sha} search={Route.useSearch()} />;
}
