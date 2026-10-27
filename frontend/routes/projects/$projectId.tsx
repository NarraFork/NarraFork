import { Alert, Button, Card, Group, Loader, Skeleton, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconListTree } from "@tabler/icons-react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenOutlineSpace, useOutlineEnabled } from "../../hooks/useOutline";
import { installProjectAccessListener } from "../../hooks/useProjectAccess";
import { useProject } from "../../hooks/useProjects";
import { api } from "../../lib/api";
import { describeApiError } from "../../lib/api-error";

const CreateNarratorModal = lazy(() =>
	import("../../components/narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);
const ProjectSettingsPanel = lazy(() =>
	import("../../components/project/ProjectSettingsPanel").then((m) => ({
		default: m.ProjectSettingsPanel,
	})),
);

export const Route = createFileRoute("/projects/$projectId")({ component: ProjectPage });

// Optional project tools must never take down the directory and session list.
class ProjectToolsBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function ProjectPage() {
	const { projectId } = Route.useParams();
	const { t } = useTranslation("projects");
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const project = useProject(projectId);
	useEffect(installProjectAccessListener, []);
	const canWrite = !project.isError && project.data?.canWrite === true;
	const [creating, setCreating] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const outline = useOutlineEnabled();
	const openOutline = useOpenOutlineSpace({
		onMissing: () => notifications.show({ color: "gray", message: t("outlineNotCreated") }),
		onError: (error) =>
			notifications.show({ color: "red", message: describeApiError(error, t).message }),
	});
	const sessions = useInfiniteQuery({
		queryKey: ["narrators", "project", projectId],
		queryFn: ({ pageParam }) =>
			api.listNarratorsPaginated({ projectId, limit: 30, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		// The request needs only projectId; start it in parallel with the project detail.
		enabled: !project.isError,
		gcTime: 60_000,
	});
	if (project.isError || (!project.isLoading && !project.data))
		return <Alert color="red">{t("compatibility.unavailable")}</Alert>;
	return (
		<Stack>
			<Group justify="space-between">
				{project.data ? (
					<Title order={3}>{project.data.name}</Title>
				) : (
					<Skeleton height={28} width={220} />
				)}
				<Group gap="xs">
					{outline.enabled && (
						<Button
							variant="light"
							leftSection={<IconListTree size={16} />}
							loading={openOutline.pending}
							onClick={() => openOutline.open("project", projectId)}
						>
							{t("openOutline")}
						</Button>
					)}
					<Button disabled={!canWrite} onClick={() => setCreating(true)}>
						{t("newSession")}
					</Button>
				</Group>
			</Group>
			{project.data ? (
				<>
					<Text size="sm" c="dimmed">
						{project.data.gitPath}
					</Text>
					{project.data.description && <Text>{project.data.description}</Text>}
				</>
			) : (
				<Skeleton height={18} width="70%" />
			)}
			<Title order={4}>{t("compatibility.sessions")}</Title>
			{sessions.isLoading && <Loader size="sm" />}
			{sessions.isError && <Alert color="red">{t("compatibility.sessionsUnavailable")}</Alert>}
			{!sessions.isError &&
				sessions.data?.pages
					.flatMap((page) => page.items)
					.map((session) => (
						<Card key={session.id} withBorder>
							<Group justify="space-between">
								<Stack gap={2}>
									<Text>{session.title || session.id}</Text>
									<Text size="xs" c="dimmed">
										{session.cwd}
									</Text>
								</Stack>
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
			<details onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
				<summary>{t("advancedSettings")}</summary>
				{settingsOpen && (
					<ProjectToolsBoundary
						fallback={<Alert color="red">{t("compatibility.unavailable")}</Alert>}
					>
						<Suspense fallback={<Loader size="sm" />}>
							<ProjectSettingsPanel projectId={projectId} />
						</Suspense>
					</ProjectToolsBoundary>
				)}
			</details>
			{creating && canWrite && project.data && (
				<ProjectToolsBoundary fallback={<Alert color="red">{t("createFailed")}</Alert>}>
					<Suspense fallback={<Loader size="sm" />}>
						<CreateNarratorModal
							opened
							onClose={() => setCreating(false)}
							contextProjectId={projectId}
							initialCwd={project.data.gitPath}
							onCreated={(session) => {
								void queryClient.invalidateQueries({
									queryKey: ["narrators", "project", projectId],
								});
								void navigate({ to: "/narrators/$narratorId", params: { narratorId: session.id } });
							}}
						/>
					</Suspense>
				</ProjectToolsBoundary>
			)}
		</Stack>
	);
}
