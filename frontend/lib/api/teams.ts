import { PROJECT_TEAM_CARDS_LIMIT, type TeamCard } from "@shared/project-overview";
import type {
	TeamActivityPage,
	TeamApprovalsResponse,
	TeamBoardColumn,
	TeamBoardColumnPage,
	TeamDetail,
	TeamGithubPinResponse,
	TeamListResponse,
	TeamMembersResponse,
	TeamPageSummary,
	TeamPrMergeMethod,
	TeamRunningResponse,
	TeamSettingsPatch,
	TeamWorkFileDiff,
	TeamWorkItemDetail,
	TeamWorkMergeResponse,
	TeamWorkPrRefreshResponse,
	TeamWorkReturnResponse,
	TeamWorkStatsResponse,
} from "@shared/project-teams";
import { TEAM_CONVERSATION_EVENT_KINDS } from "@shared/project-teams";
import { request } from "./client";

const teamBase = (projectId: string, teamId: string) =>
	`/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}`;

function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params))
		if (value !== undefined && value !== "") search.set(key, String(value));
	const text = search.toString();
	return text ? `?${text}` : "";
}

export interface CreateTeamPayload {
	name: string;
	baseBranch?: string;
	brief?: string;
}

/** Turn an existing session into a team's coordinator; its audiences stay as they are. */
export interface UpgradeToTeamPayload {
	fromNarratorId: string;
	/** Omitted keeps the session's title. */
	name?: string;
	baseBranch?: string;
	brief?: string;
}

