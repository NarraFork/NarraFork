/**
 * Shared state between the sidebar shell and its sections, kept out of the component
 * modules so they stay valid Fast Refresh boundaries (see `recent-tabs-logic.ts`).
 *
 * The sections render the same tree collapsed or not (`NavHoverPanel` clips it), so
 * they only need the stored preference, for the brand's tooltip, and a way to open the
 * collapsed sidebar. It comes from `NavHoverPanel` through context so that opening on
 * hover re-renders nothing above it.
 */

import { createContext, useContext } from "react";

export interface NavRenderState {
	/** The stored preference is collapsed (it may be open on hover right now). */
	storedCollapsed: boolean;
	/** Open the collapsed sidebar now (Cmd/Ctrl+K). */
	openPanel: () => void;
}

export const NavRenderContext = createContext<NavRenderState>({
	storedCollapsed: false,
	openPanel: () => {},
});

export function useNavRender(): NavRenderState {
	return useContext(NavRenderContext);
}

// ── The phone drawer ───────────────────────────────────────────────────────
//
// Phones have no header row, so the menu button lives in each page's own title row
// (`MobileNavButton`). This context hands it the drawer's toggle.

export interface MobileNavState {
	opened: boolean;
	toggle: () => void;
}

export const MobileNavContext = createContext<MobileNavState | null>(null);

export function useMobileNav(): MobileNavState | null {
	return useContext(MobileNavContext);
}

// ── "Focus the sidebar search box" ─────────────────────────────────────────
//
// The box may not be mounted yet (the rail is collapsed and is about to open), so the
// request is held until a box takes it on mount.

let searchFocusPending = false;
const searchFocusListeners = new Set<() => void>();

export function requestNavSearchFocus(): void {
	searchFocusPending = true;
	for (const listener of searchFocusListeners) listener();
}

export function takeNavSearchFocusRequest(): boolean {
	const was = searchFocusPending;
	searchFocusPending = false;
	return was;
}

export function subscribeNavSearchFocus(listener: () => void): () => void {
	searchFocusListeners.add(listener);
	return () => searchFocusListeners.delete(listener);
}
