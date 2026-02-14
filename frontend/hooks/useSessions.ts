import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export function useSessionMessages(id: string, around?: string) {
	return useInfiniteQuery({
		queryKey: ["sessions", id, "messages", { around }],
		queryFn: ({ pageParam }) => {
			if (!pageParam && around) {
				return api.getSessionMessages(id, undefined, undefined, around);
			}
			return api.getSessionMessages(id, pageParam ? 50 : 10, pageParam);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
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
