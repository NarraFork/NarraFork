import { request } from "./client";

export const OAUTH_APP_LEGACY_SCOPES = ["device:manage", "narrator:use"] as const;

export const OAUTH_APP_RECOMMENDED_SCOPES = [
	"project:read",
	"device:read",
	"device:provision",
	"device:rotate",
	"narrator:read",
	"narrator:subscribe",
	"narrator:provision",
	"narrator:message",
	"narrator:interrupt",
] as const;

export const OAUTH_APP_AVAILABLE_SCOPES = [
	...OAUTH_APP_RECOMMENDED_SCOPES,
	...OAUTH_APP_LEGACY_SCOPES,
] as const;

export type OAuthAppPermissionMode = "readOnly" | "dontAsk";
export type OAuthAppSystemPromptMode = "managed" | "append";

export interface OAuthAppPolicy {
	defaultPermissionMode: OAuthAppPermissionMode;
	allowedPermissionModes: OAuthAppPermissionMode[];
	systemPromptMode: OAuthAppSystemPromptMode;
	maxSystemPromptChars: number;
	allowGlobalDevice: boolean;
	allowKnowledgeWrite: boolean;
}

export interface OAuthApp {
	id: string;
	clientId: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	grantTypes: string[];
	publicClient: boolean;
	policy: OAuthAppPolicy;
	lastUsedAt: string | null;
	revokedAt: string | null;
	revokedByUserId: string | null;
	revokedReason: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateOAuthAppInput {
	/** Stable ID such as `robot-assistant`; omitted for a generated ID. */
	clientId?: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	/** OAuth apps managed by this UI remain public clients and use PKCE. */
	publicClient?: true;
	policy?: OAuthAppPolicy;
}

export interface UpdateOAuthAppInput {
	name?: string;
	redirectUris?: string[];
	scopes?: string[];
	policy?: Partial<OAuthAppPolicy>;
}

export const oauthAppsApi = {
	listOAuthApps: () => request<OAuthApp[]>("/oauth-apps"),
	createOAuthApp: (input: CreateOAuthAppInput) =>
		request<OAuthApp>("/oauth-apps", { method: "POST", body: JSON.stringify(input) }),
	updateOAuthApp: (id: string, input: UpdateOAuthAppInput) =>
		request<OAuthApp>(`/oauth-apps/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
	deleteOAuthApp: (id: string) =>
		request<{ success: boolean }>(`/oauth-apps/${id}`, { method: "DELETE" }),
};
