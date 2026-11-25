import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { getAuthSnapshot, subscribeAuth } from "../lib/api/client";

export const RUNTIME_SETTINGS_QUERY_KEY = ["settings-runtime"] as const;
export const runtimeSettingsQueryKey = (authGeneration: number) =>
	[...RUNTIME_SETTINGS_QUERY_KEY, authGeneration] as const;

export function runtimeSettingsQueryOptions(authGeneration = getAuthSnapshot().generation) {
	return {
		queryKey: runtimeSettingsQueryKey(authGeneration),
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			if (getAuthSnapshot().generation !== authGeneration)
				throw new DOMException("Identity changed", "AbortError");
			const result = await api.getRuntimeSettings({ signal });
			if (getAuthSnapshot().generation !== authGeneration)
				throw new DOMException("Identity changed", "AbortError");
			return result;
		},
		staleTime: 30_000,
		gcTime: 60_000,
	};
}

/** Independent cache: a slim DTO must never replace the complete [settings] object. */
export function useRuntimeSettings(enabled = true) {
	const { generation, hasToken } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	return useQuery({ ...runtimeSettingsQueryOptions(generation), enabled: enabled && hasToken });
}
