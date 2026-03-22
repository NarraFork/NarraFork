import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../lib/api";
import { queryClient as globalQC } from "../lib/query-client";

// === Types ===

export interface RecentTabViewer {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface RecentTab {
	type: "chapter" | "narrator" | "project" | "workspace";
	id: string;
	/** Primary narrator ID — used for WS subscriptions */
	narratorId?: string;
	/** If this tab belongs to a workspace, the workspace ID */
	workspaceId?: string | null;
	title: string;
	subtitle?: string;
	status?: string;
	lastVisitedAt: number;
	// Runtime-enriched fields (not persisted to DB)
	activeTerminalCount?: number;
	viewers?: RecentTabViewer[];
	containerStatus?: "created" | "running" | "paused" | "stopped" | null;
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

	// --- Remove a single tab (optimistic) ---
	const removeMutation = useMutation({
		mutationFn: ({ type, id }: { type: RecentTab["type"]; id: string }) =>
			api.removeRecentTab(type, id),
		onMutate: async ({ type, id }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const tab = prev.find((t) => t.type === type && t.id === id);
			if (tab) {
				if (tab.type === "chapter") {
					qc.removeQueries({ queryKey: ["chapters", tab.id] });
					if (tab.narratorId) qc.removeQueries({ queryKey: ["narrators", tab.narratorId] });
				} else if (tab.type === "narrator") {
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
		// No onSuccess — WS snapshot will deliver the authoritative list
	});

	// --- Move a tab (optimistic) ---
	const moveMutation = useMutation({
		mutationFn: (args: {
			key: string;
			target: { toIndex: number } | { position: "top" | "above_idle" };
		}) => api.moveRecentTab(args.key, args.target),
		onMutate: async ({ key, target }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const idx = prev.findIndex((t) => `${t.type}:${t.id}` === key);
			if (idx === -1) return { prev };
			const next = [...prev];
			const [moved] = next.splice(idx, 1);
			if ("toIndex" in target) {
				next.splice(Math.min(target.toIndex, next.length), 0, moved);
			} else {
				// top or above_idle — just put at top for optimistic (server will do exact placement)
				next.unshift(moved);
			}
			qc.setQueryData(RECENT_TABS_QUERY_KEY, next);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	// --- Clear tabs by scope (optimistic) ---
	const clearMutation = useMutation({
		mutationFn: ({
			scope,
			keepTabKey,
		}: {
			scope: "all" | "projects" | "inactive_narrators";
			keepTabKey?: string;
		}) => api.clearRecentTabs(scope, keepTabKey),
		onMutate: async ({ scope, keepTabKey }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const isKept = (t: RecentTab) => (keepTabKey ? `${t.type}:${t.id}` === keepTabKey : false);
			if (scope === "all") {
				for (const tab of prev) {
					if (!isKept(tab)) evictTabCache(qc, tab);
				}
				qc.setQueryData(RECENT_TABS_QUERY_KEY, keepTabKey ? prev.filter(isKept) : []);
			} else if (scope === "projects") {
				for (const tab of prev) {
					if (tab.type === "project" && !isKept(tab)) evictTabCache(qc, tab);
				}
				qc.setQueryData(
					RECENT_TABS_QUERY_KEY,
					prev.filter((t) => t.type !== "project" || isKept(t)),
				);
			} else {
				// inactive_narrators — keep projects + active tabs + kept tab
				const ACTIVE = new Set(["thinking", "waiting", "done"]);
				const kept: RecentTab[] = [];
				for (const tab of prev) {
					if (isKept(tab) || tab.type === "project" || ACTIVE.has(tab.status ?? "")) {
						kept.push(tab);
					} else {
						evictTabCache(qc, tab);
					}
				}
				qc.setQueryData(RECENT_TABS_QUERY_KEY, kept);
			}
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	return {
		tabs,
		removeTab: useCallback(
			(type: RecentTab["type"], id: string) => removeMutation.mutate({ type, id }),
			[removeMutation],
		),
		moveTab: useCallback(
			(key: string, target: { toIndex: number } | { position: "top" | "above_idle" }) =>
				moveMutation.mutate({ key, target }),
			[moveMutation],
		),
		clearTabs: useCallback(
			(scope: "all" | "projects" | "inactive_narrators", keepTabKey?: string) =>
				clearMutation.mutate({ scope, keepTabKey }),
			[clearMutation],
		),
	};
}

function evictTabCache(qc: ReturnType<typeof useQueryClient>, tab: RecentTab) {
	if (tab.type === "chapter") {
		qc.removeQueries({ queryKey: ["chapters", tab.id] });
		if (tab.narratorId) qc.removeQueries({ queryKey: ["narrators", tab.narratorId] });
	} else if (tab.type === "narrator") {
		qc.removeQueries({ queryKey: ["narrators", tab.id] });
	}
}

// === Standalone helper for use in effects (fire-and-forget) ===

export function addRecentTab(
	tab: Omit<RecentTab, "lastVisitedAt"> & { lastVisitedAt?: number; updateOnly?: boolean },
) {
	const { updateOnly, ...rest } = tab;
	const entry = { ...rest, lastVisitedAt: rest.lastVisitedAt ?? Date.now() };
	api.upsertRecentTab({ ...entry, updateOnly }).catch((err) => {
		if (import.meta.env.DEV) console.warn("[useRecentTabs] upsertRecentTab failed:", err);
	});
}

/**
 * Update a recent tab's fields in the local cache only — no server request.
 * Used by route effects to keep tab metadata fresh without triggering upserts.
 */
export function updateRecentTabLocal(
	type: RecentTab["type"],
	id: string,
	patch: Partial<Pick<RecentTab, "title" | "subtitle" | "status">>,
) {
	globalQC.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, (prev) => {
		if (!prev) return prev;
		let changed = false;
		const next = prev.map((t) => {
			if (t.type === type && t.id === id) {
				changed = true;
				return { ...t, ...patch };
			}
			return t;
		});
		return changed ? next : prev;
	});
}
