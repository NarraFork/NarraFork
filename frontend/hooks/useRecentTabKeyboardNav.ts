import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
// The logic module, not `RecentTabs.tsx`: importing from the component file would create
// a cycle (RecentTabs imports this hook) AND keep a non-component export there, which
// breaks its Fast Refresh boundary. See `recent-tabs-logic.ts`.
import {
	activeNavRowKey,
	navRowElement,
	navRowUrl,
	nextNavRow,
	readNavRows,
} from "../components/nav/recent-tab-keyboard-nav";

const DEBOUNCE_MS = 400;
/** The sidebar's session list (`RecentTabList`); the rows the keys walk live in it. */
const LIST_SELECTOR = "[data-recent-tab-list]";

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

// === Debounce timer (module-level, survives re-renders) ===

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function cancelDebounce() {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = null;
}

/** Inside a text field: the arrows and Enter are the field's. */
function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * Ctrl+Up / Ctrl+Down: walk the sidebar's rows as shown (`recent-tab-keyboard-nav.ts`).
 *
 * The highlight moves at once; landing on a session opens it after DEBOUNCE_MS of no
 * further presses, so passing over rows costs nothing. A folder header or a folder's
 * "N more" row is a stop of its own that opens nothing: Enter (or Ctrl+Enter) opens it,
 * collapsed ↔ shown and "N more" ↔ all, and the highlight stays there so the next press
 * walks into what appeared. On "N more", the plain arrows resize the preview, as with
 * the row focused. Enter on a session opens it now. Escape, a pointer press or any page
 * change drops the highlight.
 */
export function useRecentTabKeyboardNav() {
	const navigate = useNavigate();
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	// Any page change ends the switch: the keys' own, or a click elsewhere while the
	// highlight rested on a folder row (it opens nothing, so it would otherwise stay, and
	// every row's active state would keep following it instead of the open page).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on page change only
	useEffect(() => {
		cancelDebounce();
		setPendingKey(null);
	}, [pathname]);

	// A pointer press anywhere ends it too: the pointer is choosing now, not the keys.
	useEffect(() => {
		const end = () => {
			if (pendingKey === null) return;
			cancelDebounce();
			setPendingKey(null);
		};
		window.addEventListener("pointerdown", end, true);
		return () => window.removeEventListener("pointerdown", end, true);
	}, []);

	useEffect(() => {
		const list = () => document.querySelector(LIST_SELECTOR);

		const open = (key: string) => {
			cancelDebounce();
			setPendingKey(null);
			const url = navRowUrl(key);
			if (url) navigateRef.current({ to: url });
		};

		const onKeyDown = (e: KeyboardEvent) => {
			// Enter / Escape / plain arrows act on the highlight only while there is one.
			if (pendingKey !== null && !e.altKey && !e.shiftKey && !e.metaKey) {
				// On a folder's "N more" row the plain arrows resize the preview, as they do
				// with the row focused; the row's own handler does it (and persists it).
				if (
					!e.ctrlKey &&
					(e.key === "ArrowUp" || e.key === "ArrowDown") &&
					pendingKey.startsWith("strip:") &&
					!isTyping(e.target)
				) {
					const el = list() && navRowElement(list() as Element, pendingKey);
					if (el instanceof HTMLElement && el !== e.target) {
						e.preventDefault();
						el.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true }));
					}
					return;
				}
				if (e.key === "Escape") {
					cancelDebounce();
					setPendingKey(null);
					return;
				}
				if (e.key === "Enter" && !e.isComposing && !isTyping(e.target)) {
					e.preventDefault();
					const key = pendingKey;
					const el = list() && navRowElement(list() as Element, key);
					if (navRowUrl(key)) open(key);
					// A folder header or "N more": the row's own click toggles it.
					else if (el instanceof HTMLElement) {
						cancelDebounce();
						(el.matches("button") ? el : el.querySelector<HTMLElement>("button"))?.click();
					}
					return;
				}
			}

			if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
			if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
			if (isTyping(e.target)) return;
			const root = list();
			if (!root) return;
			const rows = readNavRows(root);
			const from = pendingKey ?? activeNavRowKey(root);
			const next = nextNavRow(rows, from, e.key === "ArrowDown" ? "down" : "up");
			if (!next) return;
			e.preventDefault();
			setPendingKey(next.key);
			navRowElement(root, next.key)?.scrollIntoView({ block: "nearest", behavior: "smooth" });

			// Only a session opens on its own; a folder row waits for Enter.
			cancelDebounce();
			if (next.kind !== "tab") return;
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				if (pendingKey) open(pendingKey);
			}, DEBOUNCE_MS);
		};

		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			cancelDebounce();
		};
	}, []);
}
