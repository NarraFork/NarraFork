/**
 * Per-device collapse state for the sidebar's directory groups.
 *
 * Stored in localStorage rather than user preferences on purpose: which groups are folded
 * is a scratch view state that changes on every click, and pushing a PATCH per click to
 * sync it across devices would be a lot of traffic for something a user re-adjusts in a
 * second. The MODE switch (flat vs directory) is a real preference and does live on the
 * server.
 *
 * Only EXPLICIT choices are persisted. A path absent from the map is resolved by the
 * default policy in {@link resolveDirectoryCollapsed}, so the defaults can change later
 * without rewriting anyone's stored state.
 */

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "narrafork_recent_tab_dirs";

export type CollapsedDirectoryMap = Readonly<Record<string, boolean>>;

const EMPTY: CollapsedDirectoryMap = Object.freeze({});

const listeners = new Set<() => void>();

/**
 * Parsed cache of the stored map.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders on every change,
 * so parsing fresh JSON per call would return a new object each time and loop forever.
 * The cache is keyed by the raw string, so an external write (another tab) still
 * invalidates it.
 */
let cachedRaw: string | null = null;
let cachedMap: CollapsedDirectoryMap = EMPTY;

let storageListener: ((event: StorageEvent) => void) | null = null;

function ensureStorageListener() {
	if (storageListener) return;
	storageListener = (event: StorageEvent) => {
		if (event.key !== null && event.key !== STORAGE_KEY) return;
		// Force a re-parse: the value changed underneath us in another tab.
		cachedRaw = null;
		for (const listener of listeners) listener();
	};
	window.addEventListener("storage", storageListener);
}

function removeStorageListenerIfIdle() {
	if (listeners.size > 0 || !storageListener) return;
	window.removeEventListener("storage", storageListener);
	storageListener = null;
}

function subscribe(onStoreChange: () => void) {
	listeners.add(onStoreChange);
	ensureStorageListener();
	return () => {
		listeners.delete(onStoreChange);
		removeStorageListenerIfIdle();
	};
}

/** Read the persisted map. Corrupt or non-object JSON degrades to "no explicit choices". */
export function readCollapsedDirectories(): CollapsedDirectoryMap {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return EMPTY;
	}
	if (raw === null) {
		cachedRaw = null;
		cachedMap = EMPTY;
		return EMPTY;
	}
	if (raw === cachedRaw) return cachedMap;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			cachedRaw = raw;
			cachedMap = EMPTY;
			return cachedMap;
		}
		const next: Record<string, boolean> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "boolean") next[key] = value;
		}
		cachedRaw = raw;
		cachedMap = next;
		return cachedMap;
	} catch {
		cachedRaw = raw;
		cachedMap = EMPTY;
		return cachedMap;
	}
}

function writeCollapsedDirectories(map: CollapsedDirectoryMap): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
	} catch {
		// Storage full or blocked — the in-memory value below still drives this session.
	}
	cachedRaw = null;
	for (const listener of listeners) listener();
}

export interface DirectoryCollapseContext {
	/** The group holds the tab for the page currently open. */
	containsActive?: boolean;
	/** The group holds the Ctrl+↑/↓ highlight target. */
	containsPending?: boolean;
}

/**
 * Whether a directory renders collapsed.
 *
 * Groups default to COLLAPSED — that is the whole point of the mode. Two cases auto-expand
 * so the list never hides the row the user is looking at:
 *
 *  - it contains the active tab, so "where am I" stays answerable;
 *  - it contains the keyboard-nav highlight, because Ctrl+↑/↓ scrolls to that row and
 *    highlighting something inside a folded group would scroll to nothing.
 *
 * An EXPLICIT choice always wins, including an explicit collapse of the active group:
 * the user pressed the chevron, and overriding that would make the control feel broken.
 */
export function resolveDirectoryCollapsed(
	map: CollapsedDirectoryMap,
	path: string,
	context: DirectoryCollapseContext = {},
): boolean {
	const explicit = map[path];
	if (explicit !== undefined) return explicit;
	if (context.containsActive || context.containsPending) return false;
	return true;
}

/** Flip a directory, writing the result as an explicit choice. */
export function toggleCollapsedDirectory(
	map: CollapsedDirectoryMap,
	path: string,
	context: DirectoryCollapseContext = {},
): CollapsedDirectoryMap {
	const next = { ...map };
	next[path] = !resolveDirectoryCollapsed(map, path, context);
	return next;
}

export interface UseCollapsedTabDirectories {
	isCollapsed: (path: string, context?: DirectoryCollapseContext) => boolean;
	toggle: (path: string, context?: DirectoryCollapseContext) => void;
}

export function useCollapsedTabDirectories(): UseCollapsedTabDirectories {
	const map = useSyncExternalStore(subscribe, readCollapsedDirectories, () => EMPTY);

	const isCollapsed = useCallback(
		(path: string, context?: DirectoryCollapseContext) =>
			resolveDirectoryCollapsed(map, path, context),
		[map],
	);

	const toggle = useCallback(
		(path: string, context?: DirectoryCollapseContext) => {
			writeCollapsedDirectories(toggleCollapsedDirectory(map, path, context));
		},
		[map],
	);

	return { isCollapsed, toggle };
}
