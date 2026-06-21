import { useSyncExternalStore } from "react";

/**
 * Feature flag for the experimental chunk-virtualized message list (Phase 0).
 *
 * Backed by localStorage so it survives reloads and can be toggled per-device
 * for gradual rollout. While the flag is off, NarratorPanel keeps using the
 * existing BroadMessageList + render-window path, so the new list can be
 * developed and verified in parallel without risking the core message view.
 */

const STORAGE_KEY = "narrafork_chunk_list";
const EVENT = "narrafork:chunk-list-flag";

function read(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

function subscribe(callback: () => void): () => void {
	const handler = () => callback();
	window.addEventListener(EVENT, handler);
	window.addEventListener("storage", handler);
	return () => {
		window.removeEventListener(EVENT, handler);
		window.removeEventListener("storage", handler);
	};
}

export function setChunkedListEnabled(enabled: boolean): void {
	try {
		if (enabled) localStorage.setItem(STORAGE_KEY, "true");
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Ignore storage failures (private mode, quota).
	}
	window.dispatchEvent(new CustomEvent(EVENT));
}

export function useChunkedListEnabled(): boolean {
	return useSyncExternalStore(subscribe, read, () => false);
}
