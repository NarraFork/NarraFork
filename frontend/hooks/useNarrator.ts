import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ApiError,
	api,
	type BlacklistCmd,
	type BlacklistDir,
	type PaginatedNarrators,
	type WhitelistCmd,
	type WhitelistDir,
} from "../lib/api";
import { RECENT_TABS_QUERY_KEY } from "./useRecentTabs";

const FILE_PREVIEW_QUERY_GC_TIME_MS = 30_000;
const NARRATORS_LIST_GC_TIME_MS = 60_000;
const NARRATOR_DETAIL_QUERY_GC_TIME_MS = 60_000;
const TOOL_CALL_DETAIL_QUERY_GC_TIME_MS = 5 * 60_000;

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
		gcTime: NARRATORS_LIST_GC_TIME_MS,
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
		gcTime: NARRATORS_LIST_GC_TIME_MS,
	});
}

// --- File modifications ---

export function useFileModifications(
	narratorId: string,
	enabled = true,
	upToMessageId?: string | null,
	fromMessageId?: string | null,
) {
	return useQuery({
		queryKey: [
			"narrators",
			narratorId,
			"file-modifications",
			fromMessageId ?? "start",
			upToMessageId ?? "all",
		],
		queryFn: () =>
			api.getFileModifications(narratorId, upToMessageId ?? undefined, fromMessageId ?? undefined),
		enabled,
		gcTime: FILE_PREVIEW_QUERY_GC_TIME_MS,
	});
}

export function useFileDiff(
	narratorId: string,
	snapshotId: string,
	enabled = false,
	upToMessageId?: string | null,
	fromMessageId?: string | null,
) {
	return useQuery({
		queryKey: [
			"narrators",
			narratorId,
			"file-diff",
			snapshotId,
			fromMessageId ?? "start",
			upToMessageId ?? "all",
		],
		queryFn: () =>
			api.getFileDiff(
				narratorId,
				snapshotId,
				upToMessageId ?? undefined,
				fromMessageId ?? undefined,
			),
		enabled: enabled && !!snapshotId,
		gcTime: FILE_PREVIEW_QUERY_GC_TIME_MS,
	});
}

export function useDeletePreview(narratorId: string, messageId: string | null, enabled = false) {
	return useQuery({
		queryKey: ["narrators", narratorId, "delete-preview", messageId],
		queryFn: () => api.getDeletePreview(narratorId, messageId as string),
		enabled: enabled && !!messageId,
		gcTime: FILE_PREVIEW_QUERY_GC_TIME_MS,
	});
}

export function useRollbackPreview(
	narratorId: string,
	messageId: string | null,
	blockIndex: number | null,
	enabled = false,
) {
	return useQuery({
		queryKey: ["narrators", narratorId, "rollback-preview", messageId, blockIndex],
		queryFn: () => api.getRollbackPreview(narratorId, messageId as string, blockIndex as number),
		enabled: enabled && !!messageId && blockIndex != null,
		gcTime: FILE_PREVIEW_QUERY_GC_TIME_MS,
	});
}

export function usePermissionFilePreview(
	narratorId: string,
	toolUseId: string | null,
	enabled = false,
) {
	return useQuery({
		queryKey: ["narrators", narratorId, "permission-file-preview", toolUseId],
		queryFn: () => api.getPermissionFilePreview(narratorId, toolUseId as string),
		enabled: enabled && !!toolUseId,
		gcTime: FILE_PREVIEW_QUERY_GC_TIME_MS,
	});
}

export function useRevertFile(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (target: { deviceId: string; filePath: string }) =>
			api.revertFile(narratorId, target),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "file-modifications"] });
		},
	});
}

export function useUnrevertAll(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.unrevertAll(narratorId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "file-modifications"] });
		},
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
			// 只让 narrator 列表失效, 避免误伤 narrator 详情/预览/工具调用等子资源查询
			qc.invalidateQueries({
				predicate: (query) => {
					const key = query.queryKey;
					if (!Array.isArray(key) || key[0] !== "narrators") return false;
					// 列表查询: ["narrators", {...}] 或 ["narrators", "paginated", {...}]
					if (key.length === 2 && typeof key[1] === "object") return true;
					if (key.length === 3 && key[1] === "paginated") return true;
					return false;
				},
			});
		},
	});
}

