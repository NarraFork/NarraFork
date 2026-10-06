import { request } from "./client";

export type IntegrationAttentionSeverity = "info" | "warning" | "critical";

export interface IntegrationAttentionItem {
	id: string;
	severity: IntegrationAttentionSeverity;
	count: number;
	target:
		| "/settings/connected-apps"
		| "/settings/devices"
		| "/settings/oauth-apps"
		| "/settings/plugins";
}

export interface IntegrationPluginSummary {
	featureEnabled: boolean;
	total: number;
	enabled: number;
	active: number;
	degraded: number;
	attention: number;
}

export interface IntegrationOAuthClientSummary {
	total: number;
	active: number;
	revoked: number;
}

export interface IntegrationDeviceSummary {
	total: number;
	online: number;
	offline: number;
	oauthOwned: number;
	orphaned: number;
}

export interface IntegrationExternalResourceSummary {
	active: number;
	orphaned: number;
	revoked: number;
	devices: number;
	narrators: number;
}

export interface IntegrationSummary {
	generatedAt: string;
	viewer: {
		role: "admin" | "user";
	};
	connectedApps: {
		active: number;
		revoked: number;
	};
	capabilityCatalog: {
		oauth: number;
		plugin: number;
		shared: number;
	};
	attention: IntegrationAttentionItem[];
	admin: {
		plugins: IntegrationPluginSummary;
		oauthClients: IntegrationOAuthClientSummary;
		devices: IntegrationDeviceSummary;
		externalResources: IntegrationExternalResourceSummary;
	} | null;
}

export const integrationsApi = {
	getIntegrationSummary: (signal?: AbortSignal) =>
		request<IntegrationSummary>("/integrations/summary", { signal }),
};
