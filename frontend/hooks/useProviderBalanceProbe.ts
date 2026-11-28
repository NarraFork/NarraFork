import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api } from "../lib/api";
import { quotaSnapshotsKey } from "./useQuotaSnapshots";

/** Rediscovery is an administrator diagnostic, not the ordinary quota refresh. */
export function useProbeProviderBalance(
	providerId: string,
	generation: string | undefined,
	canProbe: boolean,
) {
	const client = useQueryClient();
	const pending = useRef<{
		key: string;
		promise: ReturnType<typeof api.providerProbeBalance>;
	} | null>(null);
	return useMutation({
		mutationFn: async () => {
			if (REMOTE_BUILD || !canProbe || !generation) return null;
			const key = JSON.stringify([providerId, generation]);
			if (pending.current?.key === key) return pending.current.promise;
			const promise = api.providerProbeBalance(providerId);
			pending.current = { key, promise };
			try {
				return await promise;
			} finally {
				if (pending.current?.promise === promise) pending.current = null;
			}
		},
		onSuccess: (snapshot) => {
			if (!snapshot) return;
			if (snapshot.generation !== generation) {
				void client.invalidateQueries({ queryKey: ["settings"] });
				void client.invalidateQueries({ queryKey: ["admin", "settings"] });
			}
			void client.invalidateQueries({ queryKey: quotaSnapshotsKey });
		},
	});
}

export function useProviderBalanceCapability(): boolean {
	const { data } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
	});
	return (
		(data as { providerBalanceCapability?: { enabled?: unknown } } | undefined)
			?.providerBalanceCapability?.enabled !== false
	);
}
