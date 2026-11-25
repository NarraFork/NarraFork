/**
 * The team page `/projects/$projectId/teams/$teamId` (docs/PROJECT_TEAMS-PLAN.md §二.11; the
 * redesign R).
 *
 * Not nested under the project page (`$projectId_`): it fills the app shell's content box the
 * way a session page does. The coordinator's conversation (the ordinary narrator panel, so
 * members talk to the coordinator exactly as in its session page; a read-only member sees
 * 「你是只读成员」 instead of the composer) with the work list and the activity beside it; narrow
 * screens get tabs instead. No list of the project's teams: teams are switched from the
 * sidebar's pinned team tabs and the project page.
 */

import { NarratorPanelSkeleton } from "@frontend/components/narrator/NarratorPanelSkeleton";
import { usePanelCompact } from "@frontend/components/narrator/panels/shared";
import { TeamPageView } from "@frontend/components/teams/TeamPageView";
import { lazyWithRetry } from "@frontend/lib/lazy-with-retry";
import { Box } from "@mantine/core";
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
	const { t } = useTranslation("projects");
	return (
		<Box ref={ref} h="100%" style={{ overflow: "hidden", minHeight: 0 }}>
			<NarratorDockContext.Provider value={null}>
				<Suspense fallback={<NarratorPanelSkeleton />}>
					<NarratorPanel
						key={teamId}
						narratorId={teamId}
						compact={compact}
						onViewSubagentSession={(subagentId) => onOpenSession(subagentId)}
						readOnlyNotice={t("teams.page.readOnly")}
					/>
				</Suspense>
			</NarratorDockContext.Provider>
		</Box>
	);
}

function TeamPage() {
	const { projectId, teamId } = Route.useParams();
	const navigate = useNavigate();
	const openSession = useCallback(
		(narratorId: string) => void navigate({ to: "/narrators/$narratorId", params: { narratorId } }),
		[navigate],
	);
	return (
		<TeamPageView
			projectId={projectId}
			teamId={teamId}
			conversation={<CoordinatorConversation teamId={teamId} onOpenSession={openSession} />}
			onOpenSession={openSession}
			onOpenCoordinatorSession={() => openSession(teamId)}
			onBack={() => void navigate({ to: "/projects/$projectId", params: { projectId } })}
			onDisbanded={openSession}
		/>
	);
}
