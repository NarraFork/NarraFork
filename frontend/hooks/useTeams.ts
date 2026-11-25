/**
 * Project teams on the client (docs/PROJECT_TEAMS-PLAN.md P1, P4): a project's team list, one
 * team, and the team page's live reads.
 *
 * Live updates: the page subscribes to the coordinator on the narrator socket and refetches
 * the small summary on the frames listed in `SUMMARY_NUDGE_TYPES` (coalesced); underneath, the
 * summary is polled with a backoff (4 s after a change, doubling to 60 s while nothing changes,
 * paused while the tab is hidden). The board refetches only when work items changed (new event
 * or column counts), the activity on a new event, the approvals when their count changed.
 */
import type { CreateTeamPayload, UpgradeToTeamPayload } from "@frontend/lib/api/teams";
import {
	TEAM_WORK_STATS_IDS_MAX,
	type TeamBoardColumn,
	type TeamSettings,
	type TeamWorkStatsResponse,
} from "@shared/project-teams";
import {
	useInfiniteQuery,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
	boardSignature,
	chunkIds,
	nextPollDelay,
	nudgeDelay,
	type PauseOutcome,
	pauseOrder,
	SUMMARY_POLL_MIN_MS,
	summarySignature,
} from "../components/teams/team-page-model";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { projectOverviewKeys } from "./useProjectOverview";

const TEAM_GC_TIME_MS = 60_000;

/** Whether an error says teams are not available on this deployment (PostgreSQL: 503). */
export function teamsUnavailable(error: unknown): boolean {
	return (error as { status?: unknown } | null)?.status === 503;
}

export const teamKeys = {
	list: (projectId: string) => ["teams", "project", projectId] as const,
	team: (teamId: string) => ["teams", "team", teamId] as const,
	page: (teamId: string) => ["teams", "page", teamId] as const,
	summary: (teamId: string) => ["teams", "page", teamId, "summary"] as const,
	board: (teamId: string, column: TeamBoardColumn) =>
		["teams", "page", teamId, "board", column] as const,
	activity: (teamId: string) => ["teams", "page", teamId, "activity"] as const,
	approvals: (teamId: string) => ["teams", "page", teamId, "approvals"] as const,
	members: (teamId: string) => ["teams", "page", teamId, "members"] as const,
	/** Work item sizes, the drawer and its diffs: refetched with the board. */
	work: (teamId: string) => ["teams", "page", teamId, "work"] as const,
	workStats: (teamId: string, ids: readonly string[]) =>
		["teams", "page", teamId, "work", "stats", ids.join(",")] as const,
	workItem: (teamId: string, itemId: string) =>
		["teams", "page", teamId, "work", "item", itemId] as const,
	workDiff: (teamId: string, itemId: string, path: string) =>
		["teams", "page", teamId, "work", "diff", itemId, path] as const,
	approvalDetail: (teamId: string, requestId: string) =>
		["teams", "page", teamId, "approval-detail", requestId] as const,
};

/** A project's active teams, a page at a time. */
export function useProjectTeams(projectId: string, enabled = true) {
	return useInfiniteQuery({
		// Teams are not available on every deployment (PostgreSQL answers 503): do not retry that.
		retry: (count, error) => !teamsUnavailable(error) && count < 1,
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
		// The dialog shows the failure.
		meta: { suppressErrorToast: true },
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.list(projectId) });
			void queryClient.invalidateQueries({ queryKey: ["narrators", "project", projectId] });
		},
	});
}

/** Turn an existing session into a team's coordinator (the session overflow menu). */
export function useUpgradeToTeam(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (payload: UpgradeToTeamPayload) => api.upgradeSessionToTeam(projectId, payload),
		// The dialog shows the failure.
		meta: { suppressErrorToast: true },
		onSuccess: (team) => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.list(projectId) });
			void queryClient.invalidateQueries({ queryKey: ["narrators", team.id], exact: true });
		},
	});
}

