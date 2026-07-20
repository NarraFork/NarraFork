import { ApiError, BASE, getToken, readFetchError, request } from "./client";
import type {
	ApiEntity,
	ChangelogEntry,
	CodexCredentialEntry,
	CodexLoadBalancingMode,
	CodexPlanTier,
	CodexUsageData,
	CodexUsageForecast,
	CodexUsageSchedulerSnapshot,
	CodexUsageSummary,
	CustomSubagentData,
	DatabaseCleanupExecutionResult,
	DatabaseCleanupPreviewResult,
	DatabaseCleanupTarget,
	DatabaseVacuumResult,
	HookApiRecord,
	LearningDoc,
	LearningIndexResponse,
	LearningSearchResponse,
	PublicCodexQuotaOverview,
	RuntimeScanResult,
	SearchResponse,
	StorageScanResult,
} from "./types";

export const miscApi = {
	// Dashboard aggregated summary
	getDashboardSummary: () =>
		request<{
			activeProjectCount: number;
			totalProjectCount: number;
			workingNarratorCount: number;
			waitingNarratorCount: number;
			runningTerminalCount: number;
			runningContainerCount: number;
			enabledScheduledTaskCount: number;
			todayCostUsd: number;
			todayTokens: { input: number; output: number; reasoning: number; total: number };
			attention: { permissionCount: number; failedNarratorCount: number };
		}>("/dashboard/summary"),

	// Learning
	getLearningIndex: (lang?: string) =>
		request<LearningIndexResponse>(`/learning${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`),
	getLearningDoc: (id: string, lang?: string) =>
		request<LearningDoc>(
			`/learning/${encodeURIComponent(id)}${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`,
		),
	searchLearningDocs: (q: string, lang?: string) =>
		request<LearningSearchResponse>(
			`/learning/search?q=${encodeURIComponent(q)}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`,
		),

	// Search
	search: (q: string, entities = "chapters,messages") =>
		request<SearchResponse>(`/search?q=${encodeURIComponent(q)}&entities=${entities}`),

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
			const error = await readFetchError(res, "Upload failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return res.json() as Promise<{ id: string; filename: string; mediaType: string }>;
	},
	deleteNotificationSound: (id: string) =>
		request<{ ok: boolean }>(`/notification-sounds/${id}`, { method: "DELETE" }),
	testDingtalkWebhook: (webhook: string, secret?: string) =>
		request<{ ok: boolean; code?: string; reason?: string; error?: string; message?: string }>(
			"/notifications/test-dingtalk",
			{
				method: "POST",
				body: JSON.stringify({ webhook, secret }),
			},
		),
	testFeishuWebhook: (webhook: string, secret?: string) =>
		request<{ ok: boolean; code?: string; reason?: string; error?: string; message?: string }>(
			"/notifications/test-feishu",
			{
				method: "POST",
				body: JSON.stringify({ webhook, secret }),
			},
		),

	// Skills
	listSkills: (projectId: string) =>
		request<
			Array<{
				name: string;
				description: string;
				location: string;
				files: string[];
				disabled?: boolean;
			}>
		>(`/skills?projectId=${encodeURIComponent(projectId)}`),
	getSkill: (projectId: string, name: string) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
			disabled?: boolean;
		}>(`/skills/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`),
	createProjectSkill: (
		projectId: string,
		data: { name: string; description: string; content: string },
	) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
		}>(`/skills?projectId=${encodeURIComponent(projectId)}`, {
			method: "POST",
			body: JSON.stringify(data),
		}),
	updateProjectSkill: (
		projectId: string,
		currentName: string,
		data: { name: string; description: string; content: string },
	) =>
		request<{
			name: string;
			description: string;
			location: string;
			content: string;
			files: string[];
		}>(`/skills/${encodeURIComponent(currentName)}?projectId=${encodeURIComponent(projectId)}`, {
			method: "PUT",
			body: JSON.stringify(data),
		}),
	deleteProjectSkill: (projectId: string, name: string) =>
		request<{ ok: boolean }>(
			`/skills/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
			{ method: "DELETE" },
		),

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

			method: "POST",
			body: JSON.stringify({ proxy }),
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
		request<{
			models: Array<{ id: string; owned_by?: string }>;
			fromCache: boolean;
			resolvedBaseUrl?: string;
			resolvedModelsUrl?: string;
		}>(`/openai/providers/${providerId}/models/refresh`, { method: "POST" }),

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
				envKeys: string[];
				headerKeys: string[];
				enabled: boolean;
				defaultBehavior?: string;
				toolPermissions?: Array<{
					toolName: string;
					behavior: string;
					enabled?: boolean;
				}>;
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
	mcpTestExistingServer: (id: string, data: Record<string, unknown>) =>
		request<{
			ok: boolean;
			tools?: Array<{ name: string; description?: string }>;
			error?: string;
		}>(`/mcp/servers/${id}/test`, {
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
	codexQuotaOverview: () => request<PublicCodexQuotaOverview>("/codex/quota-overview"),
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
			unhealthyTotal: number;
			currentId: string;
			loadBalancingMode: CodexLoadBalancingMode;
			tierOrder: CodexPlanTier[];
			effectiveTierOrder: CodexPlanTier[];
			total: number;
			available: number;
			stickySessionCount: number;
			globalProxy?: string;
			useWebSocket?: boolean;
			useWebSearch?: boolean;
			useImageGeneration?: boolean;
			lastBrowserAuthError?: string;
			usageCache: Record<string, CodexUsageData>;
			usageSummary: CodexUsageSummary;
			usageForecast: CodexUsageForecast;
			usageScheduler: CodexUsageSchedulerSnapshot;
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
	codexCredentialDeleteUnhealthy: () =>
		request<{ removed: string[]; reasons: Array<"too_many_failures" | "banned"> }>(
			"/codex/credentials/unhealthy",
			{ method: "DELETE" },
		),
	codexCredentialUpdate: (id: string, data: { displayName?: string; priority?: number }) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
	codexCredentialRefresh: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/refresh`, { method: "POST" }),
	codexCredentialGetUsage: (id: string) =>
		request<CodexUsageData>(`/codex/credentials/${id}/usage`, { method: "POST" }),
	codexSetLoadBalancingMode: (mode: CodexLoadBalancingMode) =>
		request<{ ok: boolean; mode: CodexLoadBalancingMode }>("/codex/load-balancing-mode", {
			method: "POST",
			body: JSON.stringify({ mode }),
		}),
	codexSetTierOrder: (tierOrder: CodexPlanTier[]) =>
		request<{ ok: boolean; tierOrder: CodexPlanTier[]; effectiveTierOrder: CodexPlanTier[] }>(
			"/codex/tier-order",
			{
				method: "POST",
				body: JSON.stringify({ tierOrder }),
			},
		),
	codexSetGlobalProxy: (proxy?: string) =>
		request<{ ok: boolean }>("/codex/global-proxy", {
			method: "POST",
			body: JSON.stringify({ proxy }),
		}),
	codexGetFingerprint: () =>
		request<{
			userAgentMode: "narrafork" | "claude-code" | "codex" | "custom";
			customUserAgent: string;
			extraHeaders: Record<string, string>;
			emulateCodexHeaders: boolean;
			installationId: string;
		}>("/codex/fingerprint"),
	codexSetFingerprint: (data: {
		userAgentMode?: "narrafork" | "claude-code" | "codex" | "custom";
		customUserAgent?: string;
		extraHeaders?: Record<string, string>;
		emulateCodexHeaders?: boolean;
	}) =>
		request<{
			ok: boolean;
			userAgentMode: "narrafork" | "claude-code" | "codex" | "custom";
			customUserAgent: string;
			extraHeaders: Record<string, string>;
			emulateCodexHeaders: boolean;
		}>("/codex/fingerprint", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	codexRegenerateInstallationId: () =>
		request<{ ok: boolean; installationId: string }>(
			"/codex/fingerprint/regenerate-installation-id",
			{ method: "POST" },
		),
	codexSetUseWebSocket: (useWebSocket: boolean) =>
		request<{ ok: boolean; useWebSocket: boolean }>("/codex/use-websocket", {
			method: "POST",
			body: JSON.stringify({ useWebSocket }),
		}),
	codexSetUseWebSearch: (useWebSearch: boolean) =>
		request<{ ok: boolean; useWebSearch: boolean }>("/codex/use-web-search", {
			method: "POST",
			body: JSON.stringify({ useWebSearch }),
		}),
	codexSetUseImageGeneration: (useImageGeneration: boolean) =>
		request<{ ok: boolean; useImageGeneration: boolean }>("/codex/use-image-generation", {
			method: "POST",
			body: JSON.stringify({ useImageGeneration }),
		}),
	codexImportCredentials: (
		credentials: Array<{
			refreshToken?: string;
			refresh_token?: string;
			accessToken?: string;
			access_token?: string;
			expiresAt?: number | string;
			expires_at?: number | string;
			accountId?: string;
			account_id?: string;
			email?: string;
			user?: { email?: string };
			sub?: string;
			displayName?: string;
			display_name?: string;
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
			resolvedBaseUrl?: string;
		}>(`/anthropic/providers/${providerId}/models/refresh`, { method: "POST" }),

	// NUG
	nugLogin: (providerId: string, body: { username: string; password: string }) =>
		request<{ apiKey: string }>(`/nug/providers/${providerId}/login`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	nugGetQuota: (providerId: string) =>
		request<{
			balance: number;
			totalGranted: number;
			detailedQuotaBalance?: string | null;
			extra?: unknown;
			username?: string;
			role?: string;
		}>(`/nug/providers/${providerId}/quota`),
	nugGetQuotas: () =>
		request<
			Record<
				string,
				{
					balance: number | null;
					totalGranted: number | null;
					detailedQuotaBalance?: string | null;
					extra?: unknown;
				}
			>
		>("/nug/quotas"),
	nugGetBillingConfig: (providerId: string) =>
		request<{
			enabled: boolean;
			providers: Array<{ name: string; displayName: string }>;
			unitName: string;
			quotaRate: number;
			channelQuotaRates?: { alipay?: number; wechat?: number };
			orderMinAmount: number;
			orderMaxAmount: number;
			balance: number;
			totalGranted: number;
			detailedQuotaBalance?: string | null;
			extra?: unknown;
			pollIntervalMs?: number;
		}>(`/nug/providers/${providerId}/billing/config`),
	nugCreateBillingOrder: (
		providerId: string,
		body: { amount: number; provider: string; channel?: "alipay" | "wechat" | string },
	) =>
		request<{
			order: {
				id: string;
				amount: string;
				quota_amount: string;
				provider: string;
				channel?: string;
				status: string;
				pay_url?: string;
				created_at: string;
			};
			pollIntervalMs?: number;
		}>(`/nug/providers/${providerId}/billing/orders`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	nugGetBillingOrder: (providerId: string, orderId: string) =>
		request<{
			order: {
				id: string;
				amount: string;
				quota_amount: string;
				provider: string;
				channel?: string;
				status: string;
				pay_url?: string;
				paid_at?: string;
				created_at: string;
			};
			pollIntervalMs?: number;
		}>(`/nug/providers/${providerId}/billing/orders/${encodeURIComponent(orderId)}`),
	nugRepayBillingOrder: (providerId: string, orderId: string) =>
		request<{
			order: {
				id: string;
				amount: string;
				quota_amount: string;
				provider: string;
				channel?: string;
				status: string;
				pay_url?: string;
				created_at: string;
			};
			pollIntervalMs?: number;
		}>(`/nug/providers/${providerId}/billing/orders/${encodeURIComponent(orderId)}/repay`, {
			method: "POST",
		}),
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
				reasoningTokens?: number;
				quotaCost: number;
				meterUsage: number;
				status: string;
				durationMs: number;
				createdAt: string;
				extra?: Record<string, unknown> | string | null;
				metadata?: Record<string, unknown> | string | null;
				[key: string]: unknown;
			}>;
			total?: number;
		}>(`/nug/providers/${providerId}/usage?range=${encodeURIComponent(range)}`),
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
			models: Array<{
				id: string;
				owned_by?: string;
				contextLength?: number;
				contextWindow?: number;
			}>;
			fromCache: boolean;
			modelHash?: string;
			modelContextWindows?: Record<string, number>;
		}>(`/nug/providers/${providerId}/models/refresh`, { method: "POST" }),
	nugOAuthStart: (providerId: string) =>
		request<{ authorizeUrl: string; state: string }>(`/nug/providers/${providerId}/oauth/start`),

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
			count: number;
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
		request<{ ok: boolean; count: number; modelContextWindows?: Record<string, number> }>(
			"/cline/enabled-models",
			{
				method: "POST",
				body: JSON.stringify({ models }),
			},
		),

	// Gemini (Google Generative Language API) — per-provider model refresh.
	// Gemini is configured via the unified custom-API protocol ("gemini-compatible");
	// this refresh endpoint mirrors the openai/anthropic per-provider refresh.
	geminiRefreshProviderModels: (providerId: string) =>
		request<{
			models: Array<{ id: string; name?: string; contextLength?: number }>;
			count: number;
			fromCache: boolean;
			modelContextWindows?: Record<string, number>;
		}>(`/gemini/providers/${providerId}/models/refresh`, { method: "POST" }),

	// Health / platform
	health: () =>
		request<{
			status: string;
			version: string;
			commit: string;
			platform: "windows" | "macos" | "linux";
			gitAvailable: boolean;
			runtimeEnvironment?: {
				android: boolean;
				proot: boolean;
				termux: boolean;
				containerSupport: boolean;
				containerUnsupportedReason?: string;
			};
			capabilities?: {
				database?: {
					engine?: string;
					mainSchemaOwner?: string;
					ftsRepair?: boolean;
					mode?: string;
					searchMode?: string;
					reason?: string;
				};
				frontend?: {
					staticHosted?: boolean;
					mode?: string;
					directory?: string;
				};
				releasePackaging?: {
					buildInfo?: string;
					frontend?: string;
					changelog?: string;
					singleFileEmbedded?: boolean;
				};
				nativeExtensions?: {
					defaultEnabled?: boolean;
					scope?: string;
					browserSessions?: {
						defaultEnabled?: boolean;
						storage?: string;
						cutover?: string;
						rollback?: string;
						reason?: string;
					};
					containerBrowserToolAutoEnable?: {
						defaultEnabled?: boolean;
						cutover?: string;
						rollback?: string;
						reason?: string;
					};
				};
				chapters?: {
					split?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						mode?: string;
						routes?: { splitAtCommit?: boolean };
						partials?: {
							compressedAISummary?: {
								supported?: boolean;
								fallback?: boolean;
								code?: string;
								reason?: string;
								mode?: string;
							};
							containerAutostart?: {
								supported?: boolean;
								fallback?: boolean;
								code?: string;
								reason?: string;
								mode?: string;
							};
						};
					};
					containers?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						routes?: Partial<
							Record<
								| "setup"
								| "podmanStatus"
								| "podmanInstall"
								| "composeInfo"
								| "list"
								| "start"
								| "stop"
								| "pause"
								| "unpause"
								| "logs"
								| "remove",
								boolean
							>
						>;
						runtime?: {
							podmanCompose?: boolean;
							podmanComposeFallbackCommand?: boolean;
							boundedOutput?: boolean;
							syncStartRequest?: boolean;
							backgroundStart?: boolean;
							backgroundStartReason?: string;
							streamingLogs?: boolean;
							perChapterLock?: boolean;
						};
						ports?: { legacyHostPortAllocation?: boolean; portRelease?: boolean };
						proxy?: {
							metadataSupported?: boolean;
							requiresPastaPasst?: boolean;
							overridePortsReset?: boolean;
							reverseProxyServer?: boolean;
							http?: boolean;
							websocket?: boolean;
							dynamicSettingsHook?: boolean;
						};
						lifecycle?: {
							manualControls?: boolean;
							autoStartOnFork?: boolean;
							pauseOnDormant?: boolean;
							unpauseOnWake?: boolean;
							removeOnDelete?: boolean;
							removeOnMergeCleanup?: boolean;
							deleteVolumes?: boolean;
						};
						narratorIntegration?: {
							statusChangedEvent?: boolean;
							containerReadyMessage?: boolean;
							browserToolAutoEnable?: boolean;
							browserToolAutoEnableReason?: string;
							defaultEnabled?: boolean;
							cutover?: string;
							rollback?: string;
						};
					};
				};

				narrator?: {
					wsEvents?: {
						p0?: {
							supported?: boolean;
							fallback?: boolean;
							code?: string;
							reason?: string;
							events?: string[];
						};
						p1?: {
							supported?: boolean;
							fallback?: boolean;
							code?: string;
							reason?: string;
							mode?: string;
							events?: string[];
						};
					};
					messageHistory?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						catchUp?: boolean;
						messageVersion?: boolean;
						childOrphans?: boolean;
						toolCalls?: boolean;
						compactMarkers?: boolean;
						structuredContent?: boolean;
					};
					delete?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						feature?: string;
					};
					planMode?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						api?: boolean;
						toolReflection?: boolean;
						previousModeRestore?: boolean;
					};
					retryRecovery?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						retry?: boolean;
						continue?: boolean;
						interrupt?: boolean;
						manualOverride?: boolean;
						rollback?: boolean;
						editAndRegenerate?: boolean;
					};
					permissions?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						modes?: string[];
						approveDeny?: boolean;
						updatedInput?: boolean;
						pauseResume?: string;
						reflections?: string[];
					};
					reviewTools?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						concludeReview?: boolean;
						feedbackInjection?: boolean;
						promote?: boolean;
						dismiss?: boolean;
						convertToSubagent?: boolean;
						staleMergeGuard?: boolean;
					};
					subagents?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						foreground?: boolean;
						background?: boolean;
						awaitAgent?: boolean;
						send?: boolean;
						teamStatus?: boolean;
						detachAttach?: boolean;
						detachUnblocksParent?: boolean;
						reattachBlocksParent?: boolean;
						backgroundResultInjection?: boolean;
						staleRecovery?: boolean;
					};
					compact?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						segmentCompact?: boolean;
						contextClear?: boolean;
						mode?: string;
						fallbackSummary?: boolean;
						fallbackReason?: string;
					};
					browserSessions?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						defaultEnabled?: boolean;
						runtime?: string;
						storage?: string;
						cutover?: string;
						rollback?: string;
						narratorBound?: boolean;
						lifecycleEvents?: boolean;
						artifactPersistence?: boolean;
						resourceLimits?: boolean;
						requiresChrome?: boolean;
					};
					containerBrowserToolAutoEnable?: {
						defaultEnabled?: boolean;
						cutover?: string;
						rollback?: string;
						reason?: string;
					};
					rollbackEditRegenerate?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						rollback?: boolean;
						editAndRegenerate?: boolean;
						copyOnWrite?: boolean;
						messageRefTruncation?: boolean;
						fileStateRebuild?: boolean;
						toolCallInvalidation?: boolean;
						agentRerun?: boolean;
						optionalFileRevert?: boolean;
						optionalAgentRerun?: boolean;
						wsEvents?: boolean;
					};
					toolInventory?: {
						supported?: boolean;
						categories?: string[];
						supportedOptionalTools?: string[];
						unsupportedOptionalTools?: string[];
						reason?: string;
						mcpExternalTools?: {
							supported?: boolean;
							fallback?: boolean;
							code?: string;
							reason?: string;
							parity?: string;
							transport?: string;
							lifecycle?: string;
						};
					};
				};
				mcp?: {
					builtinProtocol?: {
						supported?: boolean;
						initialize?: boolean;
						toolsList?: boolean;
						toolsCall?: boolean;
					};
					serverSettingsStorage?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						storage?: string;
					};
					externalServerManagement?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						storage?: string;
						permissions?: boolean;
						import?: boolean;
					};
					builtinTools?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						parity?: string;
						missing?: string[];
					};
					toolsList?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						source?: string;
					};
					toolsCall?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						scope?: string;
					};
					externalToolsInjection?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						parity?: string;
						transport?: string;
						lifecycle?: string;
					};
					externalAgentInjection?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						parity?: string;
						transport?: string;
						lifecycle?: string;
					};
					transports?: {
						stdio?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
						sse?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
						streamableHttp?: {
							supported?: boolean;
							fallback?: boolean;
							code?: string;
							reason?: string;
						};
					};
				};
				benchmark?: {
					containerExecution?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						runtime?: string;
						resourceLimits?: boolean;
						timeout?: boolean;
						outputLimitBytes?: number;
					};
				};
				content?: {
					projectRoutines?: {
						supported?: boolean;
						fallback?: boolean;
						reason?: string;
						storage?: string;
					};
					projectSkills?: {
						supported?: boolean;
						fallback?: boolean;
						reason?: string;
						storage?: string;
					};
				};
				fs?: {
					browse?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					shortcuts?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					mkdir?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					preview?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						maxTextBytes?: number;
						maxBinaryBytes?: number;
					};
					reveal?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
				};
				providers?: Partial<
					Record<
						{
							auth?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
							models?: { supported?: boolean; refreshSupported?: boolean; reason?: string };
							quota?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
							agentMode?: {
								supported?: boolean;
								fallback?: boolean;
								code?: string;
								reason?: string;
							};
							routes?: { [key: string]: boolean | string | undefined };
							agentRuntime?: { [key: string]: boolean | string | undefined };
							pluginBridge?: {
								supported?: boolean;
								fallback?: boolean;
								code?: string;
								reason?: string;
								requiresBun?: boolean;
							};
							mcp?: {
								listToolsRoute?: boolean;
								searchRoute?: boolean;
								agentInjection?: boolean;
							};
							managerParity?: {
								tsCodexManagerEquivalent?: boolean;
								usageQueueParity?: string;
								usageQueueClearSupported?: boolean;
								snapshotPaginationParity?: string;
								reason?: string;
							};
						}
					>
				>;
				terminal?: {
					supported?: boolean;
					reason?: string;
					directPty?: boolean;
					windowsPty?: boolean;
					dtachSupported?: boolean;
					dtachAvailable?: boolean;
					detachedReattach?: boolean;
					orphanRecovery?: boolean;
					scrollbackReplay?: boolean;
					scrollbackReplayMode?: string;
					bufferStateReplay?: boolean;
					bufferStateMode?: string;
					xtermSerializedReplay?: boolean;
					xtermSerializedReplayReason?: string;
					maxSnapshotBytes?: number;
					multiClientResizeMode?: string;
					ws?: {
						subscribe?: boolean;
						create?: boolean;
						input?: boolean;
						resize?: boolean;
						kill?: boolean;
						rename?: boolean;
						scrollback?: boolean;
						bufferState?: boolean;
					};
					processTree?: { supported?: boolean; platform?: string };
				};
				vnet?: {
					supported?: boolean;
					reason?: string;
					mode?: string;
					ws?: boolean;
					peerCleanup?: boolean;
					udpRendezvous?: boolean;
					udpRendezvousReason?: string;
				};
				update?: {
					selfUpdateAvailable?: boolean;
					manualOnly?: boolean;
					canAutoRestart?: boolean;
					download?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						sse?: boolean;
						sha512?: boolean;
						maxBytes?: number;
						trustMode?: string;
					};
					apply?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						handoff?: string;
					};
				};
				settings?: {
					storage?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						path?: string;
					};
					patch?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					validation?: {
						tsZodParity?: boolean;
						mode?: string;
						reason?: string;
					};
					secretMasking?: boolean;
					providerModelAugmentation?: boolean;
					tlsGeneration?: boolean;
					retryRules?: boolean;
				};
				runtime?: {
					backend?: string;
					buildChannel?: string;
					scan?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					cached?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					cleanup?: Partial<
						Record<
							"terminals" | "containers" | "browsers" | "worktrees",
							{ supported?: boolean; reason?: string; mode?: string }
						>
					>;
				};
				gateway?: {
					persistentRuntimes?: boolean;
					mode?: string;
					reason?: string;
					supportedPlatforms?: Array<
						"telegram" | "discord" | "slack" | "feishu" | "webhook" | "weixin" | "qqbot"
					>;
					unsupportedPlatforms?: Partial<
						Record<
							"telegram" | "discord" | "slack" | "feishu" | "webhook" | "weixin" | "qqbot",
							string
						>
					>;
					webhook?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						error?: string;
						message?: string;
					};
					weixinQr?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						error?: string;
						message?: string;
					};
				};
				uploads?: {
					serveNarratorImages?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
					};
					serveAvatars?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
					};
					cleanupPreservesMessageImageRefs?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
					};
				};
				shares?: {
					create?: { supported?: boolean; fallback?: boolean; code?: string; reason?: string };
					publicDownload?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
					};
					preview?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						htmlMode?: string;
					};
					ephemeralOnly?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
					};
				};
				storage?: {
					scan?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						sse?: boolean;
						cache?: boolean;
					};
					cached?: {
						supported?: boolean;
						fallback?: boolean;
						code?: string;
						reason?: string;
						cache?: boolean;
					};
					database?: {
						preview?: boolean;
						cleanup?: boolean;
						cleanupTargets?: Partial<
							Record<
								"archivedSessions" | "staleSessions" | "apiRequestDumps",
								{ supported?: boolean; fallback?: boolean; code?: string; reason?: string }
							>
						>;
					};
					vacuum?: { supported?: boolean; reason?: string };
					cleanup?: Partial<
						Record<
							"uploads" | "shares" | "worktrees" | "containers",
							{
								supported?: boolean;
								fallback?: boolean;
								reason?: string;
								mode?: string;
								alternative?: string;
								preservesMessageImageRefs?: boolean;
							}
						>
					>;
				};
			};
		}>("/health"),

	// Dependencies
	checkDependencies: () =>
		request<{
			platform: "windows" | "macos" | "linux";
			packageManager?: string;
			runtimeEnvironment?: {
				android: boolean;
				proot: boolean;
				termux: boolean;
				containerSupport: boolean;
				containerUnsupportedReason?: string;
			};
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
			code?: string;
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
	getUpdateStatus: (version?: string) => {
		const suffix = version ? `?version=${encodeURIComponent(version)}` : "";
		return request<{
			ready: boolean;
			updateFile?: string;
			canAutoRestart: boolean;
			newBinaryPath?: string;
			updatePath?: string;
			placed?: boolean;
			version?: string;
			phase?: "idle" | "draining" | "restarting";
			scheduled?: boolean;
			targetVersion?: string;
			pendingExecutionCount?: number;
			error?: string;
		}>(`/update/status${suffix}`);
	},
	applyUpdate: (version?: string) =>
		request<{
			success: boolean;
			error?: string;
			newBinaryPath?: string;
			restarting?: boolean;
			scheduled?: boolean;
			phase?: "idle" | "draining" | "restarting";
			targetVersion?: string;
			pendingExecutionCount?: number;
			drainStartedAt?: string;
			replacementPid?: number;
		}>("/update/apply", {
			method: "POST",
			body: version ? JSON.stringify({ version }) : undefined,
		}),

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
			supported?: boolean;
			fallback?: boolean;
			code?: string;
			reason?: string;
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
	vacuumDatabase: () =>
		request<DatabaseVacuumResult>("/storage/database/vacuum", {
			method: "POST",
		}),

	// Runtime Resources
	scanRuntime: () => request<RuntimeScanResult>("/runtime/scan"),
	getCachedRuntime: () => request<{ cached: boolean; data?: RuntimeScanResult }>("/runtime/cached"),
	cleanupRuntime: (target: "terminals" | "containers" | "browsers" | "worktrees") =>
		request<{
			ok: boolean;
			dryRun?: boolean;
			killed?: number;
			stopped?: number;
			closedSessions?: number;
			browserClosed?: boolean;
			removedCounts?: Partial<
				Record<"terminals" | "containers" | "browsers" | "worktrees", number>
			>;
			removed?: Partial<Record<"terminals" | "containers" | "browsers" | "worktrees", string[]>>;
			supported?: Record<string, boolean>;
			fallback?: Record<string, boolean>;
			errorCount?: number;
			errors?: { target: string; id?: string; error: string }[];
		}>("/runtime/cleanup", { method: "POST", body: JSON.stringify({ target, execute: true }) }),

	// Gateway — WeChat QR login
	gatewayWeixinQrStart: () =>
		request<{
			qrcodeUrl: string;
			qrcodeToken: string;
			status?: string;
			supported?: boolean;
			fallback?: boolean;
			reason?: string;
			error?: string;
			message?: string;
			code?: string;
		}>("/gateway/weixin/qr-start", {
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
			reason?: string;
			error?: string;
			code?: string;
			supported?: boolean;
			fallback?: boolean;
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
	listAllHooks: () => request<HookApiRecord[]>("/hooks/all"),
	createHook: (data: Record<string, unknown>) =>
		request<HookApiRecord>("/hooks", { method: "POST", body: JSON.stringify(data) }),
	updateHook: (id: string, data: Record<string, unknown>) =>
		request<HookApiRecord>(`/hooks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
	deleteHook: (id: string) => request<{ ok: boolean }>(`/hooks/${id}`, { method: "DELETE" }),
};
