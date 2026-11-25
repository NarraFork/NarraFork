/**
 * Per-user visibility of plugin `overlay` views.
 *
 * Overlays are shown by default once an admin installs the plugin. Each person can hide
 * one plugin's overlays for themselves; the choice is stored on the account
 * (`user_preferences.hidden_plugin_overlays`) so it survives reloads and follows them
 * across devices, and it never affects anyone else.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { api } from "../lib/api";

import {
	isUserPreferencesScopeCurrent,
	userPreferencesQueryKey,
	useUserPreferences,
} from "./useUserPreferences";

type Preferences = Awaited<ReturnType<typeof api.getUIPreferences>>;
const EMPTY: ReadonlySet<string> = new Set();

export function usePluginOverlayVisibility(options: { enabled?: boolean } = {}) {
	const enabled = options.enabled ?? true;
	const queryClient = useQueryClient();
	const query = useUserPreferences({ enabled });
	const queryKey = query.queryKey;

	const hiddenIds = query.data?.hiddenPluginOverlays;
	const hidden = useMemo<ReadonlySet<string>>(
		() => (Array.isArray(hiddenIds) ? new Set(hiddenIds) : EMPTY),
		[hiddenIds],
	);

	const mutation = useMutation({
		mutationFn: ({
			pluginId,
			hidden: nextHidden,
			queryKey,
		}: {
			pluginId: string;
			hidden: boolean;
			queryKey: ReturnType<typeof userPreferencesQueryKey>;
		}) => {
			if (!isUserPreferencesScopeCurrent(queryKey))
				throw new DOMException("Session changed", "AbortError");
			return api.setPluginOverlayHidden(pluginId, nextHidden);
		},
		onMutate: async ({ pluginId, hidden: nextHidden, queryKey }) => {
			await queryClient.cancelQueries({ queryKey });
			if (!isUserPreferencesScopeCurrent(queryKey))
				throw new DOMException("Session changed", "AbortError");
			const previous = queryClient.getQueryData<Preferences>(queryKey);
			// Optimistic: hiding must take effect on click, not after a round trip, or a
			// covering overlay keeps blocking the app while the request is in flight.
			if (previous) {
				const current = previous.hiddenPluginOverlays ?? [];
				const others = current.filter((id) => id !== pluginId);
				queryClient.setQueryData<Preferences>(queryKey, {
					...previous,
					hiddenPluginOverlays: nextHidden ? [pluginId, ...others] : others,
				});
			}
			return { previous };
		},
		onError: (_error, { queryKey }, context) => {
			if (context?.previous && isUserPreferencesScopeCurrent(queryKey))
				queryClient.setQueryData(queryKey, context.previous);
		},
		onSuccess: (result, { queryKey }) => {
			if (!isUserPreferencesScopeCurrent(queryKey)) return;
			void queryClient.invalidateQueries({
				queryKey: userPreferencesQueryKey("detail", {
					userId: queryKey[2],
					generation: queryKey[3],
				}),
			});
			const latest = queryClient.getQueryData<Preferences>(queryKey);
			if (latest) {
				queryClient.setQueryData<Preferences>(queryKey, {
					...latest,
					hiddenPluginOverlays: result.hiddenPluginOverlays,
				});
			}
		},
	});

	const { mutate } = mutation;
	const setHidden = useCallback(
		(pluginId: string, nextHidden: boolean) => mutate({ pluginId, hidden: nextHidden, queryKey }),
		[mutate, queryKey],
	);

	return {
		hidden,
		/** Preferences have loaded (successfully or not), so `hidden` is authoritative. */
		settled: !enabled || query.isSuccess || query.isError,
		setHidden,
	};
}
