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
	methods: Array<"totp" | "backup_code">;
}

export type LoginResult = LoginSession | MfaChallenge;

export function isMfaChallenge(r: LoginResult): r is MfaChallenge {
	return "mfaRequired" in r && r.mfaRequired === true;
}

/** Current MFA status for the security settings page. */
export interface MfaStatus {
	totpEnabled: boolean;
	backupCodesRemaining: number;
}

export interface TotpSetupResult {
	secret: string;
	uri: string;
	qrDataUrl: string;
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
