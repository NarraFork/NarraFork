const BASE = "/api";
const TOKEN_KEY = "narrafork_token";

export function getAvatarUrl(userId: string, avatarImageId: string): string {
	return `${BASE}/uploads/avatars/${userId}/${avatarImageId}`;
}

export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
	path: string,
	options?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
	const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
	if (options?.body) {
		headers["Content-Type"] = "application/json";
	}
	const token = getToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const response = await fetch(`${BASE}${path}`, { ...options, headers });
	if (response.status === 401) {
		clearToken();
		throw new ApiError("Unauthorized", 401);
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: response.statusText }));
		throw new ApiError(error.error ?? "Request failed", response.status);
	}
	return response.json();
}

export interface BaseContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	/** Only present on reasoning blocks when translation is enabled */
	translatedText?: string;
	name?: string;
	id?: string;
	input?: Record<string, unknown>;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	errorMessage?: string;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	permissionDecidedAt?: string | null;
	tcId?: string;
	tcCreatedAt?: string;
	subtype?: string;
	summary?: string;
	previewUrl?: string;
	imageId?: string;
	filename?: string;
	mediaType?: string;
	[key: string]: unknown;
}

export interface ToolUseContentBlock extends BaseContentBlock {
	type: "tool_use";
	id: string;
	name: string;
}

export type ContentBlock = BaseContentBlock;

export interface ToolCallRecord {
	id?: string;
	toolUseId: string;
	toolName: string;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	durationMs?: number;
	errorMessage?: string;
	permissionDecidedBy?: string | null;
	permissionDecidedAt?: string | null;
	permissionDenyMessage?: string | null;
	permissionDecisionReason?: string | null;
	permissionSuggestions?: unknown[] | null;
	createdAt?: string;
}

export interface WhitelistDir {
	id: string;
	narratorId: string;
	path: string;
	accessLevel: "readOnly" | "readWrite" | "full";
	enabled: boolean;
	createdAt: string;
}

// biome-ignore lint/suspicious/noExplicitAny: API entity with dynamic fields
export type ApiEntity = any;

