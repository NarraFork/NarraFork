/**
 * The project page `/projects/$projectId` (R2): one repository's home — who is doing what, what
 * waits for me, and where new work starts.
 *
 *  - the header (`ProjectHeader`): name, path tail, default branch, 「N 位成员」 (a count; opens
 *    the settings page at 成员与可见性), pin, 「新团队」, 「新会话」 and the 「…」 menu (项目设置 →
 *    `/projects/$projectId/settings`);
 *  - 「等你处理」 (`ProjectAttention`, members only, hidden when empty);
 *  - 团队 (`ProjectTeamCards`) and 会话 (`ProjectSessions`);
 *  - with the outline on, the 「…」 menu opens the outline and switches the body to the project's
 *    task board.
 *
 * Optional parts never take the page down: each sits behind its own error boundary.
 */
import { ProjectAttention } from "@frontend/components/project/ProjectAttention";
import { ProjectHeader } from "@frontend/components/project/ProjectHeader";
import { ProjectSessions } from "@frontend/components/project/ProjectSessions";
import { ProjectTeamCards } from "@frontend/components/project/ProjectTeamCards";
import { Alert, Loader, Stack } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Component, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenOutlineSpace, useOutlineEnabled } from "../../hooks/useOutline";
import { installProjectAccessListener, useProjectMemberCount } from "../../hooks/useProjectAccess";
import { useProjectTeamCards } from "../../hooks/useProjectOverview";
import { useProject } from "../../hooks/useProjects";
import { teamsUnavailable } from "../../hooks/useTeams";
import { describeApiError } from "../../lib/api-error";
import { useOpenOutlinePage } from "../../lib/outline-router";

const CreateNarratorModal = lazy(() =>
	import("../../components/narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);
const CreateTeamModal = lazy(() =>
	import("../../components/teams/CreateTeamModal").then((m) => ({
		default: m.CreateTeamModal,
	})),
);
// The project's task board (outline P2 PR 5): the project space and its sessions' spaces.
const ProjectTaskBoard = lazy(() =>
	import("../../components/outline/task-board/TaskBoardViews").then((m) => ({
		default: m.ProjectTaskBoard,
	})),
);

export const Route = createFileRoute("/projects/$projectId")({ component: ProjectPage });

// Optional project parts must never take down the header and the session list.
class ProjectPartBoundary extends Component<
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
	const { t: tOutline } = useTranslation("outline");
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const project = useProject(projectId);
	useEffect(installProjectAccessListener, []);
	const phone = useMediaQuery("(max-width: 48em)") ?? false;
	const canWrite = !project.isError && project.data?.canWrite === true;
	// The team cards' own read (same query): it also tells whether teams exist here (503 on PG).
	const teamProbe = useProjectTeamCards(projectId, !project.isError);
	const teamsAvailable = !(teamProbe.isError && teamsUnavailable(teamProbe.error));
	const memberCount = useProjectMemberCount(projectId, !project.isError);
	const [creating, setCreating] = useState<"session" | "team" | null>(null);
	const outline = useOutlineEnabled();
	const [showTasks, setShowTasks] = useState(false);
	const openOutlinePage = useOpenOutlinePage();
	const openOutline = useOpenOutlineSpace({
		onMissing: () => notifications.show({ color: "gray", message: t("outlineNotCreated") }),
		onError: (error) =>
			notifications.show({ color: "red", message: describeApiError(error, t).message }),
	});
	if (project.isError || (!project.isLoading && !project.data))
		return <Alert color="red">{t("compatibility.unavailable")}</Alert>;
	const data = project.data;
	const tasks = outline.enabled && showTasks;
	const openTeam = (teamId: string) =>
		void navigate({ to: "/projects/$projectId/teams/$teamId", params: { projectId, teamId } });
	return (
		<Stack gap={phone ? "lg" : 28} pb="xl" data-testid="project-page">
			<ProjectHeader
				projectId={projectId}
				name={data ? String(data.name ?? "") : null}
				gitPath={data?.gitPath ? String(data.gitPath) : null}
				defaultBranch={data?.defaultBranch ? String(data.defaultBranch) : null}
				description={data?.description ? String(data.description) : null}
				phone={phone}
				canWrite={canWrite}
				teamsAvailable={teamsAvailable}
				onNewSession={() => setCreating("session")}
				onNewTeam={() => setCreating("team")}
				onOpenSettings={() =>
					void navigate({ to: "/projects/$projectId/settings", params: { projectId } })
				}
				memberCount={memberCount.data ?? null}
				onOpenMembers={() =>
					void navigate({
						to: "/projects/$projectId/settings",
						params: { projectId },
						hash: "settings-members",
					})
				}
				outline={
					outline.enabled
						? {
								pending: openOutline.pending,
								showingTasks: showTasks,
								onOpen: () => openOutline.open("project", projectId),
								onToggleTasks: () => setShowTasks((value) => !value),
							}
						: undefined
				}
			/>
			<ProjectPartBoundary fallback={null}>
				<ProjectAttention projectId={projectId} enabled={canWrite} phone={phone} />
			</ProjectPartBoundary>
			{tasks ? (
				<ProjectPartBoundary fallback={<Alert color="red">{tOutline("board.loadFailed")}</Alert>}>
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
							onOpenSession={(narratorId) =>
								void navigate({ to: "/narrators/$narratorId", params: { narratorId } })
							}
						/>
					</Suspense>
				</ProjectPartBoundary>
			) : (
				<>
					<ProjectPartBoundary fallback={<Alert color="red">{t("teams.loadFailed")}</Alert>}>
						<ProjectTeamCards
							projectId={projectId}
							canCreate={canWrite}
							onOpenTeam={openTeam}
							onCreate={() => setCreating("team")}
						/>
					</ProjectPartBoundary>
					<ProjectPartBoundary
						fallback={<Alert color="red">{t("compatibility.sessionsUnavailable")}</Alert>}
					>
						<ProjectSessions projectId={projectId} phone={phone} />
					</ProjectPartBoundary>
				</>
			)}
			{creating === "session" && canWrite && data && (
				<ProjectPartBoundary fallback={<Alert color="red">{t("createFailed")}</Alert>}>
					<Suspense fallback={<Loader size="sm" />}>
						<CreateNarratorModal
							opened
							onClose={() => setCreating(null)}
							contextProjectId={projectId}
							initialCwd={String(data.gitPath ?? "")}
							onCreated={(session) => {
								void queryClient.invalidateQueries({
									queryKey: ["narrators", "project", projectId],
								});
								void navigate({ to: "/narrators/$narratorId", params: { narratorId: session.id } });
							}}
						/>
					</Suspense>
				</ProjectPartBoundary>
			)}
			{creating === "team" && canWrite && (
				<ProjectPartBoundary fallback={<Alert color="red">{t("createFailed")}</Alert>}>
					<Suspense fallback={<Loader size="sm" />}>
						<CreateTeamModal
							projectId={projectId}
							opened
							onClose={() => setCreating(null)}
							onCreated={(team) => {
								setCreating(null);
								openTeam(team.id);
							}}
						/>
					</Suspense>
				</ProjectPartBoundary>
			)}
		</Stack>
	);
}
