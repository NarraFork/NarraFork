import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { type PreparedUpdateStatus, resolveUpdateStatusPollInterval } from "../lib/update-state";

export const UPDATE_STATUS_QUERY_KEY = "update-status";

/**
 * Poll the prepared-update status for one target version.
 *
 * The header pill and the update dialog share this query so a scheduled update stays visible
 * while the dialog is closed without doubling the request rate. An active schedule is polled
 * once a second; otherwise a low-frequency fallback keeps a schedule started in another tab
 * (or before a reload) discoverable. See `resolveUpdateStatusPollInterval`.
 *
 * The status endpoint is admin-only, so callers must gate `enabled` on the admin role to avoid
 * predictable 403s for regular users.
 */
export function useUpdateScheduleStatus(options: {
	targetVersion?: string;
	enabled: boolean;
	/** Ignore a stale coordination error recorded before this timestamp. */
	errorSinceMs?: number | null;
	/** Keep polling because a local apply call just reported a scheduled update. */
	assumeScheduled?: boolean;
}) {
	const { targetVersion, enabled, errorSinceMs = null, assumeScheduled = false } = options;
	return useQuery({
		queryKey: [UPDATE_STATUS_QUERY_KEY, targetVersion],
		queryFn: () => api.getUpdateStatus(targetVersion),
		enabled: enabled && !!targetVersion,
		staleTime: 0,
		refetchInterval: (query) =>
			resolveUpdateStatusPollInterval({
				status: query.state.data as PreparedUpdateStatus | undefined,
				dataUpdatedAt: query.state.dataUpdatedAt,
				errorSinceMs,
				assumeScheduled,
			}),
	});
}
