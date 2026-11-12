import { ProjectSessionList } from "@frontend/components/project/ProjectSessionList";
import {
	Alert,
	Button,
	Group,
	Loader,
	SegmentedControl,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconListTree } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenOutlineSpace, useOutlineEnabled } from "../../hooks/useOutline";
import { installProjectAccessListener } from "../../hooks/useProjectAccess";
import { useProject } from "../../hooks/useProjects";
import { describeApiError } from "../../lib/api-error";
import { useOpenOutlinePage } from "../../lib/outline-router";

const CreateNarratorModal = lazy(() =>
	import("../../components/narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);
// The project's task board (outline P2 PR 5): the project space and its sessions' spaces.
const ProjectTaskBoard = lazy(() =>
	import("../../components/outline/task-board/TaskBoardViews").then((m) => ({
		default: m.ProjectTaskBoard,
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
	const { t: tOutline } = useTranslation("outline");
	const [view, setView] = useState<"sessions" | "tasks">("sessions");
	const showTasks = outline.enabled && view === "tasks";
	const openOutlinePage = useOpenOutlinePage();
	const openOutline = useOpenOutlineSpace({
		onMissing: () => notifications.show({ color: "gray", message: t("outlineNotCreated") }),
		onError: (error) =>
			notifications.show({ color: "red", message: describeApiError(error, t).message }),
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
			{outline.enabled && (
				<SegmentedControl
					size="xs"
					style={{ alignSelf: "flex-start" }}
					value={view}
					onChange={(value) => setView(value as "sessions" | "tasks")}
					data={[
						{ value: "sessions", label: t("compatibility.sessions") },
						{ value: "tasks", label: tOutline("board.projectTitle") },
					]}
					data-testid="project-view-switch"
				/>
			)}
			{showTasks && (
				<ProjectToolsBoundary fallback={<Alert color="red">{tOutline("board.loadFailed")}</Alert>}>
					<Suspense fallback={<Loader size="sm" />}>
						<ProjectTaskBoard
							projectId={projectId}
							onOpenTask={(task) =>
								openOutlinePage({
									spaceId: task.spaceId,
									blockId: task.id,
									pageId: task.pageId,
									view: "all",
								})
							}
						/>
					</Suspense>
				</ProjectToolsBoundary>
			)}
			{!showTasks && <Title order={4}>{t("compatibility.sessions")}</Title>}
			{!showTasks && <ProjectSessionList projectId={projectId} enabled={!project.isError} />}
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
