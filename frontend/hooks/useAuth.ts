import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, api, clearToken, getToken, setToken } from "../lib/api";
import { isMfaChallenge, type LoginResult, type LoginSession } from "../lib/api/auth";
import { changeAppLanguage, getNamespacesForPath } from "../lib/i18n";

/** Establish a session from a login/verify result: store token, seed cache, set language. */
async function applySession(qc: QueryClient, data: LoginSession): Promise<void> {
	setToken(data.token);
	// Seed the user cache immediately so AuthenticatedLayout won't flash.
	qc.setQueryData(["auth", "me"], data.user);
	try {
		await changeAppLanguage(data.language, getNamespacesForPath("/"));
	} catch (error) {
		console.warn("Failed to change app language after login", error);
	}
}

export function useAuthStatus() {
	return useQuery({
		queryKey: ["auth", "status"],
		queryFn: api.authStatus,
		retry: false,
		staleTime: 60_000,
	});
}

export function useCurrentUser() {
	return useQuery({
		queryKey: ["auth", "me"],
		queryFn: api.me,
		enabled: !!getToken(),
		retry: (failureCount, error) => {
			// Don't retry auth failures or missing user, but retry transient server errors.
			// 401 = token invalid/expired; 404 = user deleted (DB wipe) while token still valid.
			const status = (error as ApiError)?.status;
			if (status === 401 || status === 404) return false;
			return failureCount < 3;
		},
		staleTime: 30_000,
	});
}

export function useLogin() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.login,
		onSuccess: async (data: LoginResult) => {
			// When a second factor is required, the login page drives the MFA step;
			// no token is issued yet, so don't touch the session here.
			if (isMfaChallenge(data)) return;
			await applySession(qc, data);
		},
	});
}

/** Step 2 of login: verify the second factor and establish the session. */
export function useMfaVerify() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.mfaVerify,
		onSuccess: async (data: LoginSession) => {
			await applySession(qc, data);
		},
	});
}

export function useRegister() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.register,
		onSuccess: async (data: LoginSession) => {
			await applySession(qc, data);
		},
	});
}

export function useLogout() {
	const qc = useQueryClient();
	return {
		logout: () => {
			clearToken();
			qc.clear();
			window.location.href = "/login";
		},
	};
}

export function useUploadAvatar() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.uploadAvatar,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "me"] });
		},
	});
}

export function useDeleteAvatar() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.deleteAvatar,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "me"] });
		},
	});
}

export function useUpdateProfile() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.updateProfile,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "me"] });
		},
	});
}

// === MFA (security settings) ===

export function useSecurityStatus() {
	return useQuery({
		queryKey: ["auth", "security"],
		queryFn: api.getSecurityStatus,
		enabled: !!getToken(),
		staleTime: 30_000,
	});
}

/** Toggle the login-time second-factor requirement. */
export function useSetMfaEnabled() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (enabled: boolean) => api.setMfaEnabled(enabled),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "security"] });
		},
	});
}

export function useTotpSetup() {
	return useMutation({ mutationFn: api.totpSetup });
}

export function useTotpActivate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.totpActivate,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "security"] });
		},
	});
}

export function useTotpDisable() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.totpDisable,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "security"] });
		},
	});
}

// === Passkeys ===

export function usePasskeys() {
	return useQuery({
		queryKey: ["auth", "passkeys"],
		queryFn: api.listPasskeys,
		enabled: !!getToken(),
		staleTime: 30_000,
	});
}

export function useRegisterPasskey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name?: string) => api.registerPasskey(name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "passkeys"] });
			qc.invalidateQueries({ queryKey: ["auth", "security"] });
		},
	});
}

export function useRenamePasskey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => api.renamePasskey(id, name),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "passkeys"] }),
	});
}

export function useDeletePasskey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.deletePasskey(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["auth", "passkeys"] });
			qc.invalidateQueries({ queryKey: ["auth", "security"] });
		},
	});
}

/** Passwordless passkey login. */
export function usePasskeyLogin() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.passkeyLogin(),
		onSuccess: (data: LoginSession) => applySession(qc, data),
	});
}

/** Passkey second-factor verification (after password). */
export function usePasskeyMfaVerify() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mfaToken: string) => api.passkeyMfaVerify(mfaToken),
		onSuccess: (data: LoginSession) => applySession(qc, data),
	});
}

// === SSO / OIDC ===

/** Public list of enabled SSO providers (for the login page). */
export function useSsoProviders() {
	return useQuery({
		queryKey: ["auth", "sso-providers"],
		queryFn: api.listSsoProviders,
		retry: false,
		staleTime: 5 * 60_000,
	});
}

/** Exchange a one-time SSO code (from the callback redirect) for a session. */
export function useSsoExchange() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (code: string) => api.ssoExchange(code),
		onSuccess: (data: LoginSession) => applySession(qc, data),
	});
}

/** The current user's linked SSO identities. */
export function useIdentities() {
	return useQuery({
		queryKey: ["auth", "identities"],
		queryFn: api.listIdentities,
		enabled: !!getToken(),
		staleTime: 30_000,
	});
}

export function useUnlinkIdentity() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => api.unlinkIdentity(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "identities"] }),
	});
}

// === Admin: instance auth configuration ===

export function useAuthConfig(enabled: boolean) {
	return useQuery({
		queryKey: ["admin", "auth-config"],
		queryFn: api.getAuthConfig,
		enabled: enabled && !!getToken(),
		staleTime: 30_000,
	});
}

export function useUpdateAuthConfig() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.updateAuthConfig,
		onSuccess: (data) => {
			qc.setQueryData(["admin", "auth-config"], data);
			// SSO provider list on the login page may have changed.
			qc.invalidateQueries({ queryKey: ["auth", "sso-providers"] });
		},
	});
}
