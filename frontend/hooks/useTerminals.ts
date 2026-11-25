import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { useDocumentVisibility } from "@mantine/hooks";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { request } from "../lib/api/client";
import type { ApiEntity } from "../lib/api/types";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useNarratorUiScope, useNarratorUiSummary } from "./useNarratorUiSummary";
import { useTerminalCapability } from "./usePlatform";

const TERMINALS_QUERY_GC_TIME_MS = 60_000;

function appendTerminalToCache(qc: QueryClient, queryKey: readonly unknown[], terminal: ApiEntity) {
	if (!terminal?.id) return;
	qc.setQueryData<ApiEntity[]>(queryKey, (old) => {
		if (!old) return [terminal];
		if (old.some((t) => t.id === terminal.id)) return old;
		return [...old, terminal];
	});
}

export function useNarratorTerminals(narratorId: string, visible = true) {
	const qc = useQueryClient();
	const { userId, token } = useNarratorUiScope();
	const canOpen = useCanOpenTerminals(narratorId);
	const documentVisibility = useDocumentVisibility();
	const documentVisible =
		documentVisibility === "visible" &&
		typeof document !== "undefined" &&
		document.visibilityState === "visible";
	const enabled =
		!REMOTE_BUILD &&
		visible &&
		documentVisible &&
		!!narratorId &&
		!!token &&
		!!userId &&
		canOpen === true;
	const queryKey = ["terminals", { narratorId }, userId, token] as const;

	// Invalidate only an actually visible list; do not keep hidden entity reads alive.
	useEffect(() => {
		if (!enabled) {
			const key = ["terminals", { narratorId }, userId, token] as const;
			// QueryObserver applies enabled in its own effect, after this hook's effect.
			queueMicrotask(() => {
				if (!qc.getQueryCache().find({ queryKey: key, exact: true })?.isActive())
					void qc.cancelQueries({ queryKey: key, exact: true });
			});
			return;
		}
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["terminal_count_changed"] },
			() => {
				qc.invalidateQueries({ queryKey: ["terminals", { narratorId }] });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, qc, enabled, userId, token]);

	return useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			request<ApiEntity[]>(`/terminals?${new URLSearchParams({ narratorId })}`, {
				signal,
				maxResponseBytes: 512 * 1024,
			}),
		enabled,
		gcTime: TERMINALS_QUERY_GC_TIME_MS,
		staleTime: 30_000,
	});
}

/**
 * Whether the current user may open a narrator's terminals: write access to the session.
 * Read-only viewers get no terminal panel and no create buttons (the server refuses them
 * anyway). `undefined` while loading.
 */
export function useCanOpenTerminals(narratorId: string): boolean | undefined {
	const query = useNarratorUiSummary(narratorId);
	return REMOTE_BUILD || query.isError ? undefined : query.data?.canWrite;
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
	const { userId, token } = useNarratorUiScope();
	const queryKey = ["terminals", { narratorId }, userId, token] as const;
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
			qc.invalidateQueries({ queryKey: ["narrator-ui-summary", narratorId] });
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
			qc.invalidateQueries({ queryKey: ["narrator-ui-summary", narratorId] });
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
