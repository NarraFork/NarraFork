import type { PublicShareLinkPage } from "@shared/public-narrator-share";
import { useInfiniteQuery } from "@tanstack/react-query";
import { request } from "../lib/api/client";

/** Management only. Never import this module into the anonymous share page. */
export function useNarratorPublicShares(narratorId: string, canManage: boolean) {
	return useInfiniteQuery({
		queryKey: ["narrators", narratorId, "public-shares"],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam, signal }) =>
			request<PublicShareLinkPage>(
				`/narrators/${encodeURIComponent(narratorId)}/public-shares${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
				{ signal },
			),
		getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
		enabled: canManage,
		gcTime: 0,
		refetchOnWindowFocus: true,
	});
}
