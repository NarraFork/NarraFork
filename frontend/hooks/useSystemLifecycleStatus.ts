import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../lib/api";
import { systemLifecycleStatusQueryKey } from "../lib/api/system-lifecycle";

/** Both administrator surfaces observe this same cache, including asynchronous preparation. */
export function useSystemLifecycleStatus(enabled = true) {
	return useQuery({
		queryKey: systemLifecycleStatusQueryKey,
		queryFn: ({ signal }) => api.getSystemLifecycleStatus(signal),
		enabled: (query) =>
			enabled &&
			query.state.data?.phase !== "shutting_down" &&
			!(
				query.state.data?.shutdownRequested &&
				query.state.error &&
				!(query.state.error instanceof ApiError)
			),
		refetchInterval: (query) =>
			query.state.data?.phase === "shutting_down" ||
			(query.state.data?.shutdownRequested &&
				query.state.error &&
				!(query.state.error instanceof ApiError))
				? false
				: 2_000,
		refetchIntervalInBackground: true,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: (query) => query.state.data?.phase !== "shutting_down",
		retry: false,
	});
}
