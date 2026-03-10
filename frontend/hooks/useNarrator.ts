import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	api,
	type MessagesAroundOptions,
	type PaginatedNarrators,
	type WhitelistDir,
} from "../lib/api";
import { RECENT_TABS_QUERY_KEY } from "./useRecentTabs";

export function useNarrators(opts?: {
	chapterId?: string;
	standalone?: boolean;
	status?: string;
	sortBy?: string;
	sortOrder?: string;
}) {
	return useQuery({
		queryKey: ["narrators", { ...opts }],
		queryFn: () => api.listNarrators(opts),
		enabled: !!(opts?.chapterId || opts?.standalone),
	});
}

export function useNarratorsPaginated(opts?: {
	standalone?: boolean | "all";
	status?: string;
	filter?: string;
	sortBy?: string;
	sortOrder?: string;
	limit?: number;
	hasTerminals?: boolean;
	hasContainers?: boolean;
	hasRunningContainers?: boolean;
	hasViewers?: boolean;
}) {
	return useInfiniteQuery<PaginatedNarrators>({
		queryKey: ["narrators", "paginated", { ...opts }],
		queryFn: ({ pageParam }) =>
			api.listNarratorsPaginated({ ...opts, cursor: pageParam as string | undefined }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) =>
			lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
	});
}

// === Narrator Fork (standalone narrators only) ===

export function useForkNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			forkMessageUuid,
			title,
			inheritMode,
		}: {
			narratorId: string;
			forkMessageUuid: string;
			title?: string;
			inheritMode?: "full" | "compressed" | "fresh";
		}) => api.forkNarrator(narratorId, forkMessageUuid, title, inheritMode),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export const DEFAULT_MESSAGES_AROUND_BEFORE = 5;
export const DEFAULT_MESSAGES_AROUND_AFTER = 20;

export interface NarratorMessagesAroundOptions extends MessagesAroundOptions {}

function normalizeAroundOptions(
	around?: NarratorMessagesAroundOptions,
): NarratorMessagesAroundOptions | undefined {
	if (!around?.messageId) return undefined;
	return {
		messageId: around.messageId,
		before: around.before ?? DEFAULT_MESSAGES_AROUND_BEFORE,
		after: around.after ?? DEFAULT_MESSAGES_AROUND_AFTER,
	};
}

export function getNarratorMessagesQueryKey(
	narratorId: string,
	around?: NarratorMessagesAroundOptions,
) {
	const normalizedAround = normalizeAroundOptions(around);
	return [
		"narrators",
		narratorId,
		"messages",
		normalizedAround
			? {
					around: normalizedAround.messageId,
					before: normalizedAround.before,
					after: normalizedAround.after,
				}
			: { around: undefined },
	] as const;
}

export function useNarrator(id: string) {
	return useQuery({
		queryKey: ["narrators", id],
		queryFn: () => api.getNarrator(id),
		enabled: !!id,
	});
}

export function useNarratorMessages(narratorId: string, around?: NarratorMessagesAroundOptions) {
	const normalizedAround = normalizeAroundOptions(around);
	return useInfiniteQuery({
		queryKey: getNarratorMessagesQueryKey(narratorId, normalizedAround),
		queryFn: ({ pageParam }) => {
			// First page: use the bounded around-window when deep-linking to a message,
			// otherwise fetch the latest page.
			if (!pageParam && normalizedAround) {
				return api.getNarratorMessages(narratorId, { around: normalizedAround });
			}
			return api.getNarratorMessages(narratorId, {
				limit: pageParam ? 50 : 20,
				cursor: pageParam,
			});
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
		enabled: !!narratorId,
		// Messages are kept up-to-date via WebSocket (setQueryData), so background
		// refetch on remount is unnecessary. A high staleTime prevents TanStack Query
		// from refetching ALL cached pages when the component remounts, which would
		// cause a cascade of API calls proportional to the number of loaded pages.
		staleTime: Infinity,
	});
}

export function useToolCallDetail(narratorId: string, toolUseId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["narrators", narratorId, "tool-calls", toolUseId],
		queryFn: () => api.getToolCallDetail(narratorId, toolUseId),
		enabled: !!narratorId && !!toolUseId && enabled,
		staleTime: 5 * 60 * 1000,
	});
}

export function useCreateNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (data: {
			chapterId?: string | null;
			type?: string;
			model?: string;
			systemPrompt?: string;
			permissionMode?: string;
			cwd?: string;
		}) => api.createNarrator(data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useArchiveNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.archiveNarrator(id),
		onSuccess: (_data, narratorId) => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			// Remove all tabs associated with the archived narrator from the sidebar
			const tabs =
				qc.getQueryData<
					{ type: "chapter" | "narrator" | "project"; id: string; narratorId?: string }[]
				>(RECENT_TABS_QUERY_KEY) ?? [];
			const isMatch = (t: (typeof tabs)[number]) =>
				(t.type === "narrator" && t.id === narratorId) ||
				(t.type === "chapter" && t.narratorId === narratorId);
			const matched = tabs.filter(isMatch);
			if (matched.length > 0) {
				for (const tab of matched) {
					api.removeRecentTab(tab.type, tab.id).catch(() => {});
				}
				qc.setQueryData(
					RECENT_TABS_QUERY_KEY,
					tabs.filter((t) => !isMatch(t)),
				);
			}
		},
	});
}
export function useUnarchiveNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.unarchiveNarrator(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useInterruptNarrator() {
	return useMutation({
		mutationFn: (id: string) => api.interruptNarrator(id),
	});
}

export function useUpdatePermissionMode() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, permissionMode }: { id: string; permissionMode: string }) =>
			api.updateNarratorPermissionMode(id, permissionMode),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

// ── Whitelist directories ──

export function useWhitelistDirs(narratorId: string) {
	return useQuery<WhitelistDir[]>({
		queryKey: ["whitelist-dirs", narratorId],
		queryFn: () => api.getWhitelistDirs(narratorId),
		enabled: !!narratorId,
	});
}

export function useCreateWhitelistDir() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			path,
			accessLevel,
		}: {
			narratorId: string;
			path: string;
			accessLevel?: string;
		}) => api.createWhitelistDir(narratorId, { path, accessLevel }),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["whitelist-dirs", vars.narratorId] });
		},
	});
}

export function useUpdateWhitelistDir(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ dirId, ...data }: { dirId: string; accessLevel?: string; enabled?: boolean }) =>
			api.updateWhitelistDir(dirId, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["whitelist-dirs", narratorId] });
		},
	});
}

export function useDeleteWhitelistDir(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (dirId: string) => api.deleteWhitelistDir(dirId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["whitelist-dirs", narratorId] });
		},
	});
}

export function useUpdateReasoningEffort() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, reasoningEffort }: { id: string; reasoningEffort: string | null }) =>
			api.updateNarratorReasoningEffort(id, reasoningEffort),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useUpdateFastMode() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, fastMode }: { id: string; fastMode: boolean }) =>
			api.updateNarratorFastMode(id, fastMode),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useUpdateRelaxedPlan() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, relaxedPlan }: { id: string; relaxedPlan: boolean }) =>
			api.updateNarratorRelaxedPlan(id, relaxedPlan),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useUpdateModel() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, model }: { id: string; model: string }) =>
			api.updateNarratorModel(id, model),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useUpdatePruneEnabled() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, pruneEnabled }: { id: string; pruneEnabled: boolean }) =>
			api.updateNarratorPruneEnabled(id, pruneEnabled),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}
