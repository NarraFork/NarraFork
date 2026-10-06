import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	GIT_VIEW_PREFS_KEY,
	type GitViewMode,
	parseGitViewPrefs,
	readGitViewMode,
	setGitViewMode,
} from "../components/chapter/git-view-prefs";

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

function notify() {
	for (const listener of listeners) listener();
}

let cachedRaw: string | null = null;
let cachedPrefs = parseGitViewPrefs(null);
let cacheInitialized = false;

function readRaw(): string | null {
	try {
		return localStorage.getItem(GIT_VIEW_PREFS_KEY);
	} catch {
		return null;
	}
}

function getSnapshot() {
	const raw = readRaw();
	if (!cacheInitialized || raw !== cachedRaw) {
		cachedRaw = raw;
		cachedPrefs = parseGitViewPrefs(raw);
		cacheInitialized = true;
	}
	return cachedPrefs;
}

const EMPTY_PREFS = parseGitViewPrefs(null);
function getServerSnapshot() {
	return EMPTY_PREFS;
}

function persist(next: ReturnType<typeof getSnapshot>) {
	try {
		localStorage.setItem(GIT_VIEW_PREFS_KEY, JSON.stringify(next));
	} catch {
		// View preferences are optional; a blocked storage must not break Git.
	}
	notify();
}

export function __resetGitViewModeCache() {
	cachedRaw = null;
	cachedPrefs = parseGitViewPrefs(null);
	cacheInitialized = false;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		listeners.clear();
		__resetGitViewModeCache();
	});
}

export function useGitViewMode(workspaceKey: string): {
	mode: GitViewMode;
	setMode: (mode: GitViewMode) => void;
} {
	const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const mode = useMemo(() => readGitViewMode(prefs, workspaceKey), [prefs, workspaceKey]);
	const setMode = useCallback(
		(nextMode: GitViewMode) => persist(setGitViewMode(getSnapshot(), workspaceKey, nextMode)),
		[workspaceKey],
	);
	return { mode, setMode };
}