/** Disband a team and keep its coordinator as an ordinary session (the team page's menu). */
export function useDisbandTeam(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.disbandTeam(projectId, teamId),
		// The dialog shows the failure.
		meta: { suppressErrorToast: true },
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.list(projectId) });
			queryClient.removeQueries({ queryKey: teamKeys.team(teamId) });
			queryClient.removeQueries({ queryKey: teamKeys.page(teamId) });
			void queryClient.invalidateQueries({ queryKey: ["narrators", teamId], exact: true });
		},
	});
}

export function useTeam(projectId: string, teamId: string) {
	return useQuery({
		retry: (count, error) => !teamsUnavailable(error) && count < 1,
		queryKey: teamKeys.team(teamId),
		queryFn: () => api.getProjectTeam(projectId, teamId),
		enabled: !!projectId && !!teamId,
		gcTime: TEAM_GC_TIME_MS,
	});
}

/**
 * Narrator socket frames on the coordinator that can change what the top bar shows. The server
 * sends the coordinator its own status, the tree's permission frames (ACL root), its direct
 * workers' start / finish (`subagent_*`), nested helpers' changes and its background task
 * counts. Other changes (a helper finishing, work item states) arrive with the poll.
 */
export const SUMMARY_NUDGE_TYPES = [
	"status_change",
	"substatus_change",
	"permission_request",
	"permission_resolved",
	"subagent_status_changed",
	"subagent_started",
	"subagent_detached",
	"subagent_nested_changed",
	"background_task_count_changed",
];
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
		let firstAt: number | null = null;
		const fire = () => {
			firstAt = null;
			delay.current = SUMMARY_POLL_MIN_MS;
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
		};
		const listener = narratorWSManager.addListener(
			{ narratorIds: [teamId], types: SUMMARY_NUDGE_TYPES },
			() => {
				const now = Date.now();
				firstAt ??= now;
				clearTimeout(timer);
				timer = setTimeout(fire, nudgeDelay(now - firstAt));
			},
		);
		return () => {
			clearTimeout(timer);
			narratorWSManager.removeListener(listener);
			narratorWSManager.unsubscribe(handle);
		};
	}, [teamId, queryClient]);

	// Only work item changes refetch the board (worker statuses are overlaid from the summary)
	// and only a new event refetches the activity.
	const board = boardSignature(summary.data);
	const seenBoard = useRef("");
	useEffect(() => {
		if (!board) return;
		if (seenBoard.current && seenBoard.current !== board) {
			void queryClient.invalidateQueries({ queryKey: [...teamKeys.page(teamId), "board"] });
			void queryClient.invalidateQueries({ queryKey: teamKeys.work(teamId) });
		}
		seenBoard.current = board;
	}, [board, teamId, queryClient]);
	const lastEvent = summary.data?.lastEventId ?? null;
	const seenEvent = useRef<string | null | undefined>(undefined);
	useEffect(() => {
		if (!summary.data) return;
		if (seenEvent.current !== undefined && seenEvent.current !== lastEvent)
			void queryClient.invalidateQueries({ queryKey: teamKeys.activity(teamId) });
		seenEvent.current = lastEvent;
	}, [lastEvent, summary.data, teamId, queryClient]);

	const pending = summary.data?.pendingApprovalCount ?? null;
	const seenPending = useRef<number | null>(null);
	useEffect(() => {
		if (pending !== null && seenPending.current !== null && seenPending.current !== pending)
			void queryClient.invalidateQueries({ queryKey: teamKeys.approvals(teamId) });
		seenPending.current = pending;
	}, [pending, teamId, queryClient]);

	return summary;
}

