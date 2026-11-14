import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function deepSeekBalanceOptions(
	client: QueryClient,
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	return queryOptions({
		queryKey: ["deepseek", "balances", providerId, generation],
		queryFn: async ({ signal }) => {
			const balances = await api.deepseekGetBalances({ signal });
			const balance = providerId ? balances[providerId] : undefined;
			// Another admin/browser may have replaced the account since settings loaded.
			// Never display that response under the old identity; reload its projection.
			if (balance?.generation !== generation) {
				void client.invalidateQueries({ queryKey: ["settings"] });
				void client.invalidateQueries({ queryKey: ["admin", "settings"] });
			}
			return balance ?? null;
		},
		select: (balance) => (balance && balance.generation === generation ? balance : undefined),
		enabled: !REMOTE_BUILD && enabled && providerId != null && generation !== undefined,
		staleTime: 30_000,
		refetchInterval: 60_000,
	});
}

export function useDeepSeekBalance(
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	return useQuery(deepSeekBalanceOptions(useQueryClient(), providerId, generation, enabled));
}
