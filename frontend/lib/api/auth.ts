import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, BASE, clearToken, getToken, readFetchError, request } from "./client";
import type { ApiEntity } from "./types";

/** Session result returned on a successful (single-factor or post-MFA) login. */
export interface LoginSession {
	user: ApiEntity;
	token: string;
	language: string;
}

/** Returned by /auth/login when the account has a second factor enrolled. */
export interface MfaChallenge {
	mfaRequired: true;
	mfaToken: string;
	methods: Array<"totp" | "backup_code" | "passkey">;
}

export type LoginResult = LoginSession | MfaChallenge;

export function isMfaChallenge(r: LoginResult): r is MfaChallenge {
	return "mfaRequired" in r && r.mfaRequired === true;
}

/** Current MFA status for the security settings page. */
export interface MfaStatus {
	/** Whether a second factor is REQUIRED at login (the explicit opt-in switch). */
	mfaEnabled: boolean;
	totpEnabled: boolean;
	backupCodesRemaining: number;
	passkeyCount: number;
}

export interface TotpSetupResult {
	secret: string;
	uri: string;
	qrDataUrl: string;
}

export interface PasskeySummary {
	id: string;
	name: string | null;
	deviceType: string | null;
	backedUp: boolean;
	lastUsedAt: string | null;
	createdAt: string;
}

/** A configured SSO provider exposed on the login page. */
export interface SsoProvider {
	id: string;
	name: string;
}

/** A user's linked SSO identity. */
export interface SsoIdentity {
	id: string;
	provider: string;
	email: string | null;
	displayName: string | null;
	lastLoginAt: string | null;
	createdAt: string;
}

/** Admin view of one OIDC provider (clientSecret arrives masked). */
export interface AdminOidcProvider {
	id: string;
	name: string;
	issuer: string;
	clientId: string;
	clientSecret?: string;
	scopes?: string[];
	allowSignup?: boolean;
	allowedEmailDomains?: string[];
	enabled?: boolean;
}

export interface AdminWebauthnConfig {
	rpID?: string;
	rpName?: string;
	origins?: string[];
}

export interface AdminAuthConfig {
	oidcProviders: AdminOidcProvider[];
	webauthn: AdminWebauthnConfig | null;
}

/** True when the browser exposes the WebAuthn API (secure context required). */
export function isPasskeySupported(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.PublicKeyCredential !== "undefined" &&
		!!navigator.credentials
	);
}

/**
 * True when a WebAuthn ceremony failed because the user dismissed/aborted the
 * browser prompt (rather than a real error). Callers treat this as a silent
 * no-op instead of surfacing an error. The browser throws a DOMException whose
 * `name` is "NotAllowedError" (cancelled/timed out) or "AbortError" (aborted).
 */
export function isUserCancelledWebAuthn(e: unknown): boolean {
	const name = (e as { name?: string } | null | undefined)?.name;
	return name === "NotAllowedError" || name === "AbortError";
}

