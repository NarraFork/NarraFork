import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
	GIT_FOLDER_PREFS_KEY,
	type GitFolderSection,
	parseFolderPrefs,
	readExpanded,
	toggleExpanded,
} from "../components/chapter/git-folder-prefs";

/**
 * React binding for the git panel's folder expansion state.
 *
 * Backed by `sessionStorage`: the state survives a refresh and a
 * navigate-away-and-back, then disappears with the tab. See
 * `git-folder-prefs.ts` for why that scope was chosen over localStorage.
 *
 * The store module owns the format and every transition; this file owns only the
 * storage read/write and the in-tab notification, so the two panel sections
 * (staged + unstaged) stay consistent without either one owning the state.
 *
 * `useSyncExternalStore` rather than `useState`: the snapshot IS storage, so
 * there is no second copy to drift out of sync.
 *
 * No `storage` event listener here, unlike `useLocalPref`. That event only fires
 * for localStorage changes in OTHER tabs, and sessionStorage is per-tab by
 * definition — there is no cross-tab writer to hear from.
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
 * changed, or `useSyncExternalStore` re-renders forever. Parsing on every call
 * would allocate a fresh object each time, so the parse is memoized on the exact
 * raw string it came from.
 */
let cachedRaw: string | null = null;
let cachedParsed = parseFolderPrefs(null);
let cacheInitialized = false;

function readRaw(): string | null {
	try {
		return sessionStorage.getItem(GIT_FOLDER_PREFS_KEY);
	} catch {
		return null;
	}
}

function getSnapshot() {
	const raw = readRaw();
	if (!cacheInitialized || raw !== cachedRaw) {
		cachedRaw = raw;
		cachedParsed = parseFolderPrefs(raw);
		cacheInitialized = true;
	}
	return cachedParsed;
}

/** Server snapshot: no storage during SSR, so nothing is expanded. */
const EMPTY_PREFS = parseFolderPrefs(null);
function getServerSnapshot() {
	return EMPTY_PREFS;
}

/** Test hook: forget the memoized parse so a stubbed storage is re-read. */
export function __resetGitFolderPrefsCache() {
	cachedRaw = null;
	cachedParsed = parseFolderPrefs(null);
	cacheInitialized = false;
}

/**
 * Expanded folders for one chapter section, plus a toggle that persists for the
 * rest of the session.
 *
 * Folders default to COLLAPSED: a repo with changes across many folders
 * otherwise opens as a wall of rows, and the grouping only pays off when the
 * panel starts summarized. The returned set is the expanded exception list.
 */
export function useGitFolderPrefs(
	chapterId: string,
	section: GitFolderSection,
	legacyChapterId?: string | null,
): { expanded: Set<string>; toggle: (path: string) => void } {
	const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	useEffect(() => {
		if (!legacyChapterId || legacyChapterId === chapterId) return;
		const previous = getSnapshot();
		if (!Object.hasOwn(previous, legacyChapterId)) return;
		const { [legacyChapterId]: legacy, ...rest } = previous;
		const next = Object.hasOwn(rest, chapterId) ? rest : { ...rest, [chapterId]: legacy };
		try {
			sessionStorage.setItem(GIT_FOLDER_PREFS_KEY, JSON.stringify(next));
		} catch {
			return;
		}
		notify();
	}, [chapterId, legacyChapterId]);
	const expanded = useMemo(
		() => readExpanded(prefs, chapterId, section),
		[prefs, chapterId, section],
	);
	const toggle = useCallback(
		(path: string) => {
			const next = toggleExpanded(getSnapshot(), chapterId, section, path);
			try {
				sessionStorage.setItem(GIT_FOLDER_PREFS_KEY, JSON.stringify(next));
			} catch {
				// Storage blocked or full — this is a view preference, not data, so the
				// panel keeps working with whatever is currently in memory.
			}
			notify();
		},
		[chapterId, section],
	);
	return { expanded, toggle };
}
