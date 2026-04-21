import { ApiError, BASE, getToken, request } from "./client";
import type {
	ApiEntity,
	ChangelogEntry,
	CodexCredentialEntry,
	CodexUsageData,
	CustomSubagentData,
	DatabaseCleanupExecutionResult,
	DatabaseCleanupPreviewResult,
	DatabaseCleanupTarget,
	HookApiRecord,
	RuntimeScanResult,
	StorageScanResult,
} from "./types";

export const miscApi = {
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
		request<{
			ok: boolean;
			reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | null;
		}>("/codex/default-reasoning-effort", {
			method: "POST",
			body: JSON.stringify({ reasoningEffort }),
		}),
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
			results: Array<{
				providerId: string;
				name: string;
				count: number;
				error?: string;
			}>;
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
			recommended: Array<{
				id: string;
				name: string;
				description?: string;
				tags: string[];
			}>;
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

	// Workspaces
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

	// Storage
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

	// Runtime Resources
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

	// Gateway — WeChat QR login
	gatewayWeixinQrStart: () =>
		request<{ qrcodeUrl: string; qrcodeToken: string }>("/gateway/weixin/qr-start", {
			method: "POST",
		}),
	gatewayWeixinQrPoll: () =>
		request<{
			status: "wait" | "scaned" | "expired" | "confirmed" | "error";
			canRefresh?: boolean;
			accountId?: string;
			token?: string;
			baseUrl?: string;
			userId?: string;
			message?: string;
			qrcodeUrl?: string;
			qrcodeToken?: string;
		}>("/gateway/weixin/qr-poll"),
	gatewayReload: (platforms?: string[]) =>
		request<{ ok: boolean; reloaded: string[]; status: { started: boolean; platforms: string[] } }>(
			"/gateway/reload",
			{ method: "POST", body: JSON.stringify({ platforms }) },
		),

	// Hooks
	listHooks: (projectId?: string) =>
		request<HookApiRecord[]>(projectId ? `/hooks?projectId=${projectId}` : "/hooks"),
	createHook: (data: Record<string, unknown>) =>
		request<HookApiRecord>("/hooks", { method: "POST", body: JSON.stringify(data) }),
	updateHook: (id: string, data: Record<string, unknown>) =>
		request<HookApiRecord>(`/hooks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
	deleteHook: (id: string) => request<{ ok: boolean }>(`/hooks/${id}`, { method: "DELETE" }),
};
