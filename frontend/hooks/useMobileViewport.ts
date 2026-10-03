import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { useSyncExternalStore } from "react";

type MobileViewportStore = {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => boolean;
};

const stores = new WeakMap<Window, MobileViewportStore>();
const getServerSnapshot = () => false;
const fallbackStore: MobileViewportStore = {
	subscribe: () => () => {},
	getSnapshot: getServerSnapshot,
};

function getStore(): MobileViewportStore {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return fallbackStore;
	}
	const existing = stores.get(window);
	if (existing) return existing;

	const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_MEDIA_QUERY);
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	const modernEvents = typeof mediaQuery.addEventListener === "function";
	const store: MobileViewportStore = {
		subscribe(listener) {
			if (listeners.size === 0) {
				if (modernEvents) mediaQuery.addEventListener("change", notify);
				else mediaQuery.addListener(notify);
			}
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					if (modernEvents) mediaQuery.removeEventListener("change", notify);
					else mediaQuery.removeListener(notify);
				}
			};
		},
		// Read LIVE matches: a parent render caused by route/context changes must
		// see the same snapshot as its children, even before native notification.
		getSnapshot: () => mediaQuery.matches,
	};
	stores.set(window, store);
	return store;
}

/** One media query and native listener per window, with stable store callbacks. */
export function useMobileViewport(): boolean {
	const { subscribe, getSnapshot } = getStore();
	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
