import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { ProviderBalanceSnapshot } from "@shared/provider-balance";
import {
	type QueryClient,
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../lib/api";

export const providerBalanceKey = (providerId: string | null, generation: string | undefined) =>
	["provider-balances", providerId, generation] as const;

function invalidateSettings(client: QueryClient) {
	void client.invalidateQueries({ queryKey: ["settings"] });
	void client.invalidateQueries({ queryKey: ["admin", "settings"] });
}

export function providerBalancePollInterval(snapshot: ProviderBalanceSnapshot | null | undefined) {
	if (!snapshot || snapshot.status === "pending" || snapshot.status === "probing") return 2_000;
	return snapshot.status === "supported" ? 60_000 : false;
}

export function providerBalanceOptions(
	client: QueryClient,
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	return queryOptions({
		queryKey: providerBalanceKey(providerId, generation),
		queryFn: async ({ signal }) => {
			const snapshots = await api.providerGetBalances({
				signal,
				providerId: providerId ?? undefined,
			});
			const snapshot = providerId ? snapshots[providerId] : undefined;
			if (snapshot?.generation !== generation) invalidateSettings(client);
			return snapshot ?? null;
		},
		select: (snapshot) =>
			providerId && generation && snapshot?.generation === generation ? snapshot : undefined,
		enabled: !REMOTE_BUILD && enabled && providerId != null && generation !== undefined,
		staleTime: (query) =>
			query.state.data?.status === "unsupported" || query.state.data?.status === "error"
				? Number.POSITIVE_INFINITY
				: 30_000,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: false,
		refetchInterval: (query) => {
			if (!enabled || !providerId || !generation) return false;
			if (query.state.data && query.state.data.generation !== generation) return false;
			const interval = providerBalancePollInterval(query.state.data);
			// Transport failure is not the server's terminal discovery error. Recover
			// conservatively after an offline GET without retrying terminal snapshots.
			return query.state.status === "error" && interval !== false ? 60_000 : interval;
		},
	});
}

export function useProviderBalance(
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	return useQuery(providerBalanceOptions(useQueryClient(), providerId, generation, enabled));
}

export function providerBalanceProbeOptions(
	client: QueryClient,
	providerId: string,
	generation: string | undefined,
	canProbe: boolean,
) {
	// Share the promise even before React renders isPending, including cancellation.
	let inFlight: Promise<{
		snapshot: ProviderBalanceSnapshot;
		providerId: string;
		generation: string;
	}> | null = null;
	return {
		mutationFn: async () => {
			if (REMOTE_BUILD || !canProbe || !generation) return null;
			if (inFlight) return inFlight;
			inFlight = client
				.cancelQueries({ queryKey: providerBalanceKey(providerId, generation), exact: true })
				.then(() => api.providerProbeBalance(providerId))
				.then((snapshot) => ({ snapshot, providerId, generation }));
			try {
				return await inFlight;
			} finally {
				inFlight = null;
			}
		},
		onSuccess: async (
			result: { snapshot: ProviderBalanceSnapshot; providerId: string; generation: string } | null,
		) => {
			if (!result) return;
			if (result.snapshot.generation !== result.generation) {
				invalidateSettings(client);
				return;
			}
			// A poll/remount may have started another GET while POST was pending.
			await client.cancelQueries({
				queryKey: providerBalanceKey(result.providerId, result.generation),
				exact: true,
			});
			client.setQueryData(
				providerBalanceKey(result.providerId, result.generation),
				result.snapshot,
			);
		},
	};
}

export function useProbeProviderBalance(
	providerId: string,
	generation: string | undefined,
	canProbe: boolean,
) {
	const client = useQueryClient();
	const options = useMemo(
		() => providerBalanceProbeOptions(client, providerId, generation, canProbe),
		[client, providerId, generation, canProbe],
	);
	return useMutation(options);
}
