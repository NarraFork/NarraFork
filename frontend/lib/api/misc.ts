import type {
	CredentialUsageTotals,
	CredentialUsageTotalsDetail,
} from "@frontend/types/usage-history";
import type { ResolvedBranding } from "@shared/branding";
import type { WorkspacePanel, WorkspacePanelInput } from "@shared/workspace-panels";
import type { PreparedUpdateStatus, UpdateCoordinationPhase } from "../update-state";
import { ApiError, apiBase, authorizedFetch, readFetchError, request } from "./client";
import { parseContentDispositionFileName } from "./narrators";
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
	KimiUsageCache,
	LearningDoc,
	LearningIndexResponse,
	LearningSearchResponse,
	LicenseManifestResponse,
	PublicCodexQuotaOverview,
	RuntimeScanResult,
	SearchResponse,
	StorageScanJobState,
	StorageScanResult,
	TutorialIndexResponse,
	TutorialLessonProgress,
	TutorialLessonResponse,
	TutorialLessonSessionResponse,
	TutorialSandboxStatus,
} from "./types";

/**
 * One workspace with its membership and arrangement.
 *
 * `panels` is authoritative; `layout` only says where those panels sit and is guarded
 * by `layoutRevision`. `tree` is the same string as `layout`, still returned so older
 * readers keep working during the rollout.
 */
export interface WorkspaceDetail extends ApiEntity {
	title?: string;
	layout: string;
	tree: string;
	layoutRevision: number;
	panels: WorkspacePanel[];
}

/** Server code for a layout save that lost a race against another session. */
export const WORKSPACE_LAYOUT_CONFLICT_CODE = "WORKSPACE_LAYOUT_CONFLICT";

/**
 * Whether a failed layout save was a lost race (as opposed to a real error).
 *
 * The current revision rides along so the caller can rebase and retry without an
 * extra read — the retry happens while the user is dragging panels, so a second round
 * trip would be visible as lag.
 */
