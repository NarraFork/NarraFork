import { useCallback, useSyncExternalStore } from "react";

/**
 * Lightweight hook for boolean preferences stored in localStorage.
 * Changes are broadcast across tabs via the "storage" event and
 * within the same tab via a manual notify mechanism.
 */

type Key =
	| "narrafork_fullscreen"
	| "narrafork_oled"
	| "narrafork_wakelock"
	| "narrafork_advanced_anim"
	| "narrafork_expand_reasoning"
	| "narrafork_narrator_virtual_list"
	| "narrafork_narrator_centered_column";

const listeners = new Set<() => void>();

// --- Singleton storage listener ---
// One global "storage" listener dispatches to all subscribers,
// instead of each useLocalPref instance registering its own.
let storageListener: ((e: StorageEvent) => void) | null = null;

function ensureStorageListener() {
	if (storageListener) return;
	storageListener = (e: StorageEvent) => {
		if (e.key?.startsWith("narrafork_")) {
			for (const cb of listeners) cb();
		}
	};
	window.addEventListener("storage", storageListener);
}

function removeStorageListenerIfIdle() {
	if (listeners.size > 0 || !storageListener) return;
	window.removeEventListener("storage", storageListener);
	storageListener = null;
}

function subscribe(cb: () => void) {
	listeners.add(cb);
	ensureStorageListener();
	return () => {
		listeners.delete(cb);
		removeStorageListenerIfIdle();
	};
}

function notify() {
	for (const cb of listeners) cb();
}

/** Keys whose default value is `true` (opt-out instead of opt-in). */
const DEFAULT_TRUE: ReadonlySet<Key> = new Set([
	"narrafork_advanced_anim",
	// Virtual list is now the default narrator renderer. "New user" == no stored
	// value for this key, so a fresh browser lands on the vlist path; anyone who
	// has flipped the header switch keeps their explicit choice (including an
	// explicit `false`, which stays on ChunkedMessageList).
	"narrafork_narrator_virtual_list",
]);

/**
 * The default value of a preference key when nothing is stored in localStorage.
 * Exported (pure, no DOM) so tests can lock critical defaults — most importantly
 * that `narrafork_narrator_virtual_list` defaults to `true`, putting users on the
 * virtual list unless they explicitly opt out.
 */
export function localPrefDefault(key: Key): boolean {
	return DEFAULT_TRUE.has(key);
}

function getSnapshot(key: Key): boolean {
	const raw = localStorage.getItem(key);
	if (raw === null) return localPrefDefault(key);
	return raw === "true";
}

export function useLocalPref(key: Key): [boolean, (v: boolean) => void] {
	const value = useSyncExternalStore(
		subscribe,
		() => getSnapshot(key),
		() => localPrefDefault(key),
	);
	const setValue = useCallback(
		(v: boolean) => {
			localStorage.setItem(key, String(v));
			notify();
		},
		[key],
	);
	return [value, setValue];
}
