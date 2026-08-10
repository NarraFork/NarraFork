import { useCallback, useEffect, useState } from "react";
import type { PluginPermissionRequestSummary } from "../lib/api/plugins";
import { pluginsApi } from "../lib/api/plugins";

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
	}, [load]);

	return { requests, loading, refresh: load };
}