export function isWorkspaceLayoutConflict(
	error: unknown,
): error is ApiError & { data: { currentRevision: number } } {
	if (!(error instanceof ApiError) || error.status !== 409) return false;
	const data = error.data as { code?: unknown; currentRevision?: unknown } | null;
	return data?.code === WORKSPACE_LAYOUT_CONFLICT_CODE && typeof data.currentRevision === "number";
}

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

	// Interactive tutorial
	//
	// No `lang` parameter: the server resolves the locale from the user's stored
	// preference. The lesson locale also has to be baked into the narrator's model
	// value at start time, so letting the client pass a different one per request
	// would let the page copy and the scripted turns disagree.
	getTutorialIndex: () => request<TutorialIndexResponse>("/tutorial"),
	getTutorialLesson: (lessonId: string) =>
		request<TutorialLessonResponse>(`/tutorial/${encodeURIComponent(lessonId)}`),
	startTutorialLesson: (lessonId: string) =>
		request<TutorialLessonSessionResponse>(`/tutorial/${encodeURIComponent(lessonId)}/start`, {
			method: "POST",
			body: JSON.stringify({}),
		}),
	updateTutorialProgress: (
		lessonId: string,
		body: { completedStepIds: string[]; completed?: boolean },
	) =>
		request<{ ok: boolean; progress: TutorialLessonProgress | null }>(
			`/tutorial/${encodeURIComponent(lessonId)}/progress`,
			{ method: "PATCH", body: JSON.stringify(body) },
		),
	resetTutorialLesson: (lessonId: string) =>
		request<{ ok: boolean }>(`/tutorial/${encodeURIComponent(lessonId)}/reset`, {
			method: "POST",
			body: JSON.stringify({}),
		}),
	getTutorialSandboxStatus: () => request<TutorialSandboxStatus>("/tutorial/sandbox/status"),

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
		const res = await authorizedFetch(`${apiBase()}/notification-sounds`, {
			method: "POST",
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
	// Returns the server's status projection (like connect), not a bare ack:
	// disconnecting now persists `enabled: false`, and the caller needs the
	// authoritative post-change state rather than having to infer it.
	mcpDisconnectServer: (id: string) =>
		request<Record<string, unknown>>(`/mcp/servers/${id}/disconnect`, { method: "POST" }),
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
		archivedPage?: number;
		pageSize?: number;
	}) => {
		const qs = new URLSearchParams();
		if (params?.availablePage) qs.set("availablePage", String(params.availablePage));
		if (params?.unavailablePage) qs.set("unavailablePage", String(params.unavailablePage));
		if (params?.archivedPage) qs.set("archivedPage", String(params.archivedPage));
		if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
		const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
		return request<{
			entries: CodexCredentialEntry[];
			availableEntries: CodexCredentialEntry[];
			unavailableEntries: CodexCredentialEntry[];
			archivedEntries: CodexCredentialEntry[];
			availableTotal: number;
			unavailableTotal: number;
			archivedTotal: number;
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
		request<{ authorizeUrl: string; redirectUri?: string }>("/codex/auth/browser", {
			method: "POST",
		}),
	codexBrowserAuthCancel: () =>
		request<{ ok: boolean }>("/codex/auth/browser/cancel", { method: "POST" }),
	codexBrowserAuthCallback: (callbackUrl: string) =>
		request<{ ok: boolean; accountId?: string; email?: string }>("/codex/auth/browser/callback", {
			method: "POST",
			body: JSON.stringify({ callbackUrl }),
		}),
	codexBrowserAuthState: () =>
		request<{ pending: boolean; redirectUri: string }>("/codex/auth/browser/state"),
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
	codexCredentialArchive: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/archive`, { method: "POST" }),
	codexCredentialUnarchive: (id: string) =>
		request<{ ok: boolean }>(`/codex/credentials/${id}/unarchive`, { method: "POST" }),
	/**
	 * Lifetime token/cost totals for every Codex credential.
	 *
	 * Sourced from `credential_usage_totals`, so unlike the per-request history
	 * these survive narrator deletion and credential archiving.
	 */
	codexCredentialUsageTotals: () =>
		request<{ entries: CredentialUsageTotals[] }>("/codex/credentials/usage-stats"),
	/** Lifetime totals for one Codex credential, broken down by model. */
	codexCredentialUsageTotalsDetail: (id: string) =>
		request<CredentialUsageTotalsDetail>(`/codex/credentials/${id}/usage-stats`),
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
	/** Consume one rate-limit reset credit, immediately resetting the upstream quota window(s). */
	codexCredentialConsumeResetCredit: (id: string) =>
		request<{ code: string; windowsReset: number; resetCreditsAvailable?: number }>(
			`/codex/credentials/${id}/reset-credits/consume`,
			{ method: "POST" },
		),
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
			installationId: string;
		}>("/codex/fingerprint"),
	codexSetFingerprint: (data: {
		userAgentMode?: "narrafork" | "claude-code" | "codex" | "custom";
		customUserAgent?: string;
		extraHeaders?: Record<string, string>;
	}) =>
		request<{
			ok: boolean;
			userAgentMode: "narrafork" | "claude-code" | "codex" | "custom";
			customUserAgent: string;
			extraHeaders: Record<string, string>;
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

	// Kimi (kimi.com / kimi.ai) usage quotas — per-provider server-side cache
	kimiGetUsages: () => request<Record<string, KimiUsageCache>>("/kimi/usages"),
	kimiRefreshUsages: () =>
		request<Record<string, KimiUsageCache>>("/kimi/usages/refresh", { method: "POST" }),
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
				channel?: string;
				channelType: string;
				healthy?: boolean;
				availabilityRate: number;
				totalCredentials?: number;
				availableCredentials?: number;
				disabledCredentials?: number;
				currentConcurrency?: number;
				maxConcurrency?: number;
				queueDepth?: number;
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
	/**
	 * Opportunistic catalog refresh (used when a model picker opens). Rate-limited
	 * server-side by a process-wide cooldown, so calling it on every picker open is
	 * safe. Returns status only — re-read `/settings` for the refreshed catalog.
	 */
	nugRefreshStaleModels: () =>
		request<{
			results: Array<{
				providerId: string;
				attempted: boolean;
				skipped?: "cooldown" | "not-configured";
				retryAfterMs: number;
				modelCount?: number;
				error?: string;
			}>;
			refreshed: boolean;
			cooldownMs: number;
		}>("/nug/models/refresh-if-stale", { method: "POST" }),
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
			// No `capabilities` here: the server has never sent one. A 643-line type describing
			// it used to sit in this spot, feeding the getter layer in `frontend/hooks/usePlatform.ts`
			// that has since collapsed to constants. A type for a field nothing sends reads exactly
			// like a type for one that works, which is what kept the dead layer looking load-bearing.
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
	fsBrowse: (path?: string, opts?: { showHidden?: boolean; includeFiles?: boolean }) => {
		const params = new URLSearchParams();
		if (path) params.set("path", path);
		if (opts?.showHidden) params.set("showHidden", "1");
		// Opt-in: the directory picker needs every entry to be selectable as a
		// directory, so only the file tree asks for files.
		if (opts?.includeFiles) params.set("includeFiles", "1");
		const qs = params.toString();
		return request<{
			path: string | null;
			/**
			 * Directories, including symlinks whose target is a directory (`isSymlink`).
			 * `path` is the link's own path, not its target: the user is choosing the
			 * path they navigated to.
			 *
			 * Files appear only when `includeFiles` was requested, marked
			 * `isDirectory: false`. `isDirectory` is optional here purely for wire
			 * compatibility with an older server; treat a missing value as `true`,
			 * since directory-only was the previous behaviour.
			 *
			 * The server caps what one listing returns (see `MAX_BROWSE_ENTRIES` in
			 * `server/routes/fs.ts`), so a length at that cap means the directory has
			 * more children than this carries.
			 */
			entries: Array<{
				name: string;
				path: string;
				isSymlink?: boolean;
				isDirectory?: boolean;
				size?: number;
			}>;
			/**
			 * Some child of the directory is NOT in `entries` — the server hit a
			 * scan/entry/probe cap (or the directory became unreadable mid-listing).
			 * `entries.length` is then a floor, not the directory's size. Optional for
			 * wire compatibility with an older server; treat a missing value as
			 * `false`, since untruncated was the previous behaviour.
			 */
			truncated?: boolean;
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
	/**
	 * Fetch a file for saving to disk.
	 *
	 * Not a plain link: `/api/fs/download` is behind the session gate, so the bytes
	 * have to come through `authorizedFetch` and be handed to the browser as a Blob.
	 * The server's `Content-Disposition` name is preferred over deriving one from
	 * the path, since it has already been sanitized for use as a filename.
	 */
	/**
	 * Save a human edit.
	 *
	 * `baseHash` is the sha256 of the content the editor loaded — the optimistic lock.
	 * Omit it only when creating a file that must not already exist; the server answers
	 * 409 in both stale cases and includes the live content so the caller can show a
	 * diff rather than only reporting failure.
	 *
	 * `narratorId` is not decoration: it is what defines the writable root, so a save
	 * without one is refused.
	 */
	fsWrite: (input: {
		path: string;
		content: string;
		narratorId: string;
		baseHash?: string | null;
		/**
		 * The encoding `fsEditSource` reported, echoed back verbatim.
		 *
		 * Omitting it means UTF-8, which silently CONVERTS a legacy-charset file on
		 * save. Always pass through what the load returned.
		 */
		encoding?: string;
		/**
		 * Acknowledge a target outside the narrator's workspace and every declared
		 * writable directory.
		 *
		 * Only meaningful after the server refused once with 409 `NEEDS_CONFIRMATION`
		 * and named the resolved physical path — sending it upfront would be consent to
		 * a destination nobody has seen. Never overrides a credential-path, git-directory
		 * or symlink-escape refusal.
		 */
		confirmOutsideRoots?: boolean;
		/**
		 * Tell the narrator that a person edited this file.
		 *
		 * Without it the agent's next turn reads a file it believes it last wrote, and
		 * the watcher classifies the save as an anonymous `external` change.
		 */
		notifyAgent?: boolean;
	}) =>
		request<{
			ok: true;
			path: string;
			hash: string;
			bytesWritten: number;
			encoding: string;
			/** How the notification reached the narrator, when `notifyAgent` was set. */
			notified?: "interjected" | "queued";
		}>("/fs/write", {
			method: "POST",
			body: JSON.stringify(input),
		}),

	/**
	 * Load a file FOR EDITING — not the same thing as previewing it.
	 *
	 * `/fs/preview` decodes as UTF-8 unconditionally, which is fine for a viewer (the
	 * reader sees the mojibake) and destructive for an editor: saving would write those
	 * replacement characters back over every un-decodable byte in the file. This route
	 * sniffs the encoding, returns its name for the save to echo, and refuses files
	 * that cannot be edited as text at all.
	 *
	 * Throws `ApiError` with `status` 415 (`code: "BINARY"`) or 413
	 * (`code: "TOO_LARGE_TO_EDIT"`) for those refusals, so the caller can explain why
	 * editing is unavailable rather than offering a save that corrupts the file.
	 *
	 * `hash` is computed server-side deliberately: it makes the optimistic lock
	 * independent of WebCrypto, which is absent over plain HTTP on a non-localhost
	 * origin — precisely where a client-side hash would silently become `null` and read
	 * as "create this file".
	 */
	fsEditSource: (path: string) =>
		request<{ content: string; encoding: string; hash: string; size: number }>(
			`/fs/edit-source?path=${encodeURIComponent(path)}`,
		),
	fsDownload: async (path: string) => {
		const res = await authorizedFetch(`${apiBase()}/fs/download?path=${encodeURIComponent(path)}`);
		if (!res.ok) {
			const error = await readFetchError(res, "Download failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return {
			blob: await res.blob(),
			fileName: parseContentDispositionFileName(res.headers.get("content-disposition")),
		};
	},

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
			/**
			 * `content` is a byte-capped prefix, not the whole file. Saving it would write
			 * the prefix over the original and destroy everything past the cut, so the
			 * editor must refuse to save while this is true.
			 */
			truncated?: boolean;
			/** Real size on disk, for telling the reader what they are not seeing. */
			totalBytes?: number;
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
		return request<PreparedUpdateStatus>(`/update/status${suffix}`);
	},
	cancelUpdate: () =>
		request<{
			success: boolean;
			cancelled: boolean;
			phase?: UpdateCoordinationPhase;
			scheduled?: boolean;
			cancelRequested?: boolean;
			error?: string;
			errorKind?: "failed" | "cancelled";
		}>("/update/cancel", { method: "POST" }),
	/**
	 * Stop the server so the user can launch the downloaded version themselves.
	 *
	 * The server answers before it tears down, so a resolved promise means "shutdown scheduled",
	 * not "shutdown finished". Expect requests issued after this to fail.
	 */
	shutdownForUpdate: () =>
		request<{
			success: boolean;
			error?: string;
			code?: "SHUTDOWN_UNAVAILABLE" | "REPLACEMENT_ALREADY_STARTING";
			cancelledSchedule: boolean;
			newBinaryPath?: string;
		}>("/update/shutdown", { method: "POST" }),
	applyUpdate: (version?: string) =>
		request<{
			success: boolean;
			error?: string;
			code?: string;
			newBinaryPath?: string;
			restarting?: boolean;
			scheduled?: boolean;
			phase?: UpdateCoordinationPhase;
			targetVersion?: string;
			pendingExecutionCount?: number;
			pendingBackgroundBashCount?: number;
			pendingOrdinaryExecutionCount?: number;
			resumableExecutionCount?: number;
			pausedToolCount?: number;
			drainStartedAt?: string;
			replacementPid?: number;
		}>("/update/apply", {
			method: "POST",
			body: version ? JSON.stringify({ version }) : undefined,
		}),

	// Workspaces
	//
	// Membership (`panels`) and arrangement (`layout`) are separate concerns here:
	// panels are rows the server owns, the layout is a positioning blob. A client must
	// never derive "which panels exist" from the layout — that equivalence is what
	// allowed a narrator to be listed in the sidebar while no panel rendered.
	listWorkspaces: () => request<ApiEntity[]>("/workspaces"),
	getWorkspace: (id: string) => request<WorkspaceDetail>(`/workspaces/${id}`),
	createWorkspace: (data: { title?: string; tree: string }) =>
		request<ApiEntity>("/workspaces", { method: "POST", body: JSON.stringify(data) }),
	/** Rename only. The layout goes through `saveWorkspaceLayout` (revision-guarded). */
	updateWorkspace: (id: string, data: { title: string }) =>
		request<ApiEntity>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
	deleteWorkspace: (id: string) =>
		request<{ ok: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),

	listWorkspacePanels: (id: string) =>
		request<{ panels: WorkspacePanel[] }>(`/workspaces/${id}/panels`),
	/** Add a panel. Idempotent for narrators: an existing member is returned as-is. */
	addWorkspacePanel: (id: string, input: WorkspacePanelInput) =>
		request<{ panel: WorkspacePanel }>(`/workspaces/${id}/panels`, {
			method: "POST",
			body: JSON.stringify(input),
		}),
	updateWorkspacePanelConfig: (id: string, panelId: string, config: unknown) =>
		request<{ panel: WorkspacePanel }>(`/workspaces/${id}/panels/${panelId}`, {
			method: "PATCH",
			body: JSON.stringify({ config }),
		}),
	removeWorkspacePanel: (id: string, panelId: string) =>
		request<{ ok: boolean }>(`/workspaces/${id}/panels/${panelId}`, { method: "DELETE" }),
	/**
	 * Save the arrangement under optimistic concurrency.
	 *
	 * Rejects with a 409 carrying `currentRevision` when another session saved first;
	 * see `isWorkspaceLayoutConflict`. Losing this write costs positions only.
	 */
	saveWorkspaceLayout: (id: string, layout: string, expectedRevision: number) =>
		request<{ layoutRevision: number }>(`/workspaces/${id}/layout`, {
			method: "PUT",
			body: JSON.stringify({ layout, expectedRevision }),
		}),

	// Changelog
	getChangelogs: () => request<ChangelogEntry[]>("/changelog"),

	// Per-instance branding. Public like /changelog: the login page and the browser
	// tab both need the instance name before a session exists.
	getBranding: () => request<ResolvedBranding>("/branding"),

	// Third-party licenses. Summaries and texts are separate calls: the full text
	// set is ~1.1 MB and the page shows one entry at a time.
	getLicenses: () => request<LicenseManifestResponse>("/licenses"),
	getLicenseText: (id: string) => request<{ id: string; text: string }>(`/licenses/text/${id}`),

	// Storage
	getCachedStorage: () => request<{ cached: boolean; data?: StorageScanResult }>("/storage/cached"),
	startStorageScan: () =>
		request<{ started: boolean; state: StorageScanJobState }>("/storage/scan/start", {
			method: "POST",
		}),
	getStorageScanStatus: (signal?: AbortSignal) =>
		request<{ state: StorageScanJobState }>("/storage/scan/status", { signal }),
	cancelStorageScan: () =>
		request<{ state: StorageScanJobState }>("/storage/scan/cancel", { method: "POST" }),
	cleanupStorage: (target: "uploads" | "chatAttachments" | "shares" | "worktrees" | "containers") =>
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
