import type {
	TeamActivityPage,
	TeamApprovalsResponse,
	TeamBoardColumn,
	TeamBoardColumnPage,
	TeamDetail,
	TeamListResponse,
	TeamMembersResponse,
	TeamPageSummary,
	TeamRunningResponse,
} from "@shared/project-teams";
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
	createProjectTeam: (projectId: string, payload: CreateTeamPayload) =>
		request<TeamDetail>(`/projects/${encodeURIComponent(projectId)}/teams`, {
			method: "POST",
			body: JSON.stringify(payload),
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
	getTeamApprovals: (projectId: string, teamId: string) =>
		request<TeamApprovalsResponse>(`${teamBase(projectId, teamId)}/approvals`),
	/** The team's people: members and onlookers, with when each last spoke (M1). */
	getTeamMembers: (projectId: string, teamId: string) =>
		request<TeamMembersResponse>(`${teamBase(projectId, teamId)}/members`),
	/** The tree's running sessions now, for "pause all" (members only, at most 500). */
	getTeamRunning: (projectId: string, teamId: string) =>
		request<TeamRunningResponse>(`${teamBase(projectId, teamId)}/running`),
};
