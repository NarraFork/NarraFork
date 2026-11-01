import { narratorTimelineApi } from "@frontend/lib/api/narrator-timeline";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

/** While a turn is running its lanes grow, so the visible turn is polled. */
export const TIMELINE_LIVE_REFETCH_MS = 2500;
/** The turn list is polled slower; it only needs to notice a new turn starting. */
export const TIMELINE_TURNS_REFETCH_MS = 5000;

export const narratorTimelineKeys = {
	turns: (narratorId: string) => ["narrator-timeline", narratorId, "turns"] as const,
	turn: (narratorId: string, turnId: string | null) =>
		["narrator-timeline", narratorId, "turn", turnId ?? "latest"] as const,
};

/**
 * `turnId === null` follows the latest turn. Polling stops on its own once nothing is
 * live, and React Query pauses it while the page is hidden.
 */
export function useNarratorTimeline(narratorId: string, turnId: string | null) {
	const turns = useQuery({
		queryKey: narratorTimelineKeys.turns(narratorId),
		queryFn: () => narratorTimelineApi.turns(narratorId, { limit: 50 }),
		refetchInterval: (query) =>
			query.state.data?.turns[0]?.status === "running" || turnId === null
				? TIMELINE_TURNS_REFETCH_MS
				: false,
	});
	const timeline = useQuery({
		queryKey: narratorTimelineKeys.turn(narratorId, turnId),
		queryFn: () => narratorTimelineApi.turn(narratorId, turnId ?? undefined),
		placeholderData: keepPreviousData,
		refetchInterval: (query) =>
			query.state.data?.lanes.some((lane) => lane.live) ? TIMELINE_LIVE_REFETCH_MS : false,
	});
	return { turns, timeline };
}
