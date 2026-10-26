import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, type SearchRequest, type SearchSectionName } from "../lib/api";
import { searchParams } from "../lib/api/misc";

/** Sections the overview ("All" tab) loads, in display order. */
export const SEARCH_SECTION_ORDER: readonly SearchSectionName[] = ["sessions", "knowledge"];
/** Items per section on the overview. */
export const SEARCH_OVERVIEW_LIMIT = 5;
/** Items per page inside one section's tab. */
export const SEARCH_PAGE_LIMIT = 20;
/** Hits per page when a session card is expanded. */
export const SESSION_HITS_PAGE_LIMIT = 20;

/** Cache identity of a request: its query string, without paging. */
function requestKey(request: SearchRequest): string {
	return searchParams({
		...request,
		cursor: undefined,
		page: undefined,
		limit: undefined,
	}).toString();
}

const SEARCH_CACHE = { staleTime: 30_000, gcTime: 60_000 } as const;

/** The first page of every section, for the overview and the tab counts. */
export function useSearchOverview(request: SearchRequest) {
	const q = request.q.trim();
	return useQuery({
		queryKey: ["search", "overview", requestKey({ ...request, q })],
		queryFn: ({ signal }) =>
			api.searchSections(
				{ ...request, q, limit: SEARCH_OVERVIEW_LIMIT },
				SEARCH_SECTION_ORDER,
				signal,
			),
		enabled: q.length > 0,
		...SEARCH_CACHE,
	});
}

/** One page (1-based) of one section; the previous page stays shown while the next loads. */
export function useSearchSection(
	request: SearchRequest,
	section: SearchSectionName,
	page: number,
	enabled: boolean,
) {
	const q = request.q.trim();
	return useQuery({
		queryKey: ["search", "section", section, requestKey({ ...request, q }), page],
		queryFn: async ({ signal }) => {
			const response = await api.searchSections(
				{ ...request, q, page, limit: SEARCH_PAGE_LIMIT },
				[section],
				signal,
			);
			return (
				response.sections[section] ?? {
					items: [],
					total: 0,
					totalIsLowerBound: false,
					nextCursor: null,
				}
			);
		},
		placeholderData: keepPreviousData,
		enabled: enabled && q.length > 0,
		...SEARCH_CACHE,
	});
}

/** One session's hits beyond those its card shows, paged; loads only once expanded. */
export function useSessionHits(narratorId: string, request: SearchRequest, enabled: boolean) {
	const q = request.q.trim();
	return useInfiniteQuery({
		queryKey: ["search", "session-hits", narratorId, requestKey({ ...request, q })],
		queryFn: ({ pageParam, signal }) =>
			api.searchSessionHits(
				narratorId,
				{ ...request, q, cursor: pageParam, limit: SESSION_HITS_PAGE_LIMIT },
				signal,
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: enabled && q.length > 0,
		...SEARCH_CACHE,
	});
}