export const authApi = {
	authStatus: () => request<{ hasUsers: boolean; registrationOpen: boolean }>("/auth/status"),
	register: (data: { username: string; password: string; language?: string }) =>
		request<LoginSession>("/auth/register", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	login: (data: { username: string; password: string }) =>
		request<LoginResult>("/auth/login", {
			method: "POST",
			body: JSON.stringify(data),
		}),
	me: () => request<ApiEntity>("/auth/me"),

	// MFA — login second step
	mfaVerify: (data: { mfaToken: string; method: "totp" | "backup_code"; code: string }) =>
		request<LoginSession>("/auth/mfa/verify", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// MFA — management (settings → security)
	getSecurityStatus: () => request<MfaStatus>("/auth/me/security"),
	/** Toggle the login-time second-factor requirement. */
	setMfaEnabled: (enabled: boolean) =>
		request<{ ok: boolean; mfaEnabled: boolean }>("/auth/me/mfa", {
			method: "PATCH",
			body: JSON.stringify({ enabled }),
		}),
	totpSetup: () => request<TotpSetupResult>("/auth/me/totp/setup", { method: "POST" }),
	totpActivate: (code: string) =>
		request<{ ok: boolean; backupCodes: string[] }>("/auth/me/totp/activate", {
			method: "POST",
			body: JSON.stringify({ code }),
		}),
	totpDisable: (data: { code?: string; password?: string }) =>
		request<{ ok: boolean }>("/auth/me/totp", {
			method: "DELETE",
			body: JSON.stringify(data),
		}),

	// === Passkey: passwordless login ===

	/** Perform a usernameless passkey login, returning a session on success. */
	passkeyLogin: async (): Promise<LoginSession> => {
		const optionsJSON = await request<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
			"/auth/passkey/login/options",
			{ method: "POST", body: JSON.stringify({}) },
		);
		const response = await startAuthentication({ optionsJSON });
		return request<LoginSession>("/auth/passkey/login/verify", {
			method: "POST",
			body: JSON.stringify({ response }),
		});
	},

	// === Passkey: second factor (after password) ===

	/** Complete the passkey second-factor step using an MFA challenge token. */
	passkeyMfaVerify: async (mfaToken: string): Promise<LoginSession> => {
		const optionsJSON = await request<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
			"/auth/mfa/passkey/options",
			{ method: "POST", body: JSON.stringify({ mfaToken }) },
		);
		const response = await startAuthentication({ optionsJSON });
		return request<LoginSession>("/auth/mfa/passkey/verify", {
			method: "POST",
			body: JSON.stringify({ mfaToken, response }),
		});
	},

	// === Passkey: management (settings → security) ===

	listPasskeys: () => request<{ passkeys: PasskeySummary[] }>("/auth/me/passkeys"),

	/** Register a new passkey on the current device. */
	registerPasskey: async (name?: string): Promise<{ ok: boolean }> => {
		const optionsJSON = await request<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
			"/auth/me/passkeys/register/options",
			{ method: "POST", body: JSON.stringify({}) },
		);
		const response = await startRegistration({ optionsJSON });
		return request<{ ok: boolean }>("/auth/me/passkeys/register/verify", {
			method: "POST",
			body: JSON.stringify({ response, name }),
		});
	},

	renamePasskey: (id: string, name: string) =>
		request<{ ok: boolean }>(`/auth/me/passkeys/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ name }),
		}),

	deletePasskey: (id: string) =>
		request<{ ok: boolean }>(`/auth/me/passkeys/${id}`, { method: "DELETE" }),

	// === SSO / OIDC ===

	/** Public: list enabled SSO providers for the login page. */
	listSsoProviders: () => request<{ providers: SsoProvider[] }>("/auth/sso/providers"),

	/** Server-side path users hit to begin an SSO login (browser navigates here). */
	ssoStartUrl: (providerId: string) => `/api/auth/sso/${encodeURIComponent(providerId)}/start`,

	/** Exchange the one-time SSO code (from the callback redirect) for a session. */
	ssoExchange: (code: string) =>
		request<LoginSession>("/auth/sso/exchange", {
			method: "POST",
			body: JSON.stringify({ code }),
		}),

	/** List the current user's linked SSO identities. */
	listIdentities: () => request<{ identities: SsoIdentity[] }>("/auth/me/identities"),

	/** Begin linking a provider to the current account; returns the authorize URL. */
	ssoLinkStart: (providerId: string) =>
		request<{ authorizeUrl: string }>(`/auth/sso/${encodeURIComponent(providerId)}/link/start`, {
			method: "POST",
		}),

	/** Unlink an SSO identity. */
	unlinkIdentity: (id: string) =>
		request<{ ok: boolean }>(`/auth/me/identities/${id}`, { method: "DELETE" }),

	// === Admin: instance auth configuration (OIDC + WebAuthn) ===

	getAuthConfig: () => request<AdminAuthConfig>("/admin/auth-config"),
	updateAuthConfig: (config: AdminAuthConfig) =>
		request<AdminAuthConfig>("/admin/auth-config", {
			method: "PATCH",
			body: JSON.stringify(config),
		}),

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
			const error = await readFetchError(res, "Unauthorized");
			throw new ApiError(error.message, 401, error.data);
		}
		if (!res.ok) {
			const error = await readFetchError(res, "Upload failed");
			throw new ApiError(error.message, res.status, error.data);
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
};