export function useStartAskInPassing() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			sourceMessageId,
			sourceMessageUuid,
		}: {
			narratorId: string;
			sourceMessageId: string;
			sourceMessageUuid?: string;
		}) => api.startAskInPassing(narratorId, { sourceMessageId, sourceMessageUuid }),
		onSuccess: (_data, { narratorId }) => {
			qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] });
		},
	});
}

export function useAskInPassing() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			question,
			pendingMessageId,
		}: {
			narratorId: string;
			question: string;
			pendingMessageId: string;
		}) => api.askInPassing(narratorId, { question, pendingMessageId }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useCancelAskInPassing() {
	return useMutation({
		mutationFn: ({ narratorId, messageId }: { narratorId: string; messageId: string }) =>
			api.cancelAskInPassing(narratorId, messageId),
	});
}

export function usePromoteNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (narratorId: string) => api.promoteNarrator(narratorId),
		onSuccess: (_data, narratorId) => {
			qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
		},
	});
}

export function useNarrator(id: string) {
	return useQuery({
		queryKey: ["narrators", id],
		queryFn: () => api.getNarrator(id),
		enabled: !!id,
		// Narrator data is kept fresh via WS invalidation (useNarratorPanelWS).
		// A 30s staleTime avoids redundant refetches when multiple components
		// subscribe to the same narrator (e.g. route + NarratorPanel).
		staleTime: 30_000,
		gcTime: NARRATOR_DETAIL_QUERY_GC_TIME_MS,
	});
}

export function useNarratorUsageStats(narratorId: string, includeSubagents = true, enabled = true) {
	return useQuery({
		queryKey: ["narrators", narratorId, "usage-stats", { includeSubagents }],
		queryFn: () => api.getNarratorUsageStats(narratorId, { includeSubagents }),
		enabled: !!narratorId && enabled,
		staleTime: 15_000,
		gcTime: 60_000,
	});
}

export function useToolCallDetail(narratorId: string, toolUseId: string, enabled: boolean) {
	return useQuery({
		queryKey: ["narrators", narratorId, "tool-calls", toolUseId],
		queryFn: () => api.getToolCallDetail(narratorId, toolUseId),
		enabled: !!narratorId && !!toolUseId && enabled,
		staleTime: TOOL_CALL_DETAIL_QUERY_GC_TIME_MS,
		gcTime: TOOL_CALL_DETAIL_QUERY_GC_TIME_MS,
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
			reasoningEffort?: string | null;
			fastMode?: boolean;
			relaxedPlan?: boolean;
			planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
			dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
			cwd?: string;
			makeNamed?: boolean;
			handle?: string;
			kind?: "knowledge";
		}) => {
			let shouldUseLegacyFastModeDefault = false;
			try {
				shouldUseLegacyFastModeDefault =
					localStorage.getItem("narrafork_fast_mode_default") === "true";
			} catch {
				// Ignore localStorage access failures.
			}

			return api.createNarrator(
				data.fastMode === undefined && shouldUseLegacyFastModeDefault
					? { ...data, fastMode: true }
					: data,
			);
		},
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

export function useDeleteNarrator() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deleteNarrator(id),
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

export function useUpdateSubagentConclusion() {
	return useMutation({
		mutationFn: (id: string) => api.updateSubagentConclusion(id),
	});
}

export function useTakeoverSubagent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.takeoverSubagent(id),
		onSuccess: (_data, id) => {
			qc.invalidateQueries({ queryKey: ["narrators", id] });
		},
	});
}

