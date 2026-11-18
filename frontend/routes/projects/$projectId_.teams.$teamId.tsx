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
import { TeamPageView } from "@frontend/components/teams/TeamPageView";
import { useProject } from "@frontend/hooks/useProjects";
import { lazyWithRetry } from "@frontend/lib/lazy-with-retry";
import { Box } from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { memo, Suspense, useCallback } from "react";
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
	const navigate = useNavigate();
	const project = useProject(projectId);
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
	return (
		<TeamPageView
			projectId={projectId}
			teamId={teamId}
			canCreateTeam={!project.isError && project.data?.canWrite === true}
			conversation={<CoordinatorConversation teamId={teamId} onOpenSession={openSession} />}
			onOpenSession={openSession}
			onOpenTeam={openTeam}
			onBack={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}
		/>
	);
}
