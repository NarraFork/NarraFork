import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { GitTarget } from "../lib/api/git";
import { gitTargetKey } from "../lib/api/git";

/**
 * Collapse state for the Git panel commit-graph strip under the changes list.
 *
 * Defaults to expanded (false) so the graph is discoverable on first visit.
 * Keyed by workspace so two worktrees never share a presentation choice.
 * Storage is localStorage: unlike folder expansion, this is a durable layout
 * preference the user is likely to set once and keep.
 */
export const GIT_GRAPH_COLLAPSED_KEY = "narrafork_git_graph_collapsed";

export type GitGraphCollapsedPrefs = Record<string, boolean>;

function parseCollapsedPrefs(raw: string | null): GitGraphCollapsedPrefs {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const result: GitGraphCollapsedPrefs = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "boolean") result[key] = value;
	}
	return result;
}

function readCollapsed(prefs: GitGraphCollapsedPrefs, key: string): boolean {
	// Missing key = expanded (false). Only an explicit true collapses.
	return prefs[key] === true;
}

function setCollapsedValue(
	prefs: GitGraphCollapsedPrefs,
	key: string,
	collapsed: boolean,
): GitGraphCollapsedPrefs {
	if ((prefs[key] === true) === collapsed) return prefs;
	return { ...prefs, [key]: collapsed };
}

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

function notify() {
	for (const listener of listeners) listener();
}

let cachedRaw: string | null = null;
let cachedPrefs: GitGraphCollapsedPrefs = parseCollapsedPrefs(null);
let cacheInitialized = false;

function readRaw(): string | null {
	try {
		return localStorage.getItem(GIT_GRAPH_COLLAPSED_KEY);
	} catch {
		return null;
	}
}

function getSnapshot() {
	const raw = readRaw();
	if (!cacheInitialized || raw !== cachedRaw) {
		cachedRaw = raw;
		cachedPrefs = parseCollapsedPrefs(raw);
		cacheInitialized = true;
	}
	return cachedPrefs;
}

const EMPTY_PREFS = parseCollapsedPrefs(null);
function getServerSnapshot() {
	return EMPTY_PREFS;
}

function persist(next: GitGraphCollapsedPrefs) {
	try {
		localStorage.setItem(GIT_GRAPH_COLLAPSED_KEY, JSON.stringify(next));
	} catch {
		// Layout preference is optional; blocked storage must not break the Git panel.
	}
	notify();
}

/** Test hook: forget the memoized parse so a stubbed storage is re-read. */
export function __resetGitGraphCollapsedCache() {
	cachedRaw = null;
	cachedPrefs = parseCollapsedPrefs(null);
	cacheInitialized = false;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		listeners.clear();
		__resetGitGraphCollapsedCache();
	});
}

export function useGitGraphCollapsed(target: GitTarget | null | undefined): {
	collapsed: boolean;
	setCollapsed: (collapsed: boolean) => void;
	toggle: () => void;
} {
	const workspaceKey = gitTargetKey(target) ?? "";
	const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const collapsed = useMemo(
		() => (workspaceKey ? readCollapsed(prefs, workspaceKey) : false),
		[prefs, workspaceKey],
	);
	const setCollapsed = useCallback(
		(nextCollapsed: boolean) => {
			if (!workspaceKey) return;
			persist(setCollapsedValue(getSnapshot(), workspaceKey, nextCollapsed));
		},
		[workspaceKey],
	);
	const toggle = useCallback(() => {
		if (!workspaceKey) return;
		const snapshot = getSnapshot();
		persist(setCollapsedValue(snapshot, workspaceKey, !readCollapsed(snapshot, workspaceKey)));
	}, [workspaceKey]);
	return { collapsed, setCollapsed, toggle };
}