/** One column's cards; a folded column reads nothing. */
export function useTeamBoardColumn(
	projectId: string,
	teamId: string,
	column: TeamBoardColumn,
	open = true,
) {
	return useInfiniteQuery({
		queryKey: teamKeys.board(teamId, column),
		queryFn: ({ pageParam }) => api.getTeamBoardColumn(projectId, teamId, column, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: open && !!projectId && !!teamId,
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

/**
 * The team's people (M1): members and onlookers from the coordinator's ACL. Read when the
 * members drawer is open; access itself is changed through the narrator sharing panel.
 */
export function useTeamMembers(projectId: string, teamId: string, enabled: boolean) {
	return useQuery({
		queryKey: teamKeys.members(teamId),
		queryFn: () => api.getTeamMembers(projectId, teamId),
		enabled: enabled && !!projectId && !!teamId,
		gcTime: TEAM_GC_TIME_MS,
	});
}

/**
 * Approve or deny one pending call through the ordinary permission routes: a tool call, a plan,
 * or a question with its answers (keyed by question header, as the session's own form sends).
 */
export function useDecideApproval(teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			requestId,
			decision,
			answers,
		}: {
			requestId: string;
			decision: "allow" | "deny";
			answers?: Record<string, string>;
		}) =>
			decision === "allow"
				? api.approvePermission(requestId, answers ? { answers } : undefined)
				: api.denyPermission(requestId),
		// The card says it failed itself.
		meta: { suppressErrorToast: true },
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.approvals(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.activity(teamId) });
		},
	});
}

/**
 * A pending call's full input (a question's options, a plan's text) through the attention
 * inbox's detail read, which checks the caller's access to that session. Read per card shown.
 */
export function useApprovalDetail(teamId: string, requestId: string, enabled: boolean) {
	return useQuery({
		queryKey: teamKeys.approvalDetail(teamId, requestId),
		queryFn: ({ signal }) => api.getHumanAttentionDetail(`permission:${requestId}`, signal),
		enabled: enabled && !!requestId,
		gcTime: TEAM_GC_TIME_MS,
		staleTime: 60_000,
		retry: false,
	});
}

/**
 * Lines added / removed and files of the listed work items: one request per 50 ids (the
 * endpoint's limit), merged; none listed, no request.
 */
export function useTeamWorkStats(projectId: string, teamId: string, ids: readonly string[]) {
	const chunks = chunkIds(ids, TEAM_WORK_STATS_IDS_MAX);
	return useQueries({
		queries: chunks.map((chunk) => ({
			queryKey: teamKeys.workStats(teamId, chunk),
			queryFn: () => api.getTeamWorkStats(projectId, teamId, chunk),
			enabled: !!projectId && !!teamId,
			gcTime: TEAM_GC_TIME_MS,
			staleTime: 15_000,
			placeholderData: (previous: TeamWorkStatsResponse | undefined) => previous,
			refetchOnWindowFocus: false,
		})),
		combine: (results) => {
			const stats: TeamWorkStatsResponse["stats"] = {};
			for (const result of results) Object.assign(stats, result.data?.stats);
			return { stats, isLoading: results.some((result) => result.isLoading) };
		},
	});
}

/** How often the drawer reads again while a merge job runs. */
const MERGE_POLL_MS = 1_500;

/**
 * The work item drawer's detail; read only while the drawer shows that item. While a merge job
 * runs it is read again every {@link MERGE_POLL_MS} until the job is done.
 */
export function useTeamWorkItem(projectId: string, teamId: string, itemId: string | null) {
	return useQuery({
		queryKey: teamKeys.workItem(teamId, itemId ?? ""),
		queryFn: () => api.getTeamWorkItem(projectId, teamId, itemId ?? ""),
		enabled: !!projectId && !!teamId && !!itemId,
		gcTime: TEAM_GC_TIME_MS,
		refetchOnWindowFocus: false,
		refetchInterval: (query) => (query.state.data?.merge?.phase ? MERGE_POLL_MS : false),
	});
}

/**
 * Merge a ready item, or fast-forward its prepared merge (members). Both answer at once (202);
 * the drawer and the board follow the job.
 */
