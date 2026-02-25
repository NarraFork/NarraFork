import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../lib/api";
import { queryClient as globalQC } from "../lib/query-client";

// === Types ===

export interface RecentTab {
	type: "chapter" | "session" | "project";
	id: string;
	/** Primary narrator ID — used for WS subscriptions */
	narratorId?: string;
	title: string;
	subtitle?: string;
	status?: string;
	lastVisitedAt: number;
}

export const RECENT_TABS_QUERY_KEY = ["user-preferences", "recent-tabs"];

// === Hook ===

export function useRecentTabs() {
	const qc = useQueryClient();

	const { data: tabs = [] } = useQuery({
		queryKey: RECENT_TABS_QUERY_KEY,
		queryFn: async () => {
			const prefs = await api.getUserPreferences();
			return (prefs.recentTabs ?? []) as RecentTab[];
		},
		staleTime: 60_000,
	});

	const upsertMutation = useMutation({
		mutationFn: (tab: RecentTab) => api.upsertRecentTab(tab),
		onMutate: async (tab) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const idx = prev.findIndex((t) => t.type === tab.type && t.id === tab.id);
			let next: RecentTab[];
			if (idx >= 0) {
				next = [...prev];
				next[idx] = tab;
			} else {
				next = [tab, ...prev].slice(0, 20);
			}
			qc.setQueryData(RECENT_TABS_QUERY_KEY, next);
			return { prev };
		},
		onError: (_err, _tab, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	const removeMutation = useMutation({
		mutationFn: ({ type, id }: { type: RecentTab["type"]; id: string }) =>
			api.removeRecentTab(type, id),
		onMutate: async ({ type, id }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			// Evict page data for the closed tab
			const tab = prev.find((t) => t.type === type && t.id === id);
			if (tab) {
				if (tab.type === "chapter") {
					qc.removeQueries({ queryKey: ["chapters", tab.id] });
					if (tab.narratorId) qc.removeQueries({ queryKey: ["narrators", tab.narratorId] });
				} else if (tab.type === "session") {
					qc.removeQueries({ queryKey: ["narrators", tab.id] });
				}
				// project tabs: no narrator/chapter cache to evict
			}
			qc.setQueryData(
				RECENT_TABS_QUERY_KEY,
				prev.filter((t) => !(t.type === type && t.id === id)),
			);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	const clearMutation = useMutation({
		mutationFn: (keepFilter?: (t: RecentTab) => boolean) => {
			if (!keepFilter) return api.clearRecentTabs();
			// Partial clear: persist only the kept tabs via reorder
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const kept = prev.filter(keepFilter);
			return api.reorderRecentTabs(kept.map((t) => `${t.type}:${t.id}`));
		},
		onMutate: async (keepFilter?: (t: RecentTab) => boolean) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const removed = keepFilter ? prev.filter((t) => !keepFilter(t)) : prev;
			// Evict page data for removed tabs
			for (const tab of removed) {
				if (tab.type === "chapter") {
					qc.removeQueries({ queryKey: ["chapters", tab.id] });
					if (tab.narratorId) qc.removeQueries({ queryKey: ["narrators", tab.narratorId] });
				} else if (tab.type === "session") {
					qc.removeQueries({ queryKey: ["narrators", tab.id] });
				}
			}
			qc.setQueryData(RECENT_TABS_QUERY_KEY, keepFilter ? prev.filter(keepFilter) : []);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	const reorderMutation = useMutation({
		mutationFn: (reordered: RecentTab[]) =>
			api.reorderRecentTabs(reordered.map((t) => `${t.type}:${t.id}`)),
		onMutate: async (reordered) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			qc.setQueryData(RECENT_TABS_QUERY_KEY, reordered);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	return {
		tabs,
		addTab: useCallback(
			(tab: Omit<RecentTab, "lastVisitedAt"> & { lastVisitedAt?: number }) => {
				upsertMutation.mutate({ ...tab, lastVisitedAt: tab.lastVisitedAt ?? Date.now() });
			},
			[upsertMutation],
		),
		removeTab: useCallback(
			(type: RecentTab["type"], id: string) => {
				removeMutation.mutate({ type, id });
			},
			[removeMutation],
		),
		reorderTabs: useCallback(
			(reordered: RecentTab[]) => {
				reorderMutation.mutate(reordered);
			},
			[reorderMutation],
		),
		clearAll: useCallback(() => {
			clearMutation.mutate(undefined);
		}, [clearMutation]),
		clearProjects: useCallback(() => {
			clearMutation.mutate((t: RecentTab) => t.type !== "project");
		}, [clearMutation]),
		clearSessions: useCallback(() => {
			clearMutation.mutate((t: RecentTab) => t.type === "project");
		}, [clearMutation]),
	};
}

// === Standalone helper for use in effects (fire-and-forget) ===

export function addRecentTab(tab: Omit<RecentTab, "lastVisitedAt"> & { lastVisitedAt?: number }) {
	const entry: RecentTab = { ...tab, lastVisitedAt: tab.lastVisitedAt ?? Date.now() };

	// Optimistic cache update
	const prev = globalQC.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
	const idx = prev.findIndex((t) => t.type === entry.type && t.id === entry.id);
	let next: RecentTab[];
	if (idx >= 0) {
		next = [...prev];
		next[idx] = entry;
	} else {
		next = [entry, ...prev].slice(0, 20);
	}
	globalQC.setQueryData(RECENT_TABS_QUERY_KEY, next);

	// Persist to backend
	api.upsertRecentTab(entry).catch((err) => {
		if (import.meta.env.DEV) console.warn("[useRecentTabs] upsertRecentTab failed:", err);
	});
}
