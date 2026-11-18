/**
 * The team page `/projects/$projectId/teams/$teamId` (docs/PROJECT_TEAMS-PLAN.md §二.11; P4).
 *
 * Not nested under the project page (`$projectId_`): it fills the app shell's content box the
 * way a session page does. Left: the project's teams; middle: the coordinator's conversation
 * (the ordinary narrator panel, so members talk to the coordinator exactly as in its session
 * page); right: the board and the activity. Narrow screens get tabs instead.
 */
import { NarratorPanelSkeleton } from "@frontend/components/narrator/NarratorPanelSkeleton";
import { usePanelCompact } from "@frontend/components/narrator/panels/shared";
import { ProjectTeamsList } from "@frontend/components/teams/ProjectTeamsList";
import { TeamActivity } from "@frontend/components/teams/TeamActivity";
import { TeamBoard } from "@frontend/components/teams/TeamBoard";
import { TeamTopBar } from "@frontend/components/teams/TeamTopBar";
import { TeamWorkspace } from "@frontend/components/teams/TeamWorkspace";
import { useProject } from "@frontend/hooks/useProjects";
import { useTeam, useTeamSummary } from "@frontend/hooks/useTeams";
import { lazyWithRetry } from "@frontend/lib/lazy-with-retry";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "@frontend/lib/safe-area";
import { ActionIcon, Alert, Box, Skeleton } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { memo, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { NarratorDockContext } from "../../components/narrator/dock/NarratorDockContext";

const NarratorPanel = lazyWithRetry(() =>
	import("../../components/narrator/NarratorPanel").then((m) => ({
		default: memo(m.NarratorPanel),
	})),
);

export const Route = createFileRoute("/projects/$projectId_/teams/$teamId")({
	component: TeamPage,
});

function CoordinatorConversation({
	teamId,
	onOpenSession,
}: {
	teamId: string;
	onOpenSession: (narratorId: string) => void;
}) {
	const { ref, compact } = usePanelCompact();
	return (
		<Box ref={ref} h="100%" style={{ overflow: "hidden", minHeight: 0 }}>
			<NarratorDockContext.Provider value={null}>
				<Suspense fallback={<NarratorPanelSkeleton />}>
					<NarratorPanel
						key={teamId}
						narratorId={teamId}
						compact={compact}
						onViewSubagentSession={(subagentId) => onOpenSession(subagentId)}
					/>
				</Suspense>
			</NarratorDockContext.Provider>
		</Box>
	);
}

function TeamPage() {
	const { projectId, teamId } = Route.useParams();
	const { t } = useTranslation("projects");
	const navigate = useNavigate();
	const project = useProject(projectId);
	const team = useTeam(projectId, teamId);
	const summary = useTeamSummary(projectId, teamId);
	const canCreate = !project.isError && project.data?.canWrite === true;
	const openSession = useCallback(
		(narratorId: string) => void navigate({ to: "/narrators/$narratorId", params: { narratorId } }),
		[navigate],
	);
	const openTeam = useCallback(
		(id: string) =>
			void navigate({
				to: "/projects/$projectId/teams/$teamId",
				params: { projectId, teamId: id },
			}),
		[navigate, projectId],
	);
	if (team.isError) return <Alert color="red">{t("teams.notFound")}</Alert>;
	return (
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
		>
			<TeamWorkspace
				topBar={
					<TeamTopBar
						projectId={projectId}
						teamId={teamId}
						title={team.data?.name ?? <Skeleton height={18} width={140} />}
						summary={summary.data}
						onOpenSession={openSession}
						leading={
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={t("teams.back")}
								onClick={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}
							>
								<IconArrowLeft size={16} />
							</ActionIcon>
						}
					/>
				}
				teams={
					<ProjectTeamsList
						projectId={projectId}
						canCreate={canCreate}
						currentTeamId={teamId}
						variant="nav"
						onOpenTeam={openTeam}
					/>
				}
				conversation={<CoordinatorConversation teamId={teamId} onOpenSession={openSession} />}
				board={
					<TeamBoard
						projectId={projectId}
						teamId={teamId}
						summary={summary.data}
						onOpenSession={openSession}
					/>
				}
				activity={<TeamActivity projectId={projectId} teamId={teamId} />}
			/>
		</Box>
	);
}
