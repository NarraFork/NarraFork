/**
 * The redesigned project pages' reads on the client (R2): the project list's card numbers, the
 * project page's 「等你处理」, its team cards and its session list.
 *
 * Each is one bounded request (`shared/project-overview.ts`), polled while the page is visible
 * (React Query stops interval refetches in a hidden tab). A deployment without these reads
 * (PostgreSQL answers 503) and a reader asking for 「等你处理」 (403) are not retried: the page
 * simply leaves the block out.
 */
import { PROJECT_SESSIONS_PAGE_LIMIT, type ProjectSessionView } from "@shared/project-overview";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

const GC_TIME_MS = 60_000;

/** No retry for "not here" answers: 403 (not a member), 404, 503 (not on this deployment). */
const retryUnlessRefused = (count: number, error: unknown) => {
	const status = (error as { status?: unknown } | null)?.status;
	return !(status === 403 || status === 404 || status === 503) && count < 1;
};

export const projectOverviewKeys = {
	summaries: ["project-overview", "summaries"] as const,
	attention: (projectId: string) => ["project-overview", projectId, "attention"] as const,
	/** Under the project's narrator list key, so a new session refreshes it. */
	sessions: (projectId: string, view: ProjectSessionView) =>
		["narrators", "project", projectId, "view", view] as const,
	/**
	 * Under the team list key (`useTeams.ts:teamKeys.list`), so creating or archiving a team
	 * refreshes the cards.
	 */
	teamCards: (projectId: string) => ["teams", "project", projectId, "cards"] as const,
};

export function useProjectSummaries(enabled = true) {
	return useQuery({
		queryKey: projectOverviewKeys.summaries,
		queryFn: ({ signal }) => api.getProjectSummaries(signal),
		enabled,
		retry: retryUnlessRefused,
		staleTime: 10_000,
		refetchInterval: 30_000,
		gcTime: GC_TIME_MS,
	});
}

export function useProjectAttention(projectId: string, enabled = true) {
	return useQuery({
		queryKey: projectOverviewKeys.attention(projectId),
		queryFn: ({ signal }) => api.getProjectAttention(projectId, signal),
		enabled: enabled && !!projectId,
		retry: retryUnlessRefused,
		staleTime: 5_000,
		refetchInterval: 15_000,
		gcTime: GC_TIME_MS,
	});
}

export function useProjectTeamCards(projectId: string, enabled = true) {
	return useInfiniteQuery({
		queryKey: projectOverviewKeys.teamCards(projectId),
		queryFn: ({ pageParam }) => api.listProjectTeamCards(projectId, { cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: enabled && !!projectId,
		retry: retryUnlessRefused,
		refetchInterval: 30_000,
		gcTime: GC_TIME_MS,
	});
}

export function useProjectSessions(projectId: string, view: ProjectSessionView, enabled = true) {
	return useInfiniteQuery({
		queryKey: projectOverviewKeys.sessions(projectId, view),
		queryFn: ({ pageParam, signal }) =>
			api.listProjectSessions(
				projectId,
				{ view, cursor: pageParam, limit: PROJECT_SESSIONS_PAGE_LIMIT },
				signal,
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: enabled && !!projectId,
		retry: retryUnlessRefused,
		refetchInterval: 30_000,
		gcTime: GC_TIME_MS,
	});
}
