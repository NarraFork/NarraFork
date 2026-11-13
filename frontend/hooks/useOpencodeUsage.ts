import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * OpenCode Go plan allowance for one provider.
 *
 * `generation` is the opaque token the server carries alongside the cache entry. It changes
 * whenever the provider's credential identity is replaced (new key, new base URL, account
 * switch), and a response whose generation no longer matches the one settings handed us
 * belongs to an account the user has since moved off — selecting it away is what keeps a
 * previous account's allowance from being rendered under the current one. A mismatch also
 * reloads the settings projection, since that is where our copy of the token came from.
 */
export function opencodeUsageOptions(
	client: QueryClient,
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	return queryOptions({
		queryKey: ["opencode", "usages", providerId, generation],
		queryFn: async ({ signal }) => {
			const usages = await api.opencodeGetUsages({ signal });
			const usage = providerId ? usages[providerId] : undefined;
			// Another admin/browser may have replaced the account since settings loaded.
			// Never display that response under the old identity; reload its projection.
			if (usage?.generation !== generation) {
				void client.invalidateQueries({ queryKey: ["settings"] });
				void client.invalidateQueries({ queryKey: ["admin", "settings"] });
			}
			return usage ?? null;
		},
		select: (usage) => (usage && usage.generation === generation ? usage : undefined),
		enabled: !REMOTE_BUILD && enabled && providerId != null && generation !== undefined,
		staleTime: 30_000,
		refetchInterval: 60_000,
	});
}

export function useOpencodeUsage(
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	return useQuery(opencodeUsageOptions(useQueryClient(), providerId, generation, enabled));
}
