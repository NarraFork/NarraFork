import type { DataDirectorySecurityStatus } from "@shared/data-directory-security";
import type { Locale } from "@shared/i18n-locales";
import type {
	PersistedRecentTab,
	RecentTabsMutationResult,
	RecentTabsPageResult,
	RecentTabsRuntimeResult,
	RecentTabsSection,
} from "@shared/recent-tabs";
import { ApiError, apiBase, authorizedFetch, readFetchError, request } from "./client";
import { parseContentDispositionFileName } from "./narrators";
import type { ApiEntity } from "./types";

export interface RecentTabsPageResponse {
	items: PersistedRecentTab[];
	nextCursor?: string;
	hasMore: boolean;
	revision: number;
}

export type RecentTabsMutationResponse = RecentTabsMutationResult;
export type RecentTabUpsertInput = PersistedRecentTab & {
	updateOnly?: boolean;
	/**
	 * Place the tab relative to an existing one in the SAME revision that creates it.
	 * Mutually exclusive. Only the single-tab endpoint is used with these; the batch
	 * endpoint accepts them too but no caller needs it yet.
	 */
	beforeKey?: string;
	afterKey?: string;
};

export type RecentTabMoveTarget =
	| { beforeKey: string }
	| { afterKey: string }
	| { position: "top" | "above_idle" }
	| { toIndex: number };

export type ModelTestNetworkErrorCategory =
	| "http"
	| "dns"
	| "connection_refused"
	| "connection_reset"
	| "timeout"
	| "tls"
	| "proxy"
	| "aborted"
	| "network";

export interface ModelTestErrorDetails {
	name?: string;
	message: string;
	category?: ModelTestNetworkErrorCategory;
	code?: string;
	errno?: string | number;
	syscall?: string;
	path?: string;
	address?: string;
	port?: string | number;
	hostname?: string;
	status?: number;
	reason?: string;
	/** Response content-type, present when the upstream body was not the expected JSON. */
	contentType?: string;
	/** Final URL the body came from, after redirects. */
	responseUrl?: string;
	/** Redacted, bounded excerpt of a non-JSON response body (often an HTML error page). */
	bodyPreview?: string;
	bodyTruncated?: boolean;
	cause?: ModelTestErrorDetails;
}

export interface ModelTestRequestAttempt {
	sequence: number;
	url: string;
	method: string;
	route?: "direct" | "proxy";
	proxyUrl?: string;
	requestBodyBytes?: number;
	verbose?: boolean;
	durationMs?: number;
	outcome?: "success" | "http_error" | "network_error" | "aborted";
	category?: ModelTestNetworkErrorCategory;
	status?: number;
	statusText?: string;
	/** Present only when a redirect took the request somewhere other than `url`. */
	responseUrl?: string;
	responseHeaders?: Record<string, string>;
	error?: ModelTestErrorDetails;
}

export interface ModelTestDiagnostics {
	id: string;
	model: string;
	resolvedProvider: string;
	resolvedModel: string;
	createdAt: string;
	durationMs: number;
	runtime: {
		name: string;
		version: string;
		platform: string;
		arch: string;
	};
	verbose?: {
		enabled: boolean;
		destination: "server_stdout";
		includesSensitiveHeaders: boolean;
		redaction: "safe_allowlist";
	};
	requests: ModelTestRequestAttempt[];
	error?: ModelTestErrorDetails;
}

export interface ModelTestResponse {
	text: string;
	requestUrls?: { url: string; method: string }[];
	diagnostics?: ModelTestDiagnostics;
}

