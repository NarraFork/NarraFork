import { useCallback, useSyncExternalStore } from "react";

export type NarratorMessageRendererMode = "react" | "pixi";

export const NARRATOR_MESSAGE_RENDERER_PREF_KEY = "narrafork_narrator_message_renderer";
export const DEFAULT_NARRATOR_MESSAGE_RENDERER: NarratorMessageRendererMode = "react";

const listeners = new Set<() => void>();
let storageListener: ((e: StorageEvent) => void) | null = null;

function isRendererMode(value: string | null): value is NarratorMessageRendererMode {
	return value === "react" || value === "pixi";
}

function ensureStorageListener() {
	if (storageListener) return;
	storageListener = (e: StorageEvent) => {
		if (e.key === NARRATOR_MESSAGE_RENDERER_PREF_KEY) {
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

function getSnapshot(): NarratorMessageRendererMode {
	if (typeof localStorage === "undefined") return DEFAULT_NARRATOR_MESSAGE_RENDERER;
	const raw = localStorage.getItem(NARRATOR_MESSAGE_RENDERER_PREF_KEY);
	return isRendererMode(raw) ? raw : DEFAULT_NARRATOR_MESSAGE_RENDERER;
}

export function useNarratorMessageRendererMode(): [
	NarratorMessageRendererMode,
	(mode: NarratorMessageRendererMode) => void,
] {
	const mode = useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => DEFAULT_NARRATOR_MESSAGE_RENDERER,
	);
	const setMode = useCallback((nextMode: NarratorMessageRendererMode) => {
		localStorage.setItem(NARRATOR_MESSAGE_RENDERER_PREF_KEY, nextMode);
		notify();
	}, []);
	return [mode, setMode];
}
