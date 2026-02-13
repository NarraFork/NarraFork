import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function useSessions() {
	return useQuery({
		queryKey: ["sessions"],
		queryFn: api.listSessions,
	});
}

export function useSession(id: string) {
	return useQuery({
		queryKey: ["sessions", id],
		queryFn: () => api.getSession(id),
		enabled: !!id,
	});
}

export function useSessionMessages(id: string, limit?: number) {
	return useQuery({
		queryKey: ["sessions", id, "messages", limit],
		queryFn: () => api.getSessionMessages(id, limit),
		enabled: !!id,
	});
}

export function useCreateSession() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.createSession,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["sessions"] });
		},
	});
}

export function useDeleteSession() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteSession,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["sessions"] });
		},
	});
}
