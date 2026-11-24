import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import type { ApiEntity } from "../lib/api/types";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useTerminalCapability } from "./usePlatform";

const TERMINALS_QUERY_GC_TIME_MS = 60_000;

function appendTerminalToCache(
	qc: QueryClient,
	queryKey: readonly ["terminals", { narratorId: string }],
	terminal: ApiEntity,
) {
	if (!terminal?.id) return;
	qc.setQueryData<ApiEntity[]>(queryKey, (old) => {
		if (!old) return [terminal];
		if (old.some((t) => t.id === terminal.id)) return old;
		return [...old, terminal];
	});
}

export function useNarratorTerminals(narratorId: string) {
	const qc = useQueryClient();

	// Invalidate when this narrator's terminal count changes
	useEffect(() => {
		if (REMOTE_BUILD || !narratorId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["terminal_count_changed"] },
			() => {
				qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, qc]);

	return useQuery({
		queryKey: ["terminals", { narratorId }],
		queryFn: () => api.listTerminalsByNarrator(narratorId),
		enabled: !REMOTE_BUILD && !!narratorId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
	});
}

/**
 * Whether the current user may open a narrator's terminals: write access to the session.
 * Read-only viewers get no terminal panel and no create buttons (the server refuses them
 * anyway). `undefined` while loading.
 */
export function useCanOpenTerminals(narratorId: string): boolean | undefined {
	const { data } = useQuery({
		queryKey: ["terminals", "access", { narratorId }],
		queryFn: () => api.getTerminalAccess(narratorId),
		enabled: !REMOTE_BUILD && !!narratorId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
		staleTime: 30_000,
	});
	return data?.canOpen;
}

/** How often an open details panel re-reads the subagents' terminals (they live on other pages). */
const TREE_TERMINALS_REFRESH_MS = 15_000;

/**
 * The running terminals of the subagents below a narrator, for its details panel. Their
 * create/exit events go to each subagent's page, not this one, so the list is re-read while
 * shown (an indexed, bounded query).
 */
export function useTreeTerminals(narratorId: string) {
	return useQuery({
		queryKey: ["terminals", "tree", { narratorId }],
		queryFn: () => api.listTreeTerminals(narratorId),
		enabled: !REMOTE_BUILD && !!narratorId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
		refetchInterval: TREE_TERMINALS_REFRESH_MS,
	});
}

export function useCreateNarratorTerminal(narratorId: string) {
	const qc = useQueryClient();
	const terminalCapability = useTerminalCapability();
	const queryKey = ["terminals", { narratorId }] as const;
	return useMutation({
		mutationFn: (data?: { name?: string; cols?: number; rows?: number; deviceId?: string }) => {
			if (!terminalCapability.supported) {
				return Promise.reject(
					new Error(terminalCapability.reason ?? "Terminal runtime is not supported"),
				);
			}
			return api.createTerminal({ narratorId, ...data });
		},
		onSuccess: (terminal) => {
			appendTerminalToCache(qc, queryKey, terminal);
			qc.invalidateQueries({ queryKey });
		},
	});
}

export function useDeleteNarratorTerminal(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			REMOTE_BUILD
				? Promise.reject(new Error("Terminal runtime is not supported"))
				: api.deleteTerminal(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
		},
	});
}

export function useRenameTerminal(key: { narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) =>
			REMOTE_BUILD
				? Promise.reject(new Error("Terminal runtime is not supported"))
				: api.renameTerminal(id, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", key] });
		},
	});
}
