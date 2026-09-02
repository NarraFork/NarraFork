import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	clearStatusFilter,
	GIT_STATUS_FILTER_KEY,
	type GitStatusFilterChar,
	parseStatusFilterPrefs,
	readStatusFilter,
	toggleStatusFilter,
} from "../components/chapter/git-status-filter";

/**
 * React binding for the git panel's status filter (show only M / A / D / …).
 *
 * Backed by `sessionStorage`, matching `useGitFolderPrefs`: the filter survives a
 * refresh and a navigate-away-and-back, then disappears with the tab. A filter
 * that outlived the tab would be worse than useless — a week-old "only D" on a
 * working tree that has moved on renders an empty panel that reads as broken,
 * and nobody would remember setting it.
 *
 * `useSyncExternalStore` rather than `useState`: the snapshot IS storage, so the
 * chips and the file list cannot drift apart. No `storage` event listener,
 * because sessionStorage is per-tab and has no cross-tab writer.
 */

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

function notify() {
	for (const cb of listeners) cb();
}

/**
 * Cached raw string → parsed document.
 *
 * `getSnapshot` must return a REFERENTIALLY STABLE value while storage has not
 * changed, or `useSyncExternalStore` re-renders forever.
 */
let cachedRaw: string | null = null;
let cachedParsed = parseStatusFilterPrefs(null);
let cacheInitialized = false;

function readRaw(): string | null {
	try {
		return sessionStorage.getItem(GIT_STATUS_FILTER_KEY);
	} catch {
		return null;
	}
}

function getSnapshot() {
	const raw = readRaw();
	if (!cacheInitialized || raw !== cachedRaw) {
		cachedRaw = raw;
		cachedParsed = parseStatusFilterPrefs(raw);
		cacheInitialized = true;
	}
	return cachedParsed;
}

/** Server snapshot: no storage during SSR, so nothing is filtered. */
const EMPTY_PREFS = parseStatusFilterPrefs(null);
function getServerSnapshot() {
	return EMPTY_PREFS;
}

/** Test hook: forget the memoized parse so a stubbed storage is re-read. */
export function __resetGitStatusFilterCache() {
	cachedRaw = null;
	cachedParsed = parseStatusFilterPrefs(null);
	cacheInitialized = false;
}

function persist(next: ReturnType<typeof getSnapshot>) {
	try {
		sessionStorage.setItem(GIT_STATUS_FILTER_KEY, JSON.stringify(next));
	} catch {
		// Storage blocked or full — this is a view preference, not data, so the
		// panel keeps working with whatever is currently in memory.
	}
	notify();
}

// `listeners` and the parse cache are module-level, so a hot replacement leaves the OLD
// module holding the subscriptions the mounted components registered through it, while
// `persist` — now called on the NEW module — notifies an empty set. The chips then stop
// responding to clicks until a full reload, which reads as a broken filter rather than a
// stale module. Same shape as `host-presentation.ts`.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		listeners.clear();
		__resetGitStatusFilterCache();
	});
}

/**
 * Selected status letters for one chapter, plus toggle/clear.
 *
 * An empty set means UNFILTERED, not "hide everything": a mis-click must never
 * leave the panel looking empty and broken.
 */
export function useGitStatusFilter(chapterId: string): {
	selected: Set<GitStatusFilterChar>;
	toggle: (char: GitStatusFilterChar) => void;
	clear: () => void;
} {
	const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const selected = useMemo(() => readStatusFilter(prefs, chapterId), [prefs, chapterId]);
	const toggle = useCallback(
		(char: GitStatusFilterChar) => {
			persist(toggleStatusFilter(getSnapshot(), chapterId, char));
		},
		[chapterId],
	);
	const clear = useCallback(() => {
		persist(clearStatusFilter(getSnapshot(), chapterId));
	}, [chapterId]);
	return { selected, toggle, clear };
}
