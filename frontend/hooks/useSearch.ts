import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SearchSortMode } from "../lib/search-utils";

export function useSearch(
	query: string,
	entities = "chapters,messages,narrators",
	sort: SearchSortMode = "relevance",
) {
	const normalizedQuery = query.trim();
	const [debouncedQuery, setDebouncedQuery] = useState(normalizedQuery);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(normalizedQuery), 300);
		return () => clearTimeout(timer);
	}, [normalizedQuery]);

	const isShortQuery = debouncedQuery.length > 0 && debouncedQuery.length < 3;

	return {
		...useQuery({
			queryKey: ["search", debouncedQuery, entities, sort],
			// Title/type only reorder the relevance-selected candidates on the page.
			queryFn: ({ signal }) =>
				api.search(debouncedQuery, entities, sort === "time" ? "time" : "relevance", signal),
			enabled: debouncedQuery.length > 0,
			staleTime: 30_000,
			gcTime: 60_000,
		}),
		isShortQuery,
	};
}
