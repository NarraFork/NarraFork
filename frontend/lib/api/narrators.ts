import { BASE, clearToken, getToken, request } from "./client";
import type {
	ApiEntity,
	BlacklistCmd,
	BlacklistDir,
	BufferMessageSummary,
	MessagesAroundOptions,
	PaginatedMessages,
	PaginatedNarrators,
	WhitelistCmd,
	WhitelistDir,
} from "./types";

export const narratorsApi = {
	listNarrators: (opts?: {
		chapterId?: string;
		standalone?: boolean;
		status?: string;
		sortBy?: string;
		sortOrder?: string;
	}) => {
		const params = new URLSearchParams();
		if (opts?.chapterId) params.set("chapterId", opts.chapterId);
		if (opts?.standalone) params.set("standalone", "true");
		if (opts?.status) params.set("status", opts.status);
		if (opts?.sortBy) params.set("sortBy", opts.sortBy);
		if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
		const qs = params.toString();
		return request<ApiEntity[]>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	listNarratorsPaginated: (opts?: {
		standalone?: boolean | "all";
		status?: string;
		filter?: string;
		sortBy?: string;
		sortOrder?: string;
		limit?: number;
		cursor?: string;
		hasTerminals?: boolean;
		hasContainers?: boolean;
		hasRunningContainers?: boolean;
		hasViewers?: boolean;
	}) => {
		const params = new URLSearchParams();
		if (opts?.standalone === "all") params.set("standalone", "all");
		else if (opts?.standalone) params.set("standalone", "true");
		if (opts?.status) params.set("status", opts.status);
		if (opts?.filter) params.set("filter", opts.filter);
		if (opts?.sortBy) params.set("sortBy", opts.sortBy);
		if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		if (opts?.hasTerminals) params.set("hasTerminals", "true");
		if (opts?.hasContainers) params.set("hasContainers", "true");
		if (opts?.hasRunningContainers) params.set("hasRunningContainers", "true");
		if (opts?.hasViewers) params.set("hasViewers", "true");
		const qs = params.toString();
		return request<PaginatedNarrators>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	getNarrator: (id: string) => request<ApiEntity>(`/narrators/${id}`),
	getNarratorCommands: (id: string) =>
		request<{
			commands: Array<{
				name: string;
				prompt: string;
				description?: string;
				source: string;
				params?: Array<{
					name: string;
					description?: string;
					required?: boolean;
					defaultValue?: string;
				}>;
			}>;
			skills: Array<{ name: string; description: string; source: string }>;
			tools: Array<{
				id: string;
				toolName: string;
				descriptionEn: string;
				descriptionZh: string;
			}>;
		}>(`/narrators/${id}/commands`),
	createNarrator: (data: {
		chapterId?: string | null;
		type?: string;
		model?: string;
		systemPrompt?: string;
		permissionMode?: string;
		reasoningEffort?: string | null;
		fastMode?: boolean;
		relaxedPlan?: boolean;
		cwd?: string;
	}) => request<ApiEntity>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	archiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/archive`, { method: "PATCH" }),
	unarchiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/unarchive`, { method: "PATCH" }),
	deleteNarrator: (id: string) => request<ApiEntity>(`/narrators/${id}`, { method: "DELETE" }),
	markNarratorRead: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/mark-read`, { method: "PATCH" }),
	getNarratorMessages: (
		id: string,
		opts?: {
			limit?: number;
			cursor?: string;
			direction?: "older" | "newer";
			around?: MessagesAroundOptions;
		},
	) => {
		const params = new URLSearchParams();
		if (opts?.around) {
			params.set("around", opts.around.messageId);
			if (opts.around.before != null) params.set("before", String(opts.around.before));
			if (opts.around.after != null) params.set("after", String(opts.around.after));
		} else {
			if (opts?.limit) params.set("limit", String(opts.limit));
			if (opts?.cursor) params.set("cursor", opts.cursor);
			if (opts?.direction === "newer") params.set("direction", "newer");
		}
		const qs = params.toString();
		return request<PaginatedMessages>(`/narrators/${id}/messages${qs ? `?${qs}` : ""}`);
	},
	getToolCallDetail: (narratorId: string, toolUseId: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/tool-calls/${toolUseId}`),
	interruptNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/interrupt`, { method: "POST" }),
	detachSubagent: (id: string) =>
		request<{ detached: boolean }>(`/narrators/${id}/detach`, { method: "POST" }),
	cancelBackgroundTask: (narratorId: string, taskId: string) =>
		request<{ success: boolean }>(`/narrators/${narratorId}/background-tasks/${taskId}/cancel`, {
			method: "POST",
		}),
	listBackgroundTasks: (narratorId: string) =>
		request<{
			tasks: {
				id: string;
				type: "bash" | "agent";
				status: string;
				command: string | null;
				exitCode: number | null;
				subagentNarratorId: string | null;
				subagentType: string | null;
				alias: string | null;
				title: string | null;
				output: string | null;
				startedAt: string;
				completedAt: string | null;
			}[];
			legacySubagentTasks: {
				id: string;
				subagentType: string | null;
				backgroundStatus: string | null;
				backgroundResult: string | null;
				backgroundCompletedAt: string | null;
				status: string;
				createdAt: string;
				title: string | null;
			}[];
		}>(`/narrators/${narratorId}/background-tasks`),
	getBackgroundTaskOutput: (narratorId: string, taskId: string) =>
		request<{ output: string | null; status: string }>(
			`/narrators/${narratorId}/background-tasks/${taskId}/output`,
		),
	updateSubagentConclusion: (id: string) =>
		request<{ ok: boolean; toolUseId: string }>(`/narrators/${id}/update-conclusion`, {
			method: "POST",
		}),
	leaveNarrator: (id: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/leave`, { method: "POST" }),
	getBufferedMessages: (id: string) => request<BufferMessageSummary[]>(`/narrators/${id}/buffer`),
	updateBufferedMessage: (narratorId: string, messageId: string, text: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ text }),
		}),
	removeBufferedMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/${messageId}`, {
			method: "DELETE",
		}),
	clearBufferedMessages: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer`, { method: "DELETE" }),
	reorderBufferedMessages: (narratorId: string, orderedIds: string[]) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/buffer/reorder`, {
			method: "PUT",
			body: JSON.stringify({ orderedIds }),
		}),
	getPendingPermissions: (id: string) => request<ApiEntity[]>(`/narrators/${id}/permissions`),
	approvePermission: (requestId: string) =>
		request<ApiEntity>(`/narrators/permissions/${requestId}/approve`, { method: "POST" }),
	denyPermission: (requestId: string, message?: string) =>
		request<ApiEntity>(`/narrators/permissions/${requestId}/deny`, {
			method: "POST",
			body: JSON.stringify({ message }),
		}),
	updateNarratorTitle: (id: string, title: string) =>
		request<{ ok: boolean; title: string }>(`/narrators/${id}/title`, {
			method: "PATCH",
			body: JSON.stringify({ title }),
		}),
	updateNarratorCwd: (id: string, cwd: string) =>
		request<{ ok: boolean; cwd: string; changed: boolean }>(`/narrators/${id}/cwd`, {
			method: "PATCH",
			body: JSON.stringify({ cwd }),
		}),
	generateNarratorTitle: (id: string) =>
		request<{ title: string }>(`/narrators/${id}/generate-title`, { method: "POST" }),
	suggestAnswers: (
		narratorId: string,
		questions: {
			question: string;
			header: string;
			options: { label: string; description: string }[];
			multiSelect?: boolean;
		}[],
	) =>
		request<{ answers: Record<string, string> }>(`/narrators/${narratorId}/suggest-answers`, {
			method: "POST",
			body: JSON.stringify({ questions }),
		}),
	updateNarratorModel: (id: string, model: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/model`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		}),
	updateNarratorPermissionMode: (id: string, permissionMode: string) =>
		request<{ ok: boolean }>(`/narrators/${id}/permission-mode`, {
			method: "PATCH",
			body: JSON.stringify({ permissionMode }),
		}),
	// Whitelist directories
	getWhitelistDirs: (id: string) => request<WhitelistDir[]>(`/narrators/${id}/whitelist-dirs`),
	createWhitelistDir: (
		id: string,
		data: { path: string; accessLevel?: string; enabled?: boolean },
	) =>
		request<WhitelistDir>(`/narrators/${id}/whitelist-dirs`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateWhitelistDir: (dirId: string, data: { accessLevel?: string; enabled?: boolean }) =>
		request<{ ok: boolean }>(`/narrators/whitelist-dirs/${dirId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteWhitelistDir: (dirId: string) =>
		request<{ ok: boolean }>(`/narrators/whitelist-dirs/${dirId}`, { method: "DELETE" }),
	// Blacklist directories
	getBlacklistDirs: (id: string) => request<BlacklistDir[]>(`/narrators/${id}/blacklist-dirs`),
	createBlacklistDir: (id: string, data: { path: string; denyLevel?: string; enabled?: boolean }) =>
		request<BlacklistDir>(`/narrators/${id}/blacklist-dirs`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateBlacklistDir: (dirId: string, data: { denyLevel?: string; enabled?: boolean }) =>
		request<{ ok: boolean }>(`/narrators/blacklist-dirs/${dirId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteBlacklistDir: (dirId: string) =>
		request<{ ok: boolean }>(`/narrators/blacklist-dirs/${dirId}`, { method: "DELETE" }),
	// Command whitelist
	getCmdWhitelist: (id: string) => request<WhitelistCmd[]>(`/narrators/${id}/cmd-whitelist`),
	createCmdWhitelist: (id: string, data: { pattern: string; enabled?: boolean }) =>
		request<WhitelistCmd>(`/narrators/${id}/cmd-whitelist`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateCmdWhitelist: (entryId: string, data: { pattern?: string; enabled?: boolean }) =>
		request<{ ok: boolean }>(`/narrators/cmd-whitelist/${entryId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteCmdWhitelist: (entryId: string) =>
		request<{ ok: boolean }>(`/narrators/cmd-whitelist/${entryId}`, { method: "DELETE" }),
	// Command blacklist
	getCmdBlacklist: (id: string) => request<BlacklistCmd[]>(`/narrators/${id}/cmd-blacklist`),
	createCmdBlacklist: (
		id: string,
		data: { pattern: string; denyPrompt?: string; enabled?: boolean },
	) =>
		request<BlacklistCmd>(`/narrators/${id}/cmd-blacklist`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateCmdBlacklist: (
		entryId: string,
		data: { pattern?: string; denyPrompt?: string | null; enabled?: boolean },
	) =>
		request<{ ok: boolean }>(`/narrators/cmd-blacklist/${entryId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteCmdBlacklist: (entryId: string) =>
		request<{ ok: boolean }>(`/narrators/cmd-blacklist/${entryId}`, { method: "DELETE" }),
	updateNarratorReasoningEffort: (id: string, reasoningEffort: string | null) =>
		request<{ ok: boolean }>(`/narrators/${id}/reasoning-effort`, {
			method: "PATCH",
			body: JSON.stringify({ reasoningEffort }),
		}),
	updateNarratorFastMode: (id: string, fastMode: boolean) =>
		request<{ ok: boolean }>(`/narrators/${id}/fast-mode`, {
			method: "PATCH",
			body: JSON.stringify({ fastMode }),
		}),
	updateNarratorRelaxedPlan: (id: string, relaxedPlan: boolean) =>
		request<{ ok: boolean }>(`/narrators/${id}/relaxed-plan`, {
			method: "PATCH",
			body: JSON.stringify({ relaxedPlan }),
		}),
	updateNarratorPruneEnabled: (id: string, pruneEnabled: boolean) =>
		request<{ ok: boolean }>(`/narrators/${id}/prune-enabled`, {
			method: "PATCH",
			body: JSON.stringify({ pruneEnabled }),
		}),
	getCompactSummary: (narratorId: string, messageId: string) =>
		request<{ summary: string }>(`/narrators/${narratorId}/compact/${messageId}`),
	sendNarratorMessage: async (
		narratorId: string,
		message: string,
		images?: File[],
		textFiles?: File[],
		priority?: boolean,
	) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		let body: BodyInit;
		if (images?.length || textFiles?.length) {
			const formData = new FormData();
			formData.append("message", message);
			if (images) {
				for (const img of images) formData.append("images", img);
			}
			if (textFiles) {
				for (const tf of textFiles) formData.append("textFiles", tf);
			}
			if (priority) formData.append("priority", "true");
			body = formData;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(priority ? { message, priority: true } : { message });
		}

		const res = await fetch(`${BASE}/narrators/${narratorId}/messages`, {
			method: "POST",
			headers,
			body,
		});
		if (res.status === 401) {
			clearToken();
			const error = await res.json().catch(() => ({ error: "Unauthorized" }));
			throw new Error(error.error ?? "Unauthorized");
		}
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: res.statusText }));
			throw new Error(error.error ?? "Request failed");
		}
		return res.json();
	},
	retryLastMessage: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/retry`, { method: "POST" }),
	continueNarrator: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/continue`, { method: "POST" }),
	rollbackToBlock: (narratorId: string, messageId: string, blockIndex: number) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/rollback/${messageId}`, {
			method: "POST",
			body: JSON.stringify({ blockIndex }),
		}),
	editAndRegenerate: (narratorId: string, messageId: string, content: string, rollback: boolean) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/edit-and-regenerate/${messageId}`, {
			method: "POST",
			body: JSON.stringify({ content, rollback }),
		}),
	triggerCompact: (narratorId: string, beforeMessageId?: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact`, {
			method: "POST",
			body: JSON.stringify(beforeMessageId ? { beforeMessageId } : {}),
		}),
	clearContext: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/clear-context`, {
			method: "POST",
		}),
	createPlan: (narratorId: string, content: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/plan`, {
			method: "POST",
			body: JSON.stringify({ content }),
		}),
	deleteCompactMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact/${messageId}`, {
			method: "DELETE",
		}),
	deleteMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean; deletedCount: number }>(
			`/narrators/${narratorId}/messages/${messageId}`,
			{
				method: "DELETE",
			},
		),
	dismissErrorMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/error-messages/${messageId}`, {
			method: "DELETE",
		}),
	deleteMessageBlock: (narratorId: string, messageId: string, blockIndex: number) =>
		request<{ ok: boolean; messageDeleted: boolean }>(
			`/narrators/${narratorId}/messages/${messageId}/blocks/${blockIndex}`,
			{ method: "DELETE" },
		),
	deleteMessageBlocks: (
		narratorId: string,
		blocks: Array<{ messageId: string; blockIndex: number }>,
	) =>
		request<{ ok: boolean; deleted: number; failed: number }>(
			`/narrators/${narratorId}/messages/batch-blocks`,
			{
				method: "DELETE",
				body: JSON.stringify({ blocks }),
			},
		),
	updateCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

	// Segment compact
	triggerSegmentCompact: (narratorId: string, messageIds: string[]) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact`, {
			method: "POST",
			body: JSON.stringify({ messageIds }),
		}),
	getSegmentCompactSummary: (narratorId: string, messageId: string) =>
		request<{ summary: string }>(`/narrators/${narratorId}/segment-compact/${messageId}`),
	getSegmentCompactMessages: (narratorId: string, messageId: string) =>
		request<{ messages: unknown[] }>(
			`/narrators/${narratorId}/segment-compact/${messageId}/messages`,
		),
	deleteSegmentCompact: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact/${messageId}`, {
			method: "DELETE",
		}),
	updateSegmentCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/segment-compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

	// File modifications
	getFileModifications: (narratorId: string, upToMessageId?: string, fromMessageId?: string) => {
		const params = new URLSearchParams();
		if (upToMessageId) params.set("upToMessageId", upToMessageId);
		if (fromMessageId) params.set("fromMessageId", fromMessageId);
		const qs = params.toString();
		return request<{
			files: Array<{
				filePath: string;
				snapshotId: string;
				originalExists: boolean;
				editCount: number;
				lastModifiedAt: string;
				operations: Array<{
					toolUseId: string;
					toolName: string;
					messageId: string;
					createdAt: string;
				}>;
			}>;
			timeline: Array<{
				messageId: string;
				createdAt: string;
				seq: number;
				role: string;
				hasEdits: boolean;
			}>;
		}>(`/narrators/${narratorId}/file-modifications${qs ? `?${qs}` : ""}`);
	},
	getFileDiff: (
		narratorId: string,
		snapshotId: string,
		upToMessageId?: string,
		fromMessageId?: string,
	) => {
		const params = new URLSearchParams();
		if (upToMessageId) params.set("upToMessageId", upToMessageId);
		if (fromMessageId) params.set("fromMessageId", fromMessageId);
		const qs = params.toString();
		return request<{ filePath: string; original: string | null; current: string | null }>(
			`/narrators/${narratorId}/patches/${snapshotId}/diff${qs ? `?${qs}` : ""}`,
		);
	},
	revertFile: (narratorId: string, filePath: string) =>
		request<{ success: boolean; originalExists: boolean }>(`/narrators/${narratorId}/revert-file`, {
			method: "POST",
			body: JSON.stringify({ filePath }),
		}),
	revertAllFiles: (narratorId: string) =>
		request<{ fileCount: number; files: string[] }>(`/narrators/${narratorId}/revert`, {
			method: "POST",
			body: JSON.stringify({ messageId: "__all__" }),
		}),
	unrevertAll: (narratorId: string) =>
		request<{ success: boolean }>(`/narrators/${narratorId}/unrevert`, { method: "POST" }),
	getDeletePreview: (narratorId: string, messageId: string) =>
		request<{
			affectedFiles: Array<{
				filePath: string;
				currentContent: string | null;
				revertedContent: string | null;
				willBeDeleted: boolean;
			}>;
			toolCallCount: number;
		}>(`/narrators/${narratorId}/delete-preview?messageId=${encodeURIComponent(messageId)}`),
	getRollbackPreview: (narratorId: string, messageId: string, blockIndex: number) =>
		request<{
			affectedFiles: Array<{
				filePath: string;
				willBeDeleted: boolean;
			}>;
			toolCallCount: number;
			deletedBlockCount: number;
			deletedMessageCount: number;
		}>(
			`/narrators/${narratorId}/rollback-preview?messageId=${encodeURIComponent(messageId)}&blockIndex=${blockIndex}`,
		),
	getPermissionFilePreview: (narratorId: string, toolUseId: string) =>
		request<{
			filePath: string;
			currentContent: string | null;
			previewContent: string | null;
			toolName: string;
			inputJson: Record<string, unknown>;
		}>(
			`/narrators/${narratorId}/permission-file-preview?toolUseId=${encodeURIComponent(toolUseId)}`,
		),

	// Narrator Fork (standalone sessions only)
	forkNarrator: (
		narratorId: string,
		forkMessageUuid: string,
		title?: string,
		inheritMode?: "full" | "compressed" | "fresh",
	) =>
		request<ApiEntity>(`/narrators/${narratorId}/fork`, {
			method: "POST",
			body: JSON.stringify({ forkMessageUuid, title, inheritMode }),
		}),
	startAskInPassing: (
		narratorId: string,
		opts: { sourceMessageId: string; sourceMessageUuid?: string },
	) =>
		request<{ messageId: string }>(`/narrators/${narratorId}/ask-in-passing/start`, {
			method: "POST",
			body: JSON.stringify(opts),
		}),
	askInPassing: (
		narratorId: string,
		opts: {
			question: string;
			pendingMessageId: string;
		},
	) =>
		request<ApiEntity>(`/narrators/${narratorId}/ask-in-passing`, {
			method: "POST",
			body: JSON.stringify(opts),
		}),
	cancelAskInPassing: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/ask-in-passing/${messageId}`, {
			method: "DELETE",
		}),
	promoteNarrator: (narratorId: string) =>
		request<{ type: "unlocked" | "forked"; narrator?: ApiEntity; chapter?: ApiEntity }>(
			`/narrators/${narratorId}/promote`,
			{ method: "POST" },
		),
	forkFromMessages: (narratorId: string, messageIds: string[], title?: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/fork-messages`, {
			method: "POST",
			body: JSON.stringify({ messageIds, title }),
		}),

	// Browser sessions
	listBrowserSessions: (narratorId: string) =>
		request<
			{
				id: string;
				url: string;
				lastActivity: number;
				tracing: { active: boolean; startedAt: number } | null;
			}[]
		>(`/narrators/${narratorId}/browser-sessions`),
	closeBrowserSession: (narratorId: string, sessionId: string) =>
		request(`/narrators/${narratorId}/browser-sessions/${sessionId}`, { method: "DELETE" }),
	stopBrowserTracing: (narratorId: string, sessionId: string) =>
		request(`/narrators/${narratorId}/browser-sessions/${sessionId}/stop-tracing`, {
			method: "POST",
		}),
};