export function useStopTakeoverSubagent() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: string): Promise<{ stopped: boolean; deferred?: boolean }> => {
			// The subagent may momentarily be in the "settling" window (its takeover
			// interrupt has fired but the loop has not yet reached the suspension
			// branch). Current servers record a pending stop and return success, but
			// guard against transient 409s (older servers / extremely short windows)
			// with a few silent retries so the user never sees a raw error toast.
			const MAX_ATTEMPTS = 4;
			const RETRY_DELAY_MS = 400;
			for (let attempt = 0; ; attempt++) {
				try {
					return await api.stopTakeoverSubagent(id);
				} catch (err) {
					const isSettling = err instanceof ApiError && err.status === 409;
					if (!isSettling) throw err;
					if (attempt >= MAX_ATTEMPTS - 1) {
						// Window did not clear in time. The server has already recorded
						// the pending stop, so the takeover will resolve on its own when
						// the loop suspends; swallow the transient error rather than
						// surfacing a confusing failure toast.
						return { stopped: true, deferred: true };
					}
					await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
				}
			}
		},
		onSuccess: (_data, id) => {
			qc.invalidateQueries({ queryKey: ["narrators", id] });
		},
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

export function useEnterPlanMode() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.enterPlanMode(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
}

export function useExitPlanMode() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.exitPlanMode(id),
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

export function useBlacklistDirs(narratorId: string) {
	return useQuery<BlacklistDir[]>({
		queryKey: ["blacklist-dirs", narratorId],
		queryFn: () => api.getBlacklistDirs(narratorId),
		enabled: !!narratorId,
	});
}

export function useCreateBlacklistDir() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			path,
			denyLevel,
		}: {
			narratorId: string;
			path: string;
			denyLevel?: string;
		}) => api.createBlacklistDir(narratorId, { path, denyLevel }),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["blacklist-dirs", vars.narratorId] });
		},
	});
}

export function useUpdateBlacklistDir(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ dirId, ...data }: { dirId: string; denyLevel?: string; enabled?: boolean }) =>
			api.updateBlacklistDir(dirId, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["blacklist-dirs", narratorId] });
		},
	});
}

export function useDeleteBlacklistDir(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (dirId: string) => api.deleteBlacklistDir(dirId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["blacklist-dirs", narratorId] });
		},
	});
}

// ── Command whitelist ──

export function useCmdWhitelist(narratorId: string) {
	return useQuery<WhitelistCmd[]>({
		queryKey: ["cmd-whitelist", narratorId],
		queryFn: () => api.getCmdWhitelist(narratorId),
		enabled: !!narratorId,
	});
}

export function useCreateCmdWhitelist() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ narratorId, pattern }: { narratorId: string; pattern: string }) =>
			api.createCmdWhitelist(narratorId, { pattern }),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["cmd-whitelist", vars.narratorId] });
		},
	});
}

export function useUpdateCmdWhitelist(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ entryId, ...data }: { entryId: string; pattern?: string; enabled?: boolean }) =>
			api.updateCmdWhitelist(entryId, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["cmd-whitelist", narratorId] });
		},
	});
}

export function useDeleteCmdWhitelist(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (entryId: string) => api.deleteCmdWhitelist(entryId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["cmd-whitelist", narratorId] });
		},
	});
}

// ── Command blacklist ──

export function useCmdBlacklist(narratorId: string) {
	return useQuery<BlacklistCmd[]>({
		queryKey: ["cmd-blacklist", narratorId],
		queryFn: () => api.getCmdBlacklist(narratorId),
		enabled: !!narratorId,
	});
}

export function useCreateCmdBlacklist() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			narratorId,
			pattern,
			denyPrompt,
		}: {
			narratorId: string;
			pattern: string;
			denyPrompt?: string;
		}) => api.createCmdBlacklist(narratorId, { pattern, denyPrompt }),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["cmd-blacklist", vars.narratorId] });
		},
	});
}

export function useUpdateCmdBlacklist(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			entryId,
			...data
		}: {
			entryId: string;
			pattern?: string;
			denyPrompt?: string | null;
			enabled?: boolean;
		}) => api.updateCmdBlacklist(entryId, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["cmd-blacklist", narratorId] });
		},
	});
}

