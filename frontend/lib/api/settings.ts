import { request } from "./client";
import type { ApiEntity } from "./types";

export const settingsApi = {
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
			manualRestartRequired?: boolean;
			replacementPid?: number;
		}>("/settings/generate-tls", { method: "POST" }),
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
	testModel: (model: string, prompt: string) =>
		request<{ text: string; requestUrls?: { url: string; method: string }[] }>(
			"/settings/test-model",
			{
				method: "POST",
				body: JSON.stringify({ model, prompt }),
			},
		),
	testSearchChannel: (data: { channelId?: string; query: string; purpose?: string }) =>
		request<{ text: string; channelId: string; channelLabel: string; attempts?: unknown[] }>(
			"/settings/search/test",
			{
				method: "POST",
				body: JSON.stringify(data),
			},
		),

	// User Preferences
	getUserPreferences: () =>
		request<{
			autoLoadOlderMessages: boolean;
			fastModeDefault: boolean;
			language: string;
			wordWrapMarkdown: boolean;
			wordWrapCode: boolean;
			wordWrapDiff: boolean;
			replyInUserLanguage: boolean;
			showTokenUsage: boolean;
			showOutputStats: boolean;
			terminalTheme: string;
			terminalFontSize: number;
			addSubagentToRecentTabs: boolean;
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
				type: "chapter" | "narrator" | "project" | "workspace" | "subagent" | "group";
				id: string;
				narratorId?: string;
				parentNarratorId?: string;
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
			enterQueueMode: "turn" | "tool" | "interrupt";
			ctrlEnterQueueMode: "turn" | "tool" | "interrupt";
			setupWizardCompleted: boolean;
		}>("/user-preferences"),
	updateUserPreferences: (data: {
		autoLoadOlderMessages?: boolean;
		fastModeDefault?: boolean;
		language?: string;
		wordWrapMarkdown?: boolean;
		wordWrapCode?: boolean;
		wordWrapDiff?: boolean;
		replyInUserLanguage?: boolean;
		showTokenUsage?: boolean;
		showOutputStats?: boolean;
		terminalTheme?: string;
		terminalFontSize?: number;
		addSubagentToRecentTabs?: boolean;
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
		// Queue behavior bound to the Enter key / send button
		enterQueueMode?: "turn" | "tool" | "interrupt";
		// Queue behavior bound to the Ctrl/Cmd+Enter key
		ctrlEnterQueueMode?: "turn" | "tool" | "interrupt";
		// Setup wizard
		setupWizardCompleted?: boolean;
	}) =>
		request<ApiEntity>("/user-preferences", {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// Recent Tabs
	upsertRecentTab: (tab: {
		type: "chapter" | "narrator" | "project" | "workspace" | "subagent" | "group";
		id: string;
		narratorId?: string;
		parentNarratorId?: string;
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
	removeRecentTab: (
		type: "chapter" | "narrator" | "project" | "workspace" | "subagent" | "group",
		id: string,
	) =>
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
	restoreRecentTabs: (
		tabs: Array<{
			type: "chapter" | "narrator" | "project" | "workspace" | "subagent" | "group";
			id: string;
			narratorId?: string;
			parentNarratorId?: string;
			workspaceId?: string | null;
			title: string;
			subtitle?: string;
			status?: string;
			lastVisitedAt: number;
			pinned?: boolean;
		}>,
	) =>
		request<ApiEntity[]>("/user-preferences/recent-tabs/restore", {
			method: "POST",
			body: JSON.stringify({ tabs }),
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
