import { useCallback, useEffect, useState } from "react";
import type { PluginPermissionRequestSummary } from "../lib/api/plugins";
import { pluginsApi } from "../lib/api/plugins";

// Poll while the grants tab is mounted (tab open + window focused): new pending
// requests appear autonomously when the plugin runtime calls an un-granted
// capability, and the admin should see them without a manual refresh.
const PENDING_REQUESTS_REFETCH_INTERVAL_MS = 15_000;

interface UsePluginPermissionRequestsResult {
	requests: PluginPermissionRequestSummary[];
	loading: boolean;
	refresh: () => void;
}

export function usePluginPermissionRequests(
	pluginId: string,
): UsePluginPermissionRequestsResult {
	const [requests, setRequests] = useState<PluginPermissionRequestSummary[]>([]);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const data = await pluginsApi.listPendingGrants(pluginId);
			setRequests(data.requests ?? []);
		} catch {
			// Silently ignore load errors; the caller may layer its own error on top.
			setRequests([]);
		} finally {
			setLoading(false);
		}
	}, [pluginId]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), PENDING_REQUESTS_REFETCH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [load]);

	return { requests, loading, refresh: load };
}
