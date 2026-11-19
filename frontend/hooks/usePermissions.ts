import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function usePermissions(narratorId: string) {
	return useQuery({
		queryKey: ["permissions", narratorId],
		queryFn: ({ signal }) => api.getPendingPermissions(narratorId, signal),
		enabled: !!narratorId,
		// No polling — permission state is pushed via WebSocket events
		// (permission_request / permission_resolved) which trigger query
		// invalidation in the narrator page components.
	});
}
