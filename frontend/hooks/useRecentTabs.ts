import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../lib/api";
import { queryClient as globalQC } from "../lib/query-client";

// === Types ===

export interface RecentTab {
	type: "chapter" | "session";
	id: string;
	/** Primary narrator ID — used for WS subscriptions */
	narratorId?: string;
	title: string;
	subtitle?: string;
	status?: string;
	/** In-memory unread flag — set when narrator finishes a turn */
	unread?: boolean;
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
				} else {
					qc.removeQueries({ queryKey: ["narrators", tab.id] });
				}
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
		mutationFn: () => api.clearRecentTabs(),
		onMutate: async () => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			// Evict page data for all tabs
			for (const tab of prev) {
				if (tab.type === "chapter") {
					qc.removeQueries({ queryKey: ["chapters", tab.id] });
					if (tab.narratorId) qc.removeQueries({ queryKey: ["narrators", tab.narratorId] });
				} else {
					qc.removeQueries({ queryKey: ["narrators", tab.id] });
				}
			}
			qc.setQueryData(RECENT_TABS_QUERY_KEY, []);
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
			clearMutation.mutate();
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

/** Mark a narrator as read — clears unread in cache and notifies backend. */
export function markTabRead(narratorId: string) {
	// Clear unread flag in cache
	globalQC.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, (prev) => {
		if (!prev) return prev;
		let changed = false;
		const next = prev.map((t) => {
			const match = (t.type === "session" && t.id === narratorId) || t.narratorId === narratorId;
			if (match && t.unread) {
				changed = true;
				return { ...t, unread: false };
			}
			return t;
		});
		return changed ? next : prev;
	});

	// Notify backend (fire-and-forget)
	api.markNarratorRead(narratorId).catch((err) => {
		if (import.meta.env.DEV) console.warn("[useRecentTabs] markNarratorRead failed:", err);
	});
}
