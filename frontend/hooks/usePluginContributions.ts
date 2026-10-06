import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import {
	fromPluginUiContributionItem,
	type PluginContributionRecord,
	pluginContributionStore,
	toPluginUiContribution,
} from "../components/plugins/PluginContributionStore";
import type { PluginUiContribution } from "../components/plugins/types";
import { getToken } from "../lib/api/client";
import { type PluginUiContributionItem, pluginsApi } from "../lib/api/plugins";
import { pluginKeys } from "./usePlugins";

/** Convert typed backend contribution items into host-owned store records. */
export function toPluginContributionRecords(
	items: readonly PluginUiContributionItem[],
): PluginContributionRecord[] {
	return items.map(fromPluginUiContributionItem);
}

export interface UsePluginContributionsOptions {
	/** Whether the hook should fetch and subscribe. Defaults to true. */
	enabled?: boolean;
}

export interface UsePluginContributionsResult {
	/** Host-owned contributions keyed by `${pluginId}:${contributionId}`. */
	contributions: Readonly<Record<string, PluginContributionRecord>>;
	/** Monotonic store revision; bumps on every applied snapshot. */
	revision: number;
	/** Whether a backend snapshot has been successfully applied. */
	synced: boolean;
	/** Last successful sync time. */
	updatedAt?: number;
	/** Last sync error, if any. */
	error?: string;
	/** Whether the underlying React Query fetch is in flight. */
	isFetching: boolean;
	/** Force an invalidation and refetch of the backend snapshot. */
	invalidate: () => void;
	/** Resolve a single contribution, returning `undefined` when missing. */
	resolve: (pluginId: string, contributionId: string) => PluginUiContribution | undefined;
}

/**
 * React Query-backed hook that keeps the host-owned contribution store in
 * sync with the backend. The backend remains the source of truth; this hook
 * only mirrors bounded snapshots and exposes a subscribable view.
 *
 * Sync entry points:
 * - login: the query is `enabled` by `getToken()`, so it runs after login;
 * - explicit invalidation: call `invalidate()` or invalidate
 *   `pluginKeys.uiContributions` from mutation handlers;
 * - WS reconnect: any component can call `invalidate()` when the narrator WS
 *   reconnects (see `useNarratorWS` / `narratorWSManager.onConnectionChange`).
 */
export function usePluginContributions(
	options?: UsePluginContributionsOptions,
): UsePluginContributionsResult {
	const queryClient = useQueryClient();
	const enabled = options?.enabled ?? true;
	const hasToken = !!getToken();
	const snapshot = useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);

	const query = useQuery({
		queryKey: pluginKeys.uiContributions,
		queryFn: pluginsApi.listUiContributions,
		enabled: enabled && hasToken,
		gcTime: 60_000,
		retry: (failureCount, error) => {
			if ((error as { status?: number }).status === 503) return false;
			return failureCount < 2;
		},
	});

	useEffect(() => {
		if (!query.data) return;
		pluginContributionStore.beginSync();
		try {
			pluginContributionStore.applyRecords(toPluginContributionRecords(query.data));
		} catch (error) {
			pluginContributionStore.failSync(error);
		}
	}, [query.data]);

	useEffect(() => {
		if (!query.error) return;
		pluginContributionStore.failSync(query.error);
	}, [query.error]);

	return {
		contributions: snapshot.contributions,
		revision: snapshot.revision,
		synced: snapshot.synced,
		updatedAt: snapshot.updatedAt,
		error: snapshot.error,
		isFetching: query.isFetching,
		invalidate: () => {
			pluginContributionStore.invalidate();
			void queryClient.invalidateQueries({ queryKey: pluginKeys.uiContributions });
		},
		resolve: (pluginId, contributionId) => {
			const record = pluginContributionStore.get(pluginId, contributionId);
			return record ? toPluginUiContribution(record) : undefined;
		},
	};
}

/** Subscribe to store changes without triggering fetches. */
export function usePluginContributionStoreSnapshot() {
	return useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);
}
