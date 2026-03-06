import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, api, clearToken, getToken, setToken } from "../lib/api";
import i18n from "../lib/i18n";

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
		onSuccess: (data) => {
			setToken(data.token);
			// Seed the user cache immediately so AuthenticatedLayout won't flash
			qc.setQueryData(["auth", "me"], data.user);
			i18n.changeLanguage(data.language);
		},
	});
}

export function useRegister() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.register,
		onSuccess: (data) => {
			setToken(data.token);
			qc.setQueryData(["auth", "me"], data.user);
			i18n.changeLanguage(data.language);
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
