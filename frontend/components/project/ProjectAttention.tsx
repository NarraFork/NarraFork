/**
 * The project page's 「等你处理」 (R2): what waits for this member across the project's sessions
 * and teams, in the team page's attention cards (`TeamAttention`): approve, deny or answer in
 * place where the team page can; a rule request opens its session; a ready item opens its team.
 * Each card names its team (「发布小组 · …」) or its session and whose it is. Hidden when nothing
 * waits, for readers (the server answers 403) and where the read is not available (503).
 */
import { useProjectAttention } from "@frontend/hooks/useProjectOverview";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { TeamAttention } from "../teams/TeamAttention";
import { projectAttentionEntries, projectDecisionKeys, teamOfItem } from "./project-page-model";

export function ProjectAttention({
	projectId,
	enabled,
	phone,
}: {
	projectId: string;
	/** Members only: the page asks only when the caller may write in the project. */
	enabled: boolean;
	phone: boolean;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const attention = useProjectAttention(projectId, enabled);
	const raw = attention.data?.entries;
	const entries = useMemo(() => projectAttentionEntries(raw ?? []), [raw]);
	if (!enabled || !attention.data || entries.length === 0) return null;
	const openTeam = (teamId: string) =>
		void navigate({ to: "/projects/$projectId/teams/$teamId", params: { projectId, teamId } });
	return (
		<TeamAttention
			// Query keys of the detail reads and decisions: scoped to the project page.
			teamId={`project:${projectId}`}
			projectId={projectId}
			base="main"
			stats={undefined}
			entries={entries}
			// On a phone the cards scroll sideways with dots, as on the team page; on a desktop they
			// are listed in the page, folded past three.
			phone={phone}
			inPage
			flush
			more={attention.data.more}
			unscanned={attention.data.unscanned}
			beyondKeys={{ more: "page.attention.more", unscanned: "page.attention.unscanned" }}
			onOpenItem={(itemId) => {
				const teamId = teamOfItem(raw ?? [], itemId);
				if (teamId) openTeam(teamId);
			}}
			onOpenSession={(narratorId) =>
				void navigate({ to: "/narrators/$narratorId", params: { narratorId } })
			}
			onOpenTeam={openTeam}
			onDecided={(entry) => {
				for (const queryKey of projectDecisionKeys(projectId, entry))
					void queryClient.invalidateQueries({ queryKey });
			}}
		/>
	);
}