export function useMergeWorkItem(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ itemId, fastForward }: { itemId: string; fastForward?: boolean }) =>
			fastForward
				? api.fastForwardTeamWorkItem(projectId, teamId, itemId)
				: api.mergeTeamWorkItem(projectId, teamId, itemId),
		meta: { suppressErrorToast: true },
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
			void queryClient.invalidateQueries({ queryKey: [...teamKeys.page(teamId), "board"] });
			void queryClient.invalidateQueries({ queryKey: teamKeys.work(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.activity(teamId) });
			// The project page's 等你处理 carries ready items of every team.
			void queryClient.invalidateQueries({ queryKey: projectOverviewKeys.attention(projectId) });
		},
	});
}

/** One changed file's diff; read only when that file is opened in the drawer. */
export function useTeamWorkDiff(
	projectId: string,
	teamId: string,
	itemId: string,
	path: string | null,
) {
	return useQuery({
		queryKey: teamKeys.workDiff(teamId, itemId, path ?? ""),
		queryFn: () => api.getTeamWorkDiff(projectId, teamId, itemId, path ?? ""),
		enabled: !!projectId && !!teamId && !!itemId && !!path,
		gcTime: TEAM_GC_TIME_MS,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
}

/** Send a work item back to work with a reason (members; the drawer shows the failure). */
export function useReturnWorkItem(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ itemId, reason }: { itemId: string; reason: string }) =>
			api.returnTeamWorkItem(projectId, teamId, itemId, reason),
		meta: { suppressErrorToast: true },
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
			void queryClient.invalidateQueries({ queryKey: [...teamKeys.page(teamId), "board"] });
			void queryClient.invalidateQueries({ queryKey: teamKeys.work(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.activity(teamId) });
		},
	});
}

/** Archive the team (the wrap-up's suggestion): its records stay, read-only. */
export function useArchiveTeam(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.archiveProjectTeam(projectId, teamId),
		meta: { suppressErrorToast: true },
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.team(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
			void queryClient.invalidateQueries({ queryKey: teamKeys.list(projectId) });
			// The drawer's 退回 depends on the team being active.
			void queryClient.invalidateQueries({ queryKey: teamKeys.work(teamId) });
		},
	});
}

/** Change the team's base branch or brief (the settings dialog). */
export function useUpdateTeam(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: { baseBranch?: string; brief?: string; settings?: TeamSettings }) =>
			api.updateProjectTeam(projectId, teamId, patch),
		meta: { suppressErrorToast: true },
		onSuccess: (team) => {
			queryClient.setQueryData(teamKeys.team(teamId), team);
			// A new base branch changes every item's merge base, sizes and diffs.
			void queryClient.invalidateQueries({ queryKey: teamKeys.work(teamId) });
		},
	});
}

/**
 * "Pause all": read the tree's running sessions now (not the summary, which names at most 20
 * and may be a minute old), then stop each through the ordinary Stop route (which ends a
 * session's turn, a detached run through its task), coordinator first. Each stop is its own
 * request with its own access check; the result says how many were stopped and how many not.
 */
export function usePauseTeam(projectId: string, teamId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (): Promise<PauseOutcome> => {
			const running = await api.getTeamRunning(projectId, teamId);
			let stopped = 0;
			let alreadyIdle = 0;
			let failed = 0;
			for (const id of pauseOrder(teamId, running.agents)) {
				try {
					// `interrupted: false`: nothing was running by the time it got there.
					const result = (await api.interruptNarrator(id)) as { interrupted?: unknown };
					if (result.interrupted === true) stopped++;
					else alreadyIdle++;
				} catch {
					failed++;
				}
			}
			return { stopped, alreadyIdle, failed, more: running.more };
		},
		meta: { suppressErrorToast: true },
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: teamKeys.summary(teamId) });
		},
	});
}
