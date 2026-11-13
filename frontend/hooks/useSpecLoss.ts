/**
 * Content the old Spec panel may have swallowed (outline P2 PR 12c), as the pages read it: a
 * session's findings (the Spec panel) or every session's (the admin page), one status a page at a
 * time, and one finding's lost text. Read only while the outline is switched on (its routes
 * answer 404 otherwise).
 */
import type {
	OutlineSpecLossAction,
	OutlineSpecLossPage,
	OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useOutlineEnabledInCache } from "./useOutlineEnabled";

const PAGE = 20;

/** `narratorId` null: the admin page's list of every session. */
export const specLossKey = (narratorId: string | null) =>
	["spec-loss", narratorId ?? "admin"] as const;

export function useSpecLossPages(
	narratorId: string | null,
	status: OutlineSpecLossStatus,
	options: { enabled?: boolean } = {},
) {
	const outline = useOutlineEnabledInCache();
	return useInfiniteQuery({
		queryKey: [...specLossKey(narratorId), "list", status],
		queryFn: ({ pageParam }) =>
			api.getSpecLossPage(narratorId, { status, cursor: pageParam, limit: PAGE }),
		initialPageParam: null as string | null,
		getNextPageParam: (last: OutlineSpecLossPage) => last.next,
		enabled: outline && options.enabled !== false,
		retry: false,
	});
}

/** How many findings a session has per status (one small page read). */
export function useSpecLossCounts(narratorId: string) {
	const outline = useOutlineEnabledInCache();
	return useQuery({
		queryKey: [...specLossKey(narratorId), "counts"],
		queryFn: () => api.getSpecLossPage(narratorId, { status: "open", limit: 1 }),
		enabled: outline && !!narratorId,
		retry: false,
	});
}

export function useSpecLossDetail(narratorId: string | null, findingId: string, enabled: boolean) {
	return useQuery({
		queryKey: [...specLossKey(narratorId), "detail", findingId],
		queryFn: () => api.getSpecLossDetail(narratorId, findingId),
		enabled,
		retry: false,
		// The lost text of a finding never changes.
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function useDecideSpecLoss(narratorId: string | null) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { findingId: string; action: OutlineSpecLossAction }) =>
			api.decideSpecLoss(narratorId, input.findingId, input.action),
		// Also after a refusal: someone else decided, the list is out of date.
		// The lists and counts of every scope (the admin page and the session's panel show the
		// same finding); the lost text itself never changes.
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: ["spec-loss"],
				predicate: (query) => query.queryKey[2] !== "detail",
			}),
	});
}
