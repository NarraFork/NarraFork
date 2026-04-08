import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useBrowserSessions(narratorId: string) {
	return useQuery({
		queryKey: ["browser-sessions", narratorId],
		queryFn: () => api.listBrowserSessions(narratorId),
		enabled: !!narratorId,
	});
}

export function useCloseBrowserSession() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ narratorId, sessionId }: { narratorId: string; sessionId: string }) =>
			api.closeBrowserSession(narratorId, sessionId),
		onSuccess: (_, { narratorId }) => {
			qc.invalidateQueries({ queryKey: ["browser-sessions", narratorId] });
		},
	});
}
