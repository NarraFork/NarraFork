import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Whether the person can open a session: its detail reads (the same request and cache as
 * `useNarrator`), without retrying a 404. Used to enable "open the session that wrote this"
 * only when the narrator routes would let the person in; the answer is the server's.
 */
export function useNarratorReadable(narratorId: string | null | undefined): {
	readable: boolean;
	loading: boolean;
} {
	const query = useQuery({
		queryKey: ["narrators", narratorId ?? ""],
		queryFn: ({ signal }) => api.getNarrator(narratorId as string, signal),
		enabled: !!narratorId,
		retry: false,
		staleTime: 30_000,
	});
	return { readable: query.isSuccess, loading: !!narratorId && query.isLoading };
}
