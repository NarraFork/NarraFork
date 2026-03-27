import { useQuery } from "@tanstack/react-query";
import { api, type ChangelogEntry } from "../lib/api";

export type { ChangelogEntry };

export function useChangelogs() {
	return useQuery({
		queryKey: ["changelogs"],
		queryFn: () => api.getChangelogs(),
		staleTime: 5 * 60 * 1000,
	});
}
