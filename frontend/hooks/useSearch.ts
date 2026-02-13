import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { api } from "../lib/api";

export function useSearch(query: string, entities = "chapters,messages") {
	const [debouncedQuery, setDebouncedQuery] = useState(query);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(query), 300);
		return () => clearTimeout(timer);
	}, [query]);

	return useQuery({
		queryKey: ["search", debouncedQuery, entities],
		queryFn: () => api.search(debouncedQuery, entities),
		enabled: debouncedQuery.length >= 2,
	});
}
