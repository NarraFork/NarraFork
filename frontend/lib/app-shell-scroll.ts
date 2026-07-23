import { useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
	createAppHistoryEntryKey,
	replaceCurrentHistoryState,
	resolveAppShellHistoryEntryKey,
} from "./history-state";
import { APP_SHELL_MAIN_ID } from "./safe-area";

export const useBrowserLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

export interface AppShellMainScrollTarget {
	scrollTop: number;
}

export interface AppShellMainScrollPosition {
	top: number;
}

const MAX_CACHED_HISTORY_ENTRIES = 100;

/**
 * History-entry scroll cache deliberately scoped to AppShell.Main.
 *
 * TanStack Router 1.168.23 captures every bubbling scroll target whenever global
 * scroll restoration is enabled. This store never observes document scroll
 * events, so message lists, ScrollArea viewports, and terminals remain owned by
 * their local state machines.
 */
export class AppShellMainScrollStore {
	private readonly positions = new Map<string, AppShellMainScrollPosition>();

	capture(key: string, target: AppShellMainScrollTarget): void {
		this.positions.delete(key);
		this.positions.set(key, { top: target.scrollTop });
		while (this.positions.size > MAX_CACHED_HISTORY_ENTRIES) {
			const oldestKey = this.positions.keys().next().value;
			if (oldestKey === undefined) break;
			this.positions.delete(oldestKey);
		}
	}

	restore(key: string, target: AppShellMainScrollTarget): AppShellMainScrollPosition {
		const position = this.positions.get(key) ?? { top: 0 };
		target.scrollTop = position.top;
		return position;
	}

	clear(): void {
		this.positions.clear();
	}
}

export const appShellMainScrollStore = new AppShellMainScrollStore();

/** Resolve and, for legacy entries, persist a unique scroll key without inventing TSR metadata. */
export function useAppShellHistoryEntryKey(): string {
	const location = useRouterState({
		select: (state) => ({ href: state.location.href, state: state.location.state }),
	});
	const fallbackRef = useRef<{ state: unknown; key: string } | undefined>(undefined);
	if (!fallbackRef.current || fallbackRef.current.state !== location.state) {
		fallbackRef.current = { state: location.state, key: createAppHistoryEntryKey() };
	}

	const resolved = resolveAppShellHistoryEntryKey(location, fallbackRef.current.key);
	useBrowserLayoutEffect(() => {
		if (!resolved.needsFallbackPersistence) return;
		replaceCurrentHistoryState({ __NF_history_key: resolved.key }, location.href);
	}, [location.href, resolved.key, resolved.needsFallbackPersistence]);
	return resolved.key;
}

export function enterAppShellMainScrollEntry(
	locationKey: string,
	targetDocument: Document = document,
	store: AppShellMainScrollStore = appShellMainScrollStore,
): (() => void) | undefined {
	const main = targetDocument.getElementById(APP_SHELL_MAIN_ID);
	if (!main) return;

	store.restore(locationKey, main);
	return () => store.capture(locationKey, main);
}

/** Restore after route DOM commits and capture immediately before it is replaced. */
export function useAppShellMainScrollRestoration(locationKey: string, enabled = true): void {
	useBrowserLayoutEffect(() => {
		if (!enabled) return;
		return enterAppShellMainScrollEntry(locationKey);
	}, [enabled, locationKey]);
}
