/**
 * Per-device display state of sidebar folders: collapsed, preview (first N members) or
 * expanded (all members).
 *
 * Stored in localStorage rather than on the server on purpose: it changes on every click,
 * and syncing that across devices would be a request per click for something the user
 * re-adjusts in a second. The preview COUNT is a real setting and lives on the folder row.
 *
 * Only explicit choices are stored; a folder absent from the map uses the default
 * ("preview"), so the default can change later without rewriting anyone's state.
 */

import { useSyncExternalStore } from "react";
import type { FolderDisplay } from "./recent-tab-folders";

const STORAGE_KEY = "narrafork_recent_tab_folders";
/** Bounds the stored map; folders are user-made, so this is generous. */
const MAX_ENTRIES = 500;

export type FolderDisplayMap = Readonly<Record<string, FolderDisplay>>;

const EMPTY: FolderDisplayMap = Object.freeze({});
const VALID = new Set<FolderDisplay>(["collapsed", "preview", "expanded"]);
const listeners = new Set<() => void>();

// `useSyncExternalStore` compares snapshots by identity, so the parse is cached by the
// raw string; an external write (another browser tab) still invalidates it.
let cachedRaw: string | null = null;
let cachedMap: FolderDisplayMap = EMPTY;
let storageListener: ((event: StorageEvent) => void) | null = null;

function subscribe(onStoreChange: () => void) {
	listeners.add(onStoreChange);
	if (!storageListener) {
		storageListener = (event: StorageEvent) => {
			if (event.key !== null && event.key !== STORAGE_KEY) return;
			cachedRaw = null;
			for (const listener of listeners) listener();
		};
		window.addEventListener("storage", storageListener);
	}
	return () => {
		listeners.delete(onStoreChange);
		if (listeners.size === 0 && storageListener) {
			window.removeEventListener("storage", storageListener);
			storageListener = null;
		}
	};
}

/** Read the stored map. Corrupt JSON or unknown values degrade to "no explicit choice". */
export function readFolderDisplays(): FolderDisplayMap {
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
	cachedRaw = raw;
	cachedMap = EMPTY;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const next: Record<string, FolderDisplay> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (VALID.has(value as FolderDisplay)) next[key] = value as FolderDisplay;
			}
			cachedMap = next;
		}
	} catch {
		// keep EMPTY
	}
	return cachedMap;
}

function writeFolderDisplay(folderId: string, display: FolderDisplay | null): void {
	const next: Record<string, FolderDisplay> = { ...readFolderDisplays() };
	delete next[folderId];
	if (display) next[folderId] = display;
	const keys = Object.keys(next);
	// Oldest insertions first: drop them when the map outgrows its bound.
	for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[key];
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Storage full or blocked: nothing to persist, the click simply does not stick.
	}
	cachedRaw = null;
	for (const listener of listeners) listener();
}

export function useFolderDisplay(): {
	displays: FolderDisplayMap;
	setDisplay: (folderId: string, display: FolderDisplay | null) => void;
} {
	const displays = useSyncExternalStore(subscribe, readFolderDisplays, () => EMPTY);
	return { displays, setDisplay: writeFolderDisplay };
}
