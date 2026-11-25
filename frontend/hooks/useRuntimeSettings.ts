import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { getToken, onTokenChange } from "../lib/api/client";

export const RUNTIME_SETTINGS_QUERY_KEY = ["settings-runtime"] as const;
export function runtimeSettingsQueryOptions() {
	const token = getToken();
	return {
		queryKey: [...RUNTIME_SETTINGS_QUERY_KEY, token],
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			if (getToken() !== token) throw new DOMException("Identity changed", "AbortError");
			const result = await api.getRuntimeSettings({ signal });
			if (getToken() !== token) throw new DOMException("Identity changed", "AbortError");
			return result;
		},
		staleTime: 30_000,
		gcTime: 60_000,
	};
}

/** Independent cache: a slim DTO must never replace the complete [settings] object. */
export function useRuntimeSettings(enabled = true) {
	const token = useSyncExternalStore(onTokenChange, getToken, () => null);
	return useQuery({ ...runtimeSettingsQueryOptions(), enabled: enabled && !!token });
}
