import { useNarrator } from "@frontend/hooks/useNarrator";
import { narratorTimelineApi } from "@frontend/lib/api/narrator-timeline";
import type { TimelineTurnSummary, TurnTimelineResponse } from "@shared/narrator-timeline";
import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

/** Fastest poll of a live turn; slower when the turn is expensive to build. */
export const TIMELINE_LIVE_REFETCH_MS = 2500;
export const TIMELINE_LIVE_MAX_REFETCH_MS = 15_000;
/**
 * Turn starts and ends arrive as narrator status changes over the WebSocket; this slow poll
 * only backs that up where no narrator socket is open (a detached panel window).
 */
export const TIMELINE_FOLLOW_REFETCH_MS = 30_000;
const TURNS_PAGE_SIZE = 50;

export const narratorTimelineKeys = {
	all: (narratorId: string) => ["narrator-timeline", narratorId] as const,
	turns: (narratorId: string) => ["narrator-timeline", narratorId, "turns"] as const,
	turn: (narratorId: string, turnId: string | null) =>
		["narrator-timeline", narratorId, "turn", turnId ?? "latest"] as const,
};

/** Keeps polling to at most a quarter of wall time, whatever one build costs. */
export function liveRefetchInterval(lastFetchMs: number): number {
	return Math.min(
		TIMELINE_LIVE_MAX_REFETCH_MS,
		Math.max(TIMELINE_LIVE_REFETCH_MS, Math.round(lastFetchMs * 4)),
	);
}

function isLive(data: TurnTimelineResponse | undefined): boolean {
	return !!data?.lanes.some((lane) => lane.live);
}

/**
 * `selectedTurnId === null` follows the latest turn. A finished turn is fetched once; a live
 * one is polled; turn starts and ends refresh both queries through the narrator's status.
 */
export function useNarratorTimeline(narratorId: string, selectedTurnId: string | null) {
	const queryClient = useQueryClient();
	const narrator = useNarrator(narratorId).data as
		| { status?: string; turnStartedAt?: string }
		| undefined;
	const working = narrator?.status === "working" || narrator?.status === "waiting";
	const following = selectedTurnId === null;

	const turnsQuery = useInfiniteQuery({
		queryKey: narratorTimelineKeys.turns(narratorId),
		queryFn: ({ pageParam }) =>
			narratorTimelineApi.turns(narratorId, { before: pageParam, limit: TURNS_PAGE_SIZE }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) =>
			last.hasMore ? last.turns[last.turns.length - 1]?.startedAt : undefined,
		refetchInterval: (query) => {
			if (!following) return false;
			// Working, but the new turn is not listed yet: catch it as soon as it is.
			const latest = query.state.data?.pages[0]?.turns[0];
			return working && latest?.status !== "running"
				? TIMELINE_LIVE_REFETCH_MS
				: TIMELINE_FOLLOW_REFETCH_MS;
		},
	});
	const turns: TimelineTurnSummary[] = useMemo(
		() => turnsQuery.data?.pages.flatMap((page) => page.turns) ?? [],
		[turnsQuery.data],
	);
	// Keyed by the concrete turn id, so a new turn is a new query rather than a stale "latest".
	const turnId = selectedTurnId ?? turns[0]?.id ?? null;

	const fetchMs = useRef(0);
	const timeline = useQuery({
		queryKey: narratorTimelineKeys.turn(narratorId, turnId),
		queryFn: async () => {
			const startedAt = performance.now();
			const result = await narratorTimelineApi.turn(narratorId, turnId ?? undefined);
			fetchMs.current = performance.now() - startedAt;
			return result;
		},
		enabled: turnsQuery.status !== "pending",
		placeholderData: keepPreviousData,
		staleTime: (query) => (isLive(query.state.data) ? 0 : Number.POSITIVE_INFINITY),
		refetchInterval: (query) =>
			isLive(query.state.data) ? liveRefetchInterval(fetchMs.current) : false,
	});

	const activity = narrator ? `${narrator.status ?? ""}|${narrator.turnStartedAt ?? ""}` : null;
	const seenActivity = useRef(activity);
	useEffect(() => {
		if (activity === null || activity === seenActivity.current) return;
		const first = seenActivity.current === null;
		seenActivity.current = activity;
		if (!first)
			void queryClient.invalidateQueries({ queryKey: narratorTimelineKeys.all(narratorId) });
	}, [activity, narratorId, queryClient]);

	return {
		turns,
		turnsQuery,
		timeline,
		hasOlderTurns: !!turnsQuery.hasNextPage,
		loadOlderTurns: turnsQuery.fetchNextPage,
	};
}
