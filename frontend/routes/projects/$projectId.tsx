import { Alert, Button, Card, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LegacyResourceRecovery } from "../../components/project/LegacyResourceRecovery";
import { ProjectCompatibilityPanel } from "../../components/project/ProjectCompatibilityPanel";
import { useChapters } from "../../hooks/useChapters";
import { useProject } from "../../hooks/useProjects";
import { api } from "../../lib/api";

export const Route = createFileRoute("/projects/$projectId")({
	component: ProjectCompatibilityPage,
});

/** Legacy deep links stay meaningful without mounting or deleting the old canvas implementation. */
function ProjectCompatibilityPage() {
	const { projectId } = Route.useParams();
	const { t } = useTranslation("projects");
	const project = useProject(projectId);
	const chapters = useChapters(project.data ? projectId : "");
	const sessions = useInfiniteQuery({
		queryKey: ["narrators", "project-compatibility", projectId],
		queryFn: ({ pageParam }) =>
			api.listNarratorsPaginated({ standalone: "all", projectId, limit: 30, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: !!project.data,
		gcTime: 60_000,
	});
	if (project.isLoading) return <Loader />;
	if (project.isError || !project.data)
		return <Alert color="red">{t("compatibility.unavailable")}</Alert>;
	return (
		<Stack>
			<Title order={3}>{project.data.name}</Title>
			<Alert>{t("compatibility.retirement")}</Alert>
			<ProjectCompatibilityPanel projectId={projectId} />
			<Title order={4}>{t("compatibility.sessions")}</Title>
			{sessions.isLoading && <Loader size="sm" />}
			{sessions.isError && <Alert color="red">{t("compatibility.sessionsUnavailable")}</Alert>}
			{sessions.data?.pages
				.flatMap((page) => page.items)
				.map((session) => (
					<Card key={session.id} withBorder>
						<Group justify="space-between">
							<Text>{session.title || session.id}</Text>
							<Link
								to="/narrators/$narratorId"
								params={{ narratorId: session.id }}
								style={{ textDecoration: "none" }}
							>
								<Button component="span" variant="light">
									{t("compatibility.openSession")}
								</Button>
							</Link>
						</Group>
					</Card>
				))}
			{sessions.isSuccess && sessions.data.pages.every((page) => page.items.length === 0) && (
				<Text c="dimmed">{t("compatibility.noSessions")}</Text>
			)}
			{sessions.hasNextPage && (
				<Button
					variant="light"
					loading={sessions.isFetchingNextPage}
					onClick={() => void sessions.fetchNextPage()}
				>
					{t("compatibility.loadMore")}
				</Button>
			)}
			<Title order={4}>{t("compatibility.resources")}</Title>
			<Text size="sm" c="dimmed">
				{t("compatibility.resourcesDescription")}
			</Text>
			{chapters.isLoading && <Loader size="sm" />}
			{chapters.isError && <Alert color="red">{t("compatibility.resourcesUnavailable")}</Alert>}
			{chapters.data?.map((chapter) => (
				<Card key={chapter.id} withBorder>
					<Group justify="space-between">
						<Stack gap={2}>
							<Text>{chapter.title}</Text>
							<Text size="xs" c="dimmed">
								{chapter.status} · {chapter.worktreePath || chapter.branch}
							</Text>
						</Stack>
						<Link
							to="/chapters/$chapterId"
							params={{ chapterId: chapter.id }}
							style={{ textDecoration: "none" }}
						>
							<Button component="span" variant="light">
								{t("compatibility.openResources")}
							</Button>
						</Link>
						<LegacyResourceRecovery
							chapterId={chapter.id}
							projectId={projectId}
							status={chapter.status}
							containerConfig={chapter.containerConfig}
						/>
					</Group>
				</Card>
			))}
			{chapters.isSuccess && chapters.data.length === 0 && (
				<Text c="dimmed">{t("compatibility.noResources")}</Text>
			)}
		</Stack>
	);
}
