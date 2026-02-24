const BASE = "/api";
const TOKEN_KEY = "narrafork_token";

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

// biome-ignore lint/suspicious/noExplicitAny: SDK content blocks have dynamic structure
export type ContentBlock = any;
// biome-ignore lint/suspicious/noExplicitAny: SDK tool call records have dynamic structure
export type ToolCallRecord = any;
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
	subagentModel?: string | null;
	createdAt: string;
	children: TreeMessage[];
	/** Synthetic flag: when true, tool run grouping should not merge this message with the preceding run. */
	_noMerge?: boolean;
}

export interface PaginatedNarrators {
	items: ApiEntity[];
	hasMore: boolean;
	nextCursor: string | null;
	totalCount: number;
}

export interface PaginatedMessages {
	messages: TreeMessage[];
	hasMore: boolean;
	nextCursor: string | null;
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

	// Admin
	listUsers: () => request<ApiEntity[]>("/admin/users"),
	deleteUser: (id: string) => request<ApiEntity>(`/admin/users/${id}`, { method: "DELETE" }),
	updateUser: (id: string, data: { username?: string; password?: string }) =>
		request<ApiEntity>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	updateAdminSettings: (data: { registrationOpen: boolean }) =>
		request<ApiEntity>("/admin/settings", { method: "PATCH", body: JSON.stringify(data) }),

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
	getNarrator: (id: string) => request<ApiEntity>(`/narrators/${id}`),
	createNarrator: (data: {
		chapterId?: string | null;
		type?: string;
		model?: string;
		systemPrompt?: string;
		permissionMode?: string;
		cwd?: string;
		planMode?: boolean;
	}) => request<ApiEntity>("/narrators", { method: "POST", body: JSON.stringify(data) }),
	archiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/archive`, { method: "PATCH" }),
	unarchiveNarrator: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/unarchive`, { method: "PATCH" }),
	markNarratorRead: (id: string) =>
		request<ApiEntity>(`/narrators/${id}/mark-read`, { method: "PATCH" }),
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
	triggerCompact: (narratorId: string, beforeMessageId?: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact`, {
			method: "POST",
			body: JSON.stringify(beforeMessageId ? { beforeMessageId } : {}),
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
	updateCompactSummary: (narratorId: string, messageId: string, summary: string) =>
		request<{ ok: boolean }>(`/narrators/${narratorId}/compact/${messageId}`, {
			method: "PATCH",
			body: JSON.stringify({ summary }),
		}),

	// Narrator Fork
	forkNarrator: (narratorId: string, forkMessageId: string, title?: string) =>
		request<ApiEntity>(`/narrators/${narratorId}/fork`, {
			method: "POST",
			body: JSON.stringify({ forkMessageId, title }),
		}),
	getRelatedNarrators: (narratorId: string) =>
		request<ApiEntity[]>(`/narrators/${narratorId}/related`),

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
	deleteTerminal: (id: string) => request<ApiEntity>(`/terminals/${id}`, { method: "DELETE" }),

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
			terminalTheme: string;
			terminalFontSize: number;
			recentTabs: Array<{
				type: "chapter" | "session";
				id: string;
				narratorId?: string;
				title: string;
				subtitle?: string;
				status?: string;
				lastVisitedAt: number;
			}>;
		}>("/user-preferences"),
	updateUserPreferences: (data: {
		autoLoadOlderMessages?: boolean;
		language?: string;
		wordWrapMarkdown?: boolean;
		wordWrapCode?: boolean;
		wordWrapDiff?: boolean;
		replyInUserLanguage?: boolean;
		showTokenUsage?: boolean;
		terminalTheme?: string;
		terminalFontSize?: number;
	}) =>
		request<ApiEntity>("/user-preferences", {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// Recent Tabs
	upsertRecentTab: (tab: {
		type: "chapter" | "session";
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
	removeRecentTab: (type: "chapter" | "session", id: string) =>
		request<ApiEntity[]>(`/user-preferences/recent-tabs/${type}/${id}`, {
			method: "DELETE",
		}),
	clearRecentTabs: () =>
		request<ApiEntity[]>("/user-preferences/recent-tabs", {
			method: "DELETE",
		}),
	reorderRecentTabs: (order: string[]) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/reorder", {
			method: "PATCH",
			body: JSON.stringify({ order }),
		}),

	// Containers
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
			title: string;
			description?: string;
			inheritMode?: string;
			forkAtMessageUuid?: string;
			role?: string;
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
		title: string;
		strategy?: string;
	}) =>
		request<ApiEntity>("/chapters/batch-merge", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	dormantChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/dormant`, { method: "POST" }),
	wakeChapter: (id: string) => request<ApiEntity>(`/chapters/${id}/wake`, { method: "POST" }),

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
		positions: Array<{ chapterId: string; x: number; y: number }>,
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
		return request<Array<{ sha: string; message: string; date: string }>>(
			`/chapters/${id}/commits${qs ? `?${qs}` : ""}`,
		);
	},

	// === chapter git status ===
	getChapterGitStatus: (id: string) =>
		request<{
			commitsAhead: number;
			baseBranch: string;
			linesAdded: number;
			linesRemoved: number;
		}>(`/chapters/${id}/git-status`),

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
			body: JSON.stringify({ query }),
		}),
			method: "POST",
			body: JSON.stringify({ credentials }),
		}),
		request<{ models: Array<Record<string, unknown>>; fromCache: boolean }>(
		),
		request<{
			models: Array<Record<string, unknown>>;
			credentialId?: number;
			fromCache: boolean;
			method: "POST",
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
