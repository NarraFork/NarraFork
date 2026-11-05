/**
 * Shared state between the sidebar shell and its sections, kept out of the component
 * modules so they stay valid Fast Refresh boundaries (see `recent-tabs-logic.ts`).
 *
 * `collapsed` is how the sidebar renders right now, not the stored preference: a
 * collapsed rail that is open on hover renders expanded, and a phone drawer always does.
 * It comes from `NavHoverPanel` through context so that opening on hover re-renders only
 * the sections that read it, not the whole app shell.
 */

import { createContext, useContext } from "react";

export interface NavRenderState {
	/** Render the icon-only rail. */
	collapsed: boolean;
	/** The stored preference is the rail (it may be open on hover right now). */
	storedCollapsed: boolean;
	/** Open the collapsed rail now (a rail icon that needs the full panel was clicked). */
	openPanel: () => void;
}

export const NavRenderContext = createContext<NavRenderState>({
	collapsed: false,
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
