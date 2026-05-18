import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import type { ApiEntity } from "../lib/api/types";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useTerminalCapability } from "./usePlatform";

const TERMINALS_QUERY_GC_TIME_MS = 60_000;

function appendTerminalToCache(
	qc: QueryClient,
	queryKey: readonly ["terminals", { chapterId?: string; narratorId?: string }],
	terminal: ApiEntity,
) {
	if (!terminal?.id) return;
	qc.setQueryData<ApiEntity[]>(queryKey, (old) => {
		if (!old) return [terminal];
		if (old.some((t) => t.id === terminal.id)) return old;
		return [...old, terminal];
	});
}

export function useTerminals(chapterId: string) {
	const qc = useQueryClient();

	// Invalidate when any narrator in this chapter reports terminal_count_changed
	useEffect(() => {
		if (!chapterId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: "*", types: ["terminal_count_changed"] },
			() => {
				qc.invalidateQueries({ queryKey: ["terminals", { chapterId }] });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [chapterId, qc]);

	return useQuery({
		queryKey: ["terminals", { chapterId }],
		queryFn: () => api.listTerminals(chapterId),
		enabled: !!chapterId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
	});
}

export function useNarratorTerminals(narratorId: string) {
	const qc = useQueryClient();

	// Invalidate when this narrator's terminal count changes
	useEffect(() => {
		if (!narratorId) return;
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
		enabled: !!narratorId,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
	});
}

export function useCreateTerminal(chapterId: string) {
	const qc = useQueryClient();
	const terminalCapability = useTerminalCapability();
	const queryKey = ["terminals", { chapterId }] as const;
	return useMutation({
		mutationFn: (data?: { name?: string; cols?: number; rows?: number }) => {
			if (!terminalCapability.supported) {
				return Promise.reject(
					new Error(terminalCapability.reason ?? "Terminal runtime is not supported"),
				);
			}
			return api.createTerminal({ chapterId, ...data });
		},
		onSuccess: (terminal) => {
			appendTerminalToCache(qc, queryKey, terminal);
			qc.invalidateQueries({ queryKey });
		},
	});
}

export function useCreateNarratorTerminal(narratorId: string) {
	const qc = useQueryClient();
	const terminalCapability = useTerminalCapability();
	const queryKey = ["terminals", { narratorId }] as const;
	return useMutation({
		mutationFn: (data?: { name?: string; cols?: number; rows?: number }) => {
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

export function useDeleteTerminal(chapterId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteTerminal(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { chapterId }] });
		},
	});
}

export function useDeleteNarratorTerminal(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteTerminal(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
		},
	});
}

export function useRenameTerminal(key: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => api.renameTerminal(id, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["terminals", key] });
		},
	});
}
