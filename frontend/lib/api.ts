const BASE = "/api";
const TOKEN_KEY = "narrafork_token";

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
		throw new Error("Unauthorized");
	}
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: response.statusText }));
		throw new Error(error.error ?? "Request failed");
	}
	return response.json();
}

export interface TreeMessage {
	id: string;
	narratorId: string;
	parentToolUseId: string | null;
	sdkMessageUuid?: string | null;
	role: string;
	contentJson: any[];
	contentText: string | null;
	toolCalls: any[];
	tokensIn?: number | null;
	tokensOut?: number | null;
	costUsd?: number | null;
	createdAt: string;
	children: TreeMessage[];
}

export interface PaginatedNarrators {
	items: any[];
	hasMore: boolean;
	nextCursor: string | null;
	totalCount: number;
}

export interface PaginatedMessages {
	messages: TreeMessage[];
	hasMore: boolean;
	nextCursor: string | null;
}

export const api = {
	// Auth
	authStatus: () => request<{ hasUsers: boolean; registrationOpen: boolean }>("/auth/status"),
	register: (data: { username: string; password: string }) =>
		request<{ user: any; token: string }>("/auth/register", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	login: (data: { username: string; password: string }) =>
		request<{ user: any; token: string }>("/auth/login", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	me: () => request<any>("/auth/me"),

	// Admin
	listUsers: () => request<any[]>("/admin/users"),
	deleteUser: (id: string) => request<any>(`/admin/users/${id}`, { method: "DELETE" }),
	updateAdminSettings: (data: { registrationOpen: boolean }) =>
		request<any>("/admin/settings", { method: "PATCH", body: JSON.stringify(data) }),

	// Projects
	listProjects: (status?: string) =>
		request<any[]>(`/projects${status ? `?status=${status}` : ""}`),
	getProject: (id: string) => request<any>(`/projects/${id}`),
	createProject: (data: any) =>
		request<any>("/projects", { method: "POST", body: JSON.stringify(data) }),
	updateProject: (id: string, data: any) =>
		request<any>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteProject: (id: string) => request<any>(`/projects/${id}`, { method: "DELETE" }),

	// Chapters
	listChapters: (projectId: string, status?: string) =>
		request<any[]>(`/chapters?projectId=${projectId}${status ? `&status=${status}` : ""}`),
	getChapter: (id: string) => request<any>(`/chapters/${id}`),
	createChapter: (data: any) =>
		request<any>("/chapters", { method: "POST", body: JSON.stringify(data) }),
	updateChapter: (id: string, data: any) =>
		request<any>(`/chapters/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteChapter: (id: string) => request<any>(`/chapters/${id}`, { method: "DELETE" }),

	// Settings
	getSettings: () => request<any>("/settings"),
	updateSettings: (data: any) =>
		request<any>("/settings", { method: "PATCH", body: JSON.stringify(data) }),

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
		return request<any[]>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	listNarratorsPaginated: (opts?: {
		standalone?: boolean;
		status?: string;
		sortBy?: string;
		sortOrder?: string;
		limit?: number;
		cursor?: string;
	}) => {
		const params = new URLSearchParams();
		if (opts?.standalone) params.set("standalone", "true");
		if (opts?.status) params.set("status", opts.status);
		if (opts?.sortBy) params.set("sortBy", opts.sortBy);
		if (opts?.sortOrder) params.set("sortOrder", opts.sortOrder);
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.cursor) params.set("cursor", opts.cursor);
		const qs = params.toString();
		return request<PaginatedNarrators>(`/narrators${qs ? `?${qs}` : ""}`);
	},
	getNarrator: (id: string) => request<any>(`/narrators/${id}`),
	createNarrator: (data: {
		chapterId?: string | null;
		type?: string;
		model?: string;
		systemPrompt?: string;
		permissionMode?: string;
		cwd?: string;
		sdkPlanMode?: boolean;
	}) => request<any>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	archiveNarrator: (id: string) => request<any>(`/narrators/${id}/archive`, { method: "PATCH" }),
	unarchiveNarrator: (id: string) =>
		request<any>(`/narrators/${id}/unarchive`, { method: "PATCH" }),
	markNarratorRead: (id: string) => request<any>(`/narrators/${id}/mark-read`, { method: "PATCH" }),
	getNarratorMessages: (id: string, limit?: number, cursor?: string, around?: string) => {
		const params = new URLSearchParams();
		if (around) {
			params.set("around", around);
		} else {
			if (limit) params.set("limit", String(limit));
			if (cursor) params.set("cursor", cursor);
		}
		const qs = params.toString();
		return request<PaginatedMessages>(`/narrators/${id}/messages${qs ? `?${qs}` : ""}`);
	},
	getToolCallDetail: (narratorId: string, toolUseId: string) =>
		request<any>(`/narrators/${narratorId}/tool-calls/${toolUseId}`),
	interruptNarrator: (id: string) => request<any>(`/narrators/${id}/interrupt`, { method: "POST" }),
	getBufferedMessage: (id: string) =>
		request<{ text: string; bufferedAt: string } | null>(`/narrators/${id}/buffer`),
	getPendingPermissions: (id: string) => request<any[]>(`/narrators/${id}/permissions`),
	approvePermission: (requestId: string) =>
		request<any>(`/narrators/permissions/${requestId}/approve`, { method: "POST" }),
	denyPermission: (requestId: string, message?: string) =>
		request<any>(`/narrators/permissions/${requestId}/deny`, {
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

	// Terminals
	listTerminals: (chapterId: string) => {
		const params = new URLSearchParams({ chapterId });
		return request<any[]>(`/terminals?${params}`);
	},
	listTerminalsByNarrator: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<any[]>(`/terminals?${params}`);
	},
	createTerminal: (data: {
		chapterId?: string;
		narratorId?: string;
		name?: string;
		cols?: number;
		rows?: number;
	}) => request<any>("/terminals", { method: "POST", body: JSON.stringify(data) }),
	getTerminal: (id: string) => request<any>(`/terminals/${id}`),
	deleteTerminal: (id: string) => request<any>(`/terminals/${id}`, { method: "DELETE" }),

	// Graph
	getProjectGraph: (projectId: string) =>
		request<{ nodes: any[]; edges: any[] }>(`/projects/${projectId}/graph`),

	// Search
	search: (q: string, entities = "chapters,messages") =>
		request<{ results: any[] }>(`/search?q=${encodeURIComponent(q)}&entities=${entities}`),

	// Favorite Directories
	listFavoriteDirectories: () => request<any[]>("/favorites"),
	createFavoriteDirectory: (data: { path: string; label?: string }) =>
		request<any>("/favorites", { method: "POST", body: JSON.stringify(data) }),
	updateFavoriteDirectory: (
		id: string,
		data: { path?: string; label?: string | null; sortOrder?: number },
	) => request<any>(`/favorites/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteFavoriteDirectory: (id: string) => request<any>(`/favorites/${id}`, { method: "DELETE" }),
	reorderFavoriteDirectories: (ids: string[]) =>
		request<any>("/favorites/reorder", { method: "PUT", body: JSON.stringify({ ids }) }),

	// User Preferences
	getUserPreferences: () =>
		request<{
			autoLoadOlderMessages: boolean;
			language: string;
			wordWrapMarkdown: boolean;
			wordWrapCode: boolean;
			wordWrapDiff: boolean;
			replyInUserLanguage: boolean;
		}>("/user-preferences"),
	updateUserPreferences: (data: {
		autoLoadOlderMessages?: boolean;
		language?: string;
		wordWrapMarkdown?: boolean;
		wordWrapCode?: boolean;
		wordWrapDiff?: boolean;
		replyInUserLanguage?: boolean;
	}) => request<any>("/user-preferences", { method: "PATCH", body: JSON.stringify(data) }),

	// Containers
	getContainers: (chapterId: string) => request<any[]>(`/chapters/${chapterId}/containers`),
	startContainers: (chapterId: string) =>
		request<any>(`/chapters/${chapterId}/containers/start`, { method: "POST" }),
	stopContainers: (chapterId: string) =>
		request<any>(`/chapters/${chapterId}/containers/stop`, { method: "POST" }),
	pauseContainers: (chapterId: string) =>
		request<any>(`/chapters/${chapterId}/containers/pause`, { method: "POST" }),
	unpauseContainers: (chapterId: string) =>
		request<any>(`/chapters/${chapterId}/containers/unpause`, { method: "POST" }),
	getContainerLogs: (chapterId: string, opts?: { tail?: number; service?: string }) => {
		const params = new URLSearchParams();
		if (opts?.tail) params.set("tail", String(opts.tail));
		if (opts?.service) params.set("service", opts.service);
		const qs = params.toString();
		return request<{ logs: string }>(`/chapters/${chapterId}/containers/logs${qs ? `?${qs}` : ""}`);
	},
	removeContainers: (chapterId: string, opts?: { deleteVolumes?: boolean }) =>
		request<any>(`/chapters/${chapterId}/containers/remove`, {
			method: "POST",
			body: JSON.stringify(opts ?? {}),
		}),

	// Chapter operations (fork/merge/cleanup)
	forkChapter: (
		id: string,
		data: {
			title: string;
			description?: string;
			inheritMode?: string;
			forkAtMessageUuid?: string;
		},
	) => request<any>(`/chapters/${id}/fork`, { method: "POST", body: JSON.stringify(data) }),
	checkMergeConflicts: (id: string, targetChapterId: string) =>
		request<any>(`/chapters/${id}/merge-check?targetChapterId=${targetChapterId}`),
	mergeChapter: (
		id: string,
		data: { targetChapterId: string; strategy?: string; message?: string },
	) => request<any>(`/chapters/${id}/merge`, { method: "POST", body: JSON.stringify(data) }),
	cleanupChapters: (data: { chapterIds: string[]; force?: boolean; deleteBranch?: boolean }) =>
		request<any>("/chapters/cleanup", { method: "POST", body: JSON.stringify(data) }),
	batchMerge: (data: {
		baseChapterId: string;
		sourceChapterIds: string[];
		title: string;
		strategy?: string;
	}) => request<any>("/chapters/batch-merge", { method: "POST", body: JSON.stringify(data) }),
	dormantChapter: (id: string) => request<any>(`/chapters/${id}/dormant`, { method: "POST" }),
	wakeChapter: (id: string) => request<any>(`/chapters/${id}/wake`, { method: "POST" }),
};
