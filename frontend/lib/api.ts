const BASE = "/api";
const TOKEN_KEY = "narrafork_token";

export interface ChangelogEntry {
	version: string;
	date: string;
	en: string;
	"zh-CN": string;
}

export interface StorageCategoryResult {
	key: string;
	sizeBytes: number;
	details?: Record<string, unknown>;
}

export interface StorageScanResult {
	categories: StorageCategoryResult[];
	totalBytes: number;
	scannedAt: number;
}

export interface DatabaseCleanupCandidateSummary {
	count: number;
	approxBytes: number;
	blockedCount: number;
	oldestAt: string | null;
	retentionDays?: number;
}

export interface DatabaseStorageBreakdown {
	mainBytes: number;
	walBytes: number;
	shmBytes: number;
	cleanupCandidates: {
		archivedSessions: DatabaseCleanupCandidateSummary;
		staleSessions: DatabaseCleanupCandidateSummary;
		apiRequestDumps: DatabaseCleanupCandidateSummary;
	};
}

export type DatabaseCleanupTarget = "archivedSessions" | "staleSessions" | "apiRequestDumps";

export type DatabaseCleanupBlockedReasonCode =
	| "chapterBound"
	| "runningTerminal"
	| "backgroundRunning"
	| "nonArchived"
	| "nonStaleStatus"
	| "recentActivity";

export type DatabaseCleanupWarningCode = "deletesUsageHistory";

export interface DatabaseCleanupPreviewCounts {
	sessions: number;
	narrators: number;
	descendantNarrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
	dumpsCleared: number;
}

export interface DatabaseCleanupNarratorSample {
	type: "narrator";
	id: string;
	title: string | null;
	status: string;
	lastActivityAt: string;
	messageCount: number;
	descendantNarratorCount: number;
	approxBytes: number;
}

export interface DatabaseCleanupApiRequestSample {
	type: "apiRequest";
	id: string;
	narratorId: string | null;
	narratorTitle: string | null;
	chapterTitle: string | null;
	createdAt: string;
	approxBytes: number;
}

export interface DatabaseCleanupBlockedItem {
	narratorId: string;
	title: string | null;
	lastActivityAt: string;
	reasonCode: DatabaseCleanupBlockedReasonCode;
	blockingNarratorId: string;
	blockingTitle: string | null;
	blockingStatus: string;
}

export interface DatabaseCleanupPreviewResult {
	target: DatabaseCleanupTarget;
	olderThanDays?: number;
	approxBytes: number;
	oldestAt: string | null;
	counts: DatabaseCleanupPreviewCounts;
	blockedCount: number;
	warningCodes: DatabaseCleanupWarningCode[];
	samples: Array<DatabaseCleanupNarratorSample | DatabaseCleanupApiRequestSample>;
	blocked: DatabaseCleanupBlockedItem[];
}

export interface DatabaseCleanupExecutionResult extends DatabaseCleanupPreviewResult {
	ok: true;
	beforeBytes: number;
	afterBytes: number;
	freedBytes: number;
	vacuumRan: boolean;
	changed: boolean;
}

export interface RuntimeScanResult {
	terminals: { running: number; exited: number; orphanSockets: number };
	containers: { running: number; stopped: number; podmanAvailable: boolean };
	browsers: { processRunning: boolean; connected: boolean; activeSessions: number };
	scannedAt: number;
}

export function getAvatarUrl(userId: string, avatarImageId: string): string {
	return `${BASE}/uploads/avatars/${userId}/${avatarImageId}`;
}

