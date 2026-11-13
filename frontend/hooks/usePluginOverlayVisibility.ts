/**
 * Per-user visibility of plugin `overlay` views.
 *
 * Overlays are shown by default once an admin installs the plugin. Each person can hide
 * one plugin's overlays for themselves; the choice is stored on the account
 * (`user_preferences.hidden_plugin_overlays`) so it survives reloads and follows them
 * across devices, and it never affects anyone else.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { api } from "../lib/api";

type Preferences = Awaited<ReturnType<typeof api.getUserPreferences>>;

const QUERY_KEY = ["user-preferences"] as const;
const EMPTY: ReadonlySet<string> = new Set();

export function usePluginOverlayVisibility(options: { enabled?: boolean } = {}) {
	const enabled = options.enabled ?? true;
	const queryClient = useQueryClient();
	// Same key and fetcher as `useUserPreferences`, so this shares that cache entry. The
	// `enabled` gate lets the always-mounted overlay host skip the request while no
	// overlay exists (including before sign-in).
	const query = useQuery({
		queryKey: QUERY_KEY,
		queryFn: api.getUserPreferences,
		staleTime: 60_000,
		enabled,
	});

	const hiddenIds = query.data?.hiddenPluginOverlays;
	const hidden = useMemo<ReadonlySet<string>>(
		() => (Array.isArray(hiddenIds) ? new Set(hiddenIds) : EMPTY),
		[hiddenIds],
	);

	const mutation = useMutation({
		mutationFn: ({ pluginId, hidden: nextHidden }: { pluginId: string; hidden: boolean }) =>
			api.setPluginOverlayHidden(pluginId, nextHidden),
		onMutate: async ({ pluginId, hidden: nextHidden }) => {
			await queryClient.cancelQueries({ queryKey: QUERY_KEY });
			const previous = queryClient.getQueryData<Preferences>(QUERY_KEY);
			// Optimistic: hiding must take effect on click, not after a round trip, or a
			// covering overlay keeps blocking the app while the request is in flight.
			if (previous) {
				const current = previous.hiddenPluginOverlays ?? [];
				const others = current.filter((id) => id !== pluginId);
				queryClient.setQueryData<Preferences>(QUERY_KEY, {
					...previous,
					hiddenPluginOverlays: nextHidden ? [pluginId, ...others] : others,
				});
			}
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) queryClient.setQueryData(QUERY_KEY, context.previous);
		},
		onSuccess: (result) => {
			const latest = queryClient.getQueryData<Preferences>(QUERY_KEY);
			if (latest) {
				queryClient.setQueryData<Preferences>(QUERY_KEY, {
					...latest,
					hiddenPluginOverlays: result.hiddenPluginOverlays,
				});
			}
		},
	});

	const { mutate } = mutation;
	const setHidden = useCallback(
		(pluginId: string, nextHidden: boolean) => mutate({ pluginId, hidden: nextHidden }),
		[mutate],
	);

	return {
		hidden,
		/** Preferences have loaded (successfully or not), so `hidden` is authoritative. */
		settled: !enabled || query.isSuccess || query.isError,
		setHidden,
	};
}
