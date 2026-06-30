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