export class ApiError extends Error {
	status: number;
	data?: Record<string, unknown>;
	constructor(message: string, status: number, data?: Record<string, unknown>) {
		super(message);
		this.status = status;
		this.data = data;
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
	const text = await response.text();
	const tryParseJson = (raw: string) => {
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	};
	if (response.status === 401) {
		clearToken();
		const error = tryParseJson(text) ?? { error: text || "Unauthorized" };
		throw new ApiError(error.error ?? "Unauthorized", 401, error);
	}
	if (!response.ok) {
		const error = tryParseJson(text) ?? { error: text || response.statusText };
		throw new ApiError(error.error ?? "Request failed", response.status, error);
	}
	const parsed = tryParseJson(text);
	if (parsed !== null) return parsed as T;
	throw new ApiError(text || "Invalid response", response.status, { error: text });
}

// --- Codex shared types ---

interface CodexUsageWindow {
	used_percent: number;
	remaining_percent: number;
	reset_at: number;
	reset_after_seconds: number;
	window_type: "5h" | "weekly" | "unknown";
}

interface CodexUsageData {
	plan_type: string;
	primary_window?: CodexUsageWindow;
	secondary_window?: CodexUsageWindow;
	code_review?: {
		used_percent: number;
		remaining_percent: number;
		reset_at: number;
		reset_after_seconds: number;
	};
	queriedAt: string;
}

interface CodexCredentialEntry {
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
	usage?: CodexUsageData;
}

// --- Content block types ---

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
	permissionDenyMessage?: string | null;
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

export interface BlacklistDir {
	id: string;
	narratorId: string;
	path: string;
	denyLevel: "denyWrite" | "denyAll";
	enabled: boolean;
	createdAt: string;
}

export interface WhitelistCmd {
	id: string;
	narratorId: string;
	pattern: string;
	enabled: boolean;
	createdAt: string;
}

export interface BlacklistCmd {
	id: string;
	narratorId: string;
	pattern: string;
	denyPrompt: string | null;
	enabled: boolean;
	createdAt: string;
}

// biome-ignore lint/suspicious/noExplicitAny: API entity with dynamic fields
export type ApiEntity = any;

export interface HookApiRecord {
	id: string;
	projectId: string | null;
	event: string;
	matcher: string;
	type: "command" | "http";
	command: string | null;
	url: string | null;
	headers: Record<string, string> | null;
	prompt: string | null;
	model: string | null;
	timeout: number;
	enabled: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface CustomSubagentData {
	name: string;
	description: string;
	toolAccess: string;
	customTools: string[];
	defaultModel: string;
	prompt: string;
}

export interface BufferCreator {
	id: string;
	username: string;
	avatarColor?: string | null;
	avatarImageId?: string | null;
}

export interface BufferMessageSummary {
	id: string;
	text: string;
	bufferedAt: string;
	imageCount: number;
	creator?: BufferCreator | null;
}

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
	prevCursor?: string | null;
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
			const err = await res.json().catch(() => ({ error: "Unauthorized" }));
			throw new ApiError(err.error ?? "Unauthorized", 401, err);
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
	updateUser: (
		id: string,
		data: { username?: string; password?: string; role?: "admin" | "user" },
	) => request<ApiEntity>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
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
	/**
	 * Create a project with clone mode — returns an SSE stream.
	 * Events: "progress" (clone output), "complete" (project JSON), "error".
	 */
	createProjectStream: (
		data: Record<string, unknown>,
		onProgress: (message: string) => void,
		onCredentialRequired?: () => void,
	): Promise<ApiEntity> => {
		return new Promise((resolve, reject) => {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			const token = getToken();
			if (token) headers.Authorization = `Bearer ${token}`;

			fetch(`${BASE}/projects`, {
				method: "POST",
				headers,
				body: JSON.stringify(data),
			})
				.then((response) => {
					if (response.status === 401) {
						clearToken();
						reject(new ApiError("Unauthorized", 401));
						return;
					}
					if (
						!response.ok &&
						!response.headers.get("content-type")?.includes("text/event-stream")
					) {
						response
							.json()
							.then((err) => reject(new ApiError(err.error ?? "Request failed", response.status)))
							.catch(() => reject(new ApiError("Request failed", response.status)));
						return;
					}

					const reader = response.body?.getReader();
					if (!reader) {
						reject(new ApiError("No response body", 500));
						return;
					}

					const decoder = new TextDecoder();
					let buffer = "";

					const pump = (): void => {
						reader
							.read()
							.then(({ done, value }) => {
								if (done) {
									reject(new ApiError("Stream ended without completion", 500));
									return;
								}
								buffer += decoder.decode(value, { stream: true });
								const lines = buffer.split("\n");
								buffer = lines.pop() ?? "";

								let eventType = "";
								for (const line of lines) {
									if (line.startsWith("event:")) {
										eventType = line.slice(6).trim();
									} else if (line.startsWith("data:")) {
										const jsonStr = line.slice(5).trim();
										if (!jsonStr) continue;
										try {
											const parsed = JSON.parse(jsonStr);
											if (eventType === "progress") {
												onProgress(parsed.message);
											} else if (eventType === "complete") {
												reader.cancel().catch(() => {});
												resolve(parsed);
												return;
											} else if (eventType === "credential_required") {
												reader.cancel().catch(() => {});
												if (onCredentialRequired) {
													onCredentialRequired();
												}
												reject(new ApiError(parsed.error ?? "Authentication required", 401));
												return;
											} else if (eventType === "error") {
												reader.cancel().catch(() => {});
												reject(new ApiError(parsed.error ?? "Clone failed", 500));
												return;
											}
										} catch {
											// skip malformed JSON
										}
									}
								}
								pump();
							})
							.catch(reject);
					};
					pump();
				})
				.catch(reject);
		});
	},
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
	getContextThresholds: (model: string, provider: string) =>
		request<{ pruneStart: number; compactStart: number }>(
			`/settings/context-thresholds?model=${encodeURIComponent(model)}&provider=${encodeURIComponent(provider)}`,
		),
	updateSettings: (data: Record<string, unknown>) =>
		request<ApiEntity>("/settings", { method: "PATCH", body: JSON.stringify(data) }),
	generateTlsCert: () =>
		request<{
			certPath: string;
			keyPath: string;
			expiresAt: string;
			newUrl: string;
			serverRestarting: boolean;
		}>("/settings/generate-tls", { method: "POST" }),

