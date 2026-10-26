import { useMantineContext } from "@mantine/core";
import { useSyncExternalStore } from "react";

type ComputedColorScheme = "light" | "dark";

const QUERY = "(prefers-color-scheme: dark)";

/**
 * One `matchMedia` list for every subscriber. Keyed by the `matchMedia` function so
 * a replaced implementation (tests, embedded hosts) is never served a stale list.
 */
let media: { source: Window["matchMedia"]; list: MediaQueryList } | null = null;
const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};

function osColorSchemeList(): MediaQueryList | null {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
	if (media?.source !== window.matchMedia) {
		try {
			media = { source: window.matchMedia, list: window.matchMedia(QUERY) };
		} catch {
			return null;
		}
	}
	return media.list;
}

let observed: MediaQueryList | null = null;

function subscribe(listener: () => void): () => void {
	const list = osColorSchemeList();
	listeners.add(listener);
	if (list !== observed) {
		observed?.removeEventListener?.("change", notify);
		list?.addEventListener?.("change", notify);
		observed = list;
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		observed?.removeEventListener?.("change", notify);
		observed = null;
	};
}

const getOsDark = (): boolean | null => osColorSchemeList()?.matches ?? null;
const getServerOsDark = (): boolean | null => null;

/**
 * Same answer as Mantine's `useComputedColorScheme`, for components mounted once per
 * virtual-list row. Mantine's hook costs every instance two media-query listeners
 * plus an unmount cleanup effect; during a fast history scroll those per-row mounts
 * and unmounts added up to ~150ms. This reads the provider's scheme from context and
 * shares a single OS-preference listener across all callers.
 */
export function useSharedComputedColorScheme(
	defaultValue: ComputedColorScheme,
): ComputedColorScheme {
	const { colorScheme } = useMantineContext();
	const osDark = useSyncExternalStore(subscribe, getOsDark, getServerOsDark);
	if (colorScheme !== "auto") return colorScheme;
	return osDark === null ? defaultValue : osDark ? "dark" : "light";
}
