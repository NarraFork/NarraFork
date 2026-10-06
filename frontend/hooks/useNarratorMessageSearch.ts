import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api";

/** Minimum query length before a search request is issued. */
export const NARRATOR_SEARCH_MIN_CHARS = 2;

/**
 * Debounced full-text search within a single narrator's own conversation
 * history. Mirrors the global `useSearch` hook (300ms debounce + React Query),
 * but scoped to one narrator and returning message hits with a `seq` for jumps.
 */
export function useNarratorMessageSearch(narratorId: string, query: string) {
	const [debouncedQuery, setDebouncedQuery] = useState(query);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(query), 300);
		return () => clearTimeout(timer);
	}, [query]);

	const trimmed = debouncedQuery.trim();
	const isShortQuery = trimmed.length > 0 && trimmed.length < NARRATOR_SEARCH_MIN_CHARS;
	const enabled = !!narratorId && trimmed.length >= NARRATOR_SEARCH_MIN_CHARS;

	return {
		...useQuery({
			queryKey: ["narrator-message-search", narratorId, trimmed],
			queryFn: () => api.searchNarratorMessages(narratorId, trimmed),
			enabled,
			staleTime: 30_000,
			gcTime: 60_000,
		}),
		isShortQuery,
		debouncedQuery: trimmed,
	};
}