	addRetryRule: (data: { domain?: string; statusCode?: number; keyword?: string; note?: string }) =>
		request<{ id: string }>("/settings/retry-rules", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	testModel: (model: string, prompt: string) =>
		request<{ text: string }>("/settings/test-model", {
			method: "POST",
			body: JSON.stringify({ model, prompt }),
		}),

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

	// Terminals
	listTerminals: (chapterId: string) => {
		const params = new URLSearchParams({ chapterId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},
	listTerminalsByNarrator: (narratorId: string) => {
		const params = new URLSearchParams({ narratorId });
		return request<ApiEntity[]>(`/terminals?${params}`);
	},

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
		panelAssignments?: Record<string, string | string[]> | null;
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
				type: "chapter" | "narrator" | "project" | "workspace";
				id: string;
				narratorId?: string;
				workspaceId?: string | null;
				title: string;
				subtitle?: string;
				status?: string;
				lastVisitedAt: number;
				pinned?: boolean;
			}>;
			commands: Array<{
				name: string;
				prompt: string;
				description?: string;
				params?: Array<{
					name: string;
					description?: string;
					required?: boolean;
					defaultValue?: string;
				}>;
				modelOverride?: {
					model: string;
					mode: "temporary" | "permanent";
				};
			}>;
			sendMode: "enter" | "ctrl+enter";
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
		commands?: Array<{
			name: string;
			prompt: string;
			description?: string;
			params?: Array<{
				name: string;
				description?: string;
				required?: boolean;
				defaultValue?: string;
			}>;
			modelOverride?: {
				model: string;
				mode: "temporary" | "permanent";
			};
		}>;
		// Send mode
		sendMode?: "enter" | "ctrl+enter";
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
		type: "chapter" | "narrator" | "project" | "workspace";
		id: string;
		narratorId?: string;
		workspaceId?: string | null;
		title: string;
		subtitle?: string;
		status?: string;
		lastVisitedAt: number;
		updateOnly?: boolean;
	}) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs", {
			method: "PUT",
			body: JSON.stringify(tab),
		}),
	removeRecentTab: (type: "chapter" | "narrator" | "project" | "workspace", id: string) =>
		request<ApiEntity[]>(`/user-preferences/recent-tabs/${type}/${id}`, {
			method: "DELETE",
		}),
	moveRecentTab: (key: string, target: { toIndex: number } | { position: "top" | "above_idle" }) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/move", {
			method: "PATCH",
			body: JSON.stringify({ key, ...target }),
		}),
	pinRecentTab: (key: string, pinned: boolean) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/pin", {
			method: "PATCH",
			body: JSON.stringify({ key, pinned }),
		}),
	clearRecentTabs: (scope: "all" | "projects" | "inactive_narrators", keepTabKey?: string) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/clear", {
			method: "POST",
			body: JSON.stringify({ scope, keepTabKey }),
		}),
	saveGraphViewport: (
		projectId: string,
		viewport: {
			x: number;
			y: number;
			zoom: number;
			rulerOrientation?: "horizontal" | "vertical";
			rulerEdge?: "start" | "end";
			rulerMainPan?: number;
			rulerCrossPan?: number;
			rulerThickness?: number;
		},
	) =>
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

	// Volume Snapshots
	listVolumeSnapshots: (
		projectId: string,
		filters?: { serviceName?: string; containerPath?: string },
	) => {
		const params = new URLSearchParams();
		if (filters?.serviceName) params.set("serviceName", filters.serviceName);
		if (filters?.containerPath) params.set("containerPath", filters.containerPath);
		const qs = params.toString();
		return request<ApiEntity[]>(`/projects/${projectId}/volume-snapshots${qs ? `?${qs}` : ""}`);
	},
	createVolumeSnapshot: (
		projectId: string,
		data: {
			chapterId: string;
			serviceName: string;
			containerPath: string;
			name: string;
			description?: string;
		},
	) =>
		request<ApiEntity>(`/projects/${projectId}/volume-snapshots`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	getVolumeSnapshot: (snapshotId: string) => request<ApiEntity>(`/volume-snapshots/${snapshotId}`),
	updateVolumeSnapshot: (
		snapshotId: string,
		data: { name?: string; description?: string | null },
	) =>
		request<ApiEntity>(`/volume-snapshots/${snapshotId}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteVolumeSnapshot: (snapshotId: string) =>
		request<{ success: boolean }>(`/volume-snapshots/${snapshotId}`, { method: "DELETE" }),
	applyVolumeSnapshot: (snapshotId: string, targetChapterId: string) =>
		request<{ success: boolean }>(`/volume-snapshots/${snapshotId}/apply`, {
			method: "POST",
			body: JSON.stringify({ targetChapterId }),
		}),
	getSnapshotApplications: (snapshotId: string) =>
		request<ApiEntity[]>(`/volume-snapshots/${snapshotId}/applications`),

	// Chapter operations (fork/merge/cleanup)
	forkChapter: (
		id: string,
		data: {
			title?: string;
			description?: string;
			inheritMode?: string;
			forkAtMessageUuid?: string;
			role?: string;
			anchorCommitSha?: string;
			axisOffset?: number;
			crossOffset?: number;
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

	// === reviews ===
	createReview: (
		chapterId: string,
		data: {
			title?: string;
			locale?: string;
			anchorCommitSha?: string;
			axisOffset?: number;
			crossOffset?: number;
		},
	) =>
		request<ApiEntity>(`/chapters/${chapterId}/review`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	convertReviewToSubagent: (reviewId: string) =>
		request<ApiEntity>(`/reviews/${reviewId}/convert-to-subagent`, { method: "POST" }),
	promoteReview: (reviewId: string) =>
		request<ApiEntity>(`/reviews/${reviewId}/promote`, { method: "POST" }),
	dismissReview: (reviewId: string) =>
		request<ApiEntity>(`/reviews/${reviewId}/dismiss`, { method: "POST" }),
	getReviewConclusionForSource: (sourceChapterId: string) =>
		request<{
			conclusion: {
				id: string;
				verdict: "approve" | "request_changes" | "comment_only";
				findingsJson: Array<{
					severity: string;
					file?: string;
					line?: number;
					message: string;
				}> | null;
				createdAt: string;
			} | null;
		}>(`/reviews/by-source/${sourceChapterId}/conclusion`),

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
			anchorCommitSha?: string;
			axisOffset: number;
			crossOffset: number;
			panelExpanded?: boolean;
			panelWidth?: number;
			panelHeight?: number;
		}>,
	) =>
		request<{ ok: boolean }>(`/projects/${projectId}/graph/positions`, {
			method: "PATCH",
			body: JSON.stringify({ positions }),
		}),

	// === ruler (new NarraFlow) ===
	getRulerData: (
		projectId: string,
		opts?: {
			limit?: number;
			skip?: number;
			cursor?: string;
			direction?: "older" | "newer";
		},
	) => {
		const params = new URLSearchParams();
		if (opts?.limit) params.set("limit", String(opts.limit));
		if (opts?.skip) params.set("skip", String(opts.skip));
		if (opts?.cursor) params.append("cursor", opts.cursor);
		if (opts?.direction) params.append("direction", opts.direction);
		const qs = params.toString();
		return request<ApiEntity>(`/projects/${projectId}/ruler${qs ? `?${qs}` : ""}`);
	},
	getRulerSegment: (
		projectId: string,
		fromSha: string,
		toSha?: string,
		detail?: "summary" | "full",
	) => {
		const params = new URLSearchParams({ from: fromSha });
		if (toSha) params.set("to", toSha);
		if (detail) params.set("detail", detail);
		return request<ApiEntity>(`/projects/${projectId}/ruler/segment?${params}`);
	},

	updateRulerPositions: (
		projectId: string,
		positions: Array<{
			chapterId: string;
			anchorCommitSha: string;
			axisOffset: number;
			crossOffset: number;
			width?: number;
			height?: number;
		}>,
	) =>
		request<{ success: boolean }>(`/projects/${projectId}/ruler/positions`, {
			method: "PATCH",
			body: JSON.stringify({ positions }),
		}),
	rulerFork: (
		projectId: string,
		data: {
			startCommitSha: string;
			title?: string;
			inheritMode?: string;
			parentChapterId?: string;
		},
	) =>
		request<ApiEntity>(`/projects/${projectId}/ruler/fork`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	rulerMerge: (
		projectId: string,
		data: { sourceChapterId: string; strategy?: string; message?: string },
	) =>
		request<ApiEntity>(`/projects/${projectId}/ruler/merge`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	rulerAbandon: (projectId: string, chapterId: string) =>
		request<{ success: boolean }>(`/projects/${projectId}/ruler/abandon`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
		}),
	rulerRebase: (projectId: string, chapterId: string) =>
		request<{
			success: boolean;
			commitSha?: string;
			conflictFiles?: Array<{ file: string; conflictLines: number }>;
		}>(`/projects/${projectId}/ruler/rebase`, {
			method: "POST",
			body: JSON.stringify({ chapterId }),
		}),
	rulerRebaseResolve: (
		projectId: string,
		data: { chapterId: string; action: "abort" | "continue" },
	) =>
		request<{ success: boolean; narratorId?: string }>(
			`/projects/${projectId}/ruler/rebase-resolve`,
			{ method: "POST", body: JSON.stringify(data) },
		),

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
				command?: string;
				args?: string[];
				cwd?: string;
				url?: string;
				env?: Record<string, string>;
				headers?: Record<string, string>;
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
				disabled: boolean;
			}>
		>("/skills/global"),
	getGlobalSkill: (name: string) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
			disabled?: boolean;
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
	toggleGlobalSkill: (name: string, enabled: boolean) =>
		request<{
			name: string;
			description: string;
			location: string;
			files: string[];
			disabled: boolean;
		}>(`/skills/global/${encodeURIComponent(name)}/toggle`, {
			method: "POST",
			body: JSON.stringify({ enabled }),
		}),

	// Custom Subagents
	listCustomSubagents: () => request<CustomSubagentData[]>("/custom-subagents"),
	getCustomSubagent: (name: string) =>
		request<CustomSubagentData>(`/custom-subagents/${encodeURIComponent(name)}`),
	createCustomSubagent: (data: CustomSubagentData) =>
		request<CustomSubagentData>("/custom-subagents", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateCustomSubagent: (currentName: string, data: CustomSubagentData) =>
		request<CustomSubagentData>(`/custom-subagents/${encodeURIComponent(currentName)}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
	deleteCustomSubagent: (name: string) =>
		request<{ ok: boolean }>(`/custom-subagents/${encodeURIComponent(name)}`, {
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
	codexStatus: (params?: {
		availablePage?: number;
		unavailablePage?: number;
		pageSize?: number;
	}) => {
		const qs = new URLSearchParams();
		if (params?.availablePage) qs.set("availablePage", String(params.availablePage));
		if (params?.unavailablePage) qs.set("unavailablePage", String(params.unavailablePage));
		if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
		const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
		return request<{
			entries: CodexCredentialEntry[];
			availableEntries: CodexCredentialEntry[];
			unavailableEntries: CodexCredentialEntry[];
			availableTotal: number;
			unavailableTotal: number;
			currentId: string;
			loadBalancingMode: "priority" | "balanced";
			total: number;
			available: number;
			stickySessionCount: number;
			globalProxy?: string;
			defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
			useWebSocket?: boolean;
			lastBrowserAuthError?: string;
			usageCache: Record<string, CodexUsageData>;
			usageQueue?: {
				items: Array<{
					id: string;
					credentialId: string;
					status: "pending" | "processing" | "done" | "failed";
					error?: string;
					addedAt: number;
					startedAt?: number;
					finishedAt?: number;
				}>;
				isRunning: boolean;
			};
		}>(`/codex/status${suffix}`);
	},
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
		request<{ reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | null }>(
			"/codex/default-reasoning-effort",
		),
	codexSetDefaultReasoningEffort: (
		reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | null,
	) =>
		request<{ ok: boolean; reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | null }>(
			"/codex/default-reasoning-effort",
			{
				method: "POST",
				body: JSON.stringify({ reasoningEffort }),
			},
		),
	codexSetUseWebSocket: (useWebSocket: boolean) =>
		request<{ ok: boolean; useWebSocket: boolean }>("/codex/use-websocket", {
			method: "POST",
			body: JSON.stringify({ useWebSocket }),
		}),
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
			skipped: number;
		}>("/codex/import", {
			method: "POST",
			body: JSON.stringify({ credentials }),
		}),
	codexUsageQueueClear: () =>
		request<{ ok: boolean }>("/codex/usage-queue/clear", { method: "POST" }),
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

	// NUG
	nugLogin: (providerId: string, body: { username: string; password: string }) =>
		request<{ apiKey: string }>(`/nug/providers/${providerId}/login`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	nugGetQuota: (providerId: string) =>
		request<{ balance: number; totalGranted: number; username?: string; role?: string }>(
			`/nug/providers/${providerId}/quota`,
		),
	nugGetChannelsHealth: (providerId: string) =>
		request<{
			channels: Array<{
				channelType: string;
				totalCredentials: number;
				availableCredentials: number;
				disabledCredentials: number;
				availabilityRate: number;
				currentConcurrency: number;
				maxConcurrency: number;
				queueDepth: number;
			}>;
		}>(`/nug/providers/${providerId}/channels/health`),
	nugGetUsage: (providerId: string, range: string) =>
		request<{
			events: Array<{
				id: string;
				channelType: string;
				model: string;
				inputTokens: number;
				outputTokens: number;
				cacheCreationInputTokens: number;
				cacheReadInputTokens: number;
				quotaCost: number;
				meterUsage: number;
				status: string;
				durationMs: number;
				createdAt: string;
			}>;
		}>(`/nug/providers/${providerId}/usage?range=${range}`),
	nugGetUsageSummary: (providerId: string, range: string) =>
		request<{
			requestCount: number;
			totalMeterUsage: number;
			totalQuotaCost: number;
			totalInputTokens: number;
			totalOutputTokens: number;
			totalCacheWriteTokens: number;
			totalCacheReadTokens: number;
		}>(`/nug/providers/${providerId}/usage/summary?range=${range}`),
	nugRefreshProviderModels: (providerId: string) =>
		request<{
			models: Array<{ id: string; owned_by?: string }>;
			fromCache: boolean;
		}>(`/nug/providers/${providerId}/models/refresh`, { method: "POST" }),

	// Cline
	clineStatus: () =>
		request<{
			authenticated: boolean;
			email?: string;
			displayName?: string;
			expiresAt?: number;
			providers: Array<{ id: string; name: string; prefix: string; hasToken: boolean }>;
			totalModels: number;
			pendingAuth: boolean;
		}>("/cline/status"),
	clineBrowserAuth: (apiBaseUrl?: string) =>
		request<{ authorizeUrl: string }>("/cline/auth/browser", {
			method: "POST",
			body: JSON.stringify(apiBaseUrl ? { apiBaseUrl } : {}),
		}),
	clineCancelAuth: () => request<{ ok: boolean }>("/cline/auth/cancel", { method: "POST" }),
	clineImportCallback: (callbackUrl: string) =>
		request<{ ok: boolean; email?: string; displayName?: string }>("/cline/auth/callback", {
			method: "POST",
			body: JSON.stringify({ callbackUrl }),
		}),
	clineLogout: () => request<{ ok: boolean }>("/cline/auth/logout", { method: "POST" }),
	clineRefreshModels: () =>
		request<{
			results: Array<{ providerId: string; name: string; count: number; error?: string }>;
			models: Array<{ id: string; name?: string }>;
			fromCache: boolean;
		}>("/cline/models/refresh", { method: "POST" }),
	clineRefreshProviderModels: (providerId: string) =>
		request<{
			models: Array<{ id: string; name?: string }>;
			fromCache: boolean;
		}>(`/cline/providers/${providerId}/models/refresh`, { method: "POST" }),
	clineBalance: () => request<{ balance: number; userId: string }>("/cline/balance"),
	clineRecommendedModels: () =>
		request<{
			recommended: Array<{ id: string; name: string; description?: string; tags: string[] }>;
			free: Array<{ id: string; name: string; description?: string; tags: string[] }>;
		}>("/cline/recommended-models"),
	clineRefreshUserInfo: () =>
		request<{
			authenticated: boolean;
			email?: string;
			displayName?: string;
			userId?: string;
		}>("/cline/user-info/refresh", { method: "POST" }),
	clinePoolSearch: (q: string, limit = 50) =>
		request<{
			models: Array<{
				id: string;
				name?: string;
				contextLength?: number;
				promptPrice?: string;
				completionPrice?: string;
			}>;
			total: number;
		}>(`/cline/pool/search?q=${encodeURIComponent(q)}&limit=${limit}`),
	clinePoolCount: () => request<{ count: number }>("/cline/pool/count"),
	clineSetEnabledModels: (models: string[]) =>
		request<{ ok: boolean; count: number }>("/cline/enabled-models", {
			method: "POST",
			body: JSON.stringify({ models }),
		}),

	// Health / platform
	health: () =>
		request<{
			status: string;
			version: string;
			commit: string;
			platform: "windows" | "macos" | "linux";
			gitAvailable: boolean;
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
	fsBrowse: (path?: string, opts?: { showHidden?: boolean }) => {
		const params = new URLSearchParams();
		if (path) params.set("path", path);
		if (opts?.showHidden) params.set("showHidden", "1");
		const qs = params.toString();
		return request<{
			path: string | null;
			entries: Array<{ name: string; path: string }>;
			drives?: Array<{ name: string; path: string }>;
			parent?: string | null;
			sep: string;
		}>(`/fs/browse${qs ? `?${qs}` : ""}`);
	},

	fsShortcuts: () =>
		request<{
			shortcuts: Array<{ key: string; path: string }>;
			drives?: Array<{ name: string; path: string }>;
			sep: string;
		}>("/fs/shortcuts"),

	fsMkdir: (parent: string, name: string) =>
		request<{ path: string }>("/fs/mkdir", {
			method: "POST",
			body: JSON.stringify({ parent, name }),
		}),

	fsReveal: (path: string) =>
		request<{ ok: true }>("/fs/reveal", {
			method: "POST",
			body: JSON.stringify({ path }),
		}),

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
	getGlobalPrompt: () =>
		request<{
			content: string | null;
			filePath: string | null;
			candidates: Array<{ path: string; exists: boolean }>;
		}>("/routines/global-prompt"),
	updateGlobalPrompt: (data: { content: string; filePath?: string }) =>
		request<{ ok: boolean; filePath: string }>("/routines/global-prompt", {
			method: "PUT",
			body: JSON.stringify(data),
		}),

	// Update
	checkUpdate: () =>
		request<{
			updateAvailable: boolean;
			currentVersion: string;
			latestVersion?: string;
			releaseInfo?: {
				version: string;
				releaseDate: string;
				releaseNotes?: string | Record<string, string>;
				path: string;
				sha512: string;
				files: Array<{ url: string; size: number; sha512: string }>;
				releaseNotesPerVersion?: Array<{
					version: string;
					releaseDate: string;
					releaseNotes?: string | Record<string, string>;
				}>;
			};
			downloadSize?: number;
			totalSize?: number;
			zstdPatchSize?: number;
			strategy?: "zstd";
			patchChain?: Array<{
				fromVersion: string;
				toVersion: string;
				patchSize: number;
				url: string;
				metaUrl: string;
			}>;
		}>("/update/check"),
	getUpdateVersion: () =>
		request<{ version: string; platform: string; arch: string }>("/update/version"),
	getUpdateDirectory: () => request<{ directory: string }>("/update/directory"),
	cleanupUpdates: () => request<{ success: boolean }>("/update/cleanup", { method: "POST" }),
	getUpdateStatus: () =>
		request<{ ready: boolean; updateFile?: string; canAutoRestart: boolean }>("/update/status"),
	applyUpdate: () =>
		request<{ success: boolean; error?: string; newBinaryPath?: string }>("/update/apply", {
			method: "POST",
		}),

	// Overseers
	listOverseers: (params?: { scope?: string; projectId?: string }) => {
		const p = new URLSearchParams();
		if (params?.scope) p.set("scope", params.scope);
		if (params?.projectId) p.set("projectId", params.projectId);
		const qs = p.toString();
		return request<ApiEntity[]>(`/overseers${qs ? `?${qs}` : ""}`);
	},
	createOverseer: (data: { scope: string; projectId?: string; model?: string }) =>
		request<ApiEntity>("/overseers", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateOverseer: (id: string, data: { enabled?: boolean }) =>
		request<ApiEntity>(`/overseers/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	deleteOverseer: (id: string) =>
		request<{ ok: boolean }>(`/overseers/${id}`, { method: "DELETE" }),

	// ── Workspaces ──
	listWorkspaces: () => request<ApiEntity[]>("/workspaces"),
	getWorkspace: (id: string) => request<ApiEntity>(`/workspaces/${id}`),
	createWorkspace: (data: { title?: string; tree: string }) =>
		request<ApiEntity>("/workspaces", { method: "POST", body: JSON.stringify(data) }),
	updateWorkspace: (id: string, data: { title?: string; tree?: string }) =>
		request<ApiEntity>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteWorkspace: (id: string) =>
		request<{ ok: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),

	// Changelog
	getChangelogs: () => request<ChangelogEntry[]>("/changelog"),

	// ── Storage ──
	getCachedStorage: () => request<{ cached: boolean; data?: StorageScanResult }>("/storage/cached"),
	cleanupStorage: (target: "uploads" | "shares" | "worktrees" | "containers") =>
		request<{
			ok: boolean;
			removed?: number;
			freedBytes?: number;
			success?: boolean;
			output?: string;
		}>("/storage/cleanup", { method: "POST", body: JSON.stringify({ target }) }),
	previewDatabaseCleanup: (data: {
		target: DatabaseCleanupTarget;
		olderThanDays?: number;
		sampleLimit?: number;
	}) =>
		request<DatabaseCleanupPreviewResult>("/storage/database/preview", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	cleanupDatabase: (data: { target: DatabaseCleanupTarget; olderThanDays?: number }) =>
		request<DatabaseCleanupExecutionResult>("/storage/database/cleanup", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// ── Runtime Resources ──
	scanRuntime: () => request<RuntimeScanResult>("/runtime/scan"),
	getCachedRuntime: () => request<{ cached: boolean; data?: RuntimeScanResult }>("/runtime/cached"),
	cleanupRuntime: (target: "terminals" | "containers" | "browsers") =>
		request<{
			ok: boolean;
			killed?: number;
			stopped?: number;
			closedSessions?: number;
			browserClosed?: boolean;
		}>("/runtime/cleanup", { method: "POST", body: JSON.stringify({ target }) }),

	// Hooks
	listHooks: (projectId?: string) =>
		request<HookApiRecord[]>(projectId ? `/hooks?projectId=${projectId}` : "/hooks"),
	createHook: (data: Record<string, unknown>) =>
		request<HookApiRecord>("/hooks", { method: "POST", body: JSON.stringify(data) }),
	updateHook: (id: string, data: Record<string, unknown>) =>
		request<HookApiRecord>(`/hooks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
	deleteHook: (id: string) => request<{ ok: boolean }>(`/hooks/${id}`, { method: "DELETE" }),
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

/**
 * Scan storage via SSE stream.
 * Calls onProgress for status updates, onCategory for each scanned category,
 * and resolves with the complete result.
 */
export function scanStorageStream(callbacks: {
	onProgress?: (message: string) => void;
	onCategory?: (data: StorageCategoryResult) => void;
	signal?: AbortSignal;
}): Promise<StorageScanResult> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		fetch(`${BASE}/storage/scan`, { headers, signal: callbacks.signal })
			.then((response) => {
				if (!response.ok) {
					reject(new ApiError("Scan failed", response.status));
					return;
				}
				const reader = response.body?.getReader();
				if (!reader) {
					reject(new ApiError("No response body", 500));
					return;
				}

				const decoder = new TextDecoder();
				let buffer = "";

				const pump = (): void => {
					reader
						.read()
						.then(({ done, value }) => {
							if (done) return;
							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split("\n");
							buffer = lines.pop() ?? "";

							let eventType = "";
							for (const line of lines) {
								if (line.startsWith("event:")) {
									eventType = line.slice(6).trim();
								} else if (line.startsWith("data:")) {
									const jsonStr = line.slice(5).trim();
									if (!jsonStr) continue;
									try {
										const parsed = JSON.parse(jsonStr);
										if (eventType === "progress") {
											callbacks.onProgress?.(parsed.message);
										} else if (eventType === "category") {
											callbacks.onCategory?.(parsed);
										} else if (eventType === "complete") {
											reader.cancel().catch(() => {});
											resolve(parsed as StorageScanResult);
											return;
										} else if (eventType === "error") {
											reader.cancel().catch(() => {});
											reject(new ApiError(parsed.error ?? "Scan failed", 500));
											return;
										}
									} catch {
										// skip malformed JSON
									}
								} else if (line.trim() === "") {
									// Empty line marks end of SSE event — reset for next event
									eventType = "";
								}
							}
							pump();
						})
						.catch(reject);
				};
				pump();
			})
			.catch(reject);
	});
}