/** Project teams (docs/PROJECT_TEAMS-PLAN.md P1) and the team page's reads (P4). */
export const teamsApi = {
	listProjectTeams: (
		projectId: string,
		options: { status?: "active" | "archived" | "all"; cursor?: string; limit?: number } = {},
	) =>
		request<TeamListResponse>(
			`/projects/${encodeURIComponent(projectId)}/teams${query({
				status: options.status,
				cursor: options.cursor,
				limit: options.limit,
			})}`,
		),
	/** The project page's team cards (R2): at most 24 teams a page, each with its numbers. */
	listProjectTeamCards: (projectId: string, options: { cursor?: string } = {}) =>
		request<{ teams: TeamCard[]; nextCursor: string | null }>(
			`/projects/${encodeURIComponent(projectId)}/teams${query({
				status: "active",
				counts: "true",
				cursor: options.cursor,
				limit: PROJECT_TEAM_CARDS_LIMIT,
			})}`,
		),
	createProjectTeam: (projectId: string, payload: CreateTeamPayload) =>
		request<TeamDetail>(`/projects/${encodeURIComponent(projectId)}/teams`, {
			method: "POST",
			body: JSON.stringify(payload),
		}),
	upgradeSessionToTeam: (projectId: string, payload: UpgradeToTeamPayload) =>
		request<TeamDetail>(`/projects/${encodeURIComponent(projectId)}/teams`, {
			method: "POST",
			body: JSON.stringify(payload),
		}),
	/** Disband the team and keep its coordinator as an ordinary session. */
	disbandTeam: (projectId: string, teamId: string) =>
		request<{ narratorId: string }>(`${teamBase(projectId, teamId)}/disband`, {
			method: "POST",
			body: "{}",
		}),
	getProjectTeam: (projectId: string, teamId: string) =>
		request<TeamDetail>(teamBase(projectId, teamId)),
	getTeamSummary: (projectId: string, teamId: string) =>
		request<TeamPageSummary>(`${teamBase(projectId, teamId)}/summary`),
	getTeamBoardColumn: (
		projectId: string,
		teamId: string,
		column: TeamBoardColumn,
		cursor?: string,
	) =>
		request<TeamBoardColumnPage>(
			`${teamBase(projectId, teamId)}/board${query({ column, cursor })}`,
		),
	getTeamActivity: (projectId: string, teamId: string, cursor?: string) =>
		request<TeamActivityPage>(`${teamBase(projectId, teamId)}/events${query({ cursor })}`),
	/**
	 * The coordinator conversation's dividers (team mode): the fixed divider kinds since the
	 * oldest loaded message, newest first, with each detail cut to what a divider reads.
	 */
	getTeamConversationEvents: (
		projectId: string,
		teamId: string,
		options: { since?: string; cursor?: string },
	) =>
		request<TeamActivityPage>(
			`${teamBase(projectId, teamId)}/events${query({
				kinds: TEAM_CONVERSATION_EVENT_KINDS.join(","),
				since: options.since,
				cursor: options.cursor,
			})}`,
		),
	getTeamApprovals: (projectId: string, teamId: string) =>
		request<TeamApprovalsResponse>(`${teamBase(projectId, teamId)}/approvals`),
	/** The team's people: members and onlookers, with when each last spoke (M1). */
	getTeamMembers: (projectId: string, teamId: string) =>
		request<TeamMembersResponse>(`${teamBase(projectId, teamId)}/members`),
	/** The tree's running sessions now, for "pause all" (members only, at most 500). */
	getTeamRunning: (projectId: string, teamId: string) =>
		request<TeamRunningResponse>(`${teamBase(projectId, teamId)}/running`),
	/** Change the team's base branch or brief (members). */
	updateProjectTeam: (
		projectId: string,
		teamId: string,
		patch: { baseBranch?: string; brief?: string; settings?: TeamSettingsPatch },
	) =>
		request<TeamDetail>(teamBase(projectId, teamId), {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),
	/** Archive the team (its coordinator): kept read-only with every record. */
	archiveProjectTeam: (projectId: string, teamId: string) =>
		request<TeamDetail>(`${teamBase(projectId, teamId)}/archive`, { method: "POST", body: "{}" }),
	/** Lines added / removed and files changed of up to 50 work items. */
	getTeamWorkStats: (projectId: string, teamId: string, ids: readonly string[]) =>
		request<TeamWorkStatsResponse>(
			`${teamBase(projectId, teamId)}/work-stats${query({ ids: ids.join(",") })}`,
		),
	/** The work item drawer (no diff text). */
	getTeamWorkItem: (projectId: string, teamId: string, itemId: string) =>
		request<TeamWorkItemDetail>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}`,
		),
	/** One changed file's diff, capped; read when the drawer opens that file. */
	getTeamWorkDiff: (projectId: string, teamId: string, itemId: string, path: string) =>
		request<TeamWorkFileDiff>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}/diff${query({ path })}`,
		),
	/** Send a work item in review or ready back to work with a reason (members). */
	returnTeamWorkItem: (projectId: string, teamId: string, itemId: string, reason: string) =>
		request<TeamWorkReturnResponse>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}/return`,
			{ method: "POST", body: JSON.stringify({ reason }) },
		),
	/** Merge a ready work item into its base (members): accepted, runs in the background. */
	mergeTeamWorkItem: (projectId: string, teamId: string, itemId: string) =>
		request<TeamWorkMergeResponse>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}/merge`,
			{ method: "POST" },
		),
	/** G: merge a ready item's pull request on GitHub (members): accepted, runs in the background. */
	mergeTeamPullRequest: (
		projectId: string,
		teamId: string,
		itemId: string,
		method: TeamPrMergeMethod | undefined,
	) =>
		request<TeamWorkMergeResponse>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}/pr/merge`,
			{ method: "POST", body: JSON.stringify(method ? { method } : {}) },
		),
	/** G: the GitHub repository the project's pull requests go to (confirmed, and detected). */
	getTeamGithub: (projectId: string) =>
		request<TeamGithubPinResponse>(`/projects/${encodeURIComponent(projectId)}/team-github`),
	/** G: confirm (`host/owner/repo`) or, with null, clear it (project managers). */
	setTeamGithub: (projectId: string, target: string | null) =>
		request<TeamGithubPinResponse>(`/projects/${encodeURIComponent(projectId)}/team-github`, {
			method: target ? "PUT" : "DELETE",
			...(target ? { body: JSON.stringify({ target }) } : {}),
		}),
	/** G: read a ready item's pull request from GitHub now (unless read in the last 20 s). */
	refreshTeamPullRequest: (projectId: string, teamId: string, itemId: string) =>
		request<TeamWorkPrRefreshResponse>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}/pr/refresh`,
			{ method: "POST" },
		),
	/** Fast-forward a prepared merge in the checkout its base is checked out in (members). */
	fastForwardTeamWorkItem: (projectId: string, teamId: string, itemId: string) =>
		request<TeamWorkMergeResponse>(
			`${teamBase(projectId, teamId)}/work/${encodeURIComponent(itemId)}/merge/fast-forward`,
			{ method: "POST" },
		),
};