export const settingsApi = {
	getDataDirectorySecurity: (signal?: AbortSignal) =>
		request<DataDirectorySecurityStatus>("/settings/data-directory-security", { signal }),
	repairDataDirectorySecurity: () =>
		request<DataDirectorySecurityStatus>("/settings/data-directory-security/repair", {
			method: "POST",
			body: JSON.stringify({ confirmed: true }),
		}),
	getSettings: () => request<ApiEntity>("/settings"),
	getContextThresholds: (model: string, provider: string) =>
		request<{ compactStart: number }>(
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
			manualRestartRequired?: boolean;
			replacementPid?: number;
		}>("/settings/generate-tls", { method: "POST" }),
	// TLS CA + SAN management (server/routes/tls.ts)
	getTlsStatus: () =>
		request<{
			caExists: boolean;
			caExpiresAt: string | null;
			certExists: boolean;
			certExpiresAt: string | null;
			legacySelfSigned: boolean;
			certSans: string[];
			customSans: string[];
			autoSans: string[];
		}>("/settings/tls/status"),
	saveTlsSans: (customSans: string[]) =>
		request<{ customSans: string[] }>("/settings/tls/sans", {
			method: "PUT",
			body: JSON.stringify({ customSans }),
		}),
	generateTlsWithCa: (customSans?: string[]) =>
		request<{
			certPath: string;
			keyPath: string;
			expiresAt: string;
			effectiveSans: string[];
			customSans: string[];
			autoSans: string[];
			caCreated: boolean;
			caExpiresAt: string;
			newUrl: string;
			serverRestarting: boolean;
		}>("/settings/tls/generate", {
			method: "POST",
			body: JSON.stringify(customSans !== undefined ? { customSans } : {}),
		}),
	regenerateTlsCa: () =>
		request<{
			expiresAt: string;
			effectiveSans: string[];
			caExpiresAt: string;
			serverRestarting: boolean;
		}>("/settings/tls/regenerate-ca", { method: "POST" }),
	/**
	 * Download the root CA certificate for importing into client devices.
	 * Goes through `authorizedFetch` (session-gated route) and hands the bytes
	 * to the browser as a Blob, matching `fsDownload`.
	 */
	downloadTlsCa: async () => {
		const res = await authorizedFetch(`${apiBase()}/settings/tls/ca.pem`);
		if (!res.ok) {
			const error = await readFetchError(res, "CA download failed");
			throw new ApiError(error.message, res.status, error.data);
		}
		return {
			blob: await res.blob(),
			fileName: parseContentDispositionFileName(res.headers.get("content-disposition")),
		};
	},
	addRetryRule: (data: { domain?: string; statusCode?: number; keyword?: string; note?: string }) =>
		request<{ id: string }>("/settings/retry-rules", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	fixProviderBaseUrl: (providerId: string) =>
		request<{ ok: boolean; providerId: string; baseUrl: string }>(
			"/settings/fix-provider-baseurl",
			{
				method: "POST",
				body: JSON.stringify({ providerId }),
			},
		),
	/**
	 * Turn off the native image_generation tool for the provider behind `model`
	 * (a prefix or a full `prefix:model` reference). The server resolves whether
	 * that is the built-in Codex adapter or a custom API provider.
	 */
	disableCodexImageGeneration: (model: string) =>
		request<{
			ok: boolean;
			target: "builtin-codex" | "custom-api-provider";
			prefix: string;
			providerName: string;
			changed: boolean;
		}>("/settings/disable-codex-image-generation", {
			method: "POST",
			body: JSON.stringify({ model }),
		}),
	testModel: (model: string, prompt: string) =>
		request<ModelTestResponse>("/settings/test-model", {
			method: "POST",
			body: JSON.stringify({ model, prompt }),
		}),
	testSearchChannel: (data: { channelId?: string; query: string; purpose?: string }) =>
		request<{ text: string; channelId: string; channelLabel: string; attempts?: unknown[] }>(
			"/settings/search/test",
			{
				method: "POST",
				body: JSON.stringify(data),
			},
		),
	getSearchProtocols: () =>
		request<
			Array<{
				id: string;
				label: { en: string; "zh-CN": string };
				description: { en: string; "zh-CN": string };
				defaultBaseUrl: string;
			}>
		>("/settings/search/protocols"),

	// User Preferences
	getUserPreferences: () =>
		request<{
			autoLoadOlderMessages: boolean;
			fastModeDefault: boolean;
			language: Locale;
			wordWrapMarkdown: boolean;
			wordWrapCode: boolean;
			wordWrapDiff: boolean;
			replyInUserLanguage: boolean;
			showTokenUsage: boolean;
			showOutputStats: boolean;
			terminalTheme: string;
			terminalFontSize: number;
			/** Narrator transcript typography, as percentages of the built-in defaults. */
			narratorFontScalePercent: number;
			narratorLetterSpacingPercent: number;
			narratorLineHeightScalePercent: number;
			narratorParagraphScalePercent: number;
			addSubagentToRecentTabs: boolean;
			recentTabsGroupMode: "flat" | "directory";
			// Notification preferences
			notifyOnDone: boolean;
			notifyOnWaiting: boolean;
			notifyPwaEnabled: boolean;
			notifySoundEnabled: boolean;
			notifySoundType: "builtin" | "custom";
			notifySoundBuiltin: string;
			notifySoundFileId: string | null;
			notifySoundVolume: number;
			notifySoundMaxConcurrent: number;
			notifyDingtalkEnabled: boolean;
			notifyDingtalkWebhook: string;
			notifyDingtalkSecret: string;
			notifyFeishuEnabled: boolean;
			notifyFeishuWebhook: string;
			notifyFeishuSecret: string;
			/** @deprecated Legacy compatibility window; use getRecentTabsPage() as the data source. */
			recentTabs: PersistedRecentTab[];
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
			enterQueueMode: "turn" | "tool" | "interrupt";
			ctrlEnterQueueMode: "turn" | "tool" | "interrupt";
			setupWizardCompleted: boolean;
			navLayout: {
				items: Array<{ id: string; hidden?: boolean }>;
			};
			narratorToolbarLayout: {
				items: Array<{ id: string }>;
			};
		}>("/user-preferences"),
	updateUserPreferences: (data: {
		autoLoadOlderMessages?: boolean;
		fastModeDefault?: boolean;
		language?: Locale;
		wordWrapMarkdown?: boolean;
		wordWrapCode?: boolean;
		wordWrapDiff?: boolean;
		replyInUserLanguage?: boolean;
		showTokenUsage?: boolean;
		showOutputStats?: boolean;
		terminalTheme?: string;
		terminalFontSize?: number;
		narratorFontScalePercent?: number;
		narratorLetterSpacingPercent?: number;
		narratorLineHeightScalePercent?: number;
		narratorParagraphScalePercent?: number;
		addSubagentToRecentTabs?: boolean;
		recentTabsGroupMode?: "flat" | "directory";
		// Notification preferences
		notifyOnDone?: boolean;
		notifyOnWaiting?: boolean;
		notifyPwaEnabled?: boolean;
		notifySoundEnabled?: boolean;
		notifySoundType?: "builtin" | "custom";
		notifySoundBuiltin?: string;
		notifySoundFileId?: string | null;
		notifySoundVolume?: number;
		notifySoundMaxConcurrent?: number;
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
		// Queue behavior bound to the Enter key / send button
		enterQueueMode?: "turn" | "tool" | "interrupt";
		// Queue behavior bound to the Ctrl/Cmd+Enter key
		ctrlEnterQueueMode?: "turn" | "tool" | "interrupt";
		// Setup wizard
		setupWizardCompleted?: boolean;
		// Sidebar navigation layout (flat ordered ids; a "__divider__" entry marks
		// the boundary — ids after it are tucked into the "More" menu)
		navLayout?: {
			items: Array<{ id: string; hidden?: boolean }>;
		};
		// Narrator header toolbar layout (same flat-ids + "__divider__" shape as
		// navLayout; order is the user's priority, shared by desktop and mobile)
		narratorToolbarLayout?: {
			items: Array<{ id: string }>;
		};
	}) =>
		request<ApiEntity>("/user-preferences", {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// Recent Tabs
	getRecentTabsPage: async (
		section: RecentTabsSection,
		params: { limit?: number; cursor?: string; signal?: AbortSignal } = {},
	): Promise<RecentTabsPageResponse> => {
		const search = new URLSearchParams({ section, limit: String(params.limit ?? 50) });
		if (params.cursor) search.set("cursor", params.cursor);
		const result = await request<RecentTabsPageResult>(
			`/user-preferences/recent-tabs?${search.toString()}`,
			params.signal ? { signal: params.signal } : undefined,
		);
		return {
			items: result.items,
			hasMore: result.hasMore,
			revision: result.revision,
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	},
	getRecentTabsRuntime: (keys: string[]) =>
		request<RecentTabsRuntimeResult>("/user-preferences/recent-tabs/runtime", {
			method: "POST",
			body: JSON.stringify({ keys }),
		}),
	upsertRecentTab: (tab: RecentTabUpsertInput) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs", {
			method: "PUT",
			body: JSON.stringify(tab),
		}),
	upsertRecentTabsBatch: (tabs: RecentTabUpsertInput[]) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs/batch", {
			method: "POST",
			body: JSON.stringify({ tabs }),
		}),
	removeRecentTab: (type: PersistedRecentTab["type"], id: string) =>
		request<RecentTabsMutationResponse>(`/user-preferences/recent-tabs/${type}/${id}`, {
			method: "DELETE",
		}),
	moveRecentTab: (key: string, target: RecentTabMoveTarget, signal?: AbortSignal) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs/move", {
			method: "PATCH",
			body: JSON.stringify({ key, ...target }),
			signal,
		}),
	pinRecentTab: (key: string, pinned: boolean) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs/pin", {
			method: "PATCH",
			body: JSON.stringify({ key, pinned }),
		}),
	/**
	 * Record the member order of ONE directory group. Writes only `dirSortOrder`, so it
	 * cannot be replaced by a sequence of `moveRecentTab` calls: those rewrite the flat
	 * recency order, which the `above_idle` auto-promote then overwrites.
	 */
	setRecentTabDirectoryOrder: (keys: string[], signal?: AbortSignal) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs/dir-order", {
			method: "PATCH",
			body: JSON.stringify({ keys }),
			signal,
		}),
	clearRecentTabs: (scope: "all" | "projects" | "inactive_narrators", keepTabKey?: string) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs/clear", {
			method: "POST",
			body: JSON.stringify({ scope, keepTabKey }),
		}),
	restoreRecentTabs: (input: { tabs?: PersistedRecentTab[]; token?: string }) =>
		request<RecentTabsMutationResponse>("/user-preferences/recent-tabs/restore", {
			method: "POST",
			body: JSON.stringify(input),
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
};
