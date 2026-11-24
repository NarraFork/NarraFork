import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { type ApiError, getToken } from "../lib/api/client";
import { clearCurrentUserCache, readCurrentUserCache } from "../lib/current-user-cache";

/** Read-only identity query: no login flows or language initialization dependencies. */
export function useCurrentUser() {
	const token = getToken();
	return useQuery({
		queryKey: ["auth", "me"],
		queryFn: async ({ signal }) => {
			try {
				return await api.me({ signal });
			} catch (error) {
				if ((error as ApiError)?.status === 401) clearCurrentUserCache();
				throw error;
			}
		},
		enabled: !!token,
		initialData: () => (token ? readCurrentUserCache() : undefined),
		initialDataUpdatedAt: 0,
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
