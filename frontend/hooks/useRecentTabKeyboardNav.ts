import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { isTabActive } from "../components/nav/RecentTabs";
import { queryClient } from "../lib/query-client";
import { RECENT_TABS_QUERY_KEY, type RecentTab } from "./useRecentTabs";

const DEBOUNCE_MS = 400;

// === Tiny reactive store ===

let pendingKey: string | null = null;
const listeners = new Set<() => void>();

function setPendingKey(key: string | null) {
	if (pendingKey === key) return;
	pendingKey = key;
	for (const l of listeners) l();
}

export function getPendingTabKey(): string | null {
	return pendingKey;
}

// Stable subscribe function — shared by all usePendingTabKey instances.
function subscribe(onStoreChange: () => void) {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

/** React hook that re-renders whenever the pending tab key changes. */
export function usePendingTabKey() {
	return useSyncExternalStore(subscribe, () => pendingKey);
}

// === URL mapping ===

function tabToUrl(tab: RecentTab): { to: string } {
	if (tab.type === "project") return { to: `/projects/${tab.id}` };
	if (tab.type === "chapter" && tab.narratorId) return { to: `/narrators/${tab.narratorId}` };
	if (tab.type === "workspace") return { to: `/narrators/workspace/${tab.id}` };
	return { to: `/narrators/${tab.id}` };
}

// === Debounce timer (module-level, survives re-renders) ===

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Global keyboard shortcut: Ctrl+Up / Ctrl+Down to switch between recent tabs.
 * Rapid presses only update the visual highlight in the sidebar; actual navigation
 * fires after DEBOUNCE_MS of idle time.
 */
export function useRecentTabKeyboardNav() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const navigate = useNavigate();

	// Flush pending navigation when pathname changes (navigation just happened)
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run on pathname change
	useEffect(() => {
		if (pendingKey) setPendingKey(null);
	}, [pathname]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
			if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;

			// Don't intercept when user is typing in an input/textarea/contenteditable
			const target = e.target as HTMLElement;
			if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
				return;
			}

			const tabs = queryClient.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY) ?? [];
			if (tabs.length === 0) return;

			// Start from pending tab if active, otherwise from actual page
			let baseIdx = -1;
			if (pendingKey) {
				baseIdx = tabs.findIndex((tab) => `${tab.type}:${tab.id}` === pendingKey);
			}
			if (baseIdx === -1) {
				baseIdx = tabs.findIndex((tab) => isTabActive(tab, pathname));
			}

			let nextIdx: number;
			if (e.key === "ArrowDown") {
				nextIdx = baseIdx === -1 ? 0 : (baseIdx + 1) % tabs.length;
			} else {
				nextIdx = baseIdx === -1 ? tabs.length - 1 : (baseIdx - 1 + tabs.length) % tabs.length;
			}

			e.preventDefault();

			const nextTab = tabs[nextIdx];
			const nextKey = `${nextTab.type}:${nextTab.id}`;
			setPendingKey(nextKey);

			// Scroll the highlighted tab into view
			const el = document.querySelector(`[data-tab-sort-id="${globalThis.CSS.escape(nextKey)}"]`);
			el?.scrollIntoView({ block: "nearest", behavior: "smooth" });

			// Reset debounce timer — only navigate after user stops pressing keys
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				const key = pendingKey;
				setPendingKey(null);
				if (!key) return;
				const tab = queryClient
					.getQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY)
					?.find((t) => `${t.type}:${t.id}` === key);
				if (tab) navigate(tabToUrl(tab));
			}, DEBOUNCE_MS);
		},
		[pathname, navigate],
	);

	useEffect(() => {
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
		};
	}, [handleKeyDown]);
}
