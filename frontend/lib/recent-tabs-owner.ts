import type { RecentTabsSection } from "@shared/recent-tabs";
import { useSyncExternalStore } from "react";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { getAuthSnapshot, subscribeAuth } from "./api/client";
import { type ListenerHandle, narratorWSManager } from "./narrator-ws-manager";

/** Only a verified identity can own a RecentTabs query. No credentials enter the key. */
export interface RecentTabsScope {
	readonly userId: string;
	readonly authGeneration: number;
	readonly accessGeneration: number;
}

export const RECENT_TABS_QUERY_KEY = ["user-preferences", "recent-tabs"] as const;
export const recentTabsScopeKey = (scope: RecentTabsScope | null) =>
	[
		...RECENT_TABS_QUERY_KEY,
		scope?.userId ?? null,
		scope?.authGeneration ?? null,
		scope?.accessGeneration ?? null,
	] as const;
export const recentTabsFlatQueryKey = (scope: RecentTabsScope) =>
	[...recentTabsScopeKey(scope), "flat"] as const;
export const recentTabsSectionQueryKey = (
	scope: RecentTabsScope | null,
	section: RecentTabsSection,
) => [...recentTabsScopeKey(scope), section] as const;

let accessGeneration = 0;
let currentScope: RecentTabsScope | null = null;
export function getRecentTabsScope(): RecentTabsScope | null {
	const auth = getAuthSnapshot();
	if (!auth.hasToken || auth.userId === null) currentScope = null;
	else if (
		currentScope?.authGeneration !== auth.generation ||
		currentScope.userId !== auth.userId ||
		currentScope.accessGeneration !== accessGeneration
	)
		currentScope = { userId: auth.userId, authGeneration: auth.generation, accessGeneration };
	return currentScope;
}

export function isRecentTabsScopeCurrent(scope: RecentTabsScope | null): scope is RecentTabsScope {
	return scope !== null && getRecentTabsScope() === scope;
}

export function requireRecentTabsScope(
	scope: RecentTabsScope | null,
): asserts scope is RecentTabsScope {
	if (!isRecentTabsScopeCurrent(scope))
		throw new DOMException("Recent tabs scope changed", "AbortError");
}

const listeners = new Set<() => void>();
let accessListener: ListenerHandle | undefined;

export function subscribeRecentTabsScope(listener: () => void): () => void {
	listeners.add(listener);
	const unsubscribeAuth = subscribeAuth(listener);
	accessListener ??= narratorWSManager.addListener(
		{ narratorIds: "*", types: ["narrator_access_changed", "project_access_changed"] },
		() => {
			if (narratorWSManager.getConnectionAuthGeneration() !== getAuthSnapshot().generation) return;
			// Immediately hide cached rows; enabled page queries load fresh authorized data.
			accessGeneration++;
			for (const notify of listeners) notify();
		},
	);
	return () => {
		unsubscribeAuth();
		listeners.delete(listener);
		if (listeners.size === 0 && accessListener !== undefined) {
			narratorWSManager.removeListener(accessListener);
			accessListener = undefined;
		}
	};
}

export function useRecentTabsScope(): RecentTabsScope | null {
	useCurrentUser();
	return useSyncExternalStore(subscribeRecentTabsScope, getRecentTabsScope, () => null);
}
