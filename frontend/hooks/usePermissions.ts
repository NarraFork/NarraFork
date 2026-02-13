import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function usePermissions(narratorId: string) {
	return useQuery({
		queryKey: ["permissions", narratorId],
		queryFn: () => api.getPendingPermissions(narratorId),
		enabled: !!narratorId,
		refetchInterval: 3000, // Poll frequently for permission requests
	});
}
