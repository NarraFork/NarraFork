import { Alert, Button, Center, Loader, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LegacyMigrationAssistant } from "../../components/project/LegacyMigrationAssistant";
import { LegacyResourceRecovery } from "../../components/project/LegacyResourceRecovery";
import {
	legacyRouteErrorKey,
	resolveLegacyChapterTarget,
} from "../../components/project/legacy-chapter-redirect";
import { useChapter } from "../../hooks/useChapters";
import { api } from "../../lib/api";
import { legacyMigrationApi } from "../../lib/api/legacy-migration";
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
	// Only a missing chapter may consult the independently authorized migration map.
	// In particular, denied access must never fall through to a cached target.
	const lookupEnabled = chapter.isError && legacyRouteErrorKey(chapter.error) === "missing";
	const mapping = useQuery({
		queryKey: ["legacy-chapter-target", chapterId],
		queryFn: () => legacyMigrationApi.chapterTarget(chapterId),
		enabled: lookupEnabled,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const mappedId = lookupEnabled && !mapping.isError ? mapping.data?.narratorId : null;
	const canRedirect = !!chapter.data && !chapter.isError && !narrators.isError;
	const target =
		canRedirect && narrators.data
			? resolveLegacyChapterTarget(narrators.data, search.from, location.hash)
			: mappedId
				? resolveLegacyChapterTarget(
						[{ id: mappedId, variant: "primary" }],
						search.from,
						location.hash,
					)
				: null;
	useEffect(() => {
		const destination =
			canRedirect && narrators.data
				? resolveLegacyChapterTarget(narrators.data, search.from, location.hash)
				: mappedId
					? resolveLegacyChapterTarget(
							[{ id: mappedId, variant: "primary" }],
							search.from,
							location.hash,
						)
					: null;
		if (destination) void navigate(destination);
	}, [navigate, canRedirect, narrators.data, mappedId, search.from, location.hash]);
	if (
		chapter.isLoading ||
		(!chapter.isError && chapter.data && narrators.isLoading) ||
		(lookupEnabled && mapping.isLoading) ||
		target
	) {
		return (
			<Center h={APP_SHELL_CONTENT_HEIGHT}>
				<Loader />
			</Center>
		);
	}
	const migratedEmpty = lookupEnabled && !mapping.isError && mapping.data?.narratorId === null;
	const error = migratedEmpty
		? null
		: lookupEnabled && mapping.error
			? mapping.error
			: (chapter.error ?? narrators.error);
	return (
		<Stack align="flex-start">
			{!chapter.isError && chapter.data?.projectId && (
				<LegacyMigrationAssistant projectId={chapter.data.projectId} autoOpen />
			)}
			<Alert color={error ? "red" : "gray"}>
				{t(
					`legacyRoute.${migratedEmpty ? "migratedEmpty" : error ? legacyRouteErrorKey(error) : !chapter.data ? "missing" : "empty"}`,
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
