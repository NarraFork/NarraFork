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
	substatus?: string[];
	lastVisitedAt: number;
	/** Whether this tab is pinned to the top */
	pinned?: boolean;
	// Runtime-enriched fields (not persisted to DB)
	activeTerminalCount?: number;
	viewers?: RecentTabViewer[];
	containerStatus?: "created" | "running" | "paused" | "stopped" | null;
}

export const RECENT_TABS_QUERY_KEY = ["user-preferences", "recent-tabs"];

/** Target types accepted by the server API */
export type RecentTabApiMoveTarget = { toIndex: number } | { position: "top" | "above_idle" };

/** Extended target types for local optimistic moves (includes key-based anchoring) */
export type RecentTabMoveTarget =
	| RecentTabApiMoveTarget
	| { afterKey: string }
	| { beforeKey: string };

/**
 * Enforce workspace grouping: workspace header is immediately followed by its children.
 * Operates in-place on the array.
 */
function regroupTabs(tabs: RecentTab[]): void {
	const childrenByWs = new Map<string, RecentTab[]>();
	for (const t of tabs) {
		if (t.workspaceId) {
			const arr = childrenByWs.get(t.workspaceId);
			if (arr) arr.push(t);
			else childrenByWs.set(t.workspaceId, [t]);
		}
	}
	if (childrenByWs.size === 0) return;

	// Remove all workspace children
	let i = 0;
	while (i < tabs.length) {
		if (tabs[i].workspaceId) tabs.splice(i, 1);
		else i++;
	}

	// Re-insert children after their workspace header
	const headerIds = new Set<string>();
	for (let j = 0; j < tabs.length; j++) {
		if (tabs[j].type === "workspace") {
			const wsId = tabs[j].id;
			headerIds.add(wsId);
			const children = childrenByWs.get(wsId);
			if (children && children.length > 0) {
				tabs.splice(j + 1, 0, ...children);
				j += children.length;
			}
		}
	}

	// Orphan children — clear workspaceId and append
	for (const [wsId, children] of childrenByWs) {
		if (!headerIds.has(wsId)) {
			for (const c of children) c.workspaceId = undefined;
			tabs.push(...children);
		}
	}
}

function getPinnedSectionEndIndex(tabs: RecentTab[]): number {
	let idx = 0;
	while (idx < tabs.length) {
		const tab = tabs[idx];
		if (!tab) break;
		if (tab.workspaceId) {
			idx++;
			continue;
		}
		if (!tab.pinned) break;
		idx++;
		if (tab.type === "workspace") {
			while (idx < tabs.length && tabs[idx]?.workspaceId === tab.id) idx++;
		}
	}
	return idx;
}

