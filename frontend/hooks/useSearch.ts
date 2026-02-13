import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function useSearch(
	query: string,
	entities = "chapters,messages,narrators",
	forceSearch = false,
) {
	const [debouncedQuery, setDebouncedQuery] = useState(query);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(query), 300);
		return () => clearTimeout(timer);
	}, [query]);

	const isShortQuery = debouncedQuery.length > 0 && debouncedQuery.length < 3;

	return {
		...useQuery({
			queryKey: ["search", debouncedQuery, entities],
			queryFn: () => api.search(debouncedQuery, entities),
			enabled: debouncedQuery.length >= 3 || (isShortQuery && forceSearch),
		}),
		isShortQuery,
	};
}
