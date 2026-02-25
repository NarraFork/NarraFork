import { useCallback, useSyncExternalStore } from "react";

/**
 * Lightweight hook for boolean preferences stored in localStorage.
 * Changes are broadcast across tabs via the "storage" event and
 * within the same tab via a manual notify mechanism.
 */

type Key = "narrafork_fullscreen" | "narrafork_oled";

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key?.startsWith("narrafork_")) cb();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(cb);
		window.removeEventListener("storage", onStorage);
	};
}

function notify() {
	for (const cb of listeners) cb();
}

function getSnapshot(key: Key): boolean {
	return localStorage.getItem(key) === "true";
}

export function useLocalPref(key: Key): [boolean, (v: boolean) => void] {
	const value = useSyncExternalStore(
		subscribe,
		() => getSnapshot(key),
		() => false,
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
