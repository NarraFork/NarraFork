import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LegacyResourceRecovery } from "../../components/project/LegacyResourceRecovery";
import {
	legacyRouteErrorKey,
	resolveLegacyChapterTarget,
} from "../../components/project/legacy-chapter-redirect";
import { useChapter } from "../../hooks/useChapters";
import { api } from "../../lib/api";
import { APP_SHELL_CONTENT_HEIGHT } from "../../lib/safe-area";

export const Route = createFileRoute("/chapters/$chapterId")({ component: ChapterRedirect });

function ChapterRedirect() {
	const { chapterId } = Route.useParams();
	const search = useSearch({ strict: false }) as { from?: string };
	const location = useLocation();
	const navigate = useNavigate();
	const { t } = useTranslation("chapters");
	const chapter = useChapter(chapterId);
	const narrators = useQuery({
		queryKey: ["narrators", { chapterId }],
		queryFn: () => api.listNarrators({ chapterId }),
		enabled: !!chapter.data && !chapter.isError,
		retry: false,
	});
	const canRedirect = !!chapter.data && !chapter.isError && !narrators.isError;
	const target =
		canRedirect && narrators.data
			? resolveLegacyChapterTarget(narrators.data, search.from, location.hash)
			: null;
	useEffect(() => {
		if (!canRedirect || !narrators.data) return;
		const destination = resolveLegacyChapterTarget(narrators.data, search.from, location.hash);
		if (destination) void navigate(destination);
	}, [navigate, canRedirect, narrators.data, search.from, location.hash]);
	if (chapter.isLoading || (chapter.data && narrators.isLoading) || target) {
		return (
			<Center h={APP_SHELL_CONTENT_HEIGHT}>
				<Loader />
			</Center>
		);
	}
	const error = chapter.error ?? narrators.error;
	return (
		<Stack align="flex-start">
			<Alert color={error ? "red" : "gray"}>
				{t(
					`legacyRoute.${error ? legacyRouteErrorKey(error) : !chapter.data ? "missing" : "empty"}`,
				)}
			</Alert>
			{!chapter.isError && chapter.data?.projectId && (
				<Link
					to="/projects/$projectId"
					params={{ projectId: chapter.data.projectId }}
					style={{ textDecoration: "none" }}
				>
					<Button component="span" variant="light">
						{t("legacyRoute.configuration")}
					</Button>
				</Link>
			)}
			{!chapter.isError && chapter.data?.projectId && (
				<LegacyResourceRecovery
					chapterId={chapterId}
					projectId={chapter.data.projectId}
					status={chapter.data.status}
					containerConfig={chapter.data.containerConfig}
				/>
			)}
			<Button component={Link} to="/narrators" variant="subtle">
				{t("legacyRoute.sessions")}
			</Button>
		</Stack>
	);
}