export function useDeleteCmdBlacklist(narratorId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (entryId: string) => api.deleteCmdBlacklist(entryId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["cmd-blacklist", narratorId] });
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

export function useUpdateReflectionOverrides() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
			dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
			autoContinuationOverride?: "inherit" | "always" | "blockStop" | "protectedOnly" | "off";
			tasksReminderIntervalOverride?: number | null;
		}) => api.updateNarratorReflectionOverrides(id, data),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.id] });
		},
	});
}

export function useUpdateBehaviorFence() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			...data
		}: {
			id: string;
			behaviorFenceIntervalOverride?: number | null;
			behaviorFenceAttachOverride?: "inherit" | "on" | "off";
		}) => api.updateNarratorBehaviorFence(id, data),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.id] });
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

export function useUpdateCwd() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, cwd }: { id: string; cwd: string }) => api.updateNarratorCwd(id, cwd),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.id] });
			qc.invalidateQueries({ queryKey: ["narrator-commands", vars.id] });
			qc.invalidateQueries({ queryKey: ["narrator-skills", vars.id] });
		},
	});
}

export function useNarratorSkills(id: string, enabled = true) {
	return useQuery({
		queryKey: ["narrator-skills", id],
		queryFn: () => api.getNarratorSkills(id),
		enabled: !!id && enabled,
		staleTime: 15_000,
		gcTime: NARRATOR_DETAIL_QUERY_GC_TIME_MS,
	});
}

export function useRefreshNarratorSkills() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.getNarratorSkills(id, { refresh: true }),
		onSuccess: (_data, id) => {
			qc.setQueryData(["narrator-skills", id], _data);
			qc.invalidateQueries({ queryKey: ["narrator-commands", id] });
		},
	});
}

export function useNarratorCustomTraits(id: string, enabled = true) {
	return useQuery({
		queryKey: ["narrators", id, "custom-traits"],
		queryFn: () => api.getCustomTraits(id),
		enabled: !!id && enabled,
		gcTime: NARRATOR_DETAIL_QUERY_GC_TIME_MS,
	});
}

export function useUpdateSubagentModelRestriction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			id,
			pools,
		}: {
			id: string;
			pools: Record<string, { model: string; purpose?: string }[]>;
		}) => api.updateSubagentModelRestriction(id, pools),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.id] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.id, "custom-traits"] });
		},
	});
}

export function useClearSubagentModelRestriction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.clearSubagentModelRestriction(id),
		onSuccess: (_data, id) => {
			qc.invalidateQueries({ queryKey: ["narrators", id] });
			qc.invalidateQueries({ queryKey: ["narrators", id, "custom-traits"] });
		},
	});
}

export function useUpdateDisabledTools() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, tools }: { id: string; tools: string[] }) =>
			api.updateDisabledTools(id, tools),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.id] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.id, "custom-traits"] });
		},
	});
}

export function useClearDisabledTools() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.clearDisabledTools(id),
		onSuccess: (_data, id) => {
			qc.invalidateQueries({ queryKey: ["narrators", id] });
			qc.invalidateQueries({ queryKey: ["narrators", id, "custom-traits"] });
		},
	});
}

export function useUpdateBlockedSkills() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, all, names }: { id: string; all: boolean; names: string[] }) =>
			api.updateBlockedSkills(id, { all, names }),
		onSuccess: (_data, vars) => {
			qc.invalidateQueries({ queryKey: ["narrators", vars.id] });
			qc.invalidateQueries({ queryKey: ["narrators", vars.id, "custom-traits"] });
			qc.invalidateQueries({ queryKey: ["narrator-commands", vars.id] });
		},
	});
}

export function useClearBlockedSkills() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.clearBlockedSkills(id),
		onSuccess: (_data, id) => {
			qc.invalidateQueries({ queryKey: ["narrators", id] });
			qc.invalidateQueries({ queryKey: ["narrators", id, "custom-traits"] });
			qc.invalidateQueries({ queryKey: ["narrator-commands", id] });
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
