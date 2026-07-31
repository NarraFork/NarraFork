import { request } from "./client";

export const OAUTH_APP_AVAILABLE_SCOPES = [
	"project.read",
	"device.read",
	"device.provision",
	"device.rotate",
	"narrator.read",
	"event.subscribe",
	"narrator.provision",
	"narrator.send_message",
	"narrator.interrupt",
] as const;

export type OAuthAppPermissionMode = "readOnly" | "dontAsk";
export type OAuthAppSystemPromptMode = "managed" | "append";
export type DeviceOperationLevel = "denied" | "readOnly" | "readWrite";

export interface DeviceAccessPolicy {
	host: DeviceOperationLevel;
	global: DeviceOperationLevel;
	selfRegistered: DeviceOperationLevel;
}

export interface OAuthAppPolicy {
	defaultPermissionMode: OAuthAppPermissionMode;
	allowedPermissionModes: OAuthAppPermissionMode[];
	systemPromptMode: OAuthAppSystemPromptMode;
	maxSystemPromptChars: number;
	allowGlobalDevice: boolean;
	allowKnowledgeWrite: boolean;
	deviceAccess: DeviceAccessPolicy;
}

export function createDefaultOAuthAppPolicy(): OAuthAppPolicy {
	return {
		defaultPermissionMode: "readOnly",
		allowedPermissionModes: ["readOnly"],
		systemPromptMode: "managed",
		maxSystemPromptChars: 0,
		allowGlobalDevice: false,
		allowKnowledgeWrite: false,
		// Device access defaults: host is denied (NarraFork server itself, highest-risk),
		// global and selfRegistered are open (a client only governs devices it registered
		// and owns, or global-scoped devices it was bound into a narrator session for).
		deviceAccess: { host: "denied", global: "readWrite", selfRegistered: "readWrite" },
	};
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
	/** Optional stable ID required by some clients; omitted for a generated ID. */
	clientId?: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	/** OAuth apps managed by this UI remain public clients and use PKCE. */
	publicClient?: true;
	policy?: OAuthAppPolicy;
}

/** Portable, secret-free OAuth public client registration format. */
export interface OAuthAppManifest {
	kind: "narrafork.oauth-client";
	version: 1;
	clientId: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	grantTypes: ["authorization_code", "refresh_token"];
	publicClient: true;
	policy: OAuthAppPolicy;
}

export interface OAuthAppImportResult {
	client: OAuthApp;
	created: boolean;
	updated: boolean;
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
	importOAuthApp: (manifest: OAuthAppManifest) =>
		request<OAuthAppImportResult>("/oauth-apps/import", {
			method: "POST",
			body: JSON.stringify(manifest),
		}),
	exportOAuthApp: (id: string) => request<OAuthAppManifest>(`/oauth-apps/${id}/export`),
	deleteOAuthApp: (id: string) =>
		request<{ success: boolean }>(`/oauth-apps/${id}`, { method: "DELETE" }),
};
