/**
 * Shared state between the sidebar shell and its sections, kept out of the component
 * modules so they stay valid Fast Refresh boundaries (see `recent-tabs-logic.ts`).
 *
 * The sections render the same tree collapsed or not (`NavHoverPanel` clips it), so
 * they only need the stored preference, for the brand's tooltip. It comes from
 * `NavHoverPanel` through context so that opening on hover re-renders nothing above it.
 */

import { createContext, useContext } from "react";

export interface NavRenderState {
	/** The stored preference is collapsed (it may be open on hover right now). */
	storedCollapsed: boolean;
}

export const NavRenderContext = createContext<NavRenderState>({ storedCollapsed: false });

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
