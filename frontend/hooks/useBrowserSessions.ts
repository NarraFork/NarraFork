import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

const BROWSER_SESSIONS_GC_TIME_MS = 30_000;
const OPTIONAL_TOOL_STATE_GC_TIME_MS = 60_000;

/**
 * Whether an optional tool (by routine id, e.g. "browser") is loaded for this
 * narrator. Used by tool panels to offer a one-click load button.
 */
export function useOptionalToolState(narratorId: string, toolId: string, enabled = true) {
	return useQuery({
		queryKey: ["narrators", narratorId, "optional-tools", toolId],
		queryFn: () => api.getOptionalToolState(narratorId, toolId),
		enabled: !!narratorId && !!toolId && enabled,
		staleTime: 10_000,
		gcTime: OPTIONAL_TOOL_STATE_GC_TIME_MS,
	});
}

export function useLoadOptionalTool() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ narratorId, toolId }: { narratorId: string; toolId: string }) =>
			api.loadOptionalTool(narratorId, toolId),
		onSuccess: (_data, { narratorId, toolId }) => {
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "optional-tools", toolId] });
			// enabledTools is surfaced in the narrator details panel too.
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
		},
	});
}

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

export function useInteractBrowserSession() {
	return useMutation({
		mutationFn: ({
			narratorId,
			sessionId,
			params,
		}: {
			narratorId: string;
			sessionId: string;
			params: {
				action: "click" | "scroll" | "drag" | "type";
				coordinate?: { x: number; y: number };
				endCoordinate?: { x: number; y: number };
				direction?: "up" | "down";
				amount?: number;
				text?: string;
				key?: string;
				keys?: Array<{ text?: string; key?: string }>;
			};
		}) => api.interactBrowserSession(narratorId, sessionId, params),
	});
}
