import { createContext, type PointerEvent, type ReactNode, useContext } from "react";

/** Optional controls supplied by a panel's host; absent on ordinary dock surfaces. */
export interface PanelHeaderControls {
	pinAction?: ReactNode;
	/** Return true when the host consumed the header gesture. */
	onPointerDown?: (event: PointerEvent) => boolean;
}

const PanelHeaderControlsContext = createContext<PanelHeaderControls | null>(null);

export const PanelHeaderControlsProvider = PanelHeaderControlsContext.Provider;

export function usePanelHeaderControls(): PanelHeaderControls | null {
	return useContext(PanelHeaderControlsContext);
}
