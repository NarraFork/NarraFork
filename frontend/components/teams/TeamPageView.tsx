/**
 * The team page's body (P4): the frame (`TeamWorkspace`) filled with the top bar, the project's
 * teams, the board and the activity. The route passes the coordinator's conversation (the
 * narrator panel) and the navigation; the browser fixture passes a stand-in conversation.
 */
import { teamsUnavailable, useTeam, useTeamSummary } from "@frontend/hooks/useTeams";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "@frontend/lib/safe-area";
import { ActionIcon, Alert, Box, Skeleton } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { type ReactNode, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProjectTeamsList } from "./ProjectTeamsList";
import { TeamActivity } from "./TeamActivity";
import { TeamBoard } from "./TeamBoard";
import { TeamTopBar } from "./TeamTopBar";
import { TeamWorkspace } from "./TeamWorkspace";

export function TeamPageView({
	projectId,
	teamId,
	canCreateTeam,
	conversation,
	onOpenSession,
	onOpenTeam,
	onBack,
}: {
	projectId: string;
	teamId: string;
	/** Project writers may create teams. */
	canCreateTeam: boolean;
	conversation: ReactNode;
	onOpenSession?: (narratorId: string) => void;
	onOpenTeam: (teamId: string) => void;
	onBack: () => void;
}) {
	const { t } = useTranslation("projects");
	const team = useTeam(projectId, teamId);
	const summary = useTeamSummary(projectId, teamId);
	const [focusConversation, setFocusConversation] = useState(0);
	// The coordinator's conversation is already on this page: bring it forward, do not leave.
	const openSession = useCallback(
		(narratorId: string) => {
			if (narratorId === teamId) setFocusConversation((value) => value + 1);
			else onOpenSession?.(narratorId);
		},
		[teamId, onOpenSession],
	);
	if (team.isError)
		return teamsUnavailable(team.error) ? (
			<Alert color="gray">{t("teams.unavailable")}</Alert>
		) : (
			<Alert color="red">{t("teams.notFound")}</Alert>
		);
	return (
		// Full bleed in the app shell's content box, like a session page.
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
		>
			<TeamWorkspace
				focusConversation={focusConversation}
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
								onClick={onBack}
								data-testid="team-back"
							>
								<IconArrowLeft size={16} />
							</ActionIcon>
						}
					/>
				}
				teams={
					<ProjectTeamsList
						projectId={projectId}
						canCreate={canCreateTeam}
						currentTeamId={teamId}
						variant="nav"
						onOpenTeam={onOpenTeam}
					/>
				}
				conversation={conversation}
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
