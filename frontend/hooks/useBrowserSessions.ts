import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const BROWSER_SESSIONS_GC_TIME_MS = 30_000;

export function useBrowserSessions(narratorId: string) {
	return useQuery({
		queryKey: ["browser-sessions", narratorId],
		queryFn: () => api.listBrowserSessions(narratorId),
		enabled: !!narratorId,
		gcTime: BROWSER_SESSIONS_GC_TIME_MS,
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

export function useSetBrowserSessionTtl() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			sessionId,
			ttlMs,
		}: {
			narratorId: string;
			sessionId: string;
			ttlMs: number;
		}) => api.setBrowserSessionTtl(narratorId, sessionId, ttlMs),
		onSuccess: (_, { narratorId }) => {
			qc.invalidateQueries({ queryKey: ["browser-sessions", narratorId] });
		},
	});
}

export function useStopBrowserTracing() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ narratorId, sessionId }: { narratorId: string; sessionId: string }) =>
			api.stopBrowserTracing(narratorId, sessionId),
		onSuccess: (_, { narratorId }) => {
			qc.invalidateQueries({ queryKey: ["browser-sessions", narratorId] });
		},
	});
}