export interface TreeMessage {
	id: string;
	narratorId: string;
	parentToolUseId: string | null;
	messageUuid?: string | null;
	role: string;
	contentJson: ContentBlock[];
	contentText: string | null;
	toolCalls: ToolCallRecord[];
	tokensIn?: number | null;
	costUsd?: number | null;
	turnUsageJson?: {
		input_tokens?: number;
		output_tokens?: number;
		[key: string]: unknown;
	} | null;
	contextPercent?: number | null;
	meterUsage?: number | null;
	meterUnit?: string | null;
	subagentModel?: string | null;
	commandText?: string | null;
	creator?: {
		id: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	createdAt: string;
	children: TreeMessage[];
	/** Synthetic flag: when true, tool run grouping should not merge this message with the preceding run. */
	_noMerge?: boolean;
	/** Maps each index in the (possibly filtered/reordered) contentJson back to its index in the original contentJson. */
	_blockOriginalIndices?: number[];
}

export interface PaginatedNarrators {
	items: ApiEntity[];
	hasMore: boolean;
	nextCursor: string | null;
	totalCount: number;
}

export interface MessagesAroundOptions {
	messageId: string;
	before?: number;
	after?: number;
}

export interface PaginatedMessages {
	messages: TreeMessage[];
	hasMore: boolean;
	nextCursor: string | null;
	hasMoreAfter?: boolean;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
}

export const api = {
	// Auth
	authStatus: () => request<{ hasUsers: boolean; registrationOpen: boolean }>("/auth/status"),
	register: (data: { username: string; password: string; language?: string }) =>
		request<{ user: ApiEntity; token: string; language: string }>("/auth/register", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	login: (data: { username: string; password: string }) =>
		request<{ user: ApiEntity; token: string; language: string }>("/auth/login", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	me: () => request<ApiEntity>("/auth/me"),

	// Avatar
	uploadAvatar: async (file: File) => {
		const formData = new FormData();
		formData.append("file", file);
		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetch(`${BASE}/auth/me/avatar`, {
			method: "PATCH",
			headers,
			body: formData,
		});
		if (res.status === 401) {
			clearToken();
			throw new ApiError("Unauthorized", 401);
		}
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Upload failed" }));
			throw new ApiError(err.error ?? "Upload failed", res.status);
		}
		return res.json() as Promise<{ ok: boolean; avatarImageId: string }>;
	},
	deleteAvatar: () => request<{ ok: boolean }>("/auth/me/avatar", { method: "DELETE" }),
	updateProfile: (data: { gitUsername?: string; gitEmail?: string }) =>
		request<{ ok: boolean }>("/auth/me", { method: "PATCH", body: JSON.stringify(data) }),

	// Admin
	listUsers: () => request<ApiEntity[]>("/admin/users"),
	deleteUser: (id: string) => request<ApiEntity>(`/admin/users/${id}`, { method: "DELETE" }),
	updateUser: (id: string, data: { username?: string; password?: string }) =>
		request<ApiEntity>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	updateAdminSettings: (data: { registrationOpen: boolean }) =>
		request<ApiEntity>("/admin/settings", { method: "PATCH", body: JSON.stringify(data) }),
	listAdminTerminals: () =>
		request<{
			terminals: ApiEntity[];
			orphanSockets: { socketPath: string; terminalId: string }[];
		}>("/admin/terminals"),
	killAdminTerminal: (id: string) =>
		request<ApiEntity>(`/admin/terminals/${id}`, { method: "DELETE" }),
	batchKillAdminTerminals: (ids: string[]) =>
		request<{ results: { id: string; ok: boolean; error?: string }[] }>(
			"/admin/terminals/batch-kill",
			{ method: "POST", body: JSON.stringify({ ids }) },
		),
	killOrphanSocket: (terminalId: string) =>
		request<ApiEntity>("/admin/terminals/kill-orphan", {
			method: "POST",
			body: JSON.stringify({ terminalId }),
		}),
	reattachTerminal: (id: string) =>
		request<ApiEntity>(`/admin/terminals/${id}/reattach`, { method: "POST" }),
	reattachOrphan: (terminalId: string) =>
		request<ApiEntity>("/admin/terminals/reattach-orphan", {
			method: "POST",
			body: JSON.stringify({ terminalId }),
		}),

	// Projects
	listProjects: (status?: string) =>
		request<ApiEntity[]>(`/projects${status ? `?status=${status}` : ""}`),
	getProject: (id: string) => request<ApiEntity>(`/projects/${id}`),
	createProject: (data: Record<string, unknown>) =>
		request<ApiEntity>("/projects", { method: "POST", body: JSON.stringify(data) }),
	updateProject: (id: string, data: Record<string, unknown>) =>
		request<ApiEntity>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteProject: (id: string) => request<ApiEntity>(`/projects/${id}`, { method: "DELETE" }),

	// Chapters
	listChapters: (projectId: string, status?: string) =>
		request<ApiEntity[]>(`/chapters?projectId=${projectId}${status ? `&status=${status}` : ""}`),
	getChapter: (id: string) => request<ApiEntity>(`/chapters/${id}`),
	createChapter: (data: Record<string, unknown>) =>
		request<ApiEntity>("/chapters", { method: "POST", body: JSON.stringify(data) }),
	updateChapter: (id: string, data: Record<string, unknown>) =>
		request<ApiEntity>(`/chapters/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteChapter: (id: string) => request<ApiEntity>(`/chapters/${id}`, { method: "DELETE" }),

	// Settings
	getSettings: () => request<ApiEntity>("/settings"),
	updateSettings: (data: Record<string, unknown>) =>
		request<ApiEntity>("/settings", { method: "PATCH", body: JSON.stringify(data) }),

	// Narrators (both chapter-bound and standalone sessions)
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
		cwd?: string;
	}) => request<ApiEntity>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	archiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/archive`, { method: "PATCH" }),
	unarchiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/unarchive`, { method: "PATCH" }),
	markNarratorRead: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/mark-read`, { method: "PATCH" }),
	getNarratorMessages: (
		id: string,
		opts?: {
			limit?: number;
			cursor?: string;
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
		}
		const qs = params.toString();
		return request<PaginatedMessages>(`/narrators/${id}/messages${qs ? `?${qs}` : ""}`);
	},
	getToolCallDetail: (narratorId: string, toolUseId: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/tool-calls/${toolUseId}`),
	interruptNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/interrupt`, { method: "POST" }),
	getBufferedMessage: (id: string) =>
		request<{ text: string; bufferedAt: string } | null>(`/narrators/${id}/buffer`),
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
	sendNarratorMessage: async (narratorId: string, message: string, images?: File[]) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		let body: BodyInit;
		if (images?.length) {
			const formData = new FormData();
			formData.append("message", message);
			for (const img of images) formData.append("images", img);
			body = formData;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify({ message });
		}

		const res = await fetch(`${BASE}/narrators/${narratorId}/messages`, {
			method: "POST",
			headers,
			body,
		});
		if (res.status === 401) {
			clearToken();
			throw new Error("Unauthorized");
		}
		if (!res.ok) {
			const error = await res.json().catch(() => ({ error: res.statusText }));
			throw new Error(error.error ?? "Request failed");
		}
		return res.json();
	},
	retryLastMessage: (narratorId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/retry`, { method: "POST" }),
	regenerateFromMessage: (narratorId: string, messageId: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/regenerate/${messageId}`, {
			method: "POST",
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
	deleteMessageBlock: (narratorId: string, messageId: string, blockIndex: number) =>
		request<{ ok: boolean; messageDeleted: boolean }>(
			`/narrators/${narratorId}/messages/${messageId}/blocks/${blockIndex}`,
			{ method: "DELETE" },
		),
	updateCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

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

	// Terminals
	listTerminals: (chapterId: string) => {
		const params = new URLSearchParams({ chapterId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},
	listTerminalsByNarrator: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},
	createTerminal: (data: {
		chapterId?: string;
		narratorId?: string;
		name?: string;
		cols?: number;
		rows?: number;
	}) => request<ApiEntity>("/terminals", { method: "POST", body: JSON.stringify(data) }),
	getTerminal: (id: string) => request<ApiEntity>(`/terminals/${id}`),
	getTerminalProcesses: (id: string) =>
		request<{ pid: number; command: string }[]>(`/terminals/${id}/processes`),
	deleteTerminal: (id: string) => request<ApiEntity>(`/terminals/${id}`, { method: "DELETE" }),
	renameTerminal: (id: string, name: string) =>
		request<ApiEntity>(`/terminals/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		}),
	updateTerminalGraphState: (
		id: string,
		state: {
			graphOpened?: boolean;
			graphX?: number;
			graphY?: number;
			graphWidth?: number;
			graphHeight?: number;
		},
	) =>
		request<ApiEntity>(`/terminals/${id}`, {
			method: "PATCH",
			body: JSON.stringify(state),
		}),

	// Terminal Tabs
	listTerminalTabs: (opts: { chapterId?: string; narratorId?: string }) => {
		const params = new URLSearchParams();
		if (opts.chapterId) params.set("chapterId", opts.chapterId);
		if (opts.narratorId) params.set("narratorId", opts.narratorId);
		return request<ApiEntity[]>(`/terminals/tabs?${params}`);
	},
	createTerminalTab: (data: { chapterId?: string; narratorId?: string; name: string }) =>
		request<ApiEntity>("/terminals/tabs", { method: "POST", body: JSON.stringify(data) }),
	updateTerminalTab: (id: string, data: { name?: string }) =>
		request<ApiEntity>(`/terminals/tabs/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteTerminalTab: (id: string) =>
		request<ApiEntity>(`/terminals/tabs/${id}`, { method: "DELETE" }),
	reorderTerminalTabs: (ids: string[]) =>
		request<ApiEntity>("/terminals/tabs/reorder", {
			method: "PUT",
			body: JSON.stringify({ ids }),
		}),

	// Terminal View State
	getTerminalViewState: (opts: { chapterId?: string; narratorId?: string }) => {
		const params = new URLSearchParams();
		if (opts.chapterId) params.set("chapterId", opts.chapterId);
		if (opts.narratorId) params.set("narratorId", opts.narratorId);
		return request<ApiEntity>(`/terminals/view-state?${params}`);
	},
	updateTerminalViewState: (data: {
		chapterId?: string;
		narratorId?: string;
		layout?: string;
		activeTabId?: string | null;
		panelAssignments?: Record<string, string> | null;
	}) =>
		request<ApiEntity>("/terminals/view-state", {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	// Graph
	getProjectGraph: (projectId: string) =>
		request<{
			nodes: ApiEntity[];
			edges: ApiEntity[];
			explorationGroups?: ApiEntity[];
			openedTerminals?: ApiEntity[];
		}>(`/projects/${projectId}/graph`),

	// Search
	search: (q: string, entities = "chapters,messages") =>
		request<{ results: ApiEntity[] }>(`/search?q=${encodeURIComponent(q)}&entities=${entities}`),

	// Favorite Directories
	listFavoriteDirectories: () => request<ApiEntity[]>("/favorites"),
	createFavoriteDirectory: (data: { path: string; label?: string }) =>
		request<ApiEntity>("/favorites", { method: "POST", body: JSON.stringify(data) }),
	updateFavoriteDirectory: (
		id: string,
		data: { path?: string; label?: string | null; sortOrder?: number },
	) => request<ApiEntity>(`/favorites/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteFavoriteDirectory: (id: string) =>
		request<ApiEntity>(`/favorites/${id}`, { method: "DELETE" }),
	reorderFavoriteDirectories: (ids: string[]) =>
		request<ApiEntity>("/favorites/reorder", {
			method: "PUT",
			body: JSON.stringify({ ids }),
		}),

	// User Preferences
	getUserPreferences: () =>
		request<{
			autoLoadOlderMessages: boolean;
			language: string;
			wordWrapMarkdown: boolean;
			wordWrapCode: boolean;
			wordWrapDiff: boolean;
			replyInUserLanguage: boolean;
			showTokenUsage: boolean;
			showOutputStats: boolean;
			terminalTheme: string;
			terminalFontSize: number;
			// Notification preferences
			notifyOnDone: boolean;
			notifyOnWaiting: boolean;
			notifyPwaEnabled: boolean;
			notifySoundEnabled: boolean;
			notifySoundType: "builtin" | "custom";
			notifySoundBuiltin: string;
			notifySoundFileId: string | null;
			notifyDingtalkEnabled: boolean;
			notifyDingtalkWebhook: string;
			notifyDingtalkSecret: string;
			notifyFeishuEnabled: boolean;
			notifyFeishuWebhook: string;
			notifyFeishuSecret: string;
			recentTabs: Array<{
				type: "chapter" | "narrator";
				id: string;
				narratorId?: string;
				title: string;
				subtitle?: string;
				status?: string;
				lastVisitedAt: number;
			}>;
			commands: Array<{ name: string; prompt: string; description?: string }>;
			setupWizardCompleted: boolean;
		}>("/user-preferences"),
	updateUserPreferences: (data: {
		autoLoadOlderMessages?: boolean;
		language?: string;
		wordWrapMarkdown?: boolean;
		wordWrapCode?: boolean;
		wordWrapDiff?: boolean;
		replyInUserLanguage?: boolean;
		showTokenUsage?: boolean;
		showOutputStats?: boolean;
		terminalTheme?: string;
		terminalFontSize?: number;
		// Notification preferences
		notifyOnDone?: boolean;
		notifyOnWaiting?: boolean;
		notifyPwaEnabled?: boolean;
		notifySoundEnabled?: boolean;
		notifySoundType?: "builtin" | "custom";
		notifySoundBuiltin?: string;
		notifySoundFileId?: string | null;
		notifyDingtalkEnabled?: boolean;
		notifyDingtalkWebhook?: string;
		notifyDingtalkSecret?: string;
		notifyFeishuEnabled?: boolean;
		notifyFeishuWebhook?: string;
		notifyFeishuSecret?: string;
		// Slash commands
		commands?: Array<{ name: string; prompt: string; description?: string }>;
		// Setup wizard
		setupWizardCompleted?: boolean;
	}) =>
		request<ApiEntity>("/user-preferences", {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// Notification sounds
	uploadNotificationSound: async (file: File) => {
		const formData = new FormData();
		formData.append("file", file);
		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await fetch(`${BASE}/notification-sounds`, {
			method: "POST",
			headers,
			body: formData,
		});
		if (!res.ok) {
			const err = await res.json().catch(() => ({ error: "Upload failed" }));
			throw new ApiError(err.error ?? "Upload failed", res.status);
		}
		return res.json() as Promise<{ id: string; filename: string; mediaType: string }>;
	},
	deleteNotificationSound: (id: string) =>
		request<{ ok: boolean }>(`/notification-sounds/${id}`, { method: "DELETE" }),
	testDingtalkWebhook: (webhook: string, secret?: string) =>
		request<{ ok: boolean; error?: string }>("/notifications/test-dingtalk", {
			method: "POST",
			body: JSON.stringify({ webhook, secret }),
		}),
	testFeishuWebhook: (webhook: string, secret?: string) =>
		request<{ ok: boolean; error?: string }>("/notifications/test-feishu", {
			method: "POST",
			body: JSON.stringify({ webhook, secret }),
		}),

	// Recent Tabs
	upsertRecentTab: (tab: {
		type: "chapter" | "narrator" | "project";
		id: string;
		narratorId?: string;
		title: string;
		subtitle?: string;
		status?: string;
		lastVisitedAt: number;
	}) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs", {
			method: "PUT",
			body: JSON.stringify(tab),
		}),
	removeRecentTab: (type: "chapter" | "narrator" | "project", id: string) =>
		request<ApiEntity[]>(`/user-preferences/recent-tabs/${type}/${id}`, {
			method: "DELETE",
		}),
	moveRecentTab: (key: string, target: { toIndex: number } | { position: "top" | "above_idle" }) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/move", {
			method: "PATCH",
			body: JSON.stringify({ key, ...target }),
		}),
	clearRecentTabs: (scope: "all" | "projects" | "inactive_narrators", keepTabKey?: string) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/clear", {
			method: "POST",
			body: JSON.stringify({ scope, keepTabKey }),
		}),
	saveGraphViewport: (projectId: string, viewport: { x: number; y: number; zoom: number }) =>
		request<{ ok: boolean }>("/user-preferences/graph-viewports", {
			method: "PATCH",
			body: JSON.stringify({ projectId, viewport }),
		}),

	// Containers
	getContainerSetup: (refresh?: boolean) =>
		request<{
			podman: { ok: boolean; version?: string };
			podmanCompose: { ok: boolean; version?: string };
			composeProvider: { ok: boolean; provider?: string };
			passt: { ok: boolean; version?: string };
			rootlessNetwork: { ok: boolean; backend?: string };
			allReady: boolean;
		}>(`/chapters/container-setup${refresh ? "?refresh=true" : ""}`),
	getPodmanStatus: () =>
		request<{ installed: boolean; version?: string; platform: string; supported: boolean }>(
			"/chapters/podman/status",
		),
	installPodman: () =>
		request<{ ok: boolean; installed?: boolean; version?: string; error?: string }>(
			"/chapters/podman/install",
			{ method: "POST" },
		),
	getComposeInfo: (chapterId: string) =>
		request<{
			services: Array<{
				name: string;
				ports: Array<{ host: number; container: number }>;
				environment: Record<string, string>;
				image?: string;
			}>;
		}>(`/chapters/${chapterId}/compose-info`),
	getContainers: (chapterId: string) => request<ApiEntity[]>(`/chapters/${chapterId}/containers`),
	startContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/start`, { method: "POST" }),
	stopContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/stop`, { method: "POST" }),
	pauseContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/pause`, { method: "POST" }),
	unpauseContainers: (chapterId: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/unpause`, { method: "POST" }),
	getContainerLogs: (chapterId: string, opts?: { tail?: number; service?: string }) => {
		const params = new URLSearchParams();
		if (opts?.tail) params.set("tail", String(opts.tail));
		if (opts?.service) params.set("service", opts.service);
		const qs = params.toString();
		return request<{ logs: string }>(`/chapters/${chapterId}/containers/logs${qs ? `?${qs}` : ""}`);
	},
	removeContainers: (chapterId: string, opts?: { deleteVolumes?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/containers/remove`, {
			method: "POST",
			body: JSON.stringify(opts ?? {}),
		}),

	// Chapter operations (fork/merge/cleanup)
	forkChapter: (
		id: string,
		data: {
			title?: string;
			description?: string;
			inheritMode?: string;
			forkAtMessageUuid?: string;
			role?: string;
			positionX?: number;
			positionY?: number;
		},
	) => request<ApiEntity>(`/chapters/${id}/fork`, { method: "POST", body: JSON.stringify(data) }),
	checkMergeConflicts: (id: string, targetChapterId: string) =>
		request<ApiEntity>(`/chapters/${id}/merge-check?targetChapterId=${targetChapterId}`),
	mergeChapter: (
		id: string,
		data: { targetChapterId: string; strategy?: string; message?: string },
	) =>
		request<ApiEntity>(`/chapters/${id}/merge`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	cleanupChapters: (data: { chapterIds: string[]; force?: boolean; deleteBranch?: boolean }) =>
		request<ApiEntity>("/chapters/cleanup", { method: "POST", body: JSON.stringify(data) }),
	batchMerge: (data: {
		baseChapterId: string;
		sourceChapterIds: string[];
		title?: string;
		strategy?: string;
		targetChapterId?: string;
	}) =>
		request<ApiEntity>("/chapters/batch-merge", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	dormantChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/dormant`, { method: "POST" }),
	wakeChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/wake`, { method: "POST" }),
	unmergeChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/unmerge`, { method: "POST" }),

	// === chapter edges ===
	listChapterEdges: (params: { projectId?: string; chapterId?: string; type?: string }) => {
		const searchParams = new URLSearchParams();
		if (params.projectId) searchParams.set("projectId", params.projectId);
		if (params.chapterId) searchParams.set("chapterId", params.chapterId);
		if (params.type) searchParams.set("type", params.type);
		return request<ApiEntity[]>(`/chapter-edges?${searchParams}`);
	},
	createChapterEdge: (data: {
		sourceId: string;
		targetId: string;
		type: string;
		metadata?: Record<string, unknown>;
	}) => request<ApiEntity>("/chapter-edges", { method: "POST", body: JSON.stringify(data) }),
	deleteChapterEdge: (id: string) =>
		request<{ ok: boolean }>(`/chapter-edges/${id}`, { method: "DELETE" }),

	// === graph positions ===
	updateGraphPositions: (
		projectId: string,
		positions: Array<{
			chapterId: string;
			x: number;
			y: number;
			panelExpanded?: boolean;
			panelWidth?: number;
			panelHeight?: number;
		}>,
	) =>
		request<{ ok: boolean }>(`/projects/${projectId}/graph/positions`, {
			method: "PATCH",
			body: JSON.stringify({ positions }),
		}),

	// === chapter commits ===
	getChapterCommits: (id: string, params?: { limit?: number; since?: string }) => {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set("limit", String(params.limit));
		if (params?.since) searchParams.set("since", params.since);
		const qs = searchParams.toString();
		return request<
			Array<{
				id: string;
				sha: string;
				message: string;
				authorName: string | null;
				authorEmail: string | null;
				authoredAt: string;
				source: "manual" | "auto" | "merge" | "cherry_pick" | "initial";
				narratorId: string | null;
				narratorMessageId: string | null;
				filesChanged: number | null;
				linesAdded: number | null;
				linesRemoved: number | null;
			}>
		>(`/chapters/${id}/commits${qs ? `?${qs}` : ""}`);
	},

	getChapterCommit: (chapterId: string, sha: string) =>
		request<{
			id: string;
			sha: string;
			message: string;
			fullMessage: string | null;
			authorName: string | null;
			authorEmail: string | null;
			authoredAt: string;
			source: "manual" | "auto" | "merge" | "cherry_pick" | "initial";
			narratorId: string | null;
			narratorMessageId: string | null;
			filesChanged: number | null;
			linesAdded: number | null;
			linesRemoved: number | null;
			files: Array<{
				path: string;
				oldPath?: string;
				status: string;
				linesAdded: number;
				linesRemoved: number;
				diff?: string;
			}>;
			diffInlined: boolean;
		}>(`/chapters/${chapterId}/commits/${sha}`),

	getCommitFileDiff: (chapterId: string, sha: string, filePath: string) =>
		request<{ diff: string; truncated: boolean }>(
			`/chapters/${chapterId}/commits/${sha}/files/${filePath}`,
		),

	// === chapter git status ===
	getChapterGitStatus: (id: string) =>
		request<{
			commitsAhead: number;
			baseBranch: string;
			linesAdded: number;
			linesRemoved: number;
		}>(`/chapters/${id}/git-status`),

	// === git operations ===
	getGitStatus: (chapterId: string) => request<ApiEntity>(`/chapters/${chapterId}/git/status`),
	gitStage: (chapterId: string, body: { files?: string[]; all?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/stage`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	gitUnstage: (chapterId: string, body: { files?: string[]; all?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/unstage`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	gitCommit: (chapterId: string, message: string) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/commit`, {
			method: "POST",
			body: JSON.stringify({ message }),
		}),
	gitDiscard: (chapterId: string, body: { files?: string[]; all?: boolean }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/discard`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	getGitDiff: (chapterId: string, file: string, staged = false) =>
		request<ApiEntity>(
			`/chapters/${chapterId}/git/diff?file=${encodeURIComponent(file)}&staged=${staged}`,
		),
	getGitStashList: (chapterId: string) =>
		request<ApiEntity[]>(`/chapters/${chapterId}/git/stash/list`),
	gitStash: (chapterId: string, body: { action: string; message?: string; index?: number }) =>
		request<ApiEntity>(`/chapters/${chapterId}/git/stash`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	getGitLog: (chapterId: string, limit = 50, skip = 0) =>
		request<ApiEntity[]>(`/chapters/${chapterId}/git/log?limit=${limit}&skip=${skip}`),
	gitReset: (chapterId: string, target: string, mode: "soft" | "hard") =>
		request<ApiEntity>(`/chapters/${chapterId}/git/reset`, {
			method: "POST",
			body: JSON.stringify({ target, mode }),
		}),
	gitAiCommitMessage: (chapterId: string) =>
		request<{ message: string }>(`/chapters/${chapterId}/git/ai-commit-message`, {
			method: "POST",
		}),

	// === chapter split ===
	splitChapter: (
		id: string,
		data: {
			commitSha: string;
			newFork: { title: string; description?: string; inheritMode?: string };
		},
	) =>
		request<ApiEntity>(`/chapters/${id}/split`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// === batch fork ===
	batchForkChapter: (
		id: string,
		data: {
			forks: Array<{
				title: string;
				description?: string;
				inheritMode?: string;
				role?: string;
			}>;
		},
	) =>
		request<{ created: ApiEntity[]; failed: Array<{ input: unknown; error: string }> }>(
			`/chapters/${id}/batch-fork`,
			{ method: "POST", body: JSON.stringify(data) },
		),

	// === cherry-pick ===
	cherryPickChapter: (id: string, data: { sourceChapterId: string; commitShas: string[] }) =>
		request<ApiEntity>(`/chapters/${id}/cherry-pick`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// === dependency status ===
	getDependencyStatus: (id: string) =>
		request<
			Array<{
				edgeId: string;
				sourceChapterId: string;
				hasUpdates: boolean;
				newCommitCount: number;
			}>
		>(`/chapters/${id}/dependency-status`),

	// === sync upstream ===
	syncUpstream: (id: string, data: { edgeId: string; strategy: "rebase" | "merge" }) =>
		request<ApiEntity>(`/chapters/${id}/sync-upstream`, {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// === exploration groups ===
	listExplorationGroups: (projectId: string) =>
		request<ApiEntity[]>(`/exploration-groups?projectId=${projectId}`),
	getExplorationGroup: (id: string) => request<ApiEntity>(`/exploration-groups/${id}`),
	createExplorationGroup: (data: {
		projectId: string;
		title: string;
		description?: string;
		baseChapterId: string;
		branches: Array<{ title: string; description?: string; inheritMode?: string }>;
	}) =>
		request<ApiEntity>("/exploration-groups", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateExplorationGroup: (id: string, data: { title?: string; description?: string }) =>
		request<ApiEntity>(`/exploration-groups/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	decideExplorationGroup: (id: string, chapterId: string) =>
		request<ApiEntity>(`/exploration-groups/${id}/decide`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
		}),
	abandonExplorationGroup: (id: string) =>
		request<ApiEntity>(`/exploration-groups/${id}/abandon`, { method: "POST" }),

			method: "POST",
			body: JSON.stringify({ priority }),
		}),
			method: "POST",
			body: JSON.stringify({ mode }),
		}),
		id: string,
		fields: { email?: string; displayName?: string; region?: string },
	) =>
			method: "PATCH",
			body: JSON.stringify(fields),
		}),
			method: "POST",
			body: JSON.stringify({ query }),
		}),
		// biome-ignore lint/suspicious/noExplicitAny: MCP tool response structure varies
			method: "POST",
			body: JSON.stringify({ credentials }),
		}),
		request<{ models: Array<Record<string, unknown>>; fromCache: boolean }>(
		),
		request<{
			models: Array<Record<string, unknown>>;
			credentialId?: string;
			fromCache: boolean;
			method: "POST",
		}),
	// OpenAI-compatible models
	openaiListModels: () =>
		request<{ models: Array<{ id: string; owned_by?: string }>; fromCache: boolean }>(
			"/openai/models",
		),

	// External MCP server management
	mcpListServers: () =>
		request<{
			servers: Array<{
				id: string;
				name: string;
				transport: string;
				enabled: boolean;
				status: string;
				error?: string;
				tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
			}>;
		}>("/mcp/servers"),
	mcpCreateServer: (data: Record<string, unknown>) =>
		request<Record<string, unknown>>("/mcp/servers", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	mcpUpdateServer: (id: string, data: Record<string, unknown>) =>
		request<Record<string, unknown>>(`/mcp/servers/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	mcpDeleteServer: (id: string) =>
		request<{ ok: boolean }>(`/mcp/servers/${id}`, { method: "DELETE" }),
	mcpConnectServer: (id: string) =>
		request<Record<string, unknown>>(`/mcp/servers/${id}/connect`, { method: "POST" }),
	mcpDisconnectServer: (id: string) =>
		request<{ ok: boolean }>(`/mcp/servers/${id}/disconnect`, { method: "POST" }),
	mcpTestConnection: (data: Record<string, unknown>) =>
		request<{
			ok: boolean;
			tools?: Array<{ name: string; description?: string }>;
			error?: string;
		}>("/mcp/servers/test", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	mcpListAllTools: () =>
		request<{
			tools: Array<{
				name: string;
				description?: string;
				inputSchema?: unknown;
				serverName: string;
				serverId: string;
				source: string;
			}>;
		}>("/mcp/tools"),
	mcpImportServers: (json: unknown) =>
		request<{ added: number; skipped: number }>("/mcp/servers/import", {
			method: "POST",
			body: JSON.stringify({ json }),
		}),

	// Skills
	listSkills: (projectId: string) =>
		request<
			Array<{
				name: string;
				description: string;
				location: string;
				files: string[];
			}>
		>(`/skills?projectId=${projectId}`),
	getSkill: (projectId: string, name: string) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
		}>(`/skills/${encodeURIComponent(name)}?projectId=${projectId}`),

	// Global Skills
	listGlobalSkills: () =>
		request<
			Array<{
				name: string;
				description: string;
				location: string;
				files: string[];
			}>
		>("/skills/global"),
	getGlobalSkill: (name: string) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
		}>(`/skills/global/${encodeURIComponent(name)}`),
	createGlobalSkill: (data: { name: string; description: string; content: string }) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
		}>("/skills/global", { method: "POST", body: JSON.stringify(data) }),
	updateGlobalSkill: (
		currentName: string,
		data: { name: string; description: string; content: string },
	) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
		}>(`/skills/global/${encodeURIComponent(currentName)}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
	deleteGlobalSkill: (name: string) =>
		request<{ ok: boolean }>(`/skills/global/${encodeURIComponent(name)}`, {
			method: "DELETE",
		}),
	openaiRefreshModels: () =>
		request<{ models: Array<{ id: string; owned_by?: string }>; fromCache: boolean }>(
			"/openai/models/refresh",
			{ method: "POST" },
		),
	openaiRefreshProviderModels: (providerId: string) =>
		request<{ models: Array<{ id: string; owned_by?: string }>; fromCache: boolean }>(
			`/openai/providers/${providerId}/models/refresh`,
			{ method: "POST" },
		),
	// Codex credential pool management
	codexStatus: () =>
		request<{
			entries: Array<{
				id: string;
				displayName?: string;
				accountId?: string;
				email?: string;
				priority: number;
				disabled: boolean;
				disabledReason?: string;
				successCount: number;
				failureCount: number;
				lastUsedAt?: string;
				expiresAt?: number;
				usage?: {
					plan_type: string;
					primary_window?: {
						used_percent: number;
						remaining_percent: number;
						reset_at: number;
						reset_after_seconds: number;
						window_type: "5h" | "weekly" | "unknown";
					};
					secondary_window?: {
						used_percent: number;
						remaining_percent: number;
						reset_at: number;
						reset_after_seconds: number;
						window_type: "5h" | "weekly" | "unknown";
					};
					code_review?: {
						used_percent: number;
						remaining_percent: number;
						reset_at: number;
						reset_after_seconds: number;
					};
					queriedAt: string;
				};
			}>;
			currentId: string;
			loadBalancingMode: "priority" | "balanced";
			total: number;
			available: number;
			stickySessionCount: number;
			globalProxy?: string;
			defaultReasoningEffort?: "low" | "medium" | "high" | "xhigh";
			usageCache: Record<
				string,
				{
					plan_type: string;
					primary_window?: {
						used_percent: number;
						remaining_percent: number;
						reset_at: number;
						reset_after_seconds: number;
						window_type: "5h" | "weekly" | "unknown";
					};
					secondary_window?: {
						used_percent: number;
						remaining_percent: number;
						reset_at: number;
						reset_after_seconds: number;
						window_type: "5h" | "weekly" | "unknown";
					};
					code_review?: {
						used_percent: number;
						remaining_percent: number;
						reset_at: number;
						reset_after_seconds: number;
					};
					queriedAt: string;
				}
			>;
		}>("/codex/status"),
	codexBrowserAuth: () =>
		request<{ authorizeUrl: string }>("/codex/auth/browser", {
			method: "POST",
		}),
	codexBrowserAuthCancel: () =>
		request<{ ok: boolean }>("/codex/auth/browser/cancel", { method: "POST" }),
	codexDeviceAuthStart: () =>
		request<{
			deviceAuthId: string;
			userCode: string;
			verificationUrl: string;
		}>("/codex/auth/device/start", {
			method: "POST",
		}),
	codexDeviceAuthPoll: () =>
		request<{
			pending: boolean;
			userCode?: string;
			verificationUrl?: string;
		}>("/codex/auth/device/poll", { method: "POST" }),
	codexDeviceAuthCancel: () =>
		request<{ ok: boolean }>("/codex/auth/device/cancel", { method: "POST" }),
	codexCredentialDisable: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/disable`, { method: "POST" }),
	codexCredentialEnable: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/enable`, { method: "POST" }),
	codexCredentialReset: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/reset`, { method: "POST" }),
	codexCredentialDelete: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}`, { method: "DELETE" }),
	codexCredentialBatchDelete: (ids: string[]) =>
		request<{ removed: string[]; notFound: string[] }>("/codex/credentials/batch", {
			method: "DELETE",
			body: JSON.stringify({ ids }),
		}),
	codexCredentialUpdate: (id: string, data: { displayName?: string; priority?: number }) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	codexCredentialRefresh: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/refresh`, { method: "POST" }),
	codexCredentialGetUsage: (id: string) =>
		request<{
			plan_type: string;
			primary_window?: {
				used_percent: number;
				remaining_percent: number;
				reset_at: number;
				reset_after_seconds: number;
				window_type: "5h" | "weekly" | "unknown";
			};
			secondary_window?: {
				used_percent: number;
				remaining_percent: number;
				reset_at: number;
				reset_after_seconds: number;
				window_type: "5h" | "weekly" | "unknown";
			};
			code_review?: {
				used_percent: number;
				remaining_percent: number;
				reset_at: number;
				reset_after_seconds: number;
			};
			queriedAt: string;
		}>(`/codex/credentials/${id}/usage`, { method: "POST" }),
	codexSetLoadBalancingMode: (mode: "priority" | "balanced") =>
		request<{ ok: boolean; mode: string }>("/codex/load-balancing-mode", {
			method: "POST",
			body: JSON.stringify({ mode }),
		}),
	codexSetGlobalProxy: (proxy?: string) =>
		request<{ ok: boolean }>("/codex/global-proxy", {
			method: "POST",
			body: JSON.stringify({ proxy }),
		}),
	codexGetDefaultReasoningEffort: () =>
		request<{ reasoningEffort: "low" | "medium" | "high" | "xhigh" | null }>(
			"/codex/default-reasoning-effort",
		),
	codexSetDefaultReasoningEffort: (reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null) =>
		request<{ ok: boolean; reasoningEffort: "low" | "medium" | "high" | "xhigh" | null }>(
			"/codex/default-reasoning-effort",
			{
				method: "POST",
				body: JSON.stringify({ reasoningEffort }),
			},
		),
	codexImportCredentials: (
		credentials: Array<{
			refreshToken: string;
			displayName?: string;
			priority?: number;
		}>,
	) =>
		request<{
			added: number;
			duplicates: number;
		}>("/codex/import", {
			method: "POST",
			body: JSON.stringify({ credentials }),
		}),
	// Anthropic models
	anthropicRefreshProviderModels: (providerId: string) =>
		request<{
			models: Array<{ id: string; display_name?: string }>;
			fromCache: boolean;
		}>(`/anthropic/providers/${providerId}/models/refresh`, { method: "POST" }),

		request<{
			models: Array<{ id: string; owned_by?: string }>;
			fromCache: boolean;

		request<{ quotaBalance: number; quotaTotalGranted: number }>(
		),

	// Health / platform
	health: () =>
		request<{
			status: string;
			version: string;
			commit: string;
			platform: "windows" | "macos" | "linux";
		}>("/health"),

	// Dependencies
	checkDependencies: () =>
		request<{
			platform: "windows" | "macos" | "linux";
			packageManager?: string;
			dependencies: Array<{
				name: string;
				required: boolean;
				installed: boolean;
				version?: string;
				platformSupported: boolean;
				installCommands: Record<string, string>;
			}>;
			allRequiredMet: boolean;
		}>("/dependencies"),

	installDependency: (name: string) =>
		request<{
			ok: boolean;
			error?: string;
			dependency?: { name: string; installed: boolean; version?: string };
		}>(`/dependencies/${name}/install`, { method: "POST" }),

	// Filesystem browsing
	fsBrowse: (path?: string) =>
		request<{
			path: string | null;
			entries: Array<{ name: string; path: string }>;
			drives?: Array<{ name: string; path: string }>;
			parent?: string | null;
			sep: string;
		}>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`),

	// Routines
	getRoutines: () =>
		request<{
			routines: Array<{
				id: string;
				type: "command" | "skill" | "tool";
				category: string;
				name: string;
				descriptionEn: string;
				descriptionZh: string;
				enabled: boolean;
			}>;
		}>("/routines"),
	toggleRoutine: (id: string, enabled: boolean) =>
		request<{ ok: boolean }>(`/routines/${id}/toggle`, {
			method: "POST",
			body: JSON.stringify({ enabled }),
		}),
	getProjectRoutines: (projectId: string) =>
		request<{
			routines: Array<{
				id: string;
				type: "command" | "skill" | "tool";
				category: string;
				name: string;
				descriptionEn: string;
				descriptionZh: string;
				enabled: boolean;
				override: "global" | "enabled" | "disabled";
				globalEnabled: boolean;
			}>;
		}>(`/routines/project/${projectId}`),
	toggleProjectRoutine: (projectId: string, id: string, action: "enable" | "disable" | "reset") =>
		request<{ ok: boolean }>(`/routines/project/${projectId}/${id}/toggle`, {
			method: "POST",
			body: JSON.stringify({ action }),
		}),
};

	text: string,
	model?: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const token = getToken();
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ text, model }),
		signal,
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(err.error ?? "Request failed");
	}
	if (!res.body) throw new Error("No response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let currentEvent = "chunk";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });

		const lines = buf.split("\n");
		buf = lines.pop() ?? "";

		for (const line of lines) {
			if (line.startsWith("event:")) {
				currentEvent = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				const data = line.slice(5).trimStart();
				if (currentEvent === "error") throw new Error(data || "Unknown error");
				if (currentEvent === "done") return;
				yield data;
			}
		}
	}
}
