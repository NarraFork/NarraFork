/**
 * Project teams on the client (docs/PROJECT_TEAMS-PLAN.md P1, P4): a project's team list, one
 * team, and the team page's live reads.
 *
 * Live updates: the page subscribes to the coordinator on the narrator socket (the server
 * broadcasts the whole tree's status and approval frames to the ACL root, i.e. the
 * coordinator) and refetches the small summary on any of them; underneath, the summary is
 * polled with a backoff (4 s after a change, doubling to 60 s while nothing changes, paused
 * while the tab is hidden). The board, the activity and the approvals refetch only when the
 * summary says something they show has changed.
 */
import type { CreateTeamPayload } from "@frontend/lib/api/teams";
import type { TeamBoardColumn, TeamPageSummary } from "@shared/project-teams";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
	boardSignature,
	nextPollDelay,
	pauseOrder,
	SUMMARY_POLL_MIN_MS,
	summarySignature,
} from "../components/teams/team-page-model";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

const TEAM_GC_TIME_MS = 60_000;

export const teamKeys = {
	list: (projectId: string) => ["teams", "project", projectId] as const,
	team: (teamId: string) => ["teams", "team", teamId] as const,
	page: (teamId: string) => ["teams", "page", teamId] as const,
	summary: (teamId: string) => ["teams", "page", teamId, "summary"] as const,
	board: (teamId: string, column: TeamBoardColumn) =>
		["teams", "page", teamId, "board", column] as const,
	activity: (teamId: string) => ["teams", "page", teamId, "activity"] as const,
	approvals: (teamId: string) => ["teams", "page", teamId, "approvals"] as const,
};

/** A project's active teams, a page at a time. */
export function useProjectTeams(projectId: string, enabled = true) {
	return useInfiniteQuery({
		queryKey: teamKeys.list(projectId),
		queryFn: ({ pageParam }) =>
			api.listProjectTeams(projectId, { status: "active", cursor: pageParam, limit: 50 }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: enabled && !!projectId,
		gcTime: TEAM_GC_TIME_MS,
	});
}

export function useCreateTeam(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: CreateTeamPayload) => api.createProjectTeam(projectId, payload),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.list(projectId) });
			void queryClient.invalidateQueries({ queryKey: ["narrators", "project", projectId] });
		},
	});
}

export function useTeam(projectId: string, teamId: string) {
	return useQuery({
		queryKey: teamKeys.team(teamId),
		queryFn: () => api.getProjectTeam(projectId, teamId),
		enabled: !!projectId && !!teamId,
		gcTime: TEAM_GC_TIME_MS,
	});
}

/** Narrator socket frames that can change what the top bar shows. */
const SUMMARY_NUDGE_TYPES = [
	"status_change",
	"narrator:status_changed",
	"substatus_change",
	"permission_request",
	"permission_resolved",
	"subagent_status_changed",
	"subagent_started",
	"subagent_nested_changed",
];
const NUDGE_DEBOUNCE_MS = 400;

/**
 * The team page's summary, kept live (see the module comment). Also refetches the board, the
 * activity and the approvals when the summary says they changed.
 */
export function useTeamSummary(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	const delay = useRef(SUMMARY_POLL_MIN_MS);
	const lastSignature = useRef("");
	const summary = useQuery({
		queryKey: teamKeys.summary(teamId),
		queryFn: async () => {
			const next = await api.getTeamSummary(projectId, teamId);
			const signature = summarySignature(next);
			delay.current = nextPollDelay(delay.current, signature !== lastSignature.current);
			lastSignature.current = signature;
			return next;
		},
		enabled: !!projectId && !!teamId,
		refetchInterval: () => delay.current,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: true,
		gcTime: TEAM_GC_TIME_MS,
	});

	// Live nudges over the narrator socket: the whole tree reports to the coordinator.
	useEffect(() => {
		if (!teamId) return;
		const handle = narratorWSManager.subscribe([teamId]);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const listener = narratorWSManager.addListener(
			{ narratorIds: [teamId], types: SUMMARY_NUDGE_TYPES },
			() => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					delay.current = SUMMARY_POLL_MIN_MS;
					void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
				}, NUDGE_DEBOUNCE_MS);
			},
		);
		return () => {
			clearTimeout(timer);
			narratorWSManager.removeListener(listener);
			narratorWSManager.unsubscribe(handle);
		};
	}, [teamId, queryClient]);

	const board = boardSignature(summary.data);
	const seenBoard = useRef("");
	useEffect(() => {
		if (!board) return;
		if (seenBoard.current && seenBoard.current !== board) {
			void queryClient.invalidateQueries({ queryKey: [...teamKeys.page(teamId), "board"] });
			void queryClient.invalidateQueries({ queryKey: teamKeys.activity(teamId) });
		}
		seenBoard.current = board;
	}, [board, teamId, queryClient]);

	const pending = summary.data?.pendingApprovalCount ?? null;
	const seenPending = useRef<number | null>(null);
	useEffect(() => {
		if (pending !== null && seenPending.current !== null && seenPending.current !== pending)
			void queryClient.invalidateQueries({ queryKey: teamKeys.approvals(teamId) });
		seenPending.current = pending;
	}, [pending, teamId, queryClient]);

	return summary;
}

export function useTeamBoardColumn(projectId: string, teamId: string, column: TeamBoardColumn) {
	return useInfiniteQuery({
		queryKey: teamKeys.board(teamId, column),
		queryFn: ({ pageParam }) => api.getTeamBoardColumn(projectId, teamId, column, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: !!projectId && !!teamId,
		gcTime: TEAM_GC_TIME_MS,
		refetchOnWindowFocus: false,
	});
}

export function useTeamActivity(projectId: string, teamId: string) {
	return useInfiniteQuery({
		queryKey: teamKeys.activity(teamId),
		queryFn: ({ pageParam }) => api.getTeamActivity(projectId, teamId, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: !!projectId && !!teamId,
		gcTime: TEAM_GC_TIME_MS,
		refetchOnWindowFocus: false,
	});
}

/** Pending approvals of the tree; members only (an onlooker never asks). */
export function useTeamApprovals(projectId: string, teamId: string, enabled: boolean) {
	return useQuery({
		queryKey: teamKeys.approvals(teamId),
		queryFn: () => api.getTeamApprovals(projectId, teamId),
		enabled: enabled && !!projectId && !!teamId,
		gcTime: TEAM_GC_TIME_MS,
	});
}

/** Approve or deny one pending tool call through the ordinary permission routes. */
export function useDecideApproval(teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ requestId, decision }: { requestId: string; decision: "allow" | "deny" }) =>
			decision === "allow" ? api.approvePermission(requestId) : api.denyPermission(requestId),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.approvals(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
		},
	});
}

/**
 * "Pause all": stop every running session of the tree through the ordinary Stop route (which
 * ends a session's turn, a detached run through its task), coordinator first. Each stop is its
 * own request with its own access check; the result counts the ones that failed.
 */
export function usePauseTeam(teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (summary: TeamPageSummary) => {
			let failed = 0;
			for (const id of pauseOrder(teamId, summary)) {
				try {
					await api.interruptNarrator(id);
				} catch {
					failed++;
				}
			}
			return { failed };
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
		},
	});
}
