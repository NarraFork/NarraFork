import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, clearToken, getToken, setToken } from "../lib/api";

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
		retry: false,
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
