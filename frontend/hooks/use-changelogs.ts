import { useQuery } from "@tanstack/react-query";
import { api, type ChangelogEntry } from "../lib/api";

export type { ChangelogEntry };

const CHANGELOGS_QUERY_GC_TIME_MS = 60_000;

export function useChangelogs() {
	return useQuery({
		queryKey: ["changelogs"],
		queryFn: () => api.getChangelogs(),
		staleTime: 5 * 60 * 1000,
		gcTime: CHANGELOGS_QUERY_GC_TIME_MS,
	});
}
