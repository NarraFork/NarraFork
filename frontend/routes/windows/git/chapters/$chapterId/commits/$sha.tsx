import { GitCommitPreviewPage } from "@frontend/components/chapter/GitCommitPreviewPage";
import { validateCommitPreviewSearch } from "@frontend/lib/git-commit-preview-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/windows/git/chapters/$chapterId/commits/$sha")({
	validateSearch: validateCommitPreviewSearch,
	component: ChapterCommitPreviewWindowRoute,
});

function ChapterCommitPreviewWindowRoute() {
	const { chapterId, sha } = Route.useParams();
	return (
		<GitCommitPreviewPage
			chapterId={chapterId}
			sha={sha}
			search={Route.useSearch()}
			mode="window"
		/>
	);
}
