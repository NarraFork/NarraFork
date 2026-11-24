import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => now;
const serverSnapshot = () => 0;
const inactiveSubscribe = () => () => {};

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (timer === undefined) {
		now = Date.now();
		timer = setInterval(() => {
			now = Date.now();
			for (const notify of listeners) notify();
		}, TICK_MS);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
}

/** One timer for visible quota countdowns and expiry, released when no consumer remains. */
export function useQuotaNow(active: boolean): number {
	const current = useSyncExternalStore(
		active ? subscribe : inactiveSubscribe,
		snapshot,
		serverSnapshot,
	);
	return active ? current : Date.now();
}
