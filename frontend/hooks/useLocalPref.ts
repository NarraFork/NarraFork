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
	| "narrafork_expand_reasoning";

const listeners = new Set<() => void>();

// --- Singleton storage listener ---
// One global "storage" listener dispatches to all subscribers,
// instead of each useLocalPref instance registering its own.
let storageListenerInstalled = false;

function ensureStorageListener() {
	if (storageListenerInstalled) return;
	storageListenerInstalled = true;
	window.addEventListener("storage", (e: StorageEvent) => {
		if (e.key?.startsWith("narrafork_")) {
			for (const cb of listeners) cb();
		}
	});
}

function subscribe(cb: () => void) {
	listeners.add(cb);
	ensureStorageListener();
	return () => {
		listeners.delete(cb);
	};
}

function notify() {
	for (const cb of listeners) cb();
}

/** Keys whose default value is `true` (opt-out instead of opt-in). */
const DEFAULT_TRUE: ReadonlySet<Key> = new Set(["narrafork_advanced_anim"]);

function getSnapshot(key: Key): boolean {
	const raw = localStorage.getItem(key);
	if (raw === null) return DEFAULT_TRUE.has(key);
	return raw === "true";
}

export function useLocalPref(key: Key): [boolean, (v: boolean) => void] {
	const value = useSyncExternalStore(
		subscribe,
		() => getSnapshot(key),
		() => DEFAULT_TRUE.has(key),
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