export function applyRecentTabMove(
	tabs: RecentTab[],
	key: string,
	target: RecentTabMoveTarget,
): RecentTab[] {
	const idx = tabs.findIndex((tab) => `${tab.type}:${tab.id}` === key);
	if (idx === -1) return tabs;

	const next = [...tabs];
	const tab = next[idx];

	let movedGroup: RecentTab[];
	if (tab.type === "workspace") {
		let end = idx + 1;
		while (end < next.length && next[end].workspaceId === tab.id) end++;
		movedGroup = next.splice(idx, end - idx);
	} else {
		movedGroup = next.splice(idx, 1);
	}

	if ("afterKey" in target) {
		const afterIdx = next.findIndex((t) => `${t.type}:${t.id}` === target.afterKey);
		next.splice(afterIdx === -1 ? next.length : afterIdx + 1, 0, ...movedGroup);
	} else if ("beforeKey" in target) {
		const beforeIdx = next.findIndex((t) => `${t.type}:${t.id}` === target.beforeKey);
		next.splice(beforeIdx === -1 ? 0 : beforeIdx, 0, ...movedGroup);
	} else if ("toIndex" in target) {
		next.splice(Math.min(target.toIndex, next.length), 0, ...movedGroup);
	} else {
		next.unshift(...movedGroup);
	}

	regroupTabs(next);
	return next;
}

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
			let next: RecentTab[];
			if (type === "workspace") {
				// Removing workspace header: release children (clear workspaceId) and remove header
				next = prev
					.filter((t) => !(t.type === type && t.id === id))
					.map((t) => (t.workspaceId === id ? { ...t, workspaceId: undefined } : t));
			} else {
				next = prev.filter((t) => !(t.type === type && t.id === id));
			}
			qc.setQueryData(RECENT_TABS_QUERY_KEY, next);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
		// No onSuccess — WS snapshot will deliver the authoritative list
	});

	// --- Move a tab (optimistic) ---
	const moveMutation = useMutation({
		mutationFn: (args: { key: string; target: RecentTabApiMoveTarget }) =>
			api.moveRecentTab(args.key, args.target),
		onMutate: async ({ key, target }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const next = applyRecentTabMove(prev, key, target);
			if (next === prev) return { prev };
			qc.setQueryData(RECENT_TABS_QUERY_KEY, next);
			return { prev };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.prev) qc.setQueryData(RECENT_TABS_QUERY_KEY, ctx.prev);
		},
	});

	// --- Pin/unpin a tab (optimistic) ---
	const pinMutation = useMutation({
		mutationFn: (args: { key: string; pinned: boolean }) => api.pinRecentTab(args.key, args.pinned),
		onMutate: async ({ key, pinned }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const prev = qc.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			const idx = prev.findIndex((t) => `${t.type}:${t.id}` === key);
			if (idx === -1) return { prev };
			const next = [...prev];
			const tab = { ...next[idx], pinned: pinned || undefined };
			if (!pinned) delete tab.pinned;
			next.splice(idx, 1);
			// Insert at end of pinned section (or start of unpinned section)
			next.splice(getPinnedSectionEndIndex(next), 0, tab);
			regroupTabs(next);
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
				// Workspace-aware: keep entire workspace if any child is active
				const ACTIVE_STATUSES = new Set(["working", "waiting"]);
				const ATTENTION_SUBSTATUS = new Set(["unread", "error"]);
				const isTabActive = (tab: RecentTab) => {
					if (ACTIVE_STATUSES.has(tab.status ?? "")) return true;
					if (tab.status === "idle" && tab.substatus?.some((s) => ATTENTION_SUBSTATUS.has(s)))
						return true;
					return false;
				};

				// Group children by workspaceId
				const childrenByWs = new Map<string, RecentTab[]>();
				for (const tab of prev) {
					if (tab.workspaceId) {
						const arr = childrenByWs.get(tab.workspaceId);
						if (arr) arr.push(tab);
						else childrenByWs.set(tab.workspaceId, [tab]);
					}
				}

				// Determine which workspaces have at least one active child
				const activeWorkspaces = new Set<string>();
				for (const tab of prev) {
					if (tab.type === "workspace") {
						const children = childrenByWs.get(tab.id) ?? [];
						if (children.some(isTabActive)) {
							activeWorkspaces.add(tab.id);
						}
					}
				}

				const kept: RecentTab[] = [];
				for (const tab of prev) {
					if (isKept(tab) || tab.type === "project") {
						kept.push(tab);
					} else if (tab.type === "workspace") {
						if (activeWorkspaces.has(tab.id)) kept.push(tab);
						else evictTabCache(qc, tab);
					} else if (tab.workspaceId) {
						if (activeWorkspaces.has(tab.workspaceId)) kept.push(tab);
						else evictTabCache(qc, tab);
					} else if (isTabActive(tab)) {
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
			(key: string, target: RecentTabApiMoveTarget) => moveMutation.mutate({ key, target }),
			[moveMutation],
		),
		pinTab: useCallback(
			(key: string, pinned: boolean) => pinMutation.mutate({ key, pinned }),
			[pinMutation],
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
	const { updateOnly: explicitUpdateOnly, ...rest } = tab;
	const entry = { ...rest, lastVisitedAt: rest.lastVisitedAt ?? Date.now() };

	// Auto-detect: if updateOnly is not explicitly set, check if tab already exists
	let updateOnly = explicitUpdateOnly;
	if (updateOnly === undefined) {
		const currentTabs = globalQC.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
		const exists = currentTabs.some((t) => t.type === entry.type && t.id === entry.id);
		updateOnly = exists;
	}

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
